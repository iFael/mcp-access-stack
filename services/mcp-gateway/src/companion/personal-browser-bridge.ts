import { createBrowserLatencyRecorder, extensionLatencyMetrics } from "@mcp-access-stack/edge-protocol";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  AppError,
  browserOperationResultSchemas,
  containsBrowserEnterKey,
  browserPdfTransportResultSchema,
  findBrowserElements,
  projectBrowserSnapshot,
  sanitizeBrowserEvaluation,
  errorCodes,
  type BrowserConfirmationCategory,
  type BrowserExecutor,
  type BrowserDragInput,
  type BrowserFrameSequenceInput,
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
import {
  PERSONAL_SITE_APPROVABLE_CATEGORIES,
  PersonalBrowserActionPolicy,
  type PersonalLegacyFrameTarget,
  type PersonalSiteApprovalRequest,
  type PersonalSiteApprovals,
  type PersonalSiteGrant,
} from "./personal-browser-action-policy.js";
import {
  PersonalBrowserRecorder,
  personalRecordingTransportSchema,
} from "./personal-browser-recording.js";
import { PersonalBrowserSnapshotState } from "./personal-browser-snapshot-state.js";
import type { ChatWake, ChatWakeOutcome, ChatWakeStatus } from "./chat-wake.js";
import { PersonalBrowserTaskInbox } from "./personal-browser-task-inbox.js";

const DEFAULT_PORT = 3361;
const DEFAULT_TIMEOUT_MS = 60_000;
const STAGED_UPLOAD_RETENTION_MS = 30 * 60 * 1_000;
const MAX_UPLOADABLE_SCREENSHOTS = 200;
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
  /** Called whenever the number of popup messages waiting for the agent changes. */
  onUserMessagesPending?: (pending: number) => void;
  /** Wakes the ChatGPT conversation when a message or a handed-back tab waits for the agent. */
  chatWake?: Pick<ChatWake, "queue" | "resolveHandback" | "setEnabled">;
}

export class PersonalBrowserBridge implements PersonalBrowserExecutor {
  readonly extensionDirectory: string;
  readonly port: number;

