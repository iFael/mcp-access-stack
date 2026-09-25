import os from "node:os";
import {
  COMPANION_PROTOCOL_VERSION,
  MAX_EDGE_REQUEST_BODY_BYTES,
  MAX_EDGE_RESPONSE_BODY_BYTES,
  isAllowedEdgeRequest,
  parseEdgeToCompanionMessage,
  utf8ByteLength,
  type CompanionHttpResponseMessage,
  type CompanionPlatform,
  type CompanionReadyMessage,
} from "@mcp-access-stack/edge-protocol";
import { AppError } from "@vs-code-gpt/shared";
import WebSocket, { type ClientOptions, type RawData } from "ws";
import {
  EDGE_INTERNAL_ASSERTION_HEADER,
  EDGE_INTERNAL_PRINCIPAL_HEADER,
  assertValidEdgeInternalAssertion,
  encodeEdgeAuthenticatedPrincipal,
} from "../edge/internal-trust.js";
import type { DesktopOAuthClient } from "./desktop-oauth.js";
import type { LocalRepositoryManager } from "./local-repository-manager.js";

const DEFAULT_MAX_PAYLOAD_BYTES = 24 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 8;
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

export const DEFAULT_COMPANION_CAPABILITIES = [
  "repositories",
  "files",
  "terminal",
  "background-tasks",
  "git",
  "source-control",
] as const;

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "x-openai-session",
  "x-openai-subject",
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

export interface CompanionConnectorOptions {
  edgeBaseUrl: URL;
  oauth: DesktopOAuthClient;
  internalAssertion: string;
  localBaseUrl: URL;
  repositories: LocalRepositoryManager;
  displayName?: string;
  capabilities?: string[];
  maxPayloadBytes?: number;
  maxConcurrentRequests?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  webSocketFactory?: (url: URL, options: ClientOptions) => WebSocket;
  log?: (entry: Record<string, unknown>) => void;
}

export class CompanionConnector {
  private readonly edgeUrl: URL;
  private readonly localBaseUrl: URL;
  private readonly maxPayloadBytes: number;
  private readonly maxConcurrentRequests: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly activeRequests = new Map<string, AbortController>();
  private socket: WebSocket | undefined;
  private stopped = false;

  constructor(private readonly options: CompanionConnectorOptions) {
    this.edgeUrl = new URL("/companion", normalizeEdgeOrigin(options.edgeBaseUrl));
    this.edgeUrl.protocol = "wss:";
    this.localBaseUrl = validateLoopback(options.localBaseUrl);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
    this.reconnectMinMs = options.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    assertValidEdgeInternalAssertion(options.internalAssertion);
  }

  async run(signal?: AbortSignal): Promise<void> {
    let delayMs = this.reconnectMinMs;
    const abort = () => this.stop();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (!this.stopped && !signal?.aborted) {
        const ready = await this.connectOnce(signal);
        if (this.stopped || signal?.aborted) break;
        delayMs = ready ? this.reconnectMinMs : Math.min(delayMs * 2, this.reconnectMaxMs);
        await delay(delayMs, signal);
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.stop();
    }
  }

  async announceState(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    await this.sendReady(socket);
  }

