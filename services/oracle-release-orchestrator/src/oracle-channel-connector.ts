import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import {
  UpdateControlInputError,
  parseUpdateGetRunArguments,
  parseUpdateListRunsArguments,
  parseUpdateWaitEventsArguments,
  type UpdateGetRunArguments,
  type UpdateListRunsArguments,
  type UpdateWaitEventsArguments,
} from "@mcp-access-stack/update-control-contract";
import {
  ORACLE_CHANNEL_CONNECT_PATH,
  ORACLE_CHANNEL_MAX_ARGUMENT_BYTES,
  ORACLE_CHANNEL_MAX_FRAME_BYTES,
  ORACLE_CHANNEL_MAX_IN_FLIGHT,
  ORACLE_CHANNEL_MAX_RPC_TIMEOUT_MS,
  ORACLE_CHANNEL_ORIGIN,
  type OracleChannelReadCommand,
  type OracleChannelRequestFrame,
  type OracleChannelResponseFrame,
} from "@mcp-access-stack/update-control-contract";

export {
  ORACLE_CHANNEL_CONNECT_PATH,
  ORACLE_CHANNEL_MAX_ARGUMENT_BYTES,
  ORACLE_CHANNEL_MAX_FRAME_BYTES,
  ORACLE_CHANNEL_MAX_IN_FLIGHT,
  ORACLE_CHANNEL_MAX_RPC_TIMEOUT_MS,
  ORACLE_CHANNEL_ORIGIN,
} from "@mcp-access-stack/update-control-contract";

export const ORACLE_READ_API_BASE_URL = "http://127.0.0.1:9381";
export const ORACLE_READ_API_MAX_RESPONSE_BYTES = 256 * 1024;
export const ORACLE_CHANNEL_HANDSHAKE_TIMEOUT_MS = 10_000;
export const ORACLE_CHANNEL_READ_API_TIMEOUT_MS = 4_000;
export const ORACLE_CHANNEL_WAIT_READ_API_GRACE_MS = 3_000;
export const ORACLE_CHANNEL_MAX_WAIT_READ_API_TIMEOUT_MS = 18_000;
export const ORACLE_CHANNEL_RECONNECT_BASE_MS = 1_000;
export const ORACLE_CHANNEL_RECONNECT_MAX_MS = 60_000;
export const ORACLE_CHANNEL_STABLE_CONNECTION_MS = 30_000;

const API_PREFIX = "/internal/v1/runs";
const TOKEN_MIN_LENGTH = 32;
const TOKEN_MAX_LENGTH = 2_048;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface OracleChannelConnectorConfig {
  readonly channelUrl: URL;
  readonly channelToken: string;
  readonly orchestratorToken: string;
}

export interface OracleChannelConnectorDependencies {
  readonly socketFactory?: (url: URL, options: ClientOptions) => WebSocket;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly monotonicNow?: () => number;
}

interface PendingRead {
  readonly socket: WebSocket;
  readonly controller: AbortController;
}

class RunNotFoundError extends Error {
  constructor() {
    super("run not found");
    this.name = "RunNotFoundError";
  }
}

export function parseOracleChannelConnectorConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): OracleChannelConnectorConfig {
  const channelUrlValue = environment.UPDATE_CONTROL_ORACLE_CHANNEL_URL?.trim();
  if (!channelUrlValue) throw new Error("UPDATE_CONTROL_ORACLE_CHANNEL_URL is required.");
  let channelUrl: URL;
  try {
    channelUrl = new URL(channelUrlValue);
  } catch {
    throw new Error("UPDATE_CONTROL_ORACLE_CHANNEL_URL is invalid.");
  }
  if (channelUrl.protocol !== "wss:" ||
      !channelUrl.hostname.toLowerCase().endsWith(".workers.dev") ||
      (channelUrl.port !== "" && channelUrl.port !== "443") ||
      channelUrl.username !== "" || channelUrl.password !== "" ||
      channelUrl.pathname !== ORACLE_CHANNEL_CONNECT_PATH ||
      channelUrl.search !== "" || channelUrl.hash !== "") {
    throw new Error("UPDATE_CONTROL_ORACLE_CHANNEL_URL must be the fixed WSS workers.dev channel endpoint.");
  }

  const channelToken = readCredentialFromEnvironment(
    environment,
    "UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE",
  );
  const orchestratorToken = readCredentialFromEnvironment(
    environment,
    "UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE",
  );
  return { channelUrl, channelToken, orchestratorToken };
}

function readCredentialFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  variable: "UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE" | "UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE",
): string {
  const filePath = environment[variable]?.trim();
  if (!filePath || !isAbsolute(filePath)) {
    throw new Error(`${variable} must reference an absolute protected credential file.`);
  }
  try {
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() ||
        (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) {
      throw new Error("credential file permissions are invalid");
    }
    const raw = readFileSync(filePath, "utf8");
    const token = raw.endsWith("\r\n") ? raw.slice(0, -2) : raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (token.length < TOKEN_MIN_LENGTH || token.length > TOKEN_MAX_LENGTH ||
        /[\r\n\0]/u.test(token)) {
      throw new Error("credential contents are invalid");
    }
    return token;
  } catch {
    throw new Error(`${variable} is unavailable or invalid.`);
  }
}

export function computeOracleConnectorReconnectDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const boundedAttempt = Number.isFinite(attempt) ? Math.max(0, Math.min(Math.floor(attempt), 30)) : 0;
  const exponential = Math.min(
    ORACLE_CHANNEL_RECONNECT_MAX_MS,
    ORACLE_CHANNEL_RECONNECT_BASE_MS * (2 ** boundedAttempt),
  );
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
  return Math.min(
    ORACLE_CHANNEL_RECONNECT_MAX_MS,
    Math.round(exponential * (0.5 + normalized)),
  );
}

export function oracleReadApiDeadlineMs(command: OracleChannelReadCommand): number {
  if (command.method !== "wait_events") return ORACLE_CHANNEL_READ_API_TIMEOUT_MS;
  const waitMs = (command.arguments.timeoutSeconds ?? 10) * 1_000;
  return Math.min(
    ORACLE_CHANNEL_MAX_WAIT_READ_API_TIMEOUT_MS,
    Math.max(ORACLE_CHANNEL_READ_API_TIMEOUT_MS, waitMs + ORACLE_CHANNEL_WAIT_READ_API_GRACE_MS),
  );
}

export class OracleChannelConnector {
  private readonly socketFactory: (url: URL, options: ClientOptions) => WebSocket;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly monotonicNow: () => number;
  private readonly inFlight = new Map<string, PendingRead>();
  private activeSocket: WebSocket | undefined;
  private running = false;

  constructor(
    private readonly config: OracleChannelConnectorConfig,
    dependencies: OracleChannelConnectorDependencies = {},
  ) {
    validateConnectorCredentials(config);
    this.socketFactory = dependencies.socketFactory ?? ((url, options) => new WebSocket(url, options));
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.sleepImpl = dependencies.sleep ?? sleep;
    this.random = dependencies.random ?? Math.random;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("Oracle channel connector is already running.");
    this.running = true;
    let attempt = 0;
    try {
      while (!signal.aborted) {
        let connectionDuration = 0;
        try {
          connectionDuration = await this.connectOnce(signal);
        } catch {
          connectionDuration = 0;
        }
        if (signal.aborted) break;
        if (connectionDuration >= ORACLE_CHANNEL_STABLE_CONNECTION_MS) attempt = 0;
        const delayMs = computeOracleConnectorReconnectDelay(attempt, this.random);
        if (connectionDuration < ORACLE_CHANNEL_STABLE_CONNECTION_MS) attempt = Math.min(attempt + 1, 30);
        await this.sleepImpl(delayMs, signal);
      }
    } finally {
      this.closeActiveSocket();
      this.running = false;
    }
  }

