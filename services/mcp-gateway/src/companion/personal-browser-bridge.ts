import { createBrowserLatencyRecorder, extensionLatencyMetrics } from "@mcp-access-stack/edge-protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  browserOperationResultSchemas,
  browserPdfTransportResultSchema,
  findBrowserElements,
  projectBrowserSnapshot,
  sanitizeBrowserEvaluation,
  errorCodes,
  type BrowserExecutor,
  type BrowserOperation,
  type OperationContext,
} from "@vs-code-gpt/shared";
import WebSocket, { WebSocketServer } from "ws";
import type {
  PersonalBrowserConnectionInfo,
  PersonalBrowserExecutor,
} from "../browser/browser-mode-router.js";
import {
  buildPersonalBrowserExtensionAssets,
  PERSONAL_BROWSER_CAPABILITIES,
  PERSONAL_BROWSER_REQUIRED_CAPABILITIES,
  PERSONAL_BROWSER_MUTATING_OPERATIONS,
  PERSONAL_BROWSER_PROTOCOL_VERSION,
  PERSONAL_BROWSER_EXTENSION_VERSION,
} from "./personal-browser-extension-assets.js";
import { PersonalBrowserActionPolicy } from "./personal-browser-action-policy.js";
import { PersonalBrowserSnapshotState } from "./personal-browser-snapshot-state.js";

const DEFAULT_PORT = 3361;
const DEFAULT_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 5_000;
// A 12 MiB PDF needs up to 16 MiB of base64 transport. Other results retain their schemas.
const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const ERROR_CODES = new Set<string>(errorCodes);

interface PendingCall {
  generation: number;
  operation: BrowserOperation;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  abort?: () => void;
  timing?: unknown;
  responseBytes?: number;
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
  private readonly actions = new PersonalBrowserActionPolicy();
  private readonly snapshots = new PersonalBrowserSnapshotState();
  private readonly coordinateClicks = new Map<string, { x: number; y: number; ref: string; url: string }>();
  private readonly coordinateDrags = new Map<string, { signature: string; fromRef: string; toRef: string }>();
  private socket: WebSocket | undefined;
  private socketGeneration = 0;
  private nextConnectionGeneration = 0;
  private peerInfo: PersonalBrowserConnectionInfo | undefined;
  private server: WebSocketServer | undefined;
  private token = "";
  private closed = false;
  private readonly recordLatency: ReturnType<typeof createBrowserLatencyRecorder>;

  private constructor(private readonly options: PersonalBrowserBridgeOptions) {
    this.recordLatency = createBrowserLatencyRecorder(e => options.log?.(e), "bridge");
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
    return this.socket?.readyState === WebSocket.OPEN && this.peerInfo !== undefined;
  }