  stop(): void {
    this.stopped = true;
    for (const controller of this.activeRequests.values()) controller.abort("companion_stopped");
    this.activeRequests.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "MCP V3 local runtime shutdown");
  }

  private async connectOnce(signal?: AbortSignal): Promise<boolean> {
    let token;
    try {
      token = await this.options.oauth.getAccessToken(signal);
    } catch (error) {
      this.log({ event: "local_runtime_auth_failed", reason: errorName(error) });
      return false;
    }

    return new Promise<boolean>((resolve) => {
      let protocolReady = false;
      let settled = false;
      const socketOptions: ClientOptions = {
        headers: { authorization: `Bearer ${token.accessToken}` },
        maxPayload: this.maxPayloadBytes,
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
      };
      const socket = this.options.webSocketFactory
        ? this.options.webSocketFactory(this.edgeUrl, socketOptions)
        : new WebSocket(this.edgeUrl, socketOptions);
      this.socket = socket;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (this.socket === socket) this.socket = undefined;
        resolve(protocolReady);
      };
      const abort = () => {
        if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "MCP V3 local runtime shutdown");
      };
      signal?.addEventListener("abort", abort, { once: true });

      socket.on("message", (data, isBinary) => {
        void this.handleMessage(socket, data, isBinary).then((ready) => {
          if (ready) protocolReady = true;
        }).catch((error) => {
          this.log({ event: "local_runtime_message_failed", reason: errorName(error) });
          if (socket.readyState === WebSocket.OPEN) socket.close(1011, "local runtime message failed");
        });
      });
      socket.on("error", (error) => this.log({ event: "local_runtime_socket_error", reason: errorName(error) }));
      socket.once("close", (code) => {
        for (const controller of this.activeRequests.values()) controller.abort(`socket_closed_${code}`);
        this.activeRequests.clear();
        finish();
      });
    });
  }

  private async handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): Promise<boolean> {
    if (isBinary) {
      socket.close(1003, "binary messages are not supported");
      return false;
    }
    const buffer = toBuffer(data);
    if (buffer.byteLength > this.maxPayloadBytes) {
      socket.close(1009, "message too large");
      return false;
    }
    const message = parseEdgeToCompanionMessage(buffer.toString("utf8"));
    if (!message) {
      socket.close(1008, "invalid companion message");
      return false;
    }

    if (message.type === "companion-hello") {
      await this.sendReady(socket);
      return true;
    }
    if (message.type === "companion-registered") {
      await this.options.repositories.setDeviceId(message.deviceId);
      this.log({ event: "local_runtime_registered", deviceId: message.deviceId });
      return true;
    }
    if (message.type === "http-cancel") {
      this.activeRequests.get(message.requestId)?.abort(message.reason);
      return true;
    }
    if (this.activeRequests.has(message.requestId)) {
      socket.close(1008, "duplicate request id");
      return true;
    }
    if (this.activeRequests.size >= this.maxConcurrentRequests) {
      this.sendResponse(socket, {
        type: "http-response",
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        requestId: message.requestId,
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8", "retry-after": "1" },
        body: JSON.stringify({ error: "local_runtime_busy" }),
      });
      return true;
    }

    const controller = new AbortController();
    this.activeRequests.set(message.requestId, controller);
    try {
      await this.forwardRequest(socket, message, controller.signal);
    } finally {
      this.activeRequests.delete(message.requestId);
    }
    return true;
  }

  private async sendReady(socket: WebSocket): Promise<void> {
    const summaries = await this.options.repositories.listWorkspaceSummaries();
    const deviceId = this.options.repositories.getDeviceId();
    const registration = {
      ...(deviceId === undefined ? {} : { deviceId }),
      displayName: this.options.displayName?.trim() || os.hostname() || "MCP V3 device",
      platform: platformName(process.platform),
      capabilities: this.options.capabilities ??
        [...DEFAULT_COMPANION_CAPABILITIES],
    };
    const ready: CompanionReadyMessage = {
      type: "companion-ready",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      registration,
      workspaces: summaries.map((workspace) => ({
        workspaceId: workspace.id,
        name: workspace.name,
        workspaceKind: workspace.workspaceKind ?? "repository",
        enabled: workspace.enabled,
        permissionProfile: workspace.permissionProfile,
        confirmationMode: workspace.confirmationMode,
        writesEnabled: workspace.writesEnabled,
        shellsEnabled: workspace.shellsEnabled,
        allowedShells: [...workspace.allowedShells],
      })),
      materializations: this.options.repositories.listMaterializationAnnouncements(),
    };
    socket.send(JSON.stringify(ready));
  }

  private async forwardRequest(
    socket: WebSocket,
    message: Extract<ReturnType<typeof parseEdgeToCompanionMessage>, { type: "http-request" }>,
    signal: AbortSignal,
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
    headers.set(EDGE_INTERNAL_ASSERTION_HEADER, this.options.internalAssertion);
    headers.set(EDGE_INTERNAL_PRINCIPAL_HEADER, encodeEdgeAuthenticatedPrincipal(message.principal));
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
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        requestId: message.requestId,
        status: response.status,
        headers: collectHeaders(response.headers, RESPONSE_HEADER_ALLOWLIST),
        body,
      });
    } catch (error) {
      if (signal.aborted) return;
      this.log({ event: "local_runtime_gateway_error", reason: errorName(error) });
      this.sendErrorResponse(socket, message.requestId, 502, "local_gateway_unavailable");
    }
  }

  private sendErrorResponse(socket: WebSocket, requestId: string, status: number, error: string): void {
    this.sendResponse(socket, {
      type: "http-response",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      requestId,
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error }),
    });
  }

  private sendResponse(socket: WebSocket, response: CompanionHttpResponseMessage): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
  }

  private log(entry: Record<string, unknown>): void {
    this.options.log?.(entry);
  }
}

function normalizeEdgeOrigin(input: URL): URL {
  const url = new URL(input.href);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new AppError("INVALID_ARGUMENT", "MCP V3 edge URL must be a credential-free HTTPS origin.");
  }
  return url;
}

function validateLoopback(input: URL): URL {
  const url = new URL(input.href);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/" || url.username || url.password || url.search || url.hash) {
    throw new AppError("INVALID_ARGUMENT", "MCP V3 local Gateway must use a credential-free loopback HTTP origin.");
  }
  return url;
}

function platformName(platform: NodeJS.Platform): CompanionPlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unknown";
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timeout = setTimeout(done, ms);
    const abort = () => { clearTimeout(timeout); done(); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string"
    ? error.name.slice(0, 128)
    : "UnknownError";
}
