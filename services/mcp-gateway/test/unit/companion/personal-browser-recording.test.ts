import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import {
  extractWebpKeyFrame,
  PersonalBrowserRecorder,
  personalVideoTimeline,
  writePersonalWebm,
} from "../../../src/companion/personal-browser-recording.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-recording-"));
  temporaryRoots.push(root);
  return root;
}

function keyFrame(width: number, height: number, fill: number): Buffer {
  const frame = Buffer.alloc(24, fill);
  frame.set([0x10, 0, 0, 0x9d, 0x01, 0x2a], 0);
  frame.writeUInt16LE(width, 6);
  frame.writeUInt16LE(height, 8);
  return frame;
}

function webp(...chunks: Array<[string, Buffer]>): Buffer {
  const body = Buffer.concat(chunks.map(([fourcc, data]) => {
    const header = Buffer.alloc(8);
    header.write(fourcc, 0, "ascii");
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, Buffer.alloc(data.length & 1)]);
  }));
  const riff = Buffer.alloc(12);
  riff.write("RIFF", 0, "ascii");
  riff.writeUInt32LE(4 + body.length, 4);
  riff.write("WEBP", 8, "ascii");
  return Buffer.concat([riff, body]);
}

interface Element {
  id: number;
  at: number;
  dataAt: number;
  size: number;
}

function readVint(bytes: Buffer, offset: number, keepMarker: boolean): { value: number; length: number } {
  const first = bytes[offset]!;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length += 1;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let index = 1; index < length; index += 1) value = value * 256 + bytes[offset + index]!;
  return { value, length };
}

function children(bytes: Buffer, start: number, end: number): Element[] {
  const elements: Element[] = [];
  for (let offset = start; offset < end;) {
    const id = readVint(bytes, offset, true);
    const size = readVint(bytes, offset + id.length, false);
    const dataAt = offset + id.length + size.length;
    elements.push({ id: id.value, at: offset, dataAt, size: size.value });
    offset = dataAt + size.value;
  }
  return elements;
}

function child(bytes: Buffer, parent: Element, id: number): Element {
  const found = children(bytes, parent.dataAt, parent.dataAt + parent.size).find((item) => item.id === id);
  if (!found) throw new Error(`Missing element ${id.toString(16)}`);
  return found;
}

function uintOf(bytes: Buffer, element: Element): number {
  let value = 0;
  for (let index = 0; index < element.size; index += 1) value = value * 256 + bytes[element.dataAt + index]!;
  return value;
}

function stillBase64(width: number, height: number, fill: number): string {
  return webp(["VP8 ", keyFrame(width, height, fill)]).toString("base64");
}