  connectionInfo(): PersonalBrowserConnectionInfo {
    if (this.isConnected() && this.peerInfo) {
      return {
        ...this.peerInfo,
        capabilities: [...this.peerInfo.capabilities],
        expectedExtensionVersion: PERSONAL_BROWSER_EXTENSION_VERSION,
      };
    }
    return {
      connected: false,
      browser: "chrome",
      profile: "personal",
      protocolVersion: PERSONAL_BROWSER_PROTOCOL_VERSION,
      capabilities: [...PERSONAL_BROWSER_CAPABILITIES],
      expectedExtensionVersion: PERSONAL_BROWSER_EXTENSION_VERSION,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket;
    this.socket = undefined;
    this.socketGeneration = 0;
    this.peerInfo = undefined;
    this.actions.clear();
    this.snapshots.clear();
    this.coordinateClicks.clear();
    this.coordinateDrags.clear();
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

  async selectTab(...args: Parameters<BrowserExecutor["selectTab"]>): ReturnType<BrowserExecutor["selectTab"]> {
    const result = await this.call("selectTab", args[0], args[1]);
    this.actions.observeTab(result.tab);
    return result;
  }

  async viewport(...args: Parameters<BrowserExecutor["viewport"]>): ReturnType<BrowserExecutor["viewport"]> {
    return this.call("viewport", args[0], args[1]);
  }

  async dialog(...args: Parameters<BrowserExecutor["dialog"]>): ReturnType<BrowserExecutor["dialog"]> {
    const [input, context] = args;
    if (input.action === "respond") {
      const observed = await this.call("dialog", { tabId: input.tabId, action: "inspect" }, context);
      if (observed.state !== "open" || observed.message !== input.expectedMessage) {
        throw new AppError("BROWSER_CONFIRMATION_INVALID", "Inspected dialog changed before response.");
      }
      this.actions.authorizeDialogResponse(input, observed);
    }
    return this.call("dialog", input, context);
  }

  async open(...args: Parameters<BrowserExecutor["open"]>): ReturnType<BrowserExecutor["open"]> {
    const result = await this.call("open", args[0], args[1]);
    this.actions.observeTab(result.tab);
    return result;
  }

  openAuthorizedSite(
    ..._args: Parameters<BrowserExecutor["openAuthorizedSite"]>
  ): ReturnType<BrowserExecutor["openAuthorizedSite"]> {
    throw unsupported("browser_open_authorized_site");
  }

  async navigate(...args: Parameters<BrowserExecutor["navigate"]>): ReturnType<BrowserExecutor["navigate"]> {
    const result = await this.call("navigate", args[0], args[1]);
    this.actions.discard([args[0].tabId]);
    this.snapshots.discard(args[0].tabId);
    this.coordinateClicks.delete(args[0].tabId);
    this.coordinateDrags.delete(args[0].tabId);
    this.actions.observeTab(result.tab);
    return result;
  }

  async snapshot(...args: Parameters<BrowserExecutor["snapshot"]>): ReturnType<BrowserExecutor["snapshot"]> {
    const [input, context] = args;
    if (input.includeAccessibility && !this.peerInfo?.capabilities.includes("cdpAccessibilityV1")) {
      throw new AppError("BROWSER_CAPABILITY_UNSUPPORTED", "Personal Chrome extension must support cdpAccessibilityV1. Reload the updated extension.");
    }
    const filtered = input.filter !== undefined || input.depth !== undefined ||
      input.refId !== undefined || input.maxChars !== undefined || input.point !== undefined;
    const result = await this.call("snapshot", {
      tabId: input.tabId,
      ...(filtered || input.forceFull ? { forceFull: true } : {}),
      ...(input.includeAccessibility ? { includeAccessibility: true } : {}),
      ...(input.point ? { point: input.point } : {}),
    }, context);
    // The original authenticated refs, not the projected text, own the guards.
    this.actions.observeSnapshot(result);
    const tracked = this.snapshots.observe(result, {
      ...input,
      ...(filtered ? { forceFull: true } : {}),
    });
    return projectBrowserSnapshot(tracked, input);
  }

  async find(...args: Parameters<BrowserExecutor["find"]>): ReturnType<BrowserExecutor["find"]> {
    // Refresh through the extension on each search: returned refs are live and
    // stay under the same tab ownership and navigation checks as snapshots.
    const [input, context] = args;
    const snapshot = await this.snapshot({ tabId: input.tabId, forceFull: true }, context);
    return {
      tabId: input.tabId,
      url: snapshot.url,
      matches: findBrowserElements(snapshot.refs, input.query, input.role, input.limit),
    };
  }

  async evaluate(...args: Parameters<BrowserExecutor["evaluate"]>): ReturnType<BrowserExecutor["evaluate"]> {
    const guard = this.actions.guardEvaluate(args[0]);
    const output = await this.call("evaluate", { ...args[0], guard }, args[1]);
    return { tabId: args[0].tabId, value: sanitizeBrowserEvaluation(output.value) };
  }

  async click(...args: Parameters<BrowserExecutor["click"]>): ReturnType<BrowserExecutor["click"]> {
    this.requireGuardedActions();
    const [input, context] = args;
    let ref = input.ref;
    if (!ref) {
      if (input.x === undefined || input.y === undefined) {
        throw new AppError("INVALID_ARGUMENT", "Provide ref or viewport CSS x/y coordinates.");
      }
      let point = this.coordinateClicks.get(input.tabId);
      if (!point || point.x !== input.x || point.y !== input.y) {
        const snapshot = await this.snapshot({
          tabId: input.tabId, point: { x: input.x, y: input.y }, forceFull: true,
        }, context);
        if (!snapshot.pointTarget) throw new AppError("LOCATOR_NOT_FOUND", "No observed control at those coordinates.");
        point = { x: input.x, y: input.y, ref: snapshot.pointTarget.ref, url: snapshot.url };
        this.coordinateClicks.set(input.tabId, point);
      }
      ref = point.ref;
    }
    const guardedInput = { ...input, ref };
    const guard = this.actions.guardClick(guardedInput);
    try {
      const result = await this.call("click", { ...guardedInput, guard }, context);
      this.coordinateClicks.delete(input.tabId);
      return result;
    } catch (error) {
      this.coordinateClicks.delete(input.tabId);
      throw error;
    }
  }

  async hover(...args: Parameters<BrowserExecutor["hover"]>): ReturnType<BrowserExecutor["hover"]> {
    this.requireGuardedActions();
    const [input, context] = args;
    let ref = input.ref;
    if (!ref) {
      if (input.x === undefined || input.y === undefined) {
        throw new AppError("INVALID_ARGUMENT", "Provide ref or viewport CSS x/y coordinates.");
      }
      const snapshot = await this.snapshot({
        tabId: input.tabId, point: { x: input.x, y: input.y }, forceFull: true,
      }, context);
      ref = snapshot.pointTarget?.ref;
      if (!ref) throw new AppError("LOCATOR_NOT_FOUND", "No observed control at those coordinates.");
    }
    const guard = this.actions.guardReference(input.tabId, ref);
    return this.call("hover", { ...input, ref, guard }, context);
  }

  async drag(...args: Parameters<BrowserExecutor["drag"]>): ReturnType<BrowserExecutor["drag"]> {
    this.requireGuardedActions();
    const [input, context] = args;
    const signature = JSON.stringify([input.from, input.to]);
    let cached = this.coordinateDrags.get(input.tabId);
    if (!cached || cached.signature !== signature) {
      const resolve = async (endpoint: typeof input.from): Promise<string> => {
        if ("ref" in endpoint) return endpoint.ref;
        const snapshot = await this.snapshot({
          tabId: input.tabId, point: { x: endpoint.x, y: endpoint.y }, forceFull: true,
        }, context);
        if (!snapshot.pointTarget) {
          throw new AppError("LOCATOR_NOT_FOUND", "No observed interactive control at the drag endpoint.");
        }
        return snapshot.pointTarget.ref;
      };
      const fromRef = await resolve(input.from);
      const toRef = await resolve(input.to);
      cached = { signature, fromRef, toRef };
      this.coordinateDrags.set(input.tabId, cached);
    }
    const from = { ...input.from, ref: cached.fromRef };
    const to = { ...input.to, ref: cached.toRef };
    const resolved = { ...input, from, to };
    const guards = this.actions.guardDrag(resolved);
    try {
      const result = await this.call("drag", { ...resolved, ...guards }, context);
      this.coordinateDrags.delete(input.tabId);
      return result;
    } catch (error) {
      this.coordinateDrags.delete(input.tabId);
      throw error;
    }
  }

  async scroll(...args: Parameters<BrowserExecutor["scroll"]>): ReturnType<BrowserExecutor["scroll"]> {
    const guard = args[0].ref
      ? this.actions.guardReference(args[0].tabId, args[0].ref)
      : this.actions.guardPage(args[0].tabId);
    return this.call("scroll", { ...args[0], guard }, args[1]);
  }

  async fill(...args: Parameters<BrowserExecutor["fill"]>): ReturnType<BrowserExecutor["fill"]> {
    this.requireGuardedActions();
    const guard = this.actions.guardFill(args[0]);
    return this.call("fill", { ...args[0], guard }, args[1]);
  }

  async formInput(...args: Parameters<BrowserExecutor["formInput"]>): ReturnType<BrowserExecutor["formInput"]> {
    this.requireGuardedActions();
    const guard = this.actions.guardFormInput(args[0]);
    return this.call("formInput", { ...args[0], guard }, args[1]);
  }

  async type(...args: Parameters<BrowserExecutor["type"]>): ReturnType<BrowserExecutor["type"]> {
    this.requireGuardedActions();
    const guard = this.actions.guardType(args[0]);
    return this.call("type", { ...args[0], guard }, args[1]);
  }

  async press(...args: Parameters<BrowserExecutor["press"]>): ReturnType<BrowserExecutor["press"]> {
    this.requireGuardedActions();
    const guard = this.actions.guardPress(args[0]);
    return this.call("press", { ...args[0], guard }, args[1]);
  }

  wait(...args: Parameters<BrowserExecutor["wait"]>): ReturnType<BrowserExecutor["wait"]> {
    return this.call("wait", args[0], args[1]);
  }

  extract(...args: Parameters<BrowserExecutor["extract"]>): ReturnType<BrowserExecutor["extract"]> {
    return this.call("extract", args[0], args[1]);
  }

  async sequence(...args: Parameters<BrowserExecutor["sequence"]>): ReturnType<BrowserExecutor["sequence"]> {
    this.requireGuardedActions();
    const steps = this.actions.guardSequence(args[0]);
    return this.call("sequence", { ...args[0], steps }, args[1]);
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

  async screenshot(
    ...args: Parameters<BrowserExecutor["screenshot"]>
  ): ReturnType<BrowserExecutor["screenshot"]> {
    const result = await this.call("screenshot", args[0], args[1]);
    const transport = result as typeof result & {
      mimeType?: string;
      contentBase64?: string;
    };
    if (!transport.mimeType || !transport.contentBase64) {
      throw new AppError(
        "RELAY_PROTOCOL_ERROR",
        "Personal browser screenshot returned no image payload.",
      );
    }
    const bytes = Buffer.from(transport.contentBase64, "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== transport.contentBase64) {
      throw new AppError(
        "RELAY_PROTOCOL_ERROR",
        "Personal browser screenshot returned invalid base64 image data.",
      );
    }
    const extension = transport.mimeType === "image/png"
      ? "png"
      : transport.mimeType === "image/webp"
        ? "webp"
        : "jpg";
    const directory = path.join(
      path.resolve(this.options.stateRoot),
      "browser",
      "personal-artifacts",
      "screenshots",
    );
    await mkdir(directory, { recursive: true });
    const absolutePath = path.join(directory, `${randomUUID()}.${extension}`);
    await writeFile(absolutePath, bytes, { mode: 0o600 });
    return {
      ...transport,
      path: absolutePath,
      sizeBytes: bytes.length,
    };
  }

  async goBack(...args: Parameters<BrowserExecutor["goBack"]>): ReturnType<BrowserExecutor["goBack"]> {
    const result = await this.call("goBack", args[0], args[1]);
    this.actions.discard([args[0].tabId]);
    this.snapshots.discard(args[0].tabId);
    this.coordinateClicks.delete(args[0].tabId);
    this.coordinateDrags.delete(args[0].tabId);
    this.actions.observeTab(result.tab);
    return result;
  }

  async goForward(
    ...args: Parameters<BrowserExecutor["goForward"]>
  ): ReturnType<BrowserExecutor["goForward"]> {
    const result = await this.call("goForward", args[0], args[1]);
    this.actions.discard([args[0].tabId]);
    this.snapshots.discard(args[0].tabId);
    this.coordinateClicks.delete(args[0].tabId);
    this.coordinateDrags.delete(args[0].tabId);
    this.actions.observeTab(result.tab);
    return result;
  }

  async closeTab(...args: Parameters<BrowserExecutor["closeTab"]>): ReturnType<BrowserExecutor["closeTab"]> {
    const result = await this.call("closeTab", args[0], args[1]);
    this.actions.discard([args[0].tabId]);
    this.snapshots.discard(args[0].tabId);
    return result;
  }

  async finishTask(
    ...args: Parameters<BrowserExecutor["finishTask"]>
  ): ReturnType<BrowserExecutor["finishTask"]> {
    const result = await this.call("finishTask", args[0], args[1]);
    this.actions.finish(args[0].taskId);
    for (const tabId of [...(result.closedTabIds ?? []), ...(result.releasedTabIds ?? [])]) {
      this.snapshots.discard(tabId);
    }
    if (!args[0].taskId) this.snapshots.clear();
    return result;
  }

  download(
    ..._args: Parameters<BrowserExecutor["download"]>
  ): ReturnType<BrowserExecutor["download"]> {
    throw unsupported("browser_download");
  }

  upload(..._args: Parameters<BrowserExecutor["upload"]>): ReturnType<BrowserExecutor["upload"]> {
    throw unsupported("browser_upload");
  }

  async console(...args: Parameters<BrowserExecutor["console"]>): ReturnType<BrowserExecutor["console"]> {
    return this.call("console", args[0], args[1]);
  }

  async networkList(...args: Parameters<BrowserExecutor["networkList"]>): ReturnType<BrowserExecutor["networkList"]> {
    return this.call("networkList", args[0], args[1]);
  }

  async networkInspect(...args: Parameters<BrowserExecutor["networkInspect"]>): ReturnType<BrowserExecutor["networkInspect"]> {
    return this.call("networkInspect", args[0], args[1]);
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

  async pdf(...args: Parameters<BrowserExecutor["pdf"]>): ReturnType<BrowserExecutor["pdf"]> {
    const [input, context] = args;
    const transport = await this.call("pdf", input, context) as {
      tabId: string; kind: "pdf"; contentBase64?: string; sizeBytes?: number; createdAt: string;
    };
    if (transport.kind !== "pdf" || !transport.contentBase64 ||
        transport.contentBase64.length > 17 * 1024 * 1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(transport.contentBase64)) {
      throw new AppError("RELAY_PROTOCOL_ERROR", "Chrome returned an invalid PDF payload.");
    }
    const bytes = Buffer.from(transport.contentBase64, "base64");
    if (bytes.length < 8 || bytes.length > 12 * 1024 * 1024 ||
        bytes.subarray(0, 5).toString("ascii") !== "%PDF-" ||
        bytes.toString("base64") !== transport.contentBase64 ||
        bytes.length !== transport.sizeBytes) {
      throw new AppError("RELAY_PROTOCOL_ERROR", "Chrome PDF failed private artifact integrity checks.");
    }
    if (input.filename && (input.filename.includes("/") || input.filename.includes("\\") ||
        input.filename.includes("..") || /[\r\n\0]/u.test(input.filename))) {
      throw new AppError("INVALID_ARGUMENT", "PDF filename must not contain path separators.");
    }
    const directory = path.join(
      path.resolve(this.options.stateRoot), "browser", "personal-artifacts", "pdfs",
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const filename = `${randomUUID()}-${input.filename ?? "page.pdf"}`;
    const absolutePath = path.join(directory, filename);
    await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
    return { tabId: input.tabId, kind: "pdf", path: absolutePath,
      sizeBytes: bytes.length, createdAt: transport.createdAt };
  }

  async diagnostics(
    ...args: Parameters<BrowserExecutor["diagnostics"]>
  ): ReturnType<BrowserExecutor["diagnostics"]> {
    const [input, context] = args;
    // These reads share a Chrome debugger target: never start both simultaneously.
    const consoleResult = await this.console({
      tabId: input.tabId,
      ...(input.consoleLevel === undefined ? {} : { level: input.consoleLevel }),
      ...(input.clearAfterRead === undefined ? {} : { clear: input.clearAfterRead }),
    }, context);
    const networkResult = await this.networkList({
      tabId: input.tabId,
      ...(input.requestFilter === undefined ? {} : { filter: input.requestFilter }),
      ...(input.includeStaticRequests === undefined ? {} : { includeStatic: input.includeStaticRequests }),
      ...(input.clearAfterRead === undefined ? {} : { clear: input.clearAfterRead }),
    }, context);
    return {
      tabId: input.tabId,
      console: {
        text: consoleResult.text, truncated: consoleResult.truncated,
        collectedAt: consoleResult.collectedAt,
      },
      network: {
        text: networkResult.text, truncated: networkResult.truncated,
        collectedAt: networkResult.collectedAt,
      },
      traceActive: false, videoActive: false,
      collectedAt: new Date().toISOString(),
    };
  }

  private async initialize(): Promise<void> {
    const personalRoot = path.dirname(this.extensionDirectory);
    const tokenPath = path.join(personalRoot, "bridge-token.txt");
    await mkdir(this.extensionDirectory, { recursive: true });
    this.token = await readOrCreateToken(tokenPath);
    const blockedPrivateOrigins = await readPrivateSiteOrigins(this.options.stateRoot);
    const assets = buildPersonalBrowserExtensionAssets(
      this.token,
      this.port,
      blockedPrivateOrigins,
    );
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
      writeFile(
        path.join(this.extensionDirectory, "secret-provision.html"),
        assets.popupHtml,
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(
        path.join(this.extensionDirectory, "secret-provision.js"),
        assets.popupScript,
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
      let activated = false;
      const handshakeTimeout = setTimeout(() => {
        if (!activated && socket.readyState < WebSocket.CLOSING) {
          socket.close(1008, "personal browser handshake timeout");
        }
      }, HANDSHAKE_TIMEOUT_MS);
      handshakeTimeout.unref();

      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const raw = data.toString();
        if (!activated) {
          const peerInfo = parsePersonalBrowserHello(raw);
          if (!peerInfo) {
            clearTimeout(handshakeTimeout);
            socket.close(1008, "incompatible personal browser extension");
            return;
          }
          activated = true;
          clearTimeout(handshakeTimeout);
          const previous = this.socket;
          const previousGeneration = this.socketGeneration;
          this.socket = socket;
          this.socketGeneration = generation;
          this.peerInfo = peerInfo;
          this.actions.clear();
          this.snapshots.clear();
          this.coordinateClicks.clear();
          this.coordinateDrags.clear();
          if (previous && previous !== socket) {
            this.rejectPendingForGeneration(
              previousGeneration,
              new AppError(
                "BROWSER_DISCONNECTED",
                "The MCP V3 personal Chrome extension connection was replaced.",
              ),
            );
            if (previous.readyState < WebSocket.CLOSING) {
              previous.close(4000, "personal browser connection replaced");
            }
          }
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              type: "hello-ack",
              protocolVersion: PERSONAL_BROWSER_PROTOCOL_VERSION,
            }));
          }
          this.options.log?.({
            event: "mcp_v3_personal_browser_connected",
            port: this.port,
            generation,
            protocolVersion: peerInfo.protocolVersion,
            extensionVersion: peerInfo.extensionVersion,
            capabilities: peerInfo.capabilities,
          });
          return;
        }
        if (this.socket !== socket || this.socketGeneration !== generation) return;
        this.handleMessage(socket, generation, raw);
      });
      socket.once("close", () => {
        clearTimeout(handshakeTimeout);
        const wasActive = this.socket === socket;
        if (wasActive) {
          this.socket = undefined;
          this.socketGeneration = 0;
          this.peerInfo = undefined;
          this.actions.clear();
          this.snapshots.clear();
          this.coordinateClicks.clear();
          this.coordinateDrags.clear();
          this.rejectPendingForGeneration(
            generation,
            new AppError(
              "BROWSER_DISCONNECTED",
              "The MCP V3 personal Chrome extension disconnected.",
            ),
          );
        }
        this.options.log?.({
          event: "mcp_v3_personal_browser_disconnected",
          generation,
          activated: wasActive,
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
    if (Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024 && pending.operation !== "pdf") {
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      pending.abort?.();
      pending.reject(new AppError("RELAY_PROTOCOL_ERROR", "Personal browser returned an oversized payload."));
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    pending.abort?.();
    pending.timing = message.timing;
    pending.responseBytes = Buffer.byteLength(raw, "utf8");

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

  private requireGuardedActions(): void {
    if (!this.peerInfo?.capabilities.includes("guardedActionsV1")) {
      throw new AppError("BROWSER_CAPABILITY_UNSUPPORTED",
        `The personal Chrome extension ${this.peerInfo?.extensionVersion ?? "unknown"} must be reloaded with guardedActionsV1 before interaction.`);
    }
  }

  private call<T extends BrowserOperation>(
    operation: T,
    input: unknown,
    context?: OperationContext,
  ): Promise<ReturnType<(typeof browserOperationResultSchemas)[T]["parse"]>> {
    const id = randomUUID();
    const started = performance.now();
    const latency = this.recordLatency({ requestId: context?.latency?.requestId ?? context?.invocationId ?? id,
      ...context?.latency, ...(context?.invocationId ? { invocationId: context.invocationId } : {}), bridgeRequestId: id }, operation);
    let pendingMetrics: PendingCall | undefined;
    const metrics: Record<string, unknown> = {};
    const gatewayStartedAt = context?.latency?.gatewayStartedAt;
    if (typeof gatewayStartedAt === "number" && Number.isFinite(gatewayStartedAt) && gatewayStartedAt <= started) metrics.gatewayBeforeBridgeMs = started - gatewayStartedAt;
    const fail = (error: Error, outcome: "error" | "cancelled" | "timeout" = "error") => {
      const code = error instanceof AppError && ERROR_CODES.has(error.code) ? error.code : "INTERNAL_ERROR";
      latency.finish(outcome, { ...metrics, responseBytes: pendingMetrics?.responseBytes,
        ...extensionLatencyMetrics(pendingMetrics?.timing), errorCode: code });
      return error;
    };
    const socket = this.socket;
    const generation = this.socketGeneration;
    const peerInfo = this.peerInfo;
    if (!socket || socket.readyState !== WebSocket.OPEN || generation === 0 || !peerInfo) {
      return Promise.reject(
        fail(new AppError(
          "BROWSER_WORKER_UNAVAILABLE",
          "Personal browser mode requires the MCP V3 Chrome extension to be loaded and connected.",
        )),
      );
    }
    if (!peerInfo.capabilities.includes(operation)) {
      return Promise.reject(fail(new AppError(
        "BROWSER_CAPABILITY_UNSUPPORTED",
        `browser_${operation} requires capability ${operation}; personal Chrome extension ${peerInfo.extensionVersion ?? "unknown"} does not offer it.`,
      )));
    }
    if (context?.signal?.aborted) {
      return Promise.reject(
        fail(new AppError("OPERATION_CANCELLED", "Personal browser operation was cancelled."), "cancelled"),
      );
    }

    const timeoutMs = resolveCallTimeoutMs(operation, input, context);
    if (timeoutMs <= 0) {
      return Promise.reject(
        fail(new AppError(
          "BROWSER_WORKER_TIMEOUT",
          `Personal browser operation deadline already expired: ${operation}`,
        ), "timeout"),
      );
    }

    const deadlineAt = new Date(Date.now() + timeoutMs).toISOString();
    return new Promise((resolve, reject) => {
      const rejectWithTiming = (error: Error, outcome?: "cancelled" | "timeout") => reject(fail(error, outcome));
      const rejectAfterDispatch = (reason: "cancelled" | "timeout") => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timeout);
        pending.abort?.();
        sendCancel(socket, id);
        if (isMutatingOperation(operation)) {
          rejectWithTiming(
            new AppError(
              "EXECUTION_OUTCOME_UNKNOWN",
              `Personal browser mutation outcome is unknown after ${reason}: ${operation}`,
            ), reason === "cancelled" ? "cancelled" : "timeout",
          );
          return;
        }
        rejectWithTiming(
          reason === "cancelled"
            ? new AppError("OPERATION_CANCELLED", "Personal browser operation was cancelled.")
            : new AppError(
              "BROWSER_WORKER_TIMEOUT",
              `Personal browser operation timed out: ${operation}`,
            ), reason === "cancelled" ? "cancelled" : "timeout",
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
            const parsed = operation === "pdf"
              ? browserPdfTransportResultSchema.parse(value)
              : browserOperationResultSchemas[operation].parse(value);
            latency.finish("success", { ...metrics, responseBytes: pending.responseBytes, ...extensionLatencyMetrics(pending.timing) });
            resolve(parsed as never);
          } catch {
            rejectWithTiming(
              new AppError(
                "RELAY_PROTOCOL_ERROR",
                `Personal browser returned an invalid result for ${operation}.`,
              ),
            );
          }
        },
        reject: rejectWithTiming,
      };
      pendingMetrics = pending;

      if (context?.signal) {
        const abort = () => rejectAfterDispatch("cancelled");
        context.signal.addEventListener("abort", abort, { once: true });
        pending.abort = () => context.signal?.removeEventListener("abort", abort);
      }

      this.pending.set(id, pending);
      try {
        const wire = JSON.stringify({
          type: "request",
          id,
          operation,
          input,
          deadlineAt,
          measureTiming: latency.enabled,
        });
        metrics.requestBytes = Buffer.byteLength(wire, "utf8");
        metrics.dispatchMs = performance.now() - started;
        socket.send(wire);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timeout);
        pending.abort?.();
        rejectWithTiming(
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

function parsePersonalBrowserHello(raw: string): PersonalBrowserConnectionInfo | undefined {
  if (Buffer.byteLength(raw, "utf8") > MAX_PAYLOAD_BYTES) return undefined;
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(message) || message.type !== "hello") return undefined;
  if (message.protocolVersion !== PERSONAL_BROWSER_PROTOCOL_VERSION) return undefined;
  if (message.browser !== "chrome" || message.profile !== "personal") return undefined;
  if (typeof message.extensionVersion !== "string" ||
      message.extensionVersion.length < 1 || message.extensionVersion.length > 100) {
    return undefined;
  }
  if (!Array.isArray(message.capabilities) || message.capabilities.length > 64) return undefined;
  const capabilities = message.capabilities.filter(
    (value): value is string => typeof value === "string" && value.length > 0 && value.length <= 64,
  );
  if (capabilities.length !== message.capabilities.length) return undefined;
  const uniqueCapabilities = new Set(capabilities);
  if (uniqueCapabilities.size !== capabilities.length) return undefined;
  // Capability negotiation is additive: an older extension may lack optional
  // operations, and a newer extension may advertise capabilities unknown here.
  // Only the stable core is mandatory; unsupported calls fail individually.
  if (PERSONAL_BROWSER_REQUIRED_CAPABILITIES.some(
    (capability) => !uniqueCapabilities.has(capability),
  )) return undefined;
  return {
    connected: true,
    browser: "chrome",
    profile: "personal",
    protocolVersion: PERSONAL_BROWSER_PROTOCOL_VERSION,
    extensionVersion: message.extensionVersion,
    capabilities: [...capabilities],
  };
}

async function readPrivateSiteOrigins(stateRoot: string): Promise<string[]> {
  const policyPath = path.join(
    path.resolve(stateRoot),
    "browser",
    "private",
    "site-policies.json",
  );
  let raw: string;
  try {
    raw = await readFile(policyPath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw new AppError(
      "EXECUTION_STATE_INVALID",
      "Unable to read Browser private-site policies for personal mode.",
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError(
      "EXECUTION_STATE_INVALID",
      "Browser private-site policies contain invalid JSON.",
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new AppError(
      "EXECUTION_STATE_INVALID",
      "Browser private-site policies must be an array.",
    );
  }

  const origins = new Set<string>();
  const addOrigin = (value: unknown) => {
    if (typeof value !== "string") return;
    try {
      origins.add(new URL(value).origin);
    } catch {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Browser private-site policy contains an invalid URL.",
      );
    }
  };
  for (const policy of parsed) {
    if (!isRecord(policy)) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Browser private-site policy entry must be an object.",
      );
    }
    addOrigin(policy.entryUrl);
    if (Array.isArray(policy.allowedOrigins)) {
      for (const origin of policy.allowedOrigins) addOrigin(origin);
    }
  }
  return [...origins].sort();
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

const PERSONAL_MUTATIONS: ReadonlySet<BrowserOperation> = new Set(PERSONAL_BROWSER_MUTATING_OPERATIONS);

function isMutatingOperation(operation: BrowserOperation): boolean {
  return PERSONAL_MUTATIONS.has(operation);
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
