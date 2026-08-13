import {
  AppError,
  agentHelloSchema,
  asAppError,
  relayAgentMessageSchema,
  type AgentHello,
  type RelayOperation,
} from "@vs-code-gpt/shared";
import WebSocket, { type RawData } from "ws";
import type { LocalAgent } from "../local-agent.js";
import { AgentRequestExecutor } from "./request-executor.js";

const capabilities: AgentHello["capabilities"] = [
  "listWorkspaces",
  "listWorkspaceRoots",
  "listFiles",
  "readFile",
  "readBinaryFile",
  "writeFile",
  "patchFile",
  "runValidation",
  "runCommand",
  "runPowerShell",
  "searchFiles",
  "inspectGit",
  "getWorkspaceContext",
  "startBackgroundTask",
  "getBackgroundTask",
  "listBackgroundTasks",
  "cancelBackgroundTask",
  "readBackgroundTaskLogs",
];

export interface AgentConnectionOptions {
  gatewayUrl: string;
  agentId: string;
  token: string;
  maxPayloadBytes?: number;
  maxConcurrentSynchronousShells?: number;
  heartbeatIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  log?: (entry: AgentConnectionLog) => void;
}

export interface AgentConnectionLog {
  event: string;
  reason?: string;
  code?: number | string | null;
  generation?: number;
  reconnectInMs?: number;
  connectedForMs?: number;
  activeRequests?: number;
  requestId?: string;
  operation?: RelayOperation;
  durationMs?: number;
  status?: string;
  rssBytes?: number;
  heapUsedBytes?: number;
}

export class AgentConnection {
  private readonly gatewayUrl: URL;
  private readonly maxPayloadBytes: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;
  private readonly requestExecutor: AgentRequestExecutor;
  private socket: WebSocket | undefined;
  private stopped = false;
  private generation = 0;