describe("personal browser recording", () => {
  it("takes the VP8 key frame out of a lossy WebP and refuses alpha, lossless and inter frames", () => {
    const frame = keyFrame(640, 360, 7);
    expect(extractWebpKeyFrame(webp(["VP8 ", frame]))).toEqual({ frame, width: 640, height: 360 });
    expect(extractWebpKeyFrame(webp(["VP8X", Buffer.alloc(10)], ["VP8 ", frame])))
      .toMatchObject({ width: 640, height: 360 });
    expect(extractWebpKeyFrame(webp(["VP8X", Buffer.alloc(10)], ["ALPH", Buffer.alloc(9)], ["VP8 ", frame])))
      .toBeUndefined();
    expect(extractWebpKeyFrame(webp(["VP8L", Buffer.alloc(30)]))).toBeUndefined();
    const inter = Buffer.from(frame);
    inter[0] = 0x11;
    expect(extractWebpKeyFrame(webp(["VP8 ", inter]))).toBeUndefined();
    expect(extractWebpKeyFrame(Buffer.from("not a webp image at all, really not"))).toBeUndefined();
    const truncated = webp(["VP8 ", frame]);
    expect(extractWebpKeyFrame(truncated.subarray(0, truncated.length - 4))).toBeUndefined();
  });

  it("times each consumer's frames from its own start and holds the last one until the stop", () => {
    const frames = [
      { at: 1_000, offset: 0, size: 10 },
      { at: 1_500, offset: 10, size: 10 },
      { at: 1_500, offset: 20, size: 10 },
      { at: 2_200, offset: 30, size: 10 },
      { at: 5_000, offset: 40, size: 10 },
    ];
    // The page as it was at the start is the frame painted just before it.
    expect(personalVideoTimeline(frames, 1_200, 3_000)).toEqual([
      { atMs: 0, offset: 0, size: 10 },
      { atMs: 300, offset: 10, size: 10 },
      { atMs: 301, offset: 20, size: 10 },
      { atMs: 1_000, offset: 30, size: 10 },
      { atMs: 1_800, offset: 30, size: 10 },
    ]);
    // A first frame painted after the start stands for the page from the start.
    expect(personalVideoTimeline(frames, 900, 1_600).map((frame) => frame.atMs)).toEqual([0, 600, 601, 700]);
    expect(personalVideoTimeline([], 0, 1_000)).toEqual([]);
  });

  it("writes a seekable WebM whose seek head, clusters and cues point at real elements", async () => {
    const root = await temporaryRoot();
    const staging = await open(path.join(root, "frames"), "w+");
    const payloads = [keyFrame(320, 180, 1), keyFrame(320, 180, 2), keyFrame(320, 180, 3)];
    let offset = 0;
    const staged = [];
    for (const [index, payload] of payloads.entries()) {
      await staging.write(payload, 0, payload.length, offset);
      staged.push({ at: 10_000 + index * 400, offset, size: payload.length });
      offset += payload.length;
    }
    const timeline = personalVideoTimeline(staged, 10_000, 11_500);
    const output = path.join(root, "out.webm");
    await writePersonalWebm(output, staging, timeline, 320, 180);
    await staging.close();
    const bytes = await readFile(output);

    const [ebml, segment, ...rest] = children(bytes, 0, bytes.length);
    expect(rest).toEqual([]);
    expect(ebml!.id).toBe(0x1a45dfa3);
    expect(child(bytes, ebml!, 0x4282).size).toBe(4);
    expect(bytes.toString("ascii", child(bytes, ebml!, 0x4282).dataAt, child(bytes, ebml!, 0x4282).dataAt + 4)).toBe("webm");
    expect(segment!.id).toBe(0x18538067);
    expect(segment!.dataAt + segment!.size).toBe(bytes.length);

    const top = children(bytes, segment!.dataAt, bytes.length);
    expect(top.map((item) => item.id)).toEqual([
      0x114d9b74, 0x1549a966, 0x1654ae6b, ...timeline.map(() => 0x1f43b675), 0x1c53bb6b,
    ]);
    for (const seek of children(bytes, top[0]!.dataAt, top[0]!.dataAt + top[0]!.size)) {
      const target = child(bytes, seek, 0x53ab);
      const position = uintOf(bytes, child(bytes, seek, 0x53ac));
      const pointed = readVint(bytes, segment!.dataAt + position, true).value;
      expect(pointed).toBe(readVint(bytes, target.dataAt, true).value);
    }
    const info = top[1]!;
    expect(uintOf(bytes, child(bytes, info, 0x2ad7b1))).toBe(1_000_000);
    expect(bytes.readDoubleBE(child(bytes, info, 0x4489).dataAt)).toBe(1_500);
    const entry = child(bytes, top[2]!, 0xae);
    const codec = child(bytes, entry, 0x86);
    expect(bytes.toString("ascii", codec.dataAt, codec.dataAt + codec.size)).toBe("V_VP8");
    const video = child(bytes, entry, 0xe0);
    expect([uintOf(bytes, child(bytes, video, 0xb0)), uintOf(bytes, child(bytes, video, 0xba))]).toEqual([320, 180]);

    const clusters = top.filter((item) => item.id === 0x1f43b675);
    clusters.forEach((cluster, index) => {
      expect(uintOf(bytes, child(bytes, cluster, 0xe7))).toBe(timeline[index]!.atMs);
      const block = child(bytes, cluster, 0xa3);
      expect([...bytes.subarray(block.dataAt, block.dataAt + 4)]).toEqual([0x81, 0, 0, 0x80]);
      const payload = bytes.subarray(block.dataAt + 4, block.dataAt + block.size);
      expect(payload.equals(payloads[Math.min(index, payloads.length - 1)]!)).toBe(true);
    });
    const cues = children(bytes, top.at(-1)!.dataAt, top.at(-1)!.dataAt + top.at(-1)!.size);
    cues.forEach((cue, index) => {
      expect(uintOf(bytes, child(bytes, cue, 0xb3))).toBe(timeline[index]!.atMs);
      const position = uintOf(bytes, child(bytes, child(bytes, cue, 0xb7), 0xf1));
      expect(segment!.dataAt + position).toBe(clusters[index]!.at);
    });
  });

  it("shares one Chrome recording between a trace and a video and stops it with the last of them", async () => {
    const root = await temporaryRoot();
    const calls: Array<[string, Record<string, unknown>]> = [];
    const recorder = new PersonalBrowserRecorder(root, {
      start: async (input) => { calls.push(["start", input]); },
      stop: async (input) => { calls.push(["stop", input]); },
    });
    const tabId = "personal:7";
    await expect(recorder.traceStart({ tabId })).resolves.toEqual({ tabId, active: true });
    const recordingId = String(calls[0]![1].recordingId);
    recorder.acceptFrame({ type: "recording-frame", recordingId, data: stillBase64(320, 180, 1) });
    const started = await recorder.videoStart({ tabId, filename: "demo" });
    expect(started).toMatchObject({ tabId, active: true });
    expect(path.basename(started.path)).toMatch(/^[0-9a-f-]{36}-demo\.webm$/u);
    expect(calls).toEqual([["start", { tabId, recordingId }]]);
    expect([recorder.isActive(tabId, "trace"), recorder.isActive(tabId, "video")]).toEqual([true, true]);

    recorder.traceAction("click", { tabId, ref: "p-1", element: "Pintar" }, Date.now(), "success");
    recorder.traceAction("type", { tabId, text: "segredo", ref: "p-2" }, Date.now(), "error", "ACTION_REQUIRES_CONFIRMATION");
    recorder.traceAction("navigate", { tabId, url: "https://example.com/a/b?token=1#x" }, Date.now(), "success");
    recorder.traceAction("click", { tabId: "personal:8", ref: "p-9" }, Date.now(), "success");
    // Frames from unknown recordings, of another size, or not WebP are dropped;
    // only the unknown recording is one Chrome should stop.
    expect(recorder.acceptFrame({ recordingId: "00000000-0000-4000-8000-000000000000", data: stillBase64(320, 180, 9) }))
      .toBe(false);
    expect([
      recorder.acceptFrame({ recordingId, data: stillBase64(640, 360, 9) }),
      recorder.acceptFrame({ recordingId, data: Buffer.from("plain text").toString("base64") }),
      recorder.acceptFrame({ recordingId, data: "not base64!" }),
      recorder.acceptFrame({ recordingId, data: stillBase64(320, 180, 2) }),
    ]).toEqual([true, true, true, true]);

    const video = await recorder.videoStop({ tabId });
    expect(video).toMatchObject({ tabId, kind: "video", path: started.path });
    expect(video.sizeBytes).toBe((await readFile(video.path)).length);
    // The trace still records, so Chrome keeps streaming.
    expect(calls).toHaveLength(1);
    expect([recorder.isActive(tabId, "trace"), recorder.isActive(tabId, "video")]).toEqual([true, false]);
    recorder.acceptFrame({ recordingId, data: stillBase64(320, 180, 3) });

    const trace = await recorder.traceStop({ tabId });
    expect(calls).toEqual([["start", { tabId, recordingId }], ["stop", { tabId, recordingId }]]);
    expect(trace.files.map((file) => path.basename(file.path))).toEqual(["trace.json", "trace.webm"]);
    expect(trace.totalBytes).toBe(trace.files.reduce((sum, file) => sum + file.sizeBytes, 0));
    const document = JSON.parse(await readFile(trace.files[0]!.path, "utf8")) as Record<string, unknown>;
    expect(document).toMatchObject({ format: "mcp-v3-personal-trace", version: 1, tabId, video: "trace.webm",
      framesTruncated: false, actionsDropped: 0 });
    expect((document.actions as Array<Record<string, unknown>>).map(({ atMs: _at, durationMs: _ms, ...rest }) => rest))
      .toEqual([
        { operation: "click", outcome: "success", target: { ref: "p-1", element: "Pintar" } },
        { operation: "type", outcome: "error", errorCode: "ACTION_REQUIRES_CONFIRMATION", target: { ref: "p-2" } },
        { operation: "navigate", outcome: "success", target: { url: "https://example.com/a/b" } },
      ]);
    expect(JSON.stringify(document)).not.toContain("segredo");
    expect(await readdir(path.join(root, "recordings"))).toEqual([]);
    expect([recorder.isActive(tabId, "trace"), recorder.isActive(tabId, "video")]).toEqual([false, false]);
  });

  it("keeps a recording that Chrome refused to stop and resumes an interrupted one at its size", async () => {
    const root = await temporaryRoot();
    const calls: Array<[string, Record<string, unknown>]> = [];
    let refuse = true;
    const recorder = new PersonalBrowserRecorder(root, {
      start: async (input) => { calls.push(["start", input]); },
      stop: async (input) => {
        calls.push(["stop", input]);
        if (refuse) throw new AppError("EXECUTION_STATE_INVALID", "shared debugger");
      },
    });
    const tabId = "personal:7";
    await recorder.videoStart({ tabId, width: 320, height: 180 });
    await expect(recorder.videoStart({ tabId })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    const recordingId = String(calls[0]![1].recordingId);
    expect(calls[0]).toEqual(["start", { tabId, recordingId, width: 320, height: 180 }]);
    recorder.acceptFrame({ recordingId, data: stillBase64(320, 180, 1) });
    await expect(recorder.videoStop({ tabId })).rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
    expect(recorder.isActive(tabId, "video")).toBe(true);

    // The user stopped debugging the tab: the frames so far still make the video,
    // and a trace started now resumes Chrome's recording under the same id.
    recorder.ended({ recordingId });
    expect(recorder.acceptFrame({ recordingId, data: stillBase64(320, 180, 5) })).toBe(false);
    await recorder.traceStart({ tabId });
    expect(calls.at(-1)).toEqual(["start", { tabId, recordingId, width: 320, height: 180 }]);
    refuse = false;
    await expect(recorder.videoStop({ tabId })).resolves.toMatchObject({ kind: "video" });
    expect(calls.filter(([kind]) => kind === "stop")).toHaveLength(1);
    // Chrome sent nothing for the trace; a disconnected extension cannot stop it either.
    recorder.disconnect();
    const trace = await recorder.traceStop({ tabId });
    expect(trace.files.map((file) => path.basename(file.path))).toEqual(["trace.json", "trace.webm"]);
    expect(calls.filter(([kind]) => kind === "stop")).toHaveLength(1);

    // No frame at all: the video says why instead of writing an empty file.
    await recorder.videoStart({ tabId });
    await expect(recorder.videoStop({ tabId })).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_UNSUPPORTED" });
    expect(recorder.isActive(tabId, "video")).toBe(false);
    expect(await readdir(path.join(root, "recordings"))).toEqual([]);
    await expect(recorder.traceStop({ tabId })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("releases staged frames when Chrome refuses to start and when the bridge closes", async () => {
    const root = await temporaryRoot();
    let fail = true;
    const recorder = new PersonalBrowserRecorder(root, {
      start: async () => {
        if (fail) throw new AppError("BROWSER_CAPABILITY_UNSUPPORTED", "no debugger");
      },
      stop: async () => undefined,
    });
    await expect(recorder.traceStart({ tabId: "personal:7" })).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_UNSUPPORTED" });
    expect(recorder.isActive("personal:7", "trace")).toBe(false);
    expect(await readdir(path.join(root, "recordings"))).toEqual([]);
    fail = false;
    await recorder.traceStart({ tabId: "personal:7" });
    expect(await readdir(path.join(root, "recordings"))).toHaveLength(1);
    await recorder.close();
    expect(await readdir(path.join(root, "recordings"))).toEqual([]);
    await recorder.sweep();
    await expect(readdir(path.join(root, "recordings"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
