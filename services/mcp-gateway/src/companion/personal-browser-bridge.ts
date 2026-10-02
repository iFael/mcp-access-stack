import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  browserOperationResultSchemas,
  errorCodes,
  type BrowserExecutor,
  type BrowserOperation,
  type OperationContext,
} from "@vs-code-gpt/shared";
import WebSocket, { WebSocketServer } from "ws";
import type { PersonalBrowserExecutor } from "../browser/browser-mode-router.js";
import { buildPersonalBrowserExtensionAssets } from "./personal-browser-extension-assets.js";

const DEFAULT_PORT = 3361;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const ERROR_CODES = new Set<string>(errorCodes);

interface PendingCall {
  generation: number;
  operation: BrowserOperation;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

export interface PersonalBrowserBridgeOptions {
  stateRoot: string;
  port?: number;
  log?: (entry: Record<string, unknown>) => void;
}

export class PersonalBrowserBridge implements PersonalBrowserExecutor {
  readonly extensionDirectory: string;
  readonly port: number;

  private readonly pending = new Map<string, PendingCall>();
  private socket: WebSocket | undefined;
  private socketGeneration = 0;
  private nextConnectionGeneration = 0;
  private server: WebSocketServer | undefined;
  private token = "";
  private closed = false;

  private constructor(private readonly options: PersonalBrowserBridgeOptions) {
    this.port = options.port ?? DEFAULT_PORT;
    this.extensionDirectory = path.join(
      path.resolve(options.stateRoot),
      "browser",
      "personal-extension",
    );
  }

  static async start(
    options: PersonalBrowserBridgeOptions,
  ): Promise<PersonalBrowserBridge> {
    const bridge = new PersonalBrowserBridge(options);
    await bridge.initialize();
    return bridge;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      socket.close(1000, "MCP V3 companion shutdown");
    }
    this.rejectPending(
      new AppError("BROWSER_DISCONNECTED", "The personal browser bridge was closed."),
    );
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  status(..._args: Parameters<BrowserExecutor["status"]>): ReturnType<BrowserExecutor["status"]> {
    throw unsupported("browser_status");
  }

  connect(..._args: Parameters<BrowserExecutor["connect"]>): ReturnType<BrowserExecutor["connect"]> {
    throw unsupported("browser_connect");
  }

  tabs(...args: Parameters<BrowserExecutor["tabs"]>): ReturnType<BrowserExecutor["tabs"]> {
    return this.call("tabs", args[0], args[1]);
  }

  open(...args: Parameters<BrowserExecutor["open"]>): ReturnType<BrowserExecutor["open"]> {
    return this.call("open", args[0], args[1]);
  }

  openAuthorizedSite(
    ..._args: Parameters<BrowserExecutor["openAuthorizedSite"]>
  ): ReturnType<BrowserExecutor["openAuthorizedSite"]> {
    throw unsupported("browser_open_authorized_site");
  }

  navigate(...args: Parameters<BrowserExecutor["navigate"]>): ReturnType<BrowserExecutor["navigate"]> {
    return this.call("navigate", args[0], args[1]);
  }

  snapshot(...args: Parameters<BrowserExecutor["snapshot"]>): ReturnType<BrowserExecutor["snapshot"]> {
    return this.call("snapshot", args[0], args[1]);
  }

  click(...args: Parameters<BrowserExecutor["click"]>): ReturnType<BrowserExecutor["click"]> {
    return this.call("click", args[0], args[1]);
  }

  fill(...args: Parameters<BrowserExecutor["fill"]>): ReturnType<BrowserExecutor["fill"]> {
    return this.call("fill", args[0], args[1]);
  }

  press(...args: Parameters<BrowserExecutor["press"]>): ReturnType<BrowserExecutor["press"]> {
    return this.call("press", args[0], args[1]);
  }

  wait(...args: Parameters<BrowserExecutor["wait"]>): ReturnType<BrowserExecutor["wait"]> {
    return this.call("wait", args[0], args[1]);
  }

  extract(...args: Parameters<BrowserExecutor["extract"]>): ReturnType<BrowserExecutor["extract"]> {
    return this.call("extract", args[0], args[1]);
  }

  sequence(...args: Parameters<BrowserExecutor["sequence"]>): ReturnType<BrowserExecutor["sequence"]> {
    return this.call("sequence", args[0], args[1]);
  }

