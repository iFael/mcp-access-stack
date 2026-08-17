import {
  EDGE_PROTOCOL_VERSION,
  MAX_EDGE_REQUEST_BODY_BYTES,
  MAX_EDGE_RESPONSE_BODY_BYTES,
  isAllowedEdgeRequest,
  parseEdgeToConnectorMessage,
  utf8ByteLength,
  type EdgeHttpResponseMessage,
} from "@mcp-access-stack/edge-protocol";
import { AppError } from "@vs-code-gpt/shared";
import WebSocket, { type RawData } from "ws";

const DEFAULT_MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  "allow",
  "cache-control",
  "content-type",
  "location",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "retry-after",
  "www-authenticate",
]);

export interface EdgeConnectorOptions {
  edgeUrl: string | URL;
  token: string;
  localBaseUrl: string | URL;
  maxPayloadBytes?: number;
  maxConcurrentRequests?: number;
  heartbeatIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  log?: (entry: EdgeConnectorLog) => void;
}

export interface EdgeConnectorLog {
  event: string;
  generation?: number;
  requestId?: string;
  status?: number | string;
  reason?: string;
  reconnectInMs?: number;
  activeRequests?: number;
}

type ConnectionState = { protocolReady: boolean };

export class EdgeConnector {
  private readonly edgeUrl: URL;
  private readonly localBaseUrl: URL;
  private readonly maxPayloadBytes: number;
  private readonly maxConcurrentRequests: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly activeRequests = new Map<string, AbortController>();
  private socket: WebSocket | undefined;
  private stopped = false;
  private generation = 0;

  constructor(private readonly options: EdgeConnectorOptions) {
    this.edgeUrl = validateEdgeUrl(options.edgeUrl);
    this.localBaseUrl = validateLocalBaseUrl(options.localBaseUrl);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.reconnectMinMs = options.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;

    if (!options.token || options.token.length < 32) {
      throw new AppError("INVALID_ARGUMENT", "Connector token must contain at least 32 characters.");
    }
    for (const [name, value] of [
      ["maxPayloadBytes", this.maxPayloadBytes],
      ["maxConcurrentRequests", this.maxConcurrentRequests],
      ["heartbeatIntervalMs", this.heartbeatIntervalMs],
      ["reconnectMinMs", this.reconnectMinMs],
      ["reconnectMaxMs", this.reconnectMaxMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new AppError("INVALID_ARGUMENT", `${name} must be a positive integer.`);
      }
    }
    if (this.reconnectMaxMs < this.reconnectMinMs) {
      throw new AppError("INVALID_ARGUMENT", "reconnectMaxMs must be greater than or equal to reconnectMinMs.");
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    let reconnectDelay = this.reconnectMinMs;
    const abort = () => this.stop();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      while (!this.stopped && !signal?.aborted) {
        const connected = await this.connectOnce(signal);
        if (this.stopped || signal?.aborted) break;
        reconnectDelay = connected
          ? this.reconnectMinMs
          : Math.min(reconnectDelay * 2, this.reconnectMaxMs);
        const reconnectInMs = addJitter(reconnectDelay);
        this.log({
          event: "edge_connector_reconnecting",
          generation: this.generation,
          reconnectInMs,
          activeRequests: this.activeRequests.size,
        });
        await delay(reconnectInMs, signal);
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.stop();
    }
  }

  stop(): void {
    this.stopped = true;
    this.abortAllRequests("connector_stopped");
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "connector shutdown");
    }
  }

  private connectOnce(signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const generation = ++this.generation;
      let opened = false;
      let settled = false;
      let heartbeat: NodeJS.Timeout | undefined;
      let isAlive = true;
      const connectionState: ConnectionState = { protocolReady: false };
      const socket = new WebSocket(this.edgeUrl, {
        headers: { authorization: `Bearer ${this.options.token}` },
        maxPayload: this.maxPayloadBytes,
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
      });
      this.socket = socket;
      this.log({ event: "edge_connector_connecting", generation, activeRequests: this.activeRequests.size });

      const finish = () => {
        if (settled) return;
        settled = true;
        if (heartbeat) clearInterval(heartbeat);
        signal?.removeEventListener("abort", abort);
        if (this.socket === socket) this.socket = undefined;
        resolve(opened);
      };
      const abort = () => {
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "connector shutdown");
      };
      signal?.addEventListener("abort", abort, { once: true });

