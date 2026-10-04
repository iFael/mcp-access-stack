import {
  UpdateControlInputError,
  parseUpdateGetRunArguments,
  parseUpdateListRunsArguments,
  parseUpdateWaitEventsArguments,
  type UpdateGetRunArguments,
  type UpdateListRunsArguments,
  type UpdateWaitEventsArguments,
} from "@mcp-access-stack/update-control-contract";

export const ORACLE_CHANNEL_CONNECT_PATH = "/_internal/oracle-channel";
export const ORACLE_CHANNEL_RPC_PATH = "/_internal/rpc";
export const ORACLE_CHANNEL_ORIGIN = "https://mcp-v3-update-control-oracle.invalid";
export const ORACLE_CHANNEL_SCOPE = "oracle-release-orchestrator-v1";
export const ORACLE_CHANNEL_MAX_FRAME_BYTES = 512 * 1024;
export const ORACLE_CHANNEL_MAX_IN_FLIGHT = 32;
export const ORACLE_CHANNEL_BASE_RPC_TIMEOUT_MS = 5_000;
export const ORACLE_CHANNEL_WAIT_RPC_GRACE_MS = 5_000;
export const ORACLE_CHANNEL_MAX_RPC_TIMEOUT_MS = 20_000;

const MAX_INTERNAL_BODY_BYTES = 4 * 1024;
const MAX_URL_LENGTH = 8 * 1024;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_BYTES = 16 * 1024;
const TOKEN_MIN_LENGTH = 32;
const TOKEN_MAX_LENGTH = 2_048;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface OracleChannelDurableState {
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  waitUntil(promise: Promise<unknown>): void;
}

export interface OracleChannelEnvironment {
  readonly UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN?: string;
}

export interface OracleChannelNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface OracleChannelDependencies {
  readonly webSocketPairFactory?: () => { client: WebSocket; server: WebSocket };
  readonly upgradeResponseFactory?: (client: WebSocket) => Response;
}

type ReadCommand =
  | { readonly method: "list_runs"; readonly arguments: UpdateListRunsArguments }
  | { readonly method: "get_run"; readonly arguments: UpdateGetRunArguments }
  | { readonly method: "wait_events"; readonly arguments: UpdateWaitEventsArguments };
type OracleRpcResponse =
  | {
      readonly version: 1;
      readonly type: "response";
      readonly requestId: string;
      readonly outcome: "success";
      readonly result: unknown;
    }
  | {
      readonly version: 1;
      readonly type: "response";
      readonly requestId: string;
      readonly outcome: "error";
      readonly errorCode: "RUN_NOT_FOUND" | "UPDATE_ORCHESTRATOR_UNAVAILABLE";
    };