  frameExtract(
    ..._args: Parameters<NonNullable<BrowserExecutor["frameExtract"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameExtract"]>> {
    throw unsupported("browser_frame_extract");
  }

  frameClick(
    ..._args: Parameters<NonNullable<BrowserExecutor["frameClick"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameClick"]>> {
    throw unsupported("browser_frame_click");
  }

  frameFill(
    ..._args: Parameters<NonNullable<BrowserExecutor["frameFill"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameFill"]>> {
    throw unsupported("browser_frame_fill");
  }

  profilePage(
    ..._args: Parameters<NonNullable<BrowserExecutor["profilePage"]>>
  ): ReturnType<NonNullable<BrowserExecutor["profilePage"]>> {
    throw unsupported("browser_profile_page");
  }

  domIndex(
    ..._args: Parameters<NonNullable<BrowserExecutor["domIndex"]>>
  ): ReturnType<NonNullable<BrowserExecutor["domIndex"]>> {
    throw unsupported("browser_dom_index");
  }

  frameSequence(
    ..._args: Parameters<NonNullable<BrowserExecutor["frameSequence"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameSequence"]>> {
    throw unsupported("browser_frame_sequence");
  }

  navigatePath(
    ..._args: Parameters<NonNullable<BrowserExecutor["navigatePath"]>>
  ): ReturnType<NonNullable<BrowserExecutor["navigatePath"]>> {
    throw unsupported("browser_navigate_path");
  }

  screenshot(
    ..._args: Parameters<BrowserExecutor["screenshot"]>
  ): ReturnType<BrowserExecutor["screenshot"]> {
    throw unsupported("browser_screenshot");
  }

  goBack(...args: Parameters<BrowserExecutor["goBack"]>): ReturnType<BrowserExecutor["goBack"]> {
    return this.call("goBack", args[0], args[1]);
  }

  goForward(
    ...args: Parameters<BrowserExecutor["goForward"]>
  ): ReturnType<BrowserExecutor["goForward"]> {
    return this.call("goForward", args[0], args[1]);
  }

  closeTab(...args: Parameters<BrowserExecutor["closeTab"]>): ReturnType<BrowserExecutor["closeTab"]> {
    return this.call("closeTab", args[0], args[1]);
  }

  finishTask(
    ...args: Parameters<BrowserExecutor["finishTask"]>
  ): ReturnType<BrowserExecutor["finishTask"]> {
    return this.call("finishTask", args[0], args[1]);
  }

  download(
    ..._args: Parameters<BrowserExecutor["download"]>
  ): ReturnType<BrowserExecutor["download"]> {
    throw unsupported("browser_download");
  }

  upload(..._args: Parameters<BrowserExecutor["upload"]>): ReturnType<BrowserExecutor["upload"]> {
    throw unsupported("browser_upload");
  }

  console(..._args: Parameters<BrowserExecutor["console"]>): ReturnType<BrowserExecutor["console"]> {
    throw unsupported("browser_console");
  }

  networkList(
    ..._args: Parameters<BrowserExecutor["networkList"]>
  ): ReturnType<BrowserExecutor["networkList"]> {
    throw unsupported("browser_network");
  }

  networkInspect(
    ..._args: Parameters<BrowserExecutor["networkInspect"]>
  ): ReturnType<BrowserExecutor["networkInspect"]> {
    throw unsupported("browser_network");
  }

  traceStart(
    ..._args: Parameters<BrowserExecutor["traceStart"]>
  ): ReturnType<BrowserExecutor["traceStart"]> {
    throw unsupported("browser_trace");
  }

  traceStop(
    ..._args: Parameters<BrowserExecutor["traceStop"]>
  ): ReturnType<BrowserExecutor["traceStop"]> {
    throw unsupported("browser_trace");
  }

  videoStart(
    ..._args: Parameters<BrowserExecutor["videoStart"]>
  ): ReturnType<BrowserExecutor["videoStart"]> {
    throw unsupported("browser_video");
  }

  videoStop(
    ..._args: Parameters<BrowserExecutor["videoStop"]>
  ): ReturnType<BrowserExecutor["videoStop"]> {
    throw unsupported("browser_video");
  }

  pdf(..._args: Parameters<BrowserExecutor["pdf"]>): ReturnType<BrowserExecutor["pdf"]> {
    throw unsupported("browser_pdf");
  }

  diagnostics(
    ..._args: Parameters<BrowserExecutor["diagnostics"]>
  ): ReturnType<BrowserExecutor["diagnostics"]> {
    throw unsupported("browser_diagnostics");
  }

  private async initialize(): Promise<void> {
    const personalRoot = path.dirname(this.extensionDirectory);
    const tokenPath = path.join(personalRoot, "bridge-token.txt");
    await mkdir(this.extensionDirectory, { recursive: true });
    this.token = await readOrCreateToken(tokenPath);
    const assets = buildPersonalBrowserExtensionAssets(this.token, this.port);
    await Promise.all([
      writeFile(
        path.join(this.extensionDirectory, "manifest.json"),
        assets.manifest,
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(
        path.join(this.extensionDirectory, "service-worker.js"),
        assets.serviceWorker,
        { encoding: "utf8", mode: 0o600 },
      ),
    ]);

    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: this.port,
      maxPayload: MAX_PAYLOAD_BYTES,
      perMessageDeflate: false,
    });
    this.server = server;

    server.on("connection", (socket, request) => {
      if (!this.authorize(request.url)) {
        socket.close(1008, "unauthorized personal browser bridge");
        return;
      }
      const generation = ++this.nextConnectionGeneration;
      const previous = this.socket;
      this.socket = socket;
      this.socketGeneration = generation;
      if (previous && previous !== socket && previous.readyState < WebSocket.CLOSING) {
        previous.close(4000, "personal browser connection replaced");
      }
      this.options.log?.({
        event: "mcp_v3_personal_browser_connected",
        port: this.port,
        generation,
      });
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        this.handleMessage(socket, generation, data.toString());
      });
      socket.once("close", () => {
        if (this.socket === socket) {
          this.socket = undefined;
          this.socketGeneration = 0;
        }
        this.rejectPendingForGeneration(
          generation,
          new AppError(
            "BROWSER_DISCONNECTED",
            "The MCP V3 personal Chrome extension disconnected.",
          ),
        );
        this.options.log?.({
          event: "mcp_v3_personal_browser_disconnected",
          generation,
        });
      });
      socket.on("error", () => undefined);
    });

    await new Promise<void>((resolve, reject) => {
      const onListening = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      server.once("listening", onListening);
      server.once("error", onError);
    });

    this.options.log?.({
      event: "mcp_v3_personal_browser_bridge_ready",
      port: this.port,
      extensionDirectory: this.extensionDirectory,
    });
  }

  private authorize(requestUrl: string | undefined): boolean {
    if (!requestUrl) return false;
    try {
      const url = new URL(requestUrl, `ws://127.0.0.1:${this.port}`);
      return url.pathname === "/" && url.searchParams.get("token") === this.token;
    } catch {
      return false;
    }
  }

  private handleMessage(
    socket: WebSocket,
    generation: number,
    raw: string,
  ): void {
    if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) return;
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.type === "heartbeat") {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "heartbeat-ack" }));
      }
      return;
    }
    if (message.type !== "response" || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending || pending.generation !== generation) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    pending.abort?.();

    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }
    const error = isRecord(message.error) ? message.error : {};
    const code = typeof error.code === "string" && ERROR_CODES.has(error.code)
      ? error.code
      : "INTERNAL_ERROR";
    const text = typeof error.message === "string" && error.message.trim()
      ? error.message.trim()
      : "Personal browser operation failed.";
    pending.reject(new AppError(code as (typeof errorCodes)[number], text));
  }

  private call<T extends BrowserOperation>(
    operation: T,
    input: unknown,
    context?: OperationContext,
  ): Promise<ReturnType<(typeof browserOperationResultSchemas)[T]["parse"]>> {
    const socket = this.socket;
    const generation = this.socketGeneration;
    if (!socket || socket.readyState !== WebSocket.OPEN || generation === 0) {
      return Promise.reject(
        new AppError(
          "BROWSER_WORKER_UNAVAILABLE",
          "Personal browser mode requires the MCP V3 Chrome extension to be loaded and connected.",
        ),
      );
    }
    if (context?.signal?.aborted) {
      return Promise.reject(
        new AppError("OPERATION_CANCELLED", "Personal browser operation was cancelled."),
      );
    }

    const timeoutMs = resolveCallTimeoutMs(operation, input, context);
    if (timeoutMs <= 0) {
      return Promise.reject(
        new AppError(
          "BROWSER_WORKER_TIMEOUT",
          `Personal browser operation deadline already expired: ${operation}`,
        ),
      );
    }

    const id = randomUUID();
    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    return new Promise((resolve, reject) => {
      const rejectAfterDispatch = (reason: "cancelled" | "timeout") => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timeout);
        pending.abort?.();
        sendCancel(socket, id);
        if (isMutatingOperation(operation)) {
          reject(
            new AppError(
              "EXECUTION_OUTCOME_UNKNOWN",
              `Personal browser mutation outcome is unknown after ${reason}: ${operation}`,
            ),
          );
          return;
        }
        reject(
          reason === "cancelled"
            ? new AppError("OPERATION_CANCELLED", "Personal browser operation was cancelled.")
            : new AppError(
              "BROWSER_WORKER_TIMEOUT",
              `Personal browser operation timed out: ${operation}`,
            ),
        );
      };

      const timeout = setTimeout(
        () => rejectAfterDispatch("timeout"),
        timeoutMs,
      );

      const pending: PendingCall = {
        generation,
        operation,
        timeout,
        resolve: (value) => {
          try {
            resolve(browserOperationResultSchemas[operation].parse(value) as never);
          } catch {
            reject(
              new AppError(
                "RELAY_PROTOCOL_ERROR",
                `Personal browser returned an invalid result for ${operation}.`,
              ),
            );
          }
        },
        reject,
      };

      if (context?.signal) {
        const abort = () => rejectAfterDispatch("cancelled");
        context.signal.addEventListener("abort", abort, { once: true });
        pending.abort = () => context.signal?.removeEventListener("abort", abort);
      }

      this.pending.set(id, pending);
      try {
        socket.send(JSON.stringify({
          type: "request",
          id,
          operation,
          input,
          deadlineAt,
        }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        pending.abort?.();
        reject(
          new AppError("BROWSER_DISCONNECTED", "Failed to dispatch personal browser operation.", {
            cause: error,
          }),
        );
      }
    });
  }

  private rejectPendingForGeneration(generation: number, error: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.abort?.();
      pending.reject(error);
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.abort?.();
      pending.reject(error);
    }
  }
}

