import { randomUUID } from "node:crypto";
import { mkdir, open, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  type BrowserExecutor,
  type OperationContext,
} from "@vs-code-gpt/shared";
import { z } from "zod";

// Chrome encodes every recorded frame as a lossy WebP still. A lossy WebP's
// VP8 chunk is a complete VP8 key frame, so the stills become a WebM video
// here without any video encoder.
const MAX_FRAME_BASE64_CHARS = 4 * 1024 * 1024;
const MAX_RECORDING_BYTES = 256 * 1024 * 1024;
const MAX_TRACE_ACTIONS = 5_000;
const WRITING_APP = "MCP V3 personal Chrome";

export const personalRecordingTransportSchema = z.object({
  tabId: z.string().min(1).max(128),
  recordingId: z.string().uuid(),
  active: z.boolean(),
}).strict();

export interface PersonalRecordingControl {
  start(
    input: { tabId: string; recordingId: string; width?: number; height?: number },
    context?: OperationContext,
  ): Promise<unknown>;
  stop(input: { tabId: string; recordingId: string }, context?: OperationContext): Promise<unknown>;
}

export interface PersonalTraceAction {
  atMs: number;
  durationMs: number;
  operation: string;
  outcome: "success" | "error" | "cancelled" | "timeout";
  errorCode?: string;
  target?: Record<string, string | number>;
}

interface StagedFrame {
  at: number;
  offset: number;
  size: number;
}

export interface PersonalVideoFrame {
  atMs: number;
  offset: number;
  size: number;
}

interface Recording {
  id: string;
  tabId: string;
  stagingPath: string;
  staging: FileHandle;
  bytes: number;
  frames: StagedFrame[];
  width?: number;
  height?: number;
  writes: Promise<void>;
  writeFailed: boolean;
  live: boolean;
  truncated: boolean;
  video?: { path: string; startedAt: number } | undefined;
  trace?: { startedAt: number; actions: PersonalTraceAction[]; dropped: number } | undefined;
}

/**
 * One Chrome recording per personal tab feeds both browser_video and
 * browser_trace. Frames are staged on disk as they arrive and assembled when
 * the last consumer stops.
 */