      socket.once("open", () => {
        opened = true;
        heartbeat = setInterval(() => {
          if (!isAlive) {
            this.log({ event: "edge_connector_heartbeat_timeout", generation });
            socket.terminate();
            return;
          }
          isAlive = false;
          socket.ping();
        }, this.heartbeatIntervalMs);
        heartbeat.unref();
        this.log({ event: "edge_connector_connected", generation, activeRequests: this.activeRequests.size });
      });

      socket.on("pong", () => { isAlive = true; });
      socket.on("ping", () => { isAlive = true; });
      socket.on("message", (data, isBinary) => {
        void this.handleMessage(socket, data, isBinary, generation, connectionState).catch((error) => {
          this.log({
            event: "edge_connector_message_failed",
            generation,
            reason: error instanceof Error ? error.name : "UnknownError",
            activeRequests: this.activeRequests.size,
          });
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, "message handler failed");
        });
      });
      socket.on("error", (error) => {
        this.log({
          event: "edge_connector_connection_error",
          generation,
          reason: error.name,
          activeRequests: this.activeRequests.size,
        });
      });
      socket.once("close", (code) => {
        this.abortAllRequests(`socket_closed_${code}`);
        this.log({
          event: "edge_connector_disconnected",
          generation,
          status: code,
          activeRequests: this.activeRequests.size,
        });
        finish();
      });
    });
  }

  private async handleMessage(
    socket: WebSocket,
    data: RawData,
    isBinary: boolean,
    generation: number,
    connectionState: ConnectionState,
  ): Promise<void> {
    if (isBinary) {
      socket.close(1003, "binary messages are not supported");
      return;
    }
    const buffer = toBuffer(data);
    if (buffer.byteLength > this.maxPayloadBytes) {
      socket.close(1009, "message too large");
      return;
    }

    const message = parseEdgeToConnectorMessage(buffer.toString("utf8"));
    if (!message) {
      socket.close(1008, "invalid edge message");
      return;
    }

    if (message.type === "edge-hello") {
      if (connectionState.protocolReady) {
        socket.close(1008, "duplicate edge hello");
        return;
      }
      connectionState.protocolReady = true;
      socket.send(JSON.stringify({
        type: "connector-ready",
        protocolVersion: EDGE_PROTOCOL_VERSION,
      }));
      this.log({ event: "edge_connector_ready", generation, activeRequests: this.activeRequests.size });
      return;
    }

    if (!connectionState.protocolReady) {
      socket.close(1008, "edge hello required");
      return;
    }

    if (message.type === "http-cancel") {
      this.activeRequests.get(message.requestId)?.abort(message.reason);
      return;
    }

    if (this.activeRequests.has(message.requestId)) {
      socket.close(1008, "duplicate request id");
      return;
    }
    if (this.activeRequests.size >= this.maxConcurrentRequests) {
      this.sendResponse(socket, {
        type: "http-response",
        protocolVersion: EDGE_PROTOCOL_VERSION,
        requestId: message.requestId,
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8", "retry-after": "1" },
        body: JSON.stringify({ error: "connector_busy" }),
      });
      return;
    }

    const controller = new AbortController();
    this.activeRequests.set(message.requestId, controller);
    try {
      await this.forwardRequest(socket, message, controller.signal, generation);
    } finally {
      this.activeRequests.delete(message.requestId);
    }
  }

  private async forwardRequest(
    socket: WebSocket,
    message: Extract<ReturnType<typeof parseEdgeToConnectorMessage>, { type: "http-request" }>,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    if (utf8ByteLength(message.body) > MAX_EDGE_REQUEST_BODY_BYTES) {
      this.sendErrorResponse(socket, message.requestId, 413, "request_too_large");
      return;
    }
    if (!isAllowedEdgeRequest(message.method, message.path)) {
      this.sendErrorResponse(socket, message.requestId, 404, "edge_route_not_allowed");
      return;
    }

    const localUrl = new URL(message.path, this.localBaseUrl);
    if (localUrl.origin !== this.localBaseUrl.origin) {
      this.sendErrorResponse(socket, message.requestId, 400, "invalid_local_route");
      return;
    }

    const headers = collectAllowedHeaders(message.headers, REQUEST_HEADER_ALLOWLIST);
    try {
      const response = await fetch(localUrl, {
        method: message.method,
        headers,
        redirect: "manual",
        signal,
        ...(message.method === "GET" || message.body.length === 0 ? {} : { body: message.body }),
      });
      const body = await response.text();
      if (utf8ByteLength(body) > MAX_EDGE_RESPONSE_BODY_BYTES) {
        this.sendErrorResponse(socket, message.requestId, 502, "gateway_response_too_large");
        return;
      }
      this.sendResponse(socket, {
        type: "http-response",
        protocolVersion: EDGE_PROTOCOL_VERSION,
        requestId: message.requestId,
        status: response.status,
        headers: collectHeaders(response.headers, RESPONSE_HEADER_ALLOWLIST),
        body,
      });
      this.log({
        event: "edge_connector_request_completed",
        generation,
        requestId: message.requestId,
        status: response.status,
        activeRequests: this.activeRequests.size,
      });
    } catch (error) {
      if (signal.aborted) {
        this.log({
          event: "edge_connector_request_cancelled",
          generation,
          requestId: message.requestId,
          activeRequests: this.activeRequests.size,
        });
        return;
      }
      this.log({
        event: "edge_connector_gateway_error",
        generation,
        requestId: message.requestId,
        reason: error instanceof Error ? error.name : "UnknownError",
        activeRequests: this.activeRequests.size,
      });
      this.sendErrorResponse(socket, message.requestId, 502, "local_gateway_unavailable");
    }
  }

  private sendErrorResponse(socket: WebSocket, requestId: string, status: number, error: string): void {
    this.sendResponse(socket, {
      type: "http-response",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      requestId,
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error }),
    });
  }

  private sendResponse(socket: WebSocket, response: EdgeHttpResponseMessage): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(response));
  }

  private abortAllRequests(reason: string): void {
    for (const controller of this.activeRequests.values()) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
    this.activeRequests.clear();
  }

  private log(entry: EdgeConnectorLog): void {
    this.options.log?.(entry);
  }
}