  constructor(
    agent: LocalAgent,
    private readonly options: AgentConnectionOptions,
  ) {
    this.gatewayUrl = validateGatewayUrl(options.gatewayUrl);
    this.maxPayloadBytes = options.maxPayloadBytes ?? 2 * 1024 * 1024;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.reconnectMinMs = options.reconnectMinMs ?? 1_000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.requestExecutor = new AgentRequestExecutor(
      agent,
      (entry) => this.log(entry),
      options.maxConcurrentSynchronousShells === undefined
        ? {}
        : {
            maxConcurrentSynchronousShells:
              options.maxConcurrentSynchronousShells,
          },
    );

    if (!options.agentId.trim() || !options.token) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "Agent id and token are required for gateway connection.",
      );
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    let reconnectDelay = this.reconnectMinMs;
    const abort = () => this.stop();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      while (!this.stopped && !signal?.aborted) {
        const connected = await this.connectOnce(signal);
        if (this.stopped || signal?.aborted) {
          break;
        }
        reconnectDelay = connected
          ? this.reconnectMinMs
          : Math.min(reconnectDelay * 2, this.reconnectMaxMs);
        const delayWithJitter = addJitter(reconnectDelay);
        this.log({
          event: "reconnecting",
          generation: this.generation,
          reconnectInMs: delayWithJitter,
          ...runtimeMetrics(this.requestExecutor.activeRequestCount),
        });
        await delay(delayWithJitter, signal);
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      this.stop();
    }
  }

  stop(): void {
    this.stopped = true;
    this.requestExecutor.abortAll("agent connection stopped");
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "agent shutdown");
    }
  }

  private connectOnce(signal?: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const generation = ++this.generation;
      const connectionStartedAt = Date.now();
      let opened = false;
      let settled = false;
      let heartbeat: NodeJS.Timeout | undefined;
      let isAlive = true;
      const socket = new WebSocket(this.gatewayUrl, {
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "x-agent-id": this.options.agentId,
        },
        maxPayload: this.maxPayloadBytes,
        perMessageDeflate: false,
        handshakeTimeout: 15_000,
      });
      this.socket = socket;
      this.log({
        event: "connecting",
        generation,
        ...runtimeMetrics(this.requestExecutor.activeRequestCount),
      });

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        signal?.removeEventListener("abort", abort);
        if (this.socket === socket) {
          this.socket = undefined;
        }
        resolve(opened);
      };

      const abort = () => {
        if (socket.readyState < WebSocket.CLOSING) {
          socket.close(1000, "agent shutdown");
        }
      };
      signal?.addEventListener("abort", abort, { once: true });

      socket.once("open", () => {
        opened = true;
        const hello = agentHelloSchema.parse({
          version: 1,
          type: "hello",
          agentId: this.options.agentId,
          capabilities,
        });
        socket.send(JSON.stringify(hello), (error) => {
          if (error) {
            this.log({
              event: "hello_send_failed",
              generation,
              reason: error.name,
              ...runtimeMetrics(this.requestExecutor.activeRequestCount),
            });
            socket.close(1011, "agent hello failed");
          }
        });
        heartbeat = setInterval(() => {
          if (!isAlive) {
            this.log({
              event: "heartbeat_timeout",
              generation,
              connectedForMs: Date.now() - connectionStartedAt,
              ...runtimeMetrics(this.requestExecutor.activeRequestCount),
            });
            socket.terminate();
            return;
          }
          isAlive = false;
          socket.ping();
        }, this.heartbeatIntervalMs);
        heartbeat.unref();
        this.log({
          event: "connected",
          generation,
          ...runtimeMetrics(this.requestExecutor.activeRequestCount),
        });
      });

      socket.on("pong", () => {
        isAlive = true;
      });
      socket.on("ping", () => {
        isAlive = true;
      });
      socket.on("message", (data, isBinary) => {
        void this.handleMessage(socket, data, isBinary, generation).catch((error) => {
          const appError = asAppError(error);
          this.log({
            event: "message_handler_failed",
            generation,
            reason: appError.code,
            ...runtimeMetrics(this.requestExecutor.activeRequestCount),
          });
          if (socket.readyState === WebSocket.OPEN) {
            socket.close(1011, "message handler failed");
          }
        });
      });
      socket.on("error", (error) => {
        this.log({
          event: "connection_error",
          generation,
          reason: error.name,
          code: (error as NodeJS.ErrnoException).code ?? null,
          connectedForMs: Date.now() - connectionStartedAt,
          ...runtimeMetrics(this.requestExecutor.activeRequestCount),
        });
      });
      socket.once("close", (code, reasonBuffer) => {
        this.requestExecutor.abortAll(`socket closed with code ${code}`);
        this.log({
          event: "disconnected",
          generation,
          code,
          reason: sanitizeCloseReason(reasonBuffer),
          connectedForMs: Date.now() - connectionStartedAt,
          ...runtimeMetrics(this.requestExecutor.activeRequestCount),
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

    let message;
    try {
      message = relayAgentMessageSchema.parse(JSON.parse(buffer.toString("utf8")));
    } catch {
      socket.close(1008, "invalid relay message");
      return;
    }

    if (message.type === "cancel") {
      this.requestExecutor.cancel(message);
      return;
    }

    const response = await this.requestExecutor.execute(message, generation);
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(response), (error) => {
        if (error) {
          this.log({
            event: "response_send_failed",
            generation,
            requestId: message.requestId,
            operation: message.operation,
            reason: error.name,
            ...runtimeMetrics(this.requestExecutor.activeRequestCount),
          });
        }
      });
    }
  }

  private log(entry: AgentConnectionLog): void {
    this.options.log?.(entry);
  }
}

function validateGatewayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AppError("INVALID_ARGUMENT", "Gateway URL is invalid.", {
      cause: error,
    });
  }
  if (!["ws:", "wss:"].includes(url.protocol)) {
    throw new AppError("INVALID_ARGUMENT", "Gateway URL must use ws or wss.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Gateway URL must not contain credentials, query parameters, or fragments.",
    );
  }
  return url;
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
  throw new AppError("RELAY_PROTOCOL_ERROR", "Unsupported WebSocket payload type.");
}

function addJitter(delayMs: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.max(1, Math.round(delayMs * factor));
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
    // Keep the reconnect timer referenced. After the socket closes, this can be
    // the only active handle preventing the standalone agent process from exiting.
  });
}

function runtimeMetrics(activeRequests: number): Pick<
  AgentConnectionLog,
  "activeRequests" | "rssBytes" | "heapUsedBytes"
> {
  const memory = process.memoryUsage();
  return {
    activeRequests,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}

function sanitizeCloseReason(reason: Buffer): string {
  const text = reason.toString("utf8").trim();
  if (!text) {
    return "none";
  }
  return text.replace(/[\r\n\t]/g, " ").slice(0, 160);
}