export class PersonalBrowserRecorder {
  private readonly byTab = new Map<string, Recording>();
  private readonly byId = new Map<string, Recording>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly artifactsRoot: string,
    private readonly control: PersonalRecordingControl,
  ) {}

  isActive(tabId: string, kind: "video" | "trace"): boolean {
    return this.byTab.get(tabId)?.[kind] !== undefined;
  }

  /** Stale staged frames from an earlier gateway run are never resumed. */
  async sweep(): Promise<void> {
    await rm(path.join(this.artifactsRoot, "recordings"), { recursive: true, force: true });
  }

  videoStart(
    ...[input, context]: Parameters<BrowserExecutor["videoStart"]>
  ): ReturnType<BrowserExecutor["videoStart"]> {
    return this.serialize(input.tabId, async () => {
      if (this.byTab.get(input.tabId)?.video) {
        throw new AppError("INVALID_ARGUMENT", "Video recording is already active.");
      }
      const name = input.filename ?? `video-${Date.now()}.webm`;
      const directory = path.join(this.artifactsRoot, "videos");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const outputPath = path.join(directory,
        `${randomUUID()}-${name.toLowerCase().endsWith(".webm") ? name : `${name}.webm`}`);
      const recording = await this.acquire(input.tabId,
        input.width !== undefined && input.height !== undefined
          ? { width: input.width, height: input.height } : undefined,
        context);
      recording.video = { path: outputPath, startedAt: Date.now() };
      return { tabId: input.tabId, path: outputPath, active: true as const };
    });
  }

  videoStop(
    ...[input, context]: Parameters<BrowserExecutor["videoStop"]>
  ): ReturnType<BrowserExecutor["videoStop"]> {
    return this.serialize(input.tabId, async () => {
      const recording = this.byTab.get(input.tabId);
      const video = recording?.video;
      if (!recording || !video) {
        throw new AppError("INVALID_ARGUMENT", "Video recording is not active.");
      }
      const stoppedAt = await this.release(recording, "video", context);
      recording.video = undefined;
      try {
        const sizeBytes = await this.writeVideo(recording, video.startedAt, stoppedAt, video.path);
        if (sizeBytes === undefined) {
          throw new AppError("BROWSER_CAPABILITY_UNSUPPORTED",
            "Chrome painted no frames for this recording; the MCP tab must be visible while it records.");
        }
        return { tabId: input.tabId, kind: "video" as const, path: video.path, sizeBytes,
          createdAt: new Date(stoppedAt).toISOString() };
      } finally {
        if (!recording.trace) await this.discard(recording);
      }
    });
  }

  traceStart(
    ...[input, context]: Parameters<BrowserExecutor["traceStart"]>
  ): ReturnType<BrowserExecutor["traceStart"]> {
    return this.serialize(input.tabId, async () => {
      if (this.byTab.get(input.tabId)?.trace) {
        throw new AppError("INVALID_ARGUMENT", "Trace recording is already active.");
      }
      const recording = await this.acquire(input.tabId, undefined, context);
      recording.trace = { startedAt: Date.now(), actions: [], dropped: 0 };
      return { tabId: input.tabId, active: true as const };
    });
  }

  traceStop(
    ...[input, context]: Parameters<BrowserExecutor["traceStop"]>
  ): ReturnType<BrowserExecutor["traceStop"]> {
    return this.serialize(input.tabId, async () => {
      const recording = this.byTab.get(input.tabId);
      const trace = recording?.trace;
      if (!recording || !trace) {
        throw new AppError("INVALID_ARGUMENT", "Trace recording is not active.");
      }
      const stoppedAt = await this.release(recording, "trace", context);
      recording.trace = undefined;
      try {
        const directory = path.join(this.artifactsRoot, "traces", randomUUID());
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const videoPath = path.join(directory, "trace.webm");
        const videoBytes = await this.writeVideo(recording, trace.startedAt, stoppedAt, videoPath);
        const jsonPath = path.join(directory, "trace.json");
        const document = {
          format: "mcp-v3-personal-trace",
          version: 1,
          tabId: input.tabId,
          startedAt: new Date(trace.startedAt).toISOString(),
          stoppedAt: new Date(stoppedAt).toISOString(),
          durationMs: stoppedAt - trace.startedAt,
          // Action times are offsets into the video, which starts with the trace.
          video: videoBytes === undefined ? null : "trace.webm",
          framesTruncated: recording.truncated,
          actionsDropped: trace.dropped,
          actions: trace.actions,
        };
        await writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        const createdAt = new Date(stoppedAt).toISOString();
        const files = [
          { kind: "trace" as const, path: jsonPath, sizeBytes: (await stat(jsonPath)).size, createdAt },
          ...(videoBytes === undefined ? [] : [{ kind: "trace" as const, path: videoPath, sizeBytes: videoBytes, createdAt }]),
        ];
        return { tabId: input.tabId, kind: "trace" as const, files,
          totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), createdAt };
      } finally {
        if (!recording.video) await this.discard(recording);
      }
    });
  }

  /** Records one operation that reached Chrome while its tab is traced. */
  traceAction(
    operation: string,
    input: unknown,
    startedAt: number,
    outcome: PersonalTraceAction["outcome"],
    errorCode?: string,
  ): void {
    if (!isRecord(input) || typeof input.tabId !== "string") return;
    const trace = this.byTab.get(input.tabId)?.trace;
    if (!trace) return;
    if (trace.actions.length >= MAX_TRACE_ACTIONS) {
      trace.dropped += 1;
      return;
    }
    const target = traceTarget(input);
    trace.actions.push({
      atMs: Math.max(0, Math.round(startedAt - trace.startedAt)),
      durationMs: Math.max(0, Math.round(Date.now() - startedAt)),
      operation,
      outcome,
      ...(errorCode ? { errorCode } : {}),
      ...(target ? { target } : {}),
    });
  }

  /**
   * A frame from the extension: a WebP still for a recording this bridge started.
   * False when no recording here wants it, so Chrome can be told to stop.
   */
  acceptFrame(message: Record<string, unknown>): boolean {
    const recording = typeof message.recordingId === "string" ? this.byId.get(message.recordingId) : undefined;
    if (!recording?.live) return false;
    const data = message.data;
    if (typeof data !== "string" || data.length > MAX_FRAME_BASE64_CHARS ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return true;
    const still = extractWebpKeyFrame(Buffer.from(data, "base64"));
    if (!still) return true;
    if (recording.width === undefined) {
      recording.width = still.width;
      recording.height = still.height;
    } else if (still.width !== recording.width || still.height !== recording.height) {
      return true;
    }
    const size = still.frame.length;
    if (recording.bytes + size > MAX_RECORDING_BYTES) {
      recording.truncated = true;
      return true;
    }
    const offset = recording.bytes;
    recording.bytes += size;
    recording.frames.push({ at: Math.max(Date.now(), recording.frames.at(-1)?.at ?? 0), offset, size });
    recording.writes = recording.writes
      .then(async () => {
        await recording.staging.write(still.frame, 0, size, offset);
      })
      .catch(() => {
        recording.writeFailed = true;
      });
    return true;
  }

  /** Chrome ended the recording: the tab closed or the user stopped debugging. */
  ended(message: Record<string, unknown>): void {
    if (typeof message.recordingId !== "string") return;
    const recording = this.byId.get(message.recordingId);
    if (recording) recording.live = false;
  }

  disconnect(): void {
    for (const recording of this.byTab.values()) recording.live = false;
  }

  async close(): Promise<void> {
    await Promise.all([...this.byTab.values()].map((recording) => this.discard(recording)));
  }

  private async acquire(
    tabId: string,
    size: { width: number; height: number } | undefined,
    context?: OperationContext,
  ): Promise<Recording> {
    const existing = this.byTab.get(tabId);
    if (existing?.live) return existing;
    if (existing) {
      // The other consumer outlived an interrupted recording: resume it at the
      // size its frames already have. Live first: Chrome's first frame can
      // arrive before its start reply.
      existing.live = true;
      try {
        await this.control.start({
          tabId, recordingId: existing.id,
          ...(existing.width && existing.height ? { width: existing.width, height: existing.height } : {}),
        }, context);
      } catch (error) {
        existing.live = false;
        throw error;
      }
      return existing;
    }
    const id = randomUUID();
    const directory = path.join(this.artifactsRoot, "recordings");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stagingPath = path.join(directory, `${id}.frames`);
    const recording: Recording = {
      id, tabId, stagingPath, staging: await open(stagingPath, "wx+", 0o600), bytes: 0, frames: [],
      writes: Promise.resolve(), writeFailed: false, live: true, truncated: false,
    };
    // Registered first: Chrome's first frame can arrive before its start reply.
    this.byTab.set(tabId, recording);
    this.byId.set(id, recording);
    try {
      await this.control.start({ tabId, recordingId: id, ...(size ?? {}) }, context);
    } catch (error) {
      await this.discard(recording);
      throw error;
    }
    return recording;
  }

  /** Stops Chrome's recording once its last consumer ends; returns the stop time. */
  private async release(
    recording: Recording,
    kind: "video" | "trace",
    context?: OperationContext,
  ): Promise<number> {
    const other = kind === "video" ? recording.trace : recording.video;
    if (!other && recording.live) {
      try {
        await this.control.stop({ tabId: recording.tabId, recordingId: recording.id }, context);
      } catch (error) {
        // Chrome is still recording; the caller can stop again later.
        if (error instanceof AppError &&
            (error.code === "EXECUTION_STATE_INVALID" || error.code === "OPERATION_CANCELLED")) throw error;
      }
      recording.live = false;
    }
    const stoppedAt = Date.now();
    await recording.writes;
    return stoppedAt;
  }

  private async writeVideo(
    recording: Recording,
    startedAt: number,
    stoppedAt: number,
    output: string,
  ): Promise<number | undefined> {
    await recording.writes;
    if (recording.writeFailed) {
      throw new AppError("INTERNAL_ERROR", "Recorded frames could not be staged on disk.");
    }
    const frames = personalVideoTimeline(recording.frames, startedAt, stoppedAt);
    if (frames.length === 0 || !recording.width || !recording.height) return undefined;
    await writePersonalWebm(output, recording.staging, frames, recording.width, recording.height);
    return (await stat(output)).size;
  }

  private async discard(recording: Recording): Promise<void> {
    if (this.byTab.get(recording.tabId) === recording) this.byTab.delete(recording.tabId);
    this.byId.delete(recording.id);
    recording.live = false;
    await recording.writes;
    await recording.staging.close().catch(() => undefined);
    await rm(recording.stagingPath, { force: true }).catch(() => undefined);
  }

  private serialize<T>(tabId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(work);
    const tail = current.then(() => undefined, () => undefined);
    this.queues.set(tabId, tail);
    void tail.then(() => {
      if (this.queues.get(tabId) === tail) this.queues.delete(tabId);
    });
    return current;
  }
}