function validateEdgeUrl(value: string | URL): URL {
  const url = new URL(value.toString());
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new AppError("INVALID_ARGUMENT", "Edge connector URL must use ws or wss.");
  }
  if (url.pathname !== "/connector" || url.username || url.password || url.search || url.hash) {
    throw new AppError("INVALID_ARGUMENT", "Edge connector URL must be an origin plus /connector without credentials, query, or fragment.");
  }
  return url;
}

function validateLocalBaseUrl(value: string | URL): URL {
  const url = new URL(value.toString());
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new AppError("INVALID_ARGUMENT", "Local Gateway URL must be a loopback HTTP origin.");
  }
  return url;
}

function collectAllowedHeaders(headers: Record<string, string>, allowlist: Set<string>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (allowlist.has(normalized)) result.set(normalized, value);
  }
  return result;
}

function collectHeaders(headers: Headers, allowlist: Set<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const normalized = name.toLowerCase();
    if (allowlist.has(normalized)) result[normalized] = value;
  }
  return result;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  throw new AppError("RELAY_PROTOCOL_ERROR", "Unsupported WebSocket payload type.");
}

function addJitter(delayMs: number): number {
  return Math.max(1, Math.round(delayMs * (0.8 + Math.random() * 0.4)));
}

function delay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      finish();
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