  private async connectOnce(signal: AbortSignal): Promise<number> {
    const options: ClientOptions = {
      headers: { authorization: `Bearer ${this.config.channelToken}` },
      origin: ORACLE_CHANNEL_ORIGIN,
      handshakeTimeout: ORACLE_CHANNEL_HANDSHAKE_TIMEOUT_MS,
      maxPayload: ORACLE_CHANNEL_MAX_FRAME_BYTES,
      perMessageDeflate: false,
      rejectUnauthorized: true,
      followRedirects: false,
    };
    const socket = this.socketFactory(this.config.channelUrl, options);
    this.activeSocket = socket;
    const onMessage = (data: RawData, isBinary: boolean) => {
      this.onMessage(socket, data, isBinary);
    };

    return await new Promise<number>((resolve) => {
      let openedAt: number | undefined;
      let settled = false;
      let forceCloseTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (forceCloseTimer !== undefined) clearTimeout(forceCloseTimer);
        socket.off("open", onOpen);
        socket.off("close", onClose);
        socket.off("error", onError);
        socket.off("message", onMessage);
        signal.removeEventListener("abort", onAbort);
        this.abortReadsForSocket(socket);
        if (this.activeSocket === socket) this.activeSocket = undefined;
      };
      const settle = () => {
        if (settled) return;
        settled = true;
        const duration = openedAt === undefined ? 0 : Math.max(0, this.monotonicNow() - openedAt);
        cleanup();
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1001, "connector reconnect");
        }
        resolve(duration);
      };
      const onOpen = () => {
        if (signal.aborted) {
          onAbort();
          return;
        }
        openedAt = this.monotonicNow();
      };
      const onClose = () => settle();
      const onError = () => settle();
      const onAbort = () => {
        this.abortReadsForSocket(socket);
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1001, "service shutdown");
          forceCloseTimer = setTimeout(() => {
            socket.terminate();
            settle();
          }, 1_000);
          forceCloseTimer.unref?.();
          return;
        }
        socket.terminate();
        settle();
      };

      socket.on("open", onOpen);
      socket.on("close", onClose);
      socket.on("error", onError);
      socket.on("message", onMessage);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private onMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.protocolViolation(socket, 1003, "text frames required");
      return;
    }
    const raw = rawDataToBuffer(data);
    if (!raw || raw.byteLength > ORACLE_CHANNEL_MAX_FRAME_BYTES) {
      this.protocolViolation(socket, 1009, "frame too large");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw.toString("utf8")) as unknown;
    } catch {
      this.protocolViolation(socket, 1008, "invalid request frame");
      return;
    }
    const frame = parseRequestFrame(value);
    if (!frame) {
      this.protocolViolation(socket, 1008, "invalid request frame");
      return;
    }
    if (this.inFlight.has(frame.requestId)) {
      this.protocolViolation(socket, 1008, "duplicate request id");
      return;
    }
    if (this.inFlight.size >= ORACLE_CHANNEL_MAX_IN_FLIGHT) {
      this.sendFrame(socket, {
        version: 1,
        type: "response",
        requestId: frame.requestId,
        outcome: "error",
        errorCode: "UPDATE_ORCHESTRATOR_UNAVAILABLE",
      });
      return;
    }

    const pending: PendingRead = { socket, controller: new AbortController() };
    this.inFlight.set(frame.requestId, pending);
    void this.executeRead(frame, pending).catch(() => {
      this.sendErrorIfCurrent(frame.requestId, pending);
    });
  }

  private async executeRead(frame: OracleChannelRequestFrame, pending: PendingRead): Promise<void> {
    const timer = setTimeout(
      () => pending.controller.abort(new Error("local read API deadline exceeded")),
      oracleReadApiDeadlineMs(frame),
    );
    try {
      const url = buildReadApiUrl(frame);
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.orchestratorToken}`,
          accept: "application/json",
          "cache-control": "no-store",
        },
        redirect: "error",
        signal: pending.controller.signal,
      });
      const body = await readBoundedJson(response);
      if (response.status === 404) {
        if (isExactRunNotFound(body) && frame.method !== "list_runs") throw new RunNotFoundError();
        throw new Error("read API returned an unexpected not-found response");
      }
      if (!response.ok || !isReadResult(frame, body)) {
        throw new Error("read API response is unavailable or invalid");
      }
      this.sendResponse(frame.requestId, pending, {
        version: 1,
        type: "response",
        requestId: frame.requestId,
        outcome: "success",
        result: body,
      });
    } catch (error) {
      const response: OracleChannelResponseFrame = {
        version: 1,
        type: "response",
        requestId: frame.requestId,
        outcome: "error",
        errorCode: error instanceof RunNotFoundError
          ? "RUN_NOT_FOUND"
          : "UPDATE_ORCHESTRATOR_UNAVAILABLE",
      };
      this.sendResponse(frame.requestId, pending, response);
    } finally {
      clearTimeout(timer);
      if (this.inFlight.get(frame.requestId) === pending) this.inFlight.delete(frame.requestId);
    }
  }

  private sendErrorIfCurrent(requestId: string, pending: PendingRead): void {
    this.sendResponse(requestId, pending, {
      version: 1,
      type: "response",
      requestId,
      outcome: "error",
      errorCode: "UPDATE_ORCHESTRATOR_UNAVAILABLE",
    });
  }

  private sendResponse(
    requestId: string,
    pending: PendingRead,
    response: OracleChannelResponseFrame,
  ): void {
    if (this.inFlight.get(requestId) !== pending ||
        this.activeSocket !== pending.socket ||
        pending.socket.readyState !== WebSocket.OPEN) return;
    this.sendFrame(pending.socket, response);
  }

  private sendFrame(socket: WebSocket, frame: OracleChannelResponseFrame): void {
    if (socket !== this.activeSocket || socket.readyState !== WebSocket.OPEN) return;
    const encoded = JSON.stringify(frame);
    if (Buffer.byteLength(encoded, "utf8") > ORACLE_CHANNEL_MAX_FRAME_BYTES) {
      this.protocolViolation(socket, 1009, "response frame too large");
      return;
    }
    try {
      socket.send(encoded);
    } catch {
      this.protocolViolation(socket, 1011, "response send failed");
    }
  }

  private protocolViolation(socket: WebSocket, code: 1003 | 1008 | 1009 | 1011, reason: string): void {
    this.abortReadsForSocket(socket);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason);
    }
  }

  private abortReadsForSocket(socket: WebSocket): void {
    for (const [requestId, pending] of this.inFlight) {
      if (pending.socket === socket) {
        this.inFlight.delete(requestId);
        pending.controller.abort(new Error("Oracle channel connection closed"));
      }
    }
  }

  private closeActiveSocket(): void {
    const socket = this.activeSocket;
    if (!socket) return;
    this.abortReadsForSocket(socket);
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1001, "service shutdown");
    }
    this.activeSocket = undefined;
  }
}

function validateConnectorCredentials(config: OracleChannelConnectorConfig): void {
  if (!(config.channelUrl instanceof URL) || config.channelUrl.protocol !== "wss:" ||
      !config.channelUrl.hostname.toLowerCase().endsWith(".workers.dev") ||
      config.channelUrl.pathname !== ORACLE_CHANNEL_CONNECT_PATH ||
      config.channelUrl.username || config.channelUrl.password ||
      config.channelUrl.search || config.channelUrl.hash ||
      (config.channelUrl.port !== "" && config.channelUrl.port !== "443")) {
    throw new Error("Oracle channel URL must be the fixed WSS workers.dev endpoint.");
  }
  validateToken(config.channelToken, "Oracle channel token");
  validateToken(config.orchestratorToken, "Oracle read API token");
}

function validateToken(value: string, label: string): void {
  if (typeof value !== "string" || value.length < TOKEN_MIN_LENGTH ||
      value.length > TOKEN_MAX_LENGTH || /[\r\n\0]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function parseRequestFrame(value: unknown): OracleChannelRequestFrame | null {
  if (!isRecord(value) ||
      !hasExactKeys(value, ["version", "type", "requestId", "method", "arguments"]) ||
      value.version !== 1 || value.type !== "request" ||
      typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId) ||
      !isRecord(value.arguments)) return null;
  let command: OracleChannelReadCommand;
  try {
    switch (value.method) {
      case "list_runs":
        command = { method: "list_runs", arguments: parseUpdateListRunsArguments(value.arguments) };
        break;
      case "get_run":
        command = { method: "get_run", arguments: parseUpdateGetRunArguments(value.arguments) };
        break;
      case "wait_events":
        command = { method: "wait_events", arguments: parseUpdateWaitEventsArguments(value.arguments) };
        break;
      default:
        return null;
    }
  } catch (error) {
    if (error instanceof UpdateControlInputError) return null;
    return null;
  }
  if (Buffer.byteLength(JSON.stringify(value.arguments), "utf8") > ORACLE_CHANNEL_MAX_ARGUMENT_BYTES) {
    return null;
  }
  return {
    version: 1,
    type: "request",
    requestId: value.requestId,
    ...command,
  };
}

function buildReadApiUrl(frame: OracleChannelRequestFrame): URL {
  const url = new URL(API_PREFIX, ORACLE_READ_API_BASE_URL);
  const params = new URLSearchParams();
  switch (frame.method) {
    case "list_runs":
      params.set("limit", String(frame.arguments.limit));
      if (frame.arguments.cursor !== undefined) params.set("cursor", frame.arguments.cursor);
      break;
    case "get_run":
      url.pathname += `/${encodeURIComponent(frame.arguments.runId)}`;
      params.set("evidenceLimit", String(frame.arguments.evidenceLimit));
      if (frame.arguments.evidenceCursor !== undefined) {
        params.set("evidenceCursor", frame.arguments.evidenceCursor);
      }
      break;
    case "wait_events":
      url.pathname += `/${encodeURIComponent(frame.arguments.runId)}/events`;
      params.set("afterSeq", String(frame.arguments.afterSeq));
      params.set("limit", String(frame.arguments.limit));
      params.set("waitMs", String((frame.arguments.timeoutSeconds ?? 10) * 1_000));
      break;
  }
  url.search = params.toString();
  return url;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    await response.body?.cancel();
    throw new Error("read API content type is invalid");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null &&
      (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > ORACLE_READ_API_MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new Error("read API response is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("read API response body is missing");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > ORACLE_READ_API_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("read API response is too large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as unknown;
}

function isExactRunNotFound(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["error"]) && value.error === "run_not_found";
}

function isReadResult(frame: OracleChannelRequestFrame, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (frame.method) {
    case "list_runs":
      return hasExactKeys(value, ["runs", "nextCursor", "hasMore"]) &&
        Array.isArray(value.runs) && value.runs.length <= 25 &&
        (value.nextCursor === null || isBoundedCursor(value.nextCursor)) &&
        typeof value.hasMore === "boolean";
    case "get_run":
      return hasExactKeys(value, ["run", "evidence", "nextEvidenceCursor", "hasMoreEvidence"]) &&
        isRecord(value.run) && value.run.runId === frame.arguments.runId &&
        Array.isArray(value.evidence) && value.evidence.length <= 100 &&
        (value.nextEvidenceCursor === null || isBoundedCursor(value.nextEvidenceCursor)) &&
        typeof value.hasMoreEvidence === "boolean";
    case "wait_events": {
      if (!(hasExactKeys(value, ["outcome", "runId", "afterSeq", "events", "currentSeq"]) ||
            hasExactKeys(value, ["outcome", "runId", "afterSeq", "events", "currentSeq", "hasMore"])) ||
          (Object.hasOwn(value, "hasMore") && typeof value.hasMore !== "boolean") ||
          (value.outcome !== "events" && value.outcome !== "timeout") ||
          value.runId !== frame.arguments.runId ||
          value.afterSeq !== frame.arguments.afterSeq ||
          !Number.isSafeInteger(value.currentSeq) ||
          (value.currentSeq as number) < frame.arguments.afterSeq ||
          !Array.isArray(value.events) || value.events.length > 100 ||
          (value.outcome === "timeout" && value.events.length !== 0) ||
          (value.outcome === "events" && value.events.length === 0)) return false;
      let previousSeq = frame.arguments.afterSeq;
      for (const event of value.events) {
        if (!isRecord(event) || event.runId !== frame.arguments.runId ||
            !Number.isSafeInteger(event.seq) || (event.seq as number) <= previousSeq) return false;
        previousSeq = event.seq as number;
      }
      return previousSeq <= (value.currentSeq as number);
    }
  }
}

function isBoundedCursor(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    /^[A-Za-z0-9_-]+$/u.test(value);
}

function rawDataToBuffer(value: RawData): Buffer | null {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (Array.isArray(value)) {
    const length = value.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (length > ORACLE_CHANNEL_MAX_FRAME_BYTES) return null;
    return Buffer.concat(value, length);
  }
  return null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