/**
 * The frames a consumer saw, timed from its own start: the page as it was at
 * the start, every frame after it, and the last one again at the stop.
 */
export function personalVideoTimeline(
  frames: readonly StagedFrame[],
  startedAt: number,
  stoppedAt: number,
): PersonalVideoFrame[] {
  let first = frames.findIndex((frame) => frame.at > startedAt);
  if (first === -1) first = frames.length;
  const chosen = frames.slice(Math.max(0, first - 1)).filter((frame) => frame.at <= stoppedAt);
  const timeline: PersonalVideoFrame[] = [];
  for (const frame of chosen) {
    // The first frame Chrome painted stands for the page from the very start.
    const previous = timeline.at(-1)?.atMs;
    timeline.push({ atMs: previous === undefined ? 0 : Math.max(previous + 1, Math.round(frame.at - startedAt)),
      offset: frame.offset, size: frame.size });
  }
  const last = timeline.at(-1);
  if (last) {
    timeline.push({ atMs: Math.max(last.atMs + 1, Math.round(stoppedAt - startedAt)), offset: last.offset, size: last.size });
  }
  return timeline;
}

/** The VP8 key frame inside a lossy, opaque WebP still. */
export function extractWebpKeyFrame(
  bytes: Buffer,
): { frame: Buffer; width: number; height: number } | undefined {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP") return undefined;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const fourcc = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length || fourcc === "ALPH" || fourcc === "VP8L") return undefined;
    if (fourcc === "VP8 ") {
      const frame = bytes.subarray(start, start + size);
      // RFC 6386 9.1: a key frame tag, the start code, then 14-bit dimensions.
      if (size < 10 || (frame[0]! & 1) !== 0 ||
          frame[3] !== 0x9d || frame[4] !== 0x01 || frame[5] !== 0x2a) return undefined;
      const width = frame.readUInt16LE(6) & 0x3fff;
      const height = frame.readUInt16LE(8) & 0x3fff;
      return width > 0 && height > 0 ? { frame, width, height } : undefined;
    }
    offset = start + size + (size & 1);
  }
  return undefined;
}