  private readonly pending = new Map<string, PendingCall>();
  private readonly actions = new PersonalBrowserActionPolicy((request) => this.requestSiteApproval(request));
  private readonly snapshots = new PersonalBrowserSnapshotState();
  private readonly inbox = new PersonalBrowserTaskInbox();
  private readonly chromeWakes = new Map<string, (outcome: ChatWakeOutcome) => void>();
  private readonly recorder: PersonalBrowserRecorder;
  private readonly coordinateClicks = new Map<string, { x: number; y: number; ref?: string; url: string; pixel?: true }>();
  private readonly pixelEvidence = new Map<string, { url: string; observedAt: number }>();
  private readonly coordinateDrags = new Map<string, {
    signature: string;
    from: { ref: string; x?: number; y?: number } | { x: number; y: number };
    to: { ref: string; x?: number; y?: number } | { x: number; y: number };
  }>();
  // Chrome reads uploaded files lazily (drop handlers, later form submits), so
  // staged copies outlive the call until their tab closes or retention ends.
  private readonly stagedUploads = new Map<string, { tabId: string; timer: NodeJS.Timeout }>();
  // Only screenshots this bridge captured may be uploaded by path.
  private readonly uploadableScreenshots = new Set<string>();
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
    this.recorder = new PersonalBrowserRecorder(
      path.join(path.resolve(options.stateRoot), "browser", "personal-artifacts"),
      {
        start: (input, context) => this.call("videoStart", input, context),
        stop: (input, context) => this.call("videoStop", input, context),
      },
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
    this.pixelEvidence.clear();
    this.coordinateDrags.clear();
    await this.releaseStagedUploads();
    await this.recorder.close();
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
    this.pixelEvidence.delete(args[0].tabId);
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
        if (snapshot.pointTarget) {
          point = { x: input.x, y: input.y, ref: snapshot.pointTarget.ref, url: snapshot.url };
        } else {
          const evidence = this.pixelEvidence.get(input.tabId);
          if (!evidence || evidence.url !== snapshot.url || Date.now() - evidence.observedAt > 60_000) {
            throw new AppError("ACTION_BLOCKED_BY_POLICY",
              "Capture a fresh browser_screenshot on the current tab before clicking a pixel with no semantic reference.");
          }
          point = { x: input.x, y: input.y, url: snapshot.url, pixel: true };
        }
        this.coordinateClicks.set(input.tabId, point);
      }
      if (point.pixel) {
        const evidence = this.pixelEvidence.get(input.tabId);
        if (!evidence || evidence.url !== point.url || Date.now() - evidence.observedAt > 60_000) {
          this.coordinateClicks.delete(input.tabId);
          throw new AppError("ACTION_BLOCKED_BY_POLICY", "Pixel click requires a screenshot captured in the past minute.");
        }
        const guard = this.actions.guardPixelClick(input, point.url);
        try {
          const result = await this.call("click", { ...input, guard }, context);
          this.coordinateClicks.delete(input.tabId);
          return result;
        } catch (error) {
          this.coordinateClicks.delete(input.tabId);
          throw error;
        }
      }
      ref = point.ref;
    }
    if (!ref) throw new AppError("LOCATOR_NOT_FOUND", "Missing actionable browser target.");
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
    const signature = JSON.stringify([input.from, input.to, input.steps ?? 10]);
    let cached = this.coordinateDrags.get(input.tabId);
    if (!cached || cached.signature !== signature) {
      const resolve = async (endpoint: BrowserDragInput["from"]) => {
        if ("ref" in endpoint) return { ref: endpoint.ref };
        const snapshot = await this.snapshot({
          tabId: input.tabId, point: { x: endpoint.x, y: endpoint.y }, forceFull: true,
        }, context);
        if (snapshot.pointTarget) {
          return { x: endpoint.x, y: endpoint.y, ref: snapshot.pointTarget.ref };
        }
        const evidence = this.pixelEvidence.get(input.tabId);
        if (!evidence || evidence.url !== snapshot.url || Date.now() - evidence.observedAt > 60_000) {
          throw new AppError("ACTION_BLOCKED_BY_POLICY",
            "Capture a fresh browser_screenshot before dragging a pixel with no semantic reference.");
        }
        return { x: endpoint.x, y: endpoint.y };
      };
      cached = { signature, from: await resolve(input.from), to: await resolve(input.to) };
      this.coordinateDrags.set(input.tabId, cached);
    }
    const resolved = { ...input, from: cached.from, to: cached.to };
    const hasPixel = !("ref" in cached.from) || !("ref" in cached.to);
    let guards: { fromGuard: import("./personal-browser-action-policy.js").PersonalActionGuard;
      toGuard: import("./personal-browser-action-policy.js").PersonalActionGuard };
    if (hasPixel) {
      const evidence = this.pixelEvidence.get(input.tabId);
      if (!evidence || Date.now() - evidence.observedAt > 60_000) {
        this.coordinateDrags.delete(input.tabId);
        throw new AppError("ACTION_BLOCKED_BY_POLICY", "Pixel drag requires a screenshot from the past minute.");
      }
      guards = this.actions.guardPixelDrag(resolved, evidence.url);
    } else {
      guards = this.actions.guardDrag(resolved);
    }
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

  async wait(...args: Parameters<BrowserExecutor["wait"]>): ReturnType<BrowserExecutor["wait"]> {
    const result = await this.call("wait", args[0], args[1]);
    if (args[0].forUser !== undefined && result.completed === true) this.options.chatWake?.resolveHandback(args[0].tabId);
    if (args[0].forUser !== undefined) {
      // The user may have navigated or changed the page while they had the turn.
      const tabId = args[0].tabId;
      this.actions.discard([tabId]);
      this.snapshots.discard(tabId);
      this.coordinateClicks.delete(tabId);
      this.pixelEvidence.delete(tabId);
      this.coordinateDrags.delete(tabId);
    }
    return result;
  }

  extract(...args: Parameters<BrowserExecutor["extract"]>): ReturnType<BrowserExecutor["extract"]> {
    return this.call("extract", args[0], args[1]);
  }

  async sequence(...args: Parameters<BrowserExecutor["sequence"]>): ReturnType<BrowserExecutor["sequence"]> {
    this.requireGuardedActions();
    const [input, context] = args;
    const resolvePoint = async (x: number, y: number): Promise<string> => {
      const snapshot = await this.snapshot({
        tabId: input.tabId, point: { x, y }, forceFull: true,
      }, context);
      if (!snapshot.pointTarget?.ref) {
        throw new AppError("LOCATOR_NOT_FOUND", "Sequence point does not resolve to a current actionable control.");
      }
      return snapshot.pointTarget.ref;
    };
    const resolvedSteps: typeof input.steps = [];
    for (const step of input.steps) {
      if (step.action === "hover" && !step.ref && step.x !== undefined && step.y !== undefined) {
        resolvedSteps.push({ ...step, ref: await resolvePoint(step.x, step.y) });
      } else if (step.action === "drag") {
        const from = "ref" in step.from ? step.from : { ...step.from,
          ref: await resolvePoint(step.from.x, step.from.y) };
        const to = "ref" in step.to ? step.to : { ...step.to,
          ref: await resolvePoint(step.to.x, step.to.y) };
        resolvedSteps.push({ ...step, from, to });
      } else {
        resolvedSteps.push(step);
      }
    }
    const steps = this.actions.guardSequence({ ...input, steps: resolvedSteps });
    const result = await this.call("sequence", { ...input, steps }, context);
    if (!input.finalScreenshot) return result;
    const screenshot = await this.screenshot({ tabId: input.tabId }, context);
    return { ...result, screenshot: { tabId: screenshot.tabId, path: screenshot.path,
      sizeBytes: screenshot.sizeBytes, ...(screenshot.imageContent ? { imageContent: screenshot.imageContent } : {}) } };
  }

  frameExtract(
    ...args: Parameters<NonNullable<BrowserExecutor["frameExtract"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameExtract"]>> {
    return this.call("frameExtract", args[0], args[1]);
  }

  async frameClick(
    ...args: Parameters<NonNullable<BrowserExecutor["frameClick"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameClick"]>> {
    this.requireGuardedActions();
    const [input, context] = args;
    const guard = this.actions.guardPage(input.tabId);
    return this.call("frameClick", { ...input, guard }, context);
  }

  async frameFill(
    ...args: Parameters<NonNullable<BrowserExecutor["frameFill"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameFill"]>> {
    this.requireGuardedActions();
    const [input, context] = args;
    const guard = this.actions.guardPage(input.tabId);
    return this.call("frameFill", { ...input, guard }, context);
  }

  profilePage(
    ...args: Parameters<NonNullable<BrowserExecutor["profilePage"]>>
  ): ReturnType<NonNullable<BrowserExecutor["profilePage"]>> {
    return this.call("profilePage", args[0], args[1]);
  }

  domIndex(
    ...args: Parameters<NonNullable<BrowserExecutor["domIndex"]>>
  ): ReturnType<NonNullable<BrowserExecutor["domIndex"]>> {
    return this.call("domIndex", args[0], args[1]);
  }

  async frameSequence(
    ...args: Parameters<NonNullable<BrowserExecutor["frameSequence"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameSequence"]>> {
    const [input, context] = args;
    if (input.steps.every((step) => READ_ONLY_FRAME_STEPS.has(step.action))) {
      return this.call("frameSequence", input, context);
    }
    this.requireGuardedActions();
    if (!this.peerInfo?.capabilities.includes("frameSequenceMutationsV1")) {
      throw unsupported("browser_frame_sequence_mutation");
    }
    // Two calls: a side-effect-free preflight describes every click/Enter
    // target, all required confirmations are bound before any is consumed,
    // and execution fails closed unless it observes the same targets.
    const guard = this.actions.guardPage(input.tabId);
    const preflight = await this.call("frameSequence", { ...input, guard, phase: "preflight" }, context);
    const targets = parseLegacyFrameTargets(input, preflight.steps);
    this.actions.guardFrameSequence(input, targets);
    return this.call("frameSequence", { ...input, guard, phase: "execute", expectedTargets: targets }, context);
  }

  async navigatePath(
    ...args: Parameters<NonNullable<BrowserExecutor["navigatePath"]>>
  ): ReturnType<NonNullable<BrowserExecutor["navigatePath"]>> {
    const [input, context] = args;
    this.requireGuardedActions();
    const guard = this.actions.guardPage(input.tabId);
    const authorized = this.actions.guardNavigatePath(input);
    return this.call("navigatePath", { ...input, guard, authorized }, context);
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
    this.uploadableScreenshots.add(absolutePath);
    if (this.uploadableScreenshots.size > MAX_UPLOADABLE_SCREENSHOTS) {
      this.uploadableScreenshots.delete(this.uploadableScreenshots.values().next().value!);
    }
    // A screenshot is a prerequisite for pixel-only actions, never a grant.
    // The separate one-use confirmation is still required for every click.
    try {
      const { url } = this.actions.guardPage(args[0].tabId);
      this.pixelEvidence.set(args[0].tabId, { url, observedAt: Date.now() });
    } catch {
      this.pixelEvidence.delete(args[0].tabId);
    }
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
    this.pixelEvidence.delete(args[0].tabId);
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
    this.pixelEvidence.delete(args[0].tabId);
    this.coordinateDrags.delete(args[0].tabId);
    this.actions.observeTab(result.tab);
    return result;
  }

  async closeTab(...args: Parameters<BrowserExecutor["closeTab"]>): ReturnType<BrowserExecutor["closeTab"]> {
    const result = await this.call("closeTab", args[0], args[1]);
    await this.releaseStagedUploads([args[0].tabId]);
    this.actions.discard([args[0].tabId]);
    this.snapshots.discard(args[0].tabId);
    this.pixelEvidence.delete(args[0].tabId);
    this.coordinateClicks.delete(args[0].tabId);
    return result;
  }

  async plan(...args: Parameters<BrowserExecutor["plan"]>): ReturnType<BrowserExecutor["plan"]> {
    return this.call("plan", args[0], args[1]);
  }

  async userMessages(
    ...args: Parameters<NonNullable<BrowserExecutor["userMessages"]>>
  ): ReturnType<NonNullable<BrowserExecutor["userMessages"]>> {
    const [input, context] = args;
    // The messages wait here, in the companion: the reply card in the chat
    // reaches them with Chrome closed. Only the popup's copy of the question
    // needs the extension.
    const socket = this.socket;
    const popup = socket?.readyState === WebSocket.OPEN && this.peerInfo?.capabilities.includes("taskMessagesV1") === true;
    const scope = input.taskId === undefined ? {} : { taskId: input.taskId };
    const all = input.taskId === undefined;
    let asked = false;
    if (input.question !== undefined && input.taskId !== undefined) {
      if (popup) socket!.send(JSON.stringify({ type: "task-question", taskId: input.taskId, question: input.question }));
      asked = true;
    }
    let waitMs = input.waitMs ?? 0;
    const deadlineAt = context?.deadline?.deadlineAt;
    if (deadlineAt) {
      const remainingMs = Date.parse(deadlineAt) - Date.now() - 1_000;
      if (Number.isFinite(remainingMs)) waitMs = Math.min(waitMs, Math.max(0, remainingMs));
    }
    await this.inbox.waitFor(scope, all, waitMs, context?.signal);
    const messages = this.deliverUserMessages(this.inbox.take(scope, all), true);
    return { messages, ...(asked ? { asked: true } : {}) };
  }

  // What the user writes in the reply card in the ChatGPT conversation joins
  // the popup's messages, and the extension shows it in the popup as sent.
  async postUserMessage(
    ...args: Parameters<NonNullable<BrowserExecutor["postUserMessage"]>>
  ): ReturnType<NonNullable<BrowserExecutor["postUserMessage"]>> {
    const [input] = args;
    const message = {
      id: `msg_${randomUUID()}`,
      text: input.text,
      sentAt: new Date().toISOString(),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    };
    const { added } = this.inbox.accept({ messages: [message] });
    if (added > 0) this.options.onUserMessagesPending?.(this.inbox.size);
    if (added > 0) this.options.chatWake?.queue({ kind: "message", messageId: message.id, text: message.text });
    const socket = this.socket;
    if (added > 0 && socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "task-messages-external", message }));
      } catch {
        // The message is already waiting here; the popup only misses its copy.
      }
    }
    return { id: message.id, accepted: added > 0 };
  }

  takeUserMessages(
    ...args: Parameters<NonNullable<BrowserExecutor["takeUserMessages"]>>
  ): ReturnType<NonNullable<BrowserExecutor["takeUserMessages"]>> {
    // Only the extension that announced taskMessagesV1 sends messages, so an older one simply has none.
    const [scope] = args;
    return this.deliverUserMessages(this.inbox.take(scope, scope.taskId === undefined && scope.tabId === undefined), true);
  }

  // Tells the extension which messages reached the agent, so the popup shows
  // them as delivered and stops sending them again.
  pendingUserMessages(): number {
    return this.inbox.size;
  }

  private deliverUserMessages<T extends { id: string }>(messages: T[], taken = false): T[] {
    if (taken && messages.length > 0) this.options.onUserMessagesPending?.(this.inbox.size);
    const socket = this.socket;
    if (messages.length > 0 && socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: "task-messages-delivered", ids: messages.map((message) => message.id) }));
      } catch {
        // The extension sends them again after a reconnect; the inbox drops repeats.
      }
    }
    return messages;
  }

  /** The wake wrote these messages into the conversation: they reached the agent. */
  deliverWokenMessages(ids: readonly string[]): void {
    this.deliverUserMessages(this.inbox.takeIds(ids), true);
  }

  /** Whether the agent has yet to take this message. */
  hasUserMessage(id: string): boolean {
    return this.inbox.holds(id);
  }

  /** The extension writes the wake notice in the ChatGPT tab used last. */
  wakeChromeTab(text: string): Promise<{ outcome: ChatWakeOutcome; detail?: string }> {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN || !this.peerInfo?.capabilities.includes("chatWakeV2")) {
      return Promise.resolve({ outcome: "unavailable", detail: "extension-not-connected" });
    }
    const id = randomUUID();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.chromeWakes.delete(id);
        resolve({ outcome: "failed", detail: "timeout" });
      }, 20_000);
      timeout.unref?.();
      this.chromeWakes.set(id, (outcome) => {
        clearTimeout(timeout);
        this.chromeWakes.delete(id);
        resolve({ outcome });
      });
      try {
        socket.send(JSON.stringify({ type: "wake-chrome", id, text }));
      } catch {
        this.chromeWakes.get(id)?.("failed");
      }
    });
  }

  /** Shows in the popup whether waking is on and what it did last. */
  showChatWakeStatus(status: ChatWakeStatus): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN || !this.peerInfo?.capabilities.includes("chatWakeV2")) return;
    try {
      socket.send(JSON.stringify({ type: "wake-status", status }));
    } catch {
      // The popup shows the next one.
    }
  }

  async finishTask(
    ...args: Parameters<BrowserExecutor["finishTask"]>
  ): ReturnType<BrowserExecutor["finishTask"]> {
    // An older extension would ignore pause and close the task's tabs.
    if (args[0].pause === true && !this.peerInfo?.capabilities.includes("pauseTaskV1")) {
      throw new AppError("BROWSER_CAPABILITY_UNSUPPORTED",
        "Personal Chrome extension must support pauseTaskV1 to pause a task. Reload the updated extension.");
    }
    const result = await this.call("finishTask", args[0], args[1]);
    await this.releaseStagedUploads(result.closedTabIds ?? []);
    this.actions.finish(args[0].taskId);
    for (const tabId of [...(result.closedTabIds ?? []), ...(result.releasedTabIds ?? [])]) {
      this.snapshots.discard(tabId);
      this.pixelEvidence.delete(tabId);
      this.coordinateClicks.delete(tabId);
    }
    if (!args[0].taskId) {
      this.snapshots.clear();
      this.pixelEvidence.clear();
      this.coordinateClicks.clear();
    }
    return result;
  }

  async download(...args: Parameters<BrowserExecutor["download"]>): ReturnType<BrowserExecutor["download"]> {
    this.requireGuardedActions();
    const [input, context] = args;
    const guard = input.ref
      ? this.actions.guardClick({ tabId: input.tabId, ref: input.ref,
          ...(input.confirmationId ? { confirmationId: input.confirmationId } : {}) })
      : this.actions.guardPage(input.tabId);
    const runId = randomUUID();
    const result = await this.call("download", { ...input, runId, guard }, context);
    const source = result.path;
    if (!path.isAbsolute(source) || path.basename(path.dirname(source)) !== runId ||
        path.basename(path.dirname(path.dirname(source))).toLowerCase() !== "mcp-v3-staging") {
      throw new AppError("RELAY_PROTOCOL_ERROR", "Chrome returned a download outside its private staging directory.");
    }
    const parent = path.dirname(source);
    const marker = path.dirname(parent);
    const [file, folder, markerFolder] = await Promise.all([
      lstat(source), lstat(parent), lstat(marker),
    ]);
    if (!file.isFile() || file.isSymbolicLink() || file.size > 128 * 1024 * 1024 ||
        !folder.isDirectory() || folder.isSymbolicLink() ||
        !markerFolder.isDirectory() || markerFolder.isSymbolicLink() ||
        (result.sizeBytes !== undefined && result.sizeBytes !== file.size)) {
      throw new AppError("RELAY_PROTOCOL_ERROR", "Chrome staged download did not pass private artifact checks.");
    }
    const raw = path.basename(result.suggestedFilename ?? source);
    const name = raw.replace(/[<>:"\/\\|?*\x00-\x1f]/gu, "_").replace(/[. ]+$/u, "");
    const filename = name && name !== "." && name !== ".." ? name.slice(0, 180) : "download.bin";
    const folderPath = path.join(path.resolve(this.options.stateRoot), "browser", "personal-artifacts", "downloads");
    await mkdir(folderPath, { recursive: true, mode: 0o700 });
    const finalPath = path.join(folderPath, randomUUID() + "-" + filename);
    try {
      await rename(source, finalPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await copyFile(source, finalPath, constants.COPYFILE_EXCL);
      await unlink(source);
    }
    const finalFile = await lstat(finalPath);
    if (!finalFile.isFile() || finalFile.isSymbolicLink() || finalFile.size !== file.size) {
      await rm(finalPath, { force: true });
      throw new AppError("RELAY_PROTOCOL_ERROR", "Downloaded artifact changed during private staging transfer.");
    }
    await chmod(finalPath, 0o600);
    await rm(parent, { recursive: false, force: false }).catch(() => undefined);
    return { tabId: input.tabId, path: finalPath, suggestedFilename: filename, sizeBytes: file.size };
  }

  async upload(...args: Parameters<BrowserExecutor["upload"]>): ReturnType<BrowserExecutor["upload"]> {
    this.requireGuardedActions();
    const [input, context] = args;
    const guard = this.actions.guardUpload(input);
    const root = this.uploadsRoot();
    await mkdir(root, { recursive: true, mode: 0o700 });
    const staged = await mkdtemp(path.join(root, "staged-"));
    let totalBytes = 0;
    const stagedFiles: Array<{ name: string; path: string }> = [];
    let delivered = false;
    try {
      if (input.files.length < 1 || input.files.length > 10) {
        throw new AppError("INVALID_ARGUMENT", "Upload requires 1-10 authorized files.");
      }
      for (const file of input.files) {
        if (!file.name || file.name === "." || file.name === ".." ||
            /[<>:"\/\\|?*\x00-\x1f]/u.test(file.name) || /[. ]$/u.test(file.name) ||
            /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:[.]|$)/iu.test(file.name)) {
          throw new AppError("INVALID_ARGUMENT", "Invalid personal Chrome upload filename.");
        }
        const bytes = file.screenshotPath !== undefined
          ? await this.readUploadableScreenshot(file.name, file.screenshotPath)
          : decodeUploadPayload(file.contentBase64 ?? "");
        if (bytes.length > 6 * 1024 * 1024) {
          throw new AppError("LIMIT_EXCEEDED", "An individual upload exceeds its permitted size.");
        }
        totalBytes += bytes.length;
        if (totalBytes > 60 * 1024 * 1024) {
          throw new AppError("LIMIT_EXCEEDED", "Upload exceeds the maximum aggregate size.");
        }
        const absolutePath = path.join(staged, file.name);
        await writeFile(absolutePath, bytes, { flag: "wx", mode: 0o600 });
        stagedFiles.push({ name: file.name, path: absolutePath });
      }
      const result = await this.call("upload", {
        tabId: input.tabId,
        files: stagedFiles,
        totalBytes,
        ...(input.inputRef ? { inputRef: input.inputRef } : {}),
        ...(input.triggerRef ? { triggerRef: input.triggerRef } : {}),
        ...(input.selector ? { selector: input.selector } : {}),
        ...(input.dropRef ? { dropRef: input.dropRef } : {}),
        guard,
      }, context);
      delivered = true;
      this.retainStagedUpload(input.tabId, staged);
      return result;
    } finally {
      if (!delivered) await rm(staged, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readUploadableScreenshot(name: string, screenshotPath: string): Promise<Buffer> {
    const source = path.resolve(screenshotPath);
    if (!this.uploadableScreenshots.has(source)) {
      throw new AppError("INVALID_ARGUMENT",
        "screenshotPath must be a browser_screenshot path captured in this personal Chrome session.");
    }
    const kind = path.extname(source).toLowerCase();
    const named = path.extname(name).toLowerCase();
    if (named !== kind && !(kind === ".jpg" && named === ".jpeg")) {
      throw new AppError("INVALID_ARGUMENT", `A screenshot upload name must keep its ${kind} extension.`);
    }
    try {
      return await readFile(source);
    } catch {
      this.uploadableScreenshots.delete(source);
      throw new AppError("INVALID_ARGUMENT", "The screenshot file no longer exists; capture it again.");
    }
  }

  private uploadsRoot(): string {
    return path.join(path.resolve(this.options.stateRoot), "browser", "personal-artifacts", "uploads");
  }

  private retainStagedUpload(tabId: string, directory: string): void {
    const timer = setTimeout(() => {
      this.stagedUploads.delete(directory);
      void rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }, STAGED_UPLOAD_RETENTION_MS);
    timer.unref();
    this.stagedUploads.set(directory, { tabId, timer });
  }

  private async releaseStagedUploads(tabIds?: readonly string[]): Promise<void> {
    const released = [...this.stagedUploads].filter(([, entry]) => !tabIds || tabIds.includes(entry.tabId));
    for (const [directory, entry] of released) {
      clearTimeout(entry.timer);
      this.stagedUploads.delete(directory);
    }
    await Promise.all(released.map(([directory]) =>
      rm(directory, { recursive: true, force: true }).catch(() => undefined)));
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

  // A personal trace is the timeline of what reached Chrome for the tab, with
  // the tab's recording as a WebM aligned to it; a video is that recording.
  traceStart(
    ...args: Parameters<BrowserExecutor["traceStart"]>
  ): ReturnType<BrowserExecutor["traceStart"]> {
    return this.recorder.traceStart(...args);
  }

  traceStop(
    ...args: Parameters<BrowserExecutor["traceStop"]>
  ): ReturnType<BrowserExecutor["traceStop"]> {
    return this.recorder.traceStop(...args);
  }

  videoStart(
    ...args: Parameters<BrowserExecutor["videoStart"]>
  ): ReturnType<BrowserExecutor["videoStart"]> {
    return this.recorder.videoStart(...args);
  }

  videoStop(
    ...args: Parameters<BrowserExecutor["videoStop"]>
  ): ReturnType<BrowserExecutor["videoStop"]> {
    return this.recorder.videoStop(...args);
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
      traceActive: this.recorder.isActive(input.tabId, "trace"),
      videoActive: this.recorder.isActive(input.tabId, "video"),
      collectedAt: new Date().toISOString(),
    };
  }

  private async initialize(): Promise<void> {
    const personalRoot = path.dirname(this.extensionDirectory);
    const tokenPath = path.join(personalRoot, "bridge-token.txt");
    await mkdir(this.extensionDirectory, { recursive: true });
    await sweepStaleStagedUploads(this.uploadsRoot());
    await this.recorder.sweep();
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
      writeFile(
        path.join(this.extensionDirectory, "tab-sharing.js"),
        assets.tabSharingScript,
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(
        path.join(this.extensionDirectory, "plan-review.html"),
        assets.planReviewHtml,
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(
        path.join(this.extensionDirectory, "plan-review.js"),
        assets.planReviewScript,
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(
        path.join(this.extensionDirectory, "task-home.html"),
        assets.taskHomeHtml,
        { encoding: "utf8", mode: 0o600 },
      ),
      writeFile(
        path.join(this.extensionDirectory, "task-home.js"),
        assets.taskHomeScript,
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
            this.recorder.disconnect();
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
          this.recorder.disconnect();
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

  // Asks Chrome to offer the user a site approval; the user decides there.
  private requestSiteApproval(request: PersonalSiteApprovalRequest): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "site-approval-request", ...request }));
    } catch {
      // The confirmation error still reaches the caller.
    }
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
    if (message.type === "site-approvals") {
      const approvals = parsePersonalSiteApprovals(message);
      if (approvals) this.actions.setSiteApprovals(approvals);
      return;
    }
    if (message.type === "wake-settings" && typeof message.enabled === "boolean") {
      this.options.chatWake?.setEnabled(message.enabled);
      return;
    }
    if (message.type === "wake-event" && message.kind === "handback" && typeof message.tabId === "string" &&
        /^personal:\d{1,12}$/u.test(message.tabId)) {
      this.options.chatWake?.queue({ kind: "handback", tabId: message.tabId,
        ...(typeof message.reason === "string" && message.reason ? { reason: message.reason.slice(0, 200) } : {}) });
      return;
    }
    if (message.type === "wake-chrome-result" && typeof message.id === "string") {
      const outcome = typeof message.outcome === "string" &&
        ["sent", "busy", "typing", "unavailable", "failed"].includes(message.outcome)
        ? message.outcome as ChatWakeOutcome : "failed";
      this.chromeWakes.get(message.id)?.(outcome);
      return;
    }
    if (message.type === "task-messages") {
      const { added, addedIds, alreadyDelivered } = this.inbox.accept(message);
      this.deliverUserMessages(alreadyDelivered.map((id) => ({ id })));
      if (added > 0) this.options.onUserMessagesPending?.(this.inbox.size);
      for (const messageId of addedIds) {
        const text = this.inbox.textOf(messageId);
        if (text !== undefined) this.options.chatWake?.queue({ kind: "message", messageId, text });
      }
      return;
    }
    if (message.type === "recording-frame") {
      // A recording nobody here wants any more (its stop timed out, say) ends in Chrome too.
      if (!this.recorder.acceptFrame(message) && typeof message.recordingId === "string" &&
          /^[0-9a-f-]{36}$/u.test(message.recordingId) && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "recording-cancel", recordingId: message.recordingId }));
      }
      return;
    }
    if (message.type === "recording-ended") {
      this.recorder.ended(message);
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
    const startedAt = Date.now();
    const traced = operation !== "videoStart" && operation !== "videoStop";
    const fail = (error: Error, outcome: "error" | "cancelled" | "timeout" = "error") => {
      const code = error instanceof AppError && ERROR_CODES.has(error.code) ? error.code : "INTERNAL_ERROR";
      latency.finish(outcome, { ...metrics, responseBytes: pendingMetrics?.responseBytes,
        ...extensionLatencyMetrics(pendingMetrics?.timing), errorCode: code });
      if (traced) this.recorder.traceAction(operation, input, startedAt, outcome, code);
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
              : operation === "videoStart" || operation === "videoStop"
                ? personalRecordingTransportSchema.parse(value)
                : browserOperationResultSchemas[operation].parse(value);
            latency.finish("success", { ...metrics, responseBytes: pending.responseBytes, ...extensionLatencyMetrics(pending.timing) });
            if (traced) this.recorder.traceAction(operation, input, startedAt, "success");
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

function decodeUploadPayload(contentBase64: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(contentBase64)) {
    throw new AppError("INVALID_ARGUMENT", "Upload payload is not canonical base64.");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (bytes.toString("base64") !== contentBase64) {
    throw new AppError("LIMIT_EXCEEDED", "An individual upload exceeds its permitted size.");
  }
  return bytes;
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
  if (operation === "download") timeoutMs = Math.max(timeoutMs, 90_000);
  if (operation === "frameSequence" && isRecord(input) &&
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)) {
    timeoutMs = Math.max(timeoutMs, Math.min(120_000, input.timeoutMs) + 5_000);
  }
  if (operation === "navigatePath" && isRecord(input)) {
    const pathTimeout = typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
      ? input.timeoutMs : 60_000;
    timeoutMs = Math.max(timeoutMs, Math.min(120_000, pathTimeout) + 5_000);
  }
  if ((operation === "wait" || operation === "plan") && isRecord(input) &&
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

// Removes staged uploads left by an earlier companion process once they are
// past retention; younger ones may still back files in an open tab.
async function sweepStaleStagedUploads(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - STAGED_UPLOAD_RETENTION_MS;
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("staged-"))
    .map(async (entry) => {
      const directory = path.join(root, entry.name);
      const info = await stat(directory).catch(() => undefined);
      if (info && info.mtimeMs < cutoff) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }));
}

function parsePersonalSiteApprovals(message: Record<string, unknown>): PersonalSiteApprovals | undefined {
  const { grants, autoSites } = message;
  if (!Array.isArray(grants) || grants.length > 500 || !Array.isArray(autoSites) || autoSites.length > 200) return undefined;
  const parsedGrants: PersonalSiteGrant[] = [];
  for (const grant of grants) {
    if (!isRecord(grant) || typeof grant.origin !== "string" || !/^https?:\/\/[^/\s]{1,260}$/u.test(grant.origin) ||
        typeof grant.category !== "string" ||
        !PERSONAL_SITE_APPROVABLE_CATEGORIES.has(grant.category as BrowserConfirmationCategory)) {
      return undefined;
    }
    // Each grant belongs to exactly one task, or to one tab that has none.
    if (grant.taskId !== undefined && grant.tabId === undefined && typeof grant.taskId === "string" &&
        grant.taskId.length >= 1 && grant.taskId.length <= 128) {
      parsedGrants.push({ origin: grant.origin, category: grant.category, taskId: grant.taskId });
    } else if (grant.tabId !== undefined && grant.taskId === undefined && typeof grant.tabId === "string" &&
        /^personal:\d{1,12}$/u.test(grant.tabId)) {
      parsedGrants.push({ origin: grant.origin, category: grant.category, tabId: grant.tabId });
    } else {
      return undefined;
    }
  }
  if (autoSites.some((site) => typeof site !== "string" || !/^[a-z0-9.-]{1,253}$/u.test(site))) return undefined;
  return { grants: parsedGrants, autoSites: [...autoSites] as string[] };
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
const READ_ONLY_FRAME_STEPS: ReadonlySet<string> = new Set(["index", "extract", "assert", "waitFor"]);

// The extension must describe exactly every click and Enter step; anything
// else means the preflight cannot be trusted to bind confirmations.
function parseLegacyFrameTargets(
  input: BrowserFrameSequenceInput,
  steps: ReadonlyArray<{ index: number; action: string; value?: unknown }>,
): PersonalLegacyFrameTarget[] {
  const expected = input.steps.flatMap((step, index) =>
    step.action === "click" || (step.action === "press" && containsBrowserEnterKey(step.key)) ? [index] : []);
  const targets = steps.map((step) => {
    const value = step.value;
    if (!isRecord(value) || typeof value.label !== "string" || value.label.length > 200 ||
        typeof value.role !== "string" || value.role.length < 1 || value.role.length > 200 ||
        typeof value.submitLike !== "boolean" || step.action !== input.steps[step.index]?.action) {
      throw new AppError("RELAY_PROTOCOL_ERROR", "Personal Chrome returned an invalid legacy frame preflight.");
    }
    return { index: step.index, label: value.label, role: value.role, submitLike: value.submitLike };
  });
  if (targets.length !== expected.length ||
      targets.some((target, position) => target.index !== expected[position])) {
    throw new AppError("RELAY_PROTOCOL_ERROR", "Personal Chrome preflight did not describe every click/Enter step.");
  }
  return targets;
}

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
