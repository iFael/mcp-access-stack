import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  AppError,
  agentHelloSchema,
  asAppError,
  relayResponseSchema,
  relayResultSchemas,
  type OperationContext,
  type RelayOperation,
} from "@vs-code-gpt/shared";
import type { Logger } from "pino";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { AgentRelayRequestManager } from "./request-manager.js";

export interface AgentRelayOptions {
  agentId: string;
  tokenSha256: string;
  requestTimeoutMs: number;
  heartbeatMs: number;
  maxConcurrency: number;
  maxPayloadBytes: number;
  allowedOrigins?: ReadonlySet<string>;
}

export class AgentRelay {
  private readonly webSocketServer: WebSocketServer;
  private readonly requestManager: AgentRelayRequestManager;
  private socket: WebSocket | undefined;
  private ready = false;
  private heartbeat: NodeJS.Timeout | undefined;
  private alive = false;
  private connectionGeneration = 0;

  constructor(
    private readonly options: AgentRelayOptions,
    private readonly logger: Logger,
  ) {
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: options.maxPayloadBytes,
      perMessageDeflate: false,
    });
    this.requestManager = new AgentRelayRequestManager(
      {
        requestTimeoutMs: options.requestTimeoutMs,
        maxConcurrency: options.maxConcurrency,
        maxPayloadBytes: options.maxPayloadBytes,
        generation: () => this.connectionGeneration,
      },
      logger,
    );
    this.webSocketServer.on("connection", (socket) => this.acceptConnection(socket));
  }

  get isConnected(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://localhost");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== "/agent" || url.search || url.hash) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!this.isOriginAllowed(request)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    if (!this.authenticate(request)) {
      rejectUpgrade(socket, 401, "Unauthorized", {
        "WWW-Authenticate": 'Bearer realm="agent"',
      });
      return;
    }
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.logger.warn({
        event: "agent_upgrade_rejected",
        reason: "duplicate_connection",
        generation: this.connectionGeneration,
        pendingRequests: this.requestManager.size,
        ...runtimeMetrics(),
      });
      rejectUpgrade(socket, 409, "Conflict");
      return;
    }

    this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      this.webSocketServer.emit("connection", webSocket, request);
    });
  }

  async call(
    operation: RelayOperation,
    input: unknown,
    context: OperationContext = {},
  ): Promise<unknown> {
    const socket = this.socket;
    if (!this.ready || !socket || socket.readyState !== WebSocket.OPEN) {
      throw new AppError("AGENT_UNAVAILABLE", "The local agent is unavailable.");
    }
    return this.requestManager.call(socket, operation, input, context);
  }

  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
    this.requestManager.rejectAll("AGENT_UNAVAILABLE", "The gateway is shutting down.");
    this.ready = false;
    this.socket?.close(1001, "gateway shutdown");
    this.socket = undefined;
    this.webSocketServer.close();
  }

  private isOriginAllowed(request: IncomingMessage): boolean {
    const rawOrigin = request.headers.origin;
    if (rawOrigin === undefined) {
      return true;
    }
    const origin = singleHeader(rawOrigin);
    return origin !== undefined && (this.options.allowedOrigins?.has(origin) ?? false);
  }

  private authenticate(request: IncomingMessage): boolean {
    const agentId = singleHeader(request.headers["x-agent-id"]);
    const authorization = singleHeader(request.headers.authorization);
    if (agentId !== this.options.agentId || !authorization?.startsWith("Bearer ")) {
      return false;
    }
    const token = authorization.slice("Bearer ".length);
    const actualHash = createHash("sha256").update(token, "utf8").digest();
    const expectedHash = Buffer.from(this.options.tokenSha256, "hex");
    return actualHash.length === expectedHash.length && timingSafeEqual(actualHash, expectedHash);
  }

  private acceptConnection(socket: WebSocket): void {
    const generation = ++this.connectionGeneration;
    const connectedAt = Date.now();
    this.socket = socket;
    this.ready = false;
    this.alive = true;
    this.logger.info({
      event: "agent_socket_accepted",
      generation,
      pendingRequests: this.requestManager.size,
      ...runtimeMetrics(),
    });
    const helloTimeout = setTimeout(() => {
      if (!this.ready) {
        this.logger.warn({
          event: "agent_hello_timeout",
          generation,
          connectedForMs: Date.now() - connectedAt,
          ...runtimeMetrics(),
        });
        socket.close(1008, "agent hello timeout");
      }
    }, Math.min(this.options.requestTimeoutMs, 5_000));
    helloTimeout.unref();

    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      this.handleMessage(socket, data, isBinary);
    });
    socket.on("error", (error) => {
      this.logger.warn({
        event: "agent_socket_error",
        generation,
        reason: error.name,
        code: (error as NodeJS.ErrnoException).code ?? null,
        connectedForMs: Date.now() - connectedAt,
        pendingRequests: this.requestManager.size,
        ...runtimeMetrics(),
      });
    });
    socket.once("close", (code, reasonBuffer) => {
      clearTimeout(helloTimeout);
      if (this.socket === socket) {
        this.socket = undefined;
        this.ready = false;
        if (this.heartbeat) {
          clearInterval(this.heartbeat);
          this.heartbeat = undefined;
        }
        this.requestManager.rejectAll("AGENT_UNAVAILABLE", "The local agent disconnected.");
      }
      this.logger.info({
        event: "agent_disconnected",
        generation,
        code,
        reason: sanitizeCloseReason(reasonBuffer),
        connectedForMs: Date.now() - connectedAt,
        pendingRequests: this.requestManager.size,
        ...runtimeMetrics(),
      });
    });
  }

  private handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): void {
    if (isBinary) {
      socket.close(1003, "binary messages are not supported");
      return;
    }
    const payload = toBuffer(data);
    if (payload.byteLength > this.options.maxPayloadBytes) {
      socket.close(1009, "message too large");
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(payload.toString("utf8"));
    } catch {
      socket.close(1008, "invalid json");
      return;
    }

    if (!this.ready) {
      const hello = agentHelloSchema.safeParse(value);
      if (!hello.success || hello.data.agentId !== this.options.agentId) {
        socket.close(1008, "invalid agent hello");
        return;
      }
      const gatewayOperations = Object.keys(relayResultSchemas) as RelayOperation[];
      const capabilities = new Set(
        hello.data.capabilities.filter((operation): operation is RelayOperation =>
          gatewayOperations.includes(operation as RelayOperation),
        ),
      );
      if (!gatewayOperations.every((operation) => capabilities.has(operation))) {
        socket.close(1008, "incompatible agent capabilities");
        return;
      }
      this.ready = true;
      this.startHeartbeat(socket, this.connectionGeneration);
      this.logger.info({
        event: "agent_connected",
        agentId: this.options.agentId,
        generation: this.connectionGeneration,
        pendingRequests: this.requestManager.size,
        ...runtimeMetrics(),
      });
      return;
    }

    const response = relayResponseSchema.safeParse(value);
    if (!response.success) {
      socket.close(1008, "invalid relay response");
      return;
    }
    this.requestManager.complete(response.data);
  }

  private startHeartbeat(socket: WebSocket, generation: number): void {
    this.heartbeat = setInterval(() => {
      if (!this.alive) {
        this.logger.warn({
          event: "agent_heartbeat_timeout",
          generation,
          pendingRequests: this.requestManager.size,
          ...runtimeMetrics(),
        });
        socket.terminate();
        return;
      }
      this.alive = false;
      socket.ping();
    }, this.options.heartbeatMs);
    this.heartbeat.unref();
  }

}

function runtimeMetrics(): { rssBytes: number; heapUsedBytes: number } {
  const memory = process.memoryUsage();
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed };
}

function sanitizeCloseReason(reason: Buffer): string {
  const text = reason.toString("utf8").trim();
  return text ? text.replace(/[\r\n\t]/g, " ").slice(0, 160) : "none";
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function rejectUpgrade(
  socket: Duplex,
  status: number,
  reason: string,
  headers: Record<string, string> = {},
): void {
  const lines = [`HTTP/1.1 ${status} ${reason}`, "Connection: close"];
  for (const [name, value] of Object.entries(headers)) {
    lines.push(`${name}: ${value}`);
  }
  socket.end(`${lines.join("\r\n")}\r\n\r\n`);
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  throw asAppError(new Error("Unsupported WebSocket payload type."));
}