/**
 * Writes VP8 key frames as a WebM file. Every frame is a key frame, so each
 * one is its own cluster and cue point, and players can seek to any frame.
 */
export async function writePersonalWebm(
  output: string,
  source: FileHandle,
  frames: readonly PersonalVideoFrame[],
  width: number,
  height: number,
): Promise<void> {
  const header = element(0x1a45dfa3,
    element(0x4286, uint(1)), element(0x42f7, uint(1)), element(0x42f2, uint(4)),
    element(0x42f3, uint(8)), element(0x4282, Buffer.from("webm")),
    element(0x4287, uint(2)), element(0x4285, uint(2)));
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE(frames.at(-1)?.atMs ?? 0);
  const info = element(0x1549a966,
    element(0x2ad7b1, uint(1_000_000)), element(0x4489, duration),
    element(0x4d80, Buffer.from(WRITING_APP)), element(0x5741, Buffer.from(WRITING_APP)));
  const tracks = element(0x1654ae6b, element(0xae,
    element(0xd7, uint(1)), element(0x73c5, uint(1)), element(0x83, uint(1)),
    element(0x9c, uint(0)), element(0x86, Buffer.from("V_VP8")),
    element(0xe0, element(0xb0, uint(width)), element(0xba, uint(height)))));
  const clusterHeads = frames.map((frame) => {
    const timestamp = element(0xe7, uint(frame.atMs));
    // Track 1, no relative offset, key frame.
    const block = Buffer.concat([ebmlId(0xa3), ebmlSize(frame.size + 4), Buffer.from([0x81, 0, 0, 0x80])]);
    const payload = timestamp.length + block.length + frame.size;
    return Buffer.concat([ebmlId(0x1f43b675), ebmlSize(payload), timestamp, block]);
  });
  // Seek positions use a fixed width, so the seek head's size is known first.
  const seek = (id: number, position: number) =>
    element(0x4dbb, element(0x53ab, ebmlId(id)), element(0x53ac, uint(position, 8)));
  const seekHeadSize = element(0x114d9b74, seek(0x1549a966, 0), seek(0x1654ae6b, 0), seek(0x1c53bb6b, 0)).length;
  const infoAt = seekHeadSize;
  const tracksAt = infoAt + info.length;
  let position = tracksAt + tracks.length;
  const clusterAt = clusterHeads.map((head, index) => {
    const at = position;
    position += head.length + frames[index]!.size;
    return at;
  });
  const cues = element(0x1c53bb6b, ...frames.map((frame, index) => element(0xbb,
    element(0xb3, uint(frame.atMs)),
    element(0xb7, element(0xf7, uint(1)), element(0xf1, uint(clusterAt[index]!))))));
  const seekHead = element(0x114d9b74,
    seek(0x1549a966, infoAt), seek(0x1654ae6b, tracksAt), seek(0x1c53bb6b, position));
  const segmentSize = position + cues.length;

  const file = await open(output, "wx", 0o600);
  try {
    await file.write(Buffer.concat([header, ebmlId(0x18538067), ebmlSize(segmentSize, 8), seekHead, info, tracks]));
    for (const [index, frame] of frames.entries()) {
      const data = Buffer.alloc(frame.size);
      const { bytesRead } = await source.read(data, 0, frame.size, frame.offset);
      if (bytesRead !== frame.size) throw new AppError("INTERNAL_ERROR", "A staged recording frame is incomplete.");
      await file.write(clusterHeads[index]!);
      await file.write(data);
    }
    await file.write(cues);
  } catch (error) {
    await file.close().catch(() => undefined);
    await rm(output, { force: true }).catch(() => undefined);
    throw error;
  }
  await file.close();
}