interface PendingRpc {
  readonly requestId: string;
  readonly socket: WebSocket;
  readonly resolve: (response: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class UpdateControlOracleChannel {
  private readonly pending = new Map<string, PendingRpc>();
  private readonly pairFactory: () => { client: WebSocket; server: WebSocket };
  private readonly upgradeResponseFactory: (client: WebSocket) => Response;

  constructor(
    private readonly state: OracleChannelDurableState,
    private readonly env: OracleChannelEnvironment,
    dependencies: OracleChannelDependencies = {},
  ) {
    this.pairFactory = dependencies.webSocketPairFactory ?? createWebSocketPair;
    this.upgradeResponseFactory = dependencies.upgradeResponseFactory ?? createUpgradeResponse;
  }

  async fetch(request: Request): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    if (url.pathname === ORACLE_CHANNEL_CONNECT_PATH) {
      return this.connectOracle(request, url);
    }
    if (url.pathname === ORACLE_CHANNEL_RPC_PATH) {
      return this.handleRpc(request, url);
    }
    return jsonResponse({ error: "not_found" }, 404);
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    this.state.waitUntil(Promise.resolve().then(() => {
      if (typeof message !== "string") {
        this.protocolViolation(socket, 1003, "text frames required");
        return;
      }
      if (utf8ByteLength(message) > ORACLE_CHANNEL_MAX_FRAME_BYTES) {
        this.protocolViolation(socket, 1009, "frame too large");
        return;
      }
      const active = this.state.getWebSockets(ORACLE_CHANNEL_SCOPE);
      if (!active.includes(socket)) {
        this.protocolViolation(socket, 1008, "inactive Oracle connection");
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(message) as unknown;
      } catch {
        this.protocolViolation(socket, 1008, "invalid response frame");
        return;
      }
      const frame = parseOracleRpcResponse(value);
      if (!frame) {
        this.protocolViolation(socket, 1008, "invalid response frame");
        return;
      }
      const pending = this.pending.get(frame.requestId);
      if (!pending || pending.socket !== socket) {
        this.protocolViolation(socket, 1008, "unexpected response id");
        return;
      }
      if (frame.outcome === "success") {
        const responseBody = JSON.stringify({ result: frame.result });
        if (utf8ByteLength(responseBody) > ORACLE_CHANNEL_MAX_FRAME_BYTES) {
          this.finish(pending, jsonResponse({ error: "invalid_oracle_response" }, 502));
          return;
        }
        this.finish(pending, jsonResponse({ result: frame.result }));
        return;
      }
      this.finish(
        pending,
        jsonResponse(
          { error: frame.errorCode },
          frame.errorCode === "RUN_NOT_FOUND" ? 404 : 503,
        ),
      );
    }).catch(() => {
      this.protocolViolation(socket, 1008, "invalid response frame");
    }));
  }

  webSocketClose(socket: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    this.failPendingForSocket(socket);
  }

  webSocketError(socket: WebSocket, _error: unknown): void {
    this.failPendingForSocket(socket);
  }

  private async connectOracle(request: Request, url: URL): Promise<Response> {
    if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET" });
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        url.pathname !== ORACLE_CHANNEL_CONNECT_PATH) {
      return jsonResponse({ error: "not_found" }, 404);
    }
    if (url.href.length > MAX_URL_LENGTH || !headersWithinBounds(request.headers)) {
      return jsonResponse({ error: "request_too_large" }, 431);
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_required" }, 426);
    }
    if (request.headers.get("origin") !== ORACLE_CHANNEL_ORIGIN) {
      return jsonResponse({ error: "invalid_origin" }, 403);
    }

    const expected = this.env.UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN;
    if (typeof expected !== "string" || expected.length < TOKEN_MIN_LENGTH ||
        expected.length > TOKEN_MAX_LENGTH || /[\r\n\0]/u.test(expected)) {
      return jsonResponse({ error: "oracle_channel_not_configured" }, 503);
    }
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || authorization.length > TOKEN_MAX_LENGTH + 7) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const supplied = authorization.slice("Bearer ".length);
    if (!supplied || /[\r\n\0]/u.test(supplied) ||
        !(await constantTimeTextEquals(expected, supplied))) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }

    try {
      for (const previous of this.state.getWebSockets(ORACLE_CHANNEL_SCOPE)) {
        this.failPendingForSocket(previous);
        previous.close(1012, "Oracle connection replaced");
      }
      const pair = this.pairFactory();
      this.state.acceptWebSocket(pair.server, [ORACLE_CHANNEL_SCOPE]);
      return this.upgradeResponseFactory(pair.client);
    } catch {
      return jsonResponse({ error: "oracle_channel_unavailable" }, 503);
    }
  }

  private async handleRpc(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST" });
    if (url.search || url.hash || url.pathname !== ORACLE_CHANNEL_RPC_PATH) {
      return jsonResponse({ error: "not_found" }, 404);
    }
    if ((request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      return jsonResponse({ error: "invalid_request" }, 415);
    }
    let body: string;
    try {
      body = await readBoundedText(request, MAX_INTERNAL_BODY_BYTES);
    } catch (error) {
      return jsonResponse(
        { error: error instanceof BodyTooLargeError ? "request_too_large" : "invalid_request" },
        error instanceof BodyTooLargeError ? 413 : 400,
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    let command: ReadCommand;
    try {
      command = parseReadCommand(value);
    } catch (error) {
      if (error instanceof UpdateControlInputError || error instanceof InvalidRpcCommandError) {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    const socket = this.getActiveOracleSocket();
    if (!socket) return jsonResponse({ error: "oracle_unavailable" }, 503);
    if (this.pending.size >= ORACLE_CHANNEL_MAX_IN_FLIGHT) {
      return jsonResponse({ error: "oracle_channel_busy" }, 503);
    }

    const requestId = crypto.randomUUID();
    if (!REQUEST_ID_PATTERN.test(requestId) || this.pending.has(requestId)) {
      return jsonResponse({ error: "oracle_channel_unavailable" }, 503);
    }
    const frame = JSON.stringify({
      version: 1,
      type: "request",
      requestId,
      method: command.method,
      arguments: command.arguments,
    });
    if (utf8ByteLength(frame) > ORACLE_CHANNEL_MAX_FRAME_BYTES) {
      return jsonResponse({ error: "request_too_large" }, 413);
    }

    return new Promise<Response>((resolve) => {
      const pending: PendingRpc = {
        requestId,
        socket,
        resolve,
        timer: setTimeout(() => {
          this.finish(pending, jsonResponse({ error: "transport_timeout" }, 504));
        }, rpcTimeoutFor(command)),
      };
      this.pending.set(requestId, pending);
      try {
        socket.send(frame);
      } catch {
        this.finish(pending, jsonResponse({ error: "oracle_unavailable" }, 503));
      }
    });
  }

  private getActiveOracleSocket(): WebSocket | null {
    const sockets = this.state.getWebSockets(ORACLE_CHANNEL_SCOPE)
      .filter((socket) => socket.readyState === 1);
    if (sockets.length !== 1) {
      if (sockets.length > 1) {
        for (const socket of sockets) this.protocolViolation(socket, 1008, "multiple Oracle connections");
      }
      return null;
    }
    return sockets[0] ?? null;
  }

  private finish(pending: PendingRpc, response: Response): void {
    if (this.pending.get(pending.requestId) !== pending) return;
    this.pending.delete(pending.requestId);
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private failPendingForSocket(socket: WebSocket): void {
    for (const pending of this.pending.values()) {
      if (pending.socket === socket) {
        this.finish(pending, jsonResponse({ error: "oracle_unavailable" }, 503));
      }
    }
  }

  private protocolViolation(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // A closed socket is already unavailable.
    }
    this.failPendingForSocket(socket);
  }
}

function parseReadCommand(value: unknown): ReadCommand {
  if (!isRecord(value) || !hasExactKeys(value, ["method", "arguments"]) ||
      typeof value.method !== "string" || !isRecord(value.arguments)) {
    throw new InvalidRpcCommandError();
  }
  switch (value.method) {
    case "list_runs":
      return {
        method: value.method,
        arguments: parseUpdateListRunsArguments(value.arguments),
      };
    case "get_run":
      return {
        method: value.method,
        arguments: parseUpdateGetRunArguments(value.arguments),
      };
    case "wait_events":
      return {
        method: value.method,
        arguments: parseUpdateWaitEventsArguments(value.arguments),
      };
    default:
      throw new InvalidRpcCommandError();
  }
}

function parseOracleRpcResponse(value: unknown): OracleRpcResponse | null {
  if (!isRecord(value) || value.version !== 1 || value.type !== "response" ||
      typeof value.requestId !== "string" || !REQUEST_ID_PATTERN.test(value.requestId) ||
      (value.outcome !== "success" && value.outcome !== "error")) return null;
  if (value.outcome === "success" && hasExactKeys(value, ["version", "type", "requestId", "outcome", "result"])) {
    return value as OracleRpcResponse;
  }
  if (value.outcome === "error" && hasExactKeys(value, ["version", "type", "requestId", "outcome", "errorCode"]) &&
      (value.errorCode === "RUN_NOT_FOUND" || value.errorCode === "UPDATE_ORCHESTRATOR_UNAVAILABLE")) {
    return value as OracleRpcResponse;
  }
  return null;
}

function rpcTimeoutFor(command: ReadCommand): number {
  if (command.method !== "wait_events") return ORACLE_CHANNEL_BASE_RPC_TIMEOUT_MS;
  return Math.min(
    ORACLE_CHANNEL_MAX_RPC_TIMEOUT_MS,
    (command.arguments.timeoutSeconds ?? 10) * 1_000 + ORACLE_CHANNEL_WAIT_RPC_GRACE_MS,
  );
}

function createWebSocketPair(): { client: WebSocket; server: WebSocket } {
  const Pair = (globalThis as unknown as {
    WebSocketPair?: new () => { 0: WebSocket; 1: WebSocket };
  }).WebSocketPair;
  if (!Pair) throw new Error("WebSocketPair is unavailable in this Worker runtime.");
  const pair = new Pair();
  return { client: pair[0], server: pair[1] };
}

function createUpgradeResponse(client: WebSocket): Response {
  const init = { status: 101, webSocket: client } as unknown as ResponseInit;
  return new Response(null, init);
}

async function constantTimeTextEquals(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

function headersWithinBounds(headers: Headers): boolean {
  let count = 0;
  let bytes = 0;
  headers.forEach((value, name) => {
    count += 1;
    bytes += utf8ByteLength(name) + utf8ByteLength(value);
  });
  return count <= MAX_HEADER_COUNT && bytes <= MAX_HEADER_BYTES;
}

async function readBoundedText(request: Request, maximumBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await request.body?.cancel();
    throw new BodyTooLargeError();
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const encoded = JSON.stringify(body);
  return new Response(encoded, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const normalized = [...expected].sort();
  return actual.length === normalized.length && actual.every((key, index) => key === normalized[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

class BodyTooLargeError extends Error {}
class InvalidRpcCommandError extends Error {}