async function readOrCreateToken(tokenPath: string): Promise<string> {
  const existing = await readFile(tokenPath, "utf8")
    .then((value) => value.trim())
    .catch(() => "");
  if (TOKEN_PATTERN.test(existing)) return existing;
  const token = randomBytes(32).toString("base64url");
  await writeFile(tokenPath, token + "\n", { encoding: "utf8", mode: 0o600 });
  return token;
}

function resolveCallTimeoutMs(
  operation: BrowserOperation,
  input: unknown,
  context?: OperationContext,
): number {
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (operation === "wait" && isRecord(input) &&
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)) {
    timeoutMs = Math.max(timeoutMs, Math.min(120_000, input.timeoutMs) + 5_000);
  }
  if (operation === "sequence" && isRecord(input) && Array.isArray(input.steps)) {
    const waitBudget = input.steps.reduce((total, step) => {
      if (!isRecord(step) || step.action !== "wait") return total;
      const stepTimeout = typeof step.timeoutMs === "number" && Number.isFinite(step.timeoutMs)
        ? Math.max(1, Math.min(120_000, step.timeoutMs))
        : 30_000;
      return total + stepTimeout;
    }, 0);
    timeoutMs = Math.max(timeoutMs, Math.min(125_000, waitBudget + 5_000));
  }
  const deadlineAt = context?.deadline?.deadlineAt;
  if (deadlineAt) {
    const remainingMs = Date.parse(deadlineAt) - Date.now();
    if (Number.isFinite(remainingMs)) timeoutMs = Math.min(timeoutMs, remainingMs);
  }
  return Math.max(0, Math.floor(timeoutMs));
}

function sendCancel(socket: WebSocket, id: string): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify({ type: "cancel", id }));
  } catch {
    // The original request already has a deterministic terminal result locally.
  }
}

function isMutatingOperation(operation: BrowserOperation): boolean {
  return new Set<BrowserOperation>([
    "open",
    "navigate",
    "click",
    "fill",
    "press",
    "sequence",
    "goBack",
    "goForward",
    "closeTab",
    "finishTask",
  ]).has(operation);
}

function unsupported(operation: string): AppError {
  return new AppError(
    "BROWSER_CAPABILITY_UNSUPPORTED",
    `${operation} is not supported by personal browser mode.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