function ebmlId(id: number): Buffer {
  const length = id > 0xffffff ? 4 : id > 0xffff ? 3 : id > 0xff ? 2 : 1;
  const bytes = Buffer.alloc(length);
  bytes.writeUIntBE(id, 0, length);
  return bytes;
}

function ebmlSize(size: number, width?: number): Buffer {
  let length = width ?? 1;
  while (width === undefined && size >= 2 ** (7 * length) - 1) length += 1;
  const bytes = uint(size, length);
  bytes[0]! |= 0x80 >> (length - 1);
  return bytes;
}

function uint(value: number, width?: number): Buffer {
  let length = width ?? 1;
  while (width === undefined && value >= 2 ** (8 * length)) length += 1;
  const bytes = Buffer.alloc(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return bytes;
}

function element(id: number, ...children: Buffer[]): Buffer {
  const payload = Buffer.concat(children);
  return Buffer.concat([ebmlId(id), ebmlSize(payload.length), payload]);
}

// What an action pointed at, never what it typed: no text, values or files.
function traceTarget(input: Record<string, unknown>): Record<string, string | number> | undefined {
  const target: Record<string, string | number> = {};
  for (const key of ["ref", "element", "key", "direction"]) {
    const value = input[key];
    if (typeof value === "string" && value) target[key] = value.slice(0, 200);
  }
  for (const key of ["x", "y"]) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
  }
  if (typeof input.url === "string") {
    try {
      const url = new URL(input.url);
      target.url = `${url.origin}${url.pathname}`.slice(0, 500);
    } catch {
      // Not an address worth keeping.
    }
  }
  return Object.keys(target).length > 0 ? target : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
