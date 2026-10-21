import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type ConsoleMessage,
  type Dialog,
  type FileChooser,
  type Frame,
  type Locator,
  type Page,
  type Request,
  type Response,
  type Route,
  type WebSocketRoute,
} from "playwright";
import {
  abortSignalError,
  AppError,
  type BrowserDialogInput,
  type BrowserDialogResult,
} from "@vs-code-gpt/shared";
import {
  normalizeBrowserDiagnosticPayload,
  validateBrowserNetworkFilter,
  type BrowserAdvancedDriver,
  type BrowserArtifact,
  type BrowserArtifactCollection,
  type BrowserConsoleOptions,
  type BrowserDiagnosticTextResult,
  type BrowserDiagnosticsOptions,
  type BrowserDiagnosticsResult,
  type BrowserNetworkDetail,
  type BrowserNetworkOptions,
  type BrowserPdfOptions,
  type BrowserVideoOptions,
} from "../browser-advanced-driver.js";
import {
  normalizeBrowserDriverError,
  resolveBrowserPrivateOutputPath,
  type BrowserAuthenticationInspection,
  type BrowserClickRequest,
  type BrowserCredentialAuthenticationOptions,
  type BrowserCredentialAuthenticationResult,
  type BrowserCredentialInput,
  type BrowserDriverCallOptions,
  type BrowserDriverResponse,
  type BrowserDriverTab,
  type BrowserEvaluateRequest,
  type BrowserFillRequest,
  type BrowserHoverRequest,
  type BrowserDragRequest,
  type BrowserScrollRequest,
  type BrowserNavigateRequest,
  type BrowserPressRequest,
  type BrowserScreenshotRequest,
  type BrowserWaitRequest,
} from "../browser-driver.js";
import { DirectArtifactStore } from "./direct-artifact-store.js";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";
import { BrowserNetworkGuardProxy } from "./browser-network-guard-proxy.js";
import {
  isAuthorizedSiteRequestAllowed,
  type AuthorizedSitePolicy,
} from "../../domain/authorized-site-policy.js";
import {
  NodeBrowserDependencyProbe,
  resolvePlaywrightFfmpegPath,
  type BrowserAdvancedReadinessSnapshot,
} from "../../services/browser-readiness.js";
import {
  SemanticSnapshotTracker,
  type SemanticSnapshotCapture,
} from "./semantic-snapshot-tracker.js";
import {
  BrowserLiveFrameMailbox,
  jpegFrameDimensions,
  type BrowserLiveFrame,
} from "../../services/browser-live-frame-mailbox.js";
import { hasBrowserCaptchaChallenge } from "../../services/browser-captcha-detector.js";
import {
  BrowserPageStabilizationService,
  type BrowserDocumentReadyState,
  type BrowserPageStabilizationResult,
  type BrowserPageStabilitySample,
} from "../../services/browser-page-stabilization-service.js";
import type {
  BrowserExtractionFormat,
  BrowserExtractionProbe,
} from "../../services/browser-extraction-completeness-service.js";
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;

export async function showActionPointer(target: Locator): Promise<void> {
  await target.scrollIntoViewIfNeeded().catch(() => undefined);
  await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return;
    const document = element.ownerDocument;
    const pointer = document.getElementById("__mcp_v3_action_pointer__") ?? document.createElement("div");
    if (!pointer.isConnected) {
      pointer.id = "__mcp_v3_action_pointer__";
      pointer.setAttribute("aria-hidden", "true");
      document.documentElement.appendChild(pointer);
    }
    pointer.innerHTML = '<svg width="32" height="40" viewBox="0 0 32 40" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M3 2V29L10 22L15 34L21 31L16 20H27Z" fill="#171321" stroke="#f8f7ff" stroke-width="2" stroke-linejoin="round"/></svg>';
    pointer.setAttribute("style", [
      "position:fixed", "width:32px", "height:40px", "z-index:2147483647",
      "pointer-events:none",
      "filter:drop-shadow(0 0 3px #a16eff) drop-shadow(0 0 10px #a16eff)",
      `left:${rect.left + rect.width / 2}px`,
      `top:${rect.top + rect.height / 2}px`,
    ].join(";"));
  }).catch(() => undefined);
}

const DEFAULT_PAGE_STABILIZATION_TIMEOUT_MS = 2_000;
const MAX_STABILIZATION_FRAME_PROBES = 32;
const STABILIZATION_RESOURCE_TYPES = new Set(["document", "script", "xhr", "fetch"]);

interface ObservedJsDialog {
  expiresAt: string;
  dialog?: Dialog;
  onDialog: (value: Dialog) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
}

interface NetworkEntry {
  request: Request;
  response?: Response;
  failedText?: string;
  timestamp: string;
}

interface ActiveScreencast {
  session: CDPSession;
  outputPath: string;
  frameDirectory: string;
  frameCount: number;
  pendingWrites: Promise<void>;
  onFrame: (event: {
    data: string;
    sessionId: number;
  }) => void;
}

interface LiveScreencast {
  page: Page;
  session: CDPSession;
  mailbox: BrowserLiveFrameMailbox;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  onFrame: (event: {
    data: string;
    sessionId: number;
    metadata?: { deviceWidth?: number; deviceHeight?: number };
  }) => void;
}

export interface DirectSemanticSnapshotOptions {
  knownRevision?: number;
  forceFull?: boolean;
}

export interface DirectPlaywrightEngineStatus {
  engine: "playwright-direct";
  engineVersion: "1.1.0-beta.1";
  protocolVersion: 3;
  playwrightVersion: string;
  browserChannel: "chromium" | "chrome";
  chromiumRevision: string;
  incrementalSnapshots: boolean;
}

async function inspectSemanticPoint(page: Page, x: number, y: number): Promise<{ role: string; name: string } | null> {
  return page.evaluate(({ x, y }) => {
    type HitElement = {
      tagName: string;
      textContent: string | null;
      parentElement?: HitElement | null;
      shadowRoot?: { elementFromPoint(px: number, py: number): HitElement | null } | null;
      closest(selector: string): HitElement | null;
      getAttribute(name: string): string | null;
      labels?: ArrayLike<{ textContent: string | null }> | null;
    };
    const browser = globalThis as unknown as {
      innerWidth: number;
      innerHeight: number;
      document: { elementFromPoint(px: number, py: number): HitElement | null };
    };
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 ||
      x >= browser.innerWidth || y >= browser.innerHeight) return null;
    let top = browser.document.elementFromPoint(x, y);
    for (let depth = 0; depth < 6; depth += 1) {
      const inner = top?.shadowRoot?.elementFromPoint(x, y);
      if (!inner || inner === top) break;
      top = inner;
    }
    if (!top) return null;
    const interactive = "button,input,textarea,select,a[href],summary,canvas,svg,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='textbox'],[role='switch'],[role='combobox'],[contenteditable='true']";
    const element = top.closest(interactive);
    if (!element) return null;
    const tag = element.tagName.toLowerCase();
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    const role = element.getAttribute("role") ??
      (tag === "canvas" || tag === "svg" ? "canvas" : tag === "a" ? "link" : tag === "button" || tag === "summary" ? "button" :
      tag === "textarea" ? "textbox" : tag === "select" ? "combobox" :
      tag === "input" ? type === "checkbox" ? "checkbox" : type === "radio" ? "radio" :
      type === "button" || type === "submit" ? "button" : "textbox" : "generic");
    const label = element.getAttribute("aria-label") ||
      Array.from(element.labels ?? []).map((item) => item.textContent ?? "").join(" ") ||
      element.getAttribute("placeholder") || element.getAttribute("title") || element.textContent || "";
    return { role: role.slice(0, 100), name: label.replace(/\s+/gu, " ").trim().slice(0, 500) };
  }, { x, y });
}

export class DirectPlaywrightDriver implements BrowserAdvancedDriver {
  readonly kind = "direct" as const;
  private readonly pageIds = new WeakMap<Page, string>();
  private readonly pagesById = new Map<string, Page>();
  private readonly crashedPages = new WeakSet<Page>();
  private readonly snapshots = new SemanticSnapshotTracker();
  private readonly legacySnapshotPages = new WeakSet<Page>();
  private readonly consoleEntries = new WeakMap<Page, string[]>();
  private readonly networkEntries = new WeakMap<Page, NetworkEntry[]>();
  private readonly relevantRequests = new WeakMap<Page, Set<Request>>();
  private readonly frameNavigationEpochs = new WeakMap<Frame, number>();
  private readonly pendingFileChoosers = new WeakMap<Page, FileChooser>();
  private readonly observedDialogs = new WeakMap<Page, ObservedJsDialog>();
  private readonly viewportSessions = new WeakMap<Page, { session: CDPSession; original: { userAgent: string; platform: string; colorScheme: "light" | "dark" } }>();
  private readonly suppressedDiagnosticPages = new WeakSet<Page>();
  private readonly pageAllowedOrigins = new WeakMap<Page, Map<string, number>>();
  private readonly pageRequestPolicies = new WeakMap<Page, AuthorizedSitePolicy>();
  private readonly pageSemanticPermitCounts = new WeakMap<Page, number>();
  private readonly privateOrigins: Set<string>;
  private readonly deniedOrigins: Set<string>;
  private readonly networkGuard: BrowserNetworkGuardProxy;
  private readonly artifacts: DirectArtifactStore;
  private readonly dependencyProbe = new NodeBrowserDependencyProbe();
  private context: BrowserContext | undefined;
  private current: Page | undefined;
  private connectPromise: Promise<void> | undefined;
  private traceActive = false;
  private screencast: ActiveScreencast | undefined;
  private readonly liveScreencasts = new Map<string, LiveScreencast>();
  private incrementalSnapshots = false;

  constructor(private readonly config: BrowserWorkerConfig) {
    const policies = config.privateSitePolicies ?? [];
    this.privateOrigins = new Set(
      policies.flatMap((policy) => policy.allowedOrigins.map(normalizeOrigin)),
    );
    this.deniedOrigins = new Set(
      policies.flatMap((policy) => policy.deniedOrigins.map(normalizeOrigin)),
    );
    this.networkGuard = new BrowserNetworkGuardProxy({
      privateOrigins: [...this.privateOrigins],
      deniedOrigins: [...this.deniedOrigins],
    });
    this.artifacts = new DirectArtifactStore(
      path.join(config.privateDirectory, "direct", "artifacts"),
      config,
    );
  }

  isConnected(): boolean {
    return this.context !== undefined;
  }

  hasUsablePage(): boolean {
    return this.usablePages().length > 0;
  }

  activePage(): Page {
    return this.requireCurrentPage();
  }

  enablePrivateOrigin(origin: string, expiresAt?: string): void {
    this.networkGuard.enableOrigin(origin, expiresAt);
  }

  disablePrivateOrigin(origin: string): void {
    this.networkGuard.disableOrigin(origin);
  }

  setActivePageAllowedOrigins(
    origins: readonly string[],
    expiresAt?: string,
  ): void {
    this.pageAllowedOrigins.set(
      this.requireCurrentPage(),
      allowedOriginMap(origins, expiresAt),
    );
  }

  setActivePageRequestPolicy(policy: AuthorizedSitePolicy | undefined): void {
    const page = this.requireCurrentPage();
    if (!policy?.requestPolicy) {
      this.pageRequestPolicies.delete(page);
      this.pageSemanticPermitCounts.delete(page);
      return;
    }
    this.pageRequestPolicies.set(page, policy);
    this.pageSemanticPermitCounts.delete(page);
  }

  acquireActivePageSemanticRequestPermit(): () => void {
    const page = this.requireCurrentPage();
    const count = this.pageSemanticPermitCounts.get(page) ?? 0;
    this.pageSemanticPermitCounts.set(page, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.pageSemanticPermitCounts.get(page) ?? 0;
      if (current <= 1) this.pageSemanticPermitCounts.delete(page);
      else this.pageSemanticPermitCounts.set(page, current - 1);
    };
  }

  async inspectAuthenticationState(): Promise<BrowserAuthenticationInspection> {
    return inspectAuthenticationPage(this.requireCurrentPage());
  }

  async authenticateWithCredential(
    credential: BrowserCredentialInput,
    options: BrowserCredentialAuthenticationOptions,
  ): Promise<BrowserCredentialAuthenticationResult> {
    const page = this.requireCurrentPage();
    const initial = await inspectAuthenticationPage(page);
    if (initial.state === "authenticated") return { status: "session-reused" };
    if (initial.state === "interaction-required") {
      return { status: "interaction-required", reason: initial.reason };
    }
    const form = await findLoginForm(page);
    if (!form) return { status: "failed", reason: "login-form-not-found" };

    let username = credential.username.toString("utf8");
    let password = credential.password.toString("utf8");
    this.suppressedDiagnosticPages.add(page);
    this.consoleEntries.set(page, []);
    this.networkEntries.set(page, []);
    this.relevantRequests.set(page, new Set<Request>());
    this.frameNavigationEpochs.set(page.mainFrame(), 0);
    this.snapshots.discard(page);
    try {
      try {
        await form.username.fill(username, { timeout: options.timeoutMs });
        await form.password.fill(password, { timeout: options.timeoutMs });
      } finally {
        username = "";
        password = "";
      }
      if (options.signal?.aborted) {
        throw abortSignalError(options.signal, "Browser login was cancelled.");
      }
      try {
        await form.submit.click({ timeout: options.timeoutMs });
      } catch {
        return { status: "failed", reason: "submit-outcome-unknown" };
      }

      const deadline = Date.now() + options.timeoutMs;
      while (Date.now() < deadline) {
        if (options.signal?.aborted) {
          throw abortSignalError(options.signal, "Browser login was cancelled.");
        }
        const state = await inspectAuthenticationPage(page);
        if (state.state === "authenticated") return { status: "performed" };
        if (state.state === "interaction-required") {
          return { status: "interaction-required", reason: state.reason };
        }
        if (await hasInvalidCredentialSignal(page)) {
          return { status: "failed", reason: "credentials-invalid" };
        }
        await page.waitForTimeout(100);
      }
      return { status: "failed", reason: "postcondition-not-reached" };
    } finally {
      username = "";
      password = "";
      this.consoleEntries.set(page, []);
      this.networkEntries.set(page, []);
      this.snapshots.discard(page);
      this.suppressedDiagnosticPages.delete(page);
    }
  }

  async newTabWithAllowedOrigins(
    url: string,
    origins: readonly string[],
    expiresAt?: string,
  ): Promise<BrowserDriverTab[]> {
    const context = this.requireContext();
    const page = await context.newPage();
    this.attachPage(page);
    this.pageAllowedOrigins.set(page, allowedOriginMap(origins, expiresAt));
    this.current = page;
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.config.navigationTimeoutMs,
    });
    await page.bringToFront();
    return this.tabSnapshot();
  }

  async resolveFramePath(framePath: readonly string[]): Promise<Frame> {
    let frame = this.requireCurrentPage().mainFrame();
    for (const segment of framePath) {
      const children = frame.childFrames();
      const numericIndex = /^\d+$/.test(segment) ? Number(segment) : -1;
      let matched = numericIndex >= 0 ? children[numericIndex] : undefined;
      if (!matched) {
        for (const child of children) {
          if (child.name() === segment) {
            matched = child;
            break;
          }
          const element = await child.frameElement().catch(() => undefined);
          if (!element) continue;
          const [name, id] = await Promise.all([
            element.getAttribute("name").catch(() => null),
            element.getAttribute("id").catch(() => null),
          ]);
          if (name === segment || id === segment) {
            matched = child;
            break;
          }
        }
      }
      if (!matched) {
        throw new AppError("FRAME_NOT_FOUND", `Frame not found: ${segment}`);
      }
      frame = matched;
    }
    return frame;
  }

  currentPageResponse(content?: string): Promise<BrowserDriverResponse> {
    return this.pageResponse(this.requireCurrentPage(), content);
  }

  async connect(): Promise<void> {
    if (this.context) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectInternal().finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  async close(): Promise<void> {
    const context = this.context;
    await Promise.all(
      [...this.liveScreencasts.keys()].map((id) => this.stopLiveScreencast(id)),
    );
    if (this.screencast) {
      await this.stopVideo().catch(() => undefined);
    }
    this.context = undefined;
    this.current = undefined;
    this.traceActive = false;
    this.incrementalSnapshots = false;
    this.pagesById.clear();
    if (context) await context.close().catch(() => undefined);
    await this.networkGuard.stop().catch(() => undefined);
  }

  async navigate(
    input: BrowserNavigateRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("navigate", options, async (page) => {
      await page.goto(input.url, {
        waitUntil: input.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? this.config.navigationTimeoutMs,
      });
      return this.pageResponse(page);
    });
  }

  async goBack(
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("go-back", options, async (page) => {
      await page.goBack({
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs ?? this.config.navigationTimeoutMs,
      });
      return this.pageResponse(page);
    });
  }

  async goForward(
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("go-forward", options, async (page) => {
      await page.goForward({
        waitUntil: "domcontentloaded",
        timeout: options.timeoutMs ?? this.config.navigationTimeoutMs,
      });
      return this.pageResponse(page);
    });
  }

  async snapshot(
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("snapshot", options, async (page) => {
      const captured = await this.captureSemanticSnapshot();
      return this.pageResponse(page, captured.fullContent);
    });
  }

  async inspectPoint(
    input: { x: number; y: number },
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("inspectPoint", options, async (page) => {
      const point = await inspectSemanticPoint(page, input.x, input.y);
      if (!point) throw new AppError("LOCATOR_NOT_FOUND", "No actionable element at the provided CSS coordinates.");
      return this.pageResponse(page, undefined, point);
    });
  }

  async click(
    input: BrowserClickRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("click", options, async (page) => {
      if (input.target) {
        const target = this.refLocator(page, input.target);
        await showActionPointer(target);
        await target.click({
          timeout: options.timeoutMs ?? this.config.actionTimeoutMs,
          ...(input.button ? { button: input.button } : {}),
          ...(input.clickCount ? { clickCount: input.clickCount } : {}),
          ...(input.modifiers ? { modifiers: input.modifiers } : {}),
        });
      } else {
        if (input.x === undefined || input.y === undefined || !input.role || !input.element) {
          throw new AppError("INVALID_ARGUMENT", "Coordinate click requires a classified target.");
        }
        const current = await inspectSemanticPoint(page, input.x, input.y);
        if (!current || current.role !== input.role || current.name !== input.element) {
          throw new AppError("BROWSER_CONFIRMATION_INVALID", "Coordinate target changed before action.");
        }
        await page.mouse.click(input.x, input.y, {
          ...(input.button ? { button: input.button } : {}),
          ...(input.clickCount ? { clickCount: input.clickCount } : {}),
          ...(input.modifiers ? { modifiers: input.modifiers } : {}),
        });
      }
      return this.pageResponse(page);
    });
  }

  async hover(
    input: BrowserHoverRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("hover", options, async (page) => {
      if (input.target) {
        const target = this.refLocator(page, input.target);
        await target.hover({ timeout: options.timeoutMs ?? this.config.actionTimeoutMs });
      } else if (input.x !== undefined && input.y !== undefined) {
        if (!await inspectSemanticPoint(page, input.x, input.y)) {
          throw new AppError("LOCATOR_NOT_FOUND", "Coordinate hover requires a visible actionable element.");
        }
        await page.mouse.move(input.x, input.y);
      } else {
        throw new AppError("INVALID_ARGUMENT", "Hover requires a ref or coordinates.");
      }
      return this.pageResponse(page);
    });
  }

  async viewport(input: import("@vs-code-gpt/shared").BrowserViewportInput): Promise<import("@vs-code-gpt/shared").BrowserViewportResult> {
    const page = this.requireCurrentPage();
    const current = this.viewportSessions.get(page);
    const dimensions = async () => page.evaluate(() => {
      const browser = globalThis as unknown as {
        innerWidth: number; innerHeight: number; devicePixelRatio: number;
        navigator: { userAgent: string; platform: string };
        matchMedia: (query: string) => { matches: boolean };
      };
      return {
        width: Math.max(1, browser.innerWidth),
        height: Math.max(1, browser.innerHeight),
        deviceScaleFactor: browser.devicePixelRatio || 1,
        userAgent: browser.navigator.userAgent,
        platform: browser.navigator.platform,
        colorScheme: browser.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" as const : "light" as const,
      };
    });
    if (input.preset === "reset") {
      if (current) {
        await current.session.send("Emulation.clearDeviceMetricsOverride");
        await current.session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
        await current.session.send("Emulation.setEmulatedMedia", { media: "", features: [] });
        await current.session.send("Emulation.setUserAgentOverride", { userAgent: current.original.userAgent, platform: current.original.platform });
        await current.session.detach();
        this.viewportSessions.delete(page);
      }
      const original = await dimensions();
      return { tabId: input.tabId, width: original.width, height: original.height,
        deviceScaleFactor: original.deviceScaleFactor, userAgent: original.userAgent,
        mobile: false, touch: false, colorScheme: original.colorScheme, emulated: false };
    }
    if (input.preset === "window") {
      throw new AppError("BROWSER_CAPABILITY_UNSUPPORTED", "Real window resize is available in personal Chrome mode.");
    }
    const presets = {
      desktop: { width: 1366, height: 768, dpr: 1, mobile: false, touch: false },
      tablet: { width: 768, height: 1024, dpr: 2, mobile: true, touch: true },
      mobile: { width: 375, height: 812, dpr: 3, mobile: true, touch: true },
      custom: { width: input.width ?? 1280, height: input.height ?? 720, dpr: 1, mobile: false, touch: false },
    } as const;
    const profile = presets[input.preset];
    const width = profile.width;
    const height = profile.height;
    const deviceScaleFactor = input.deviceScaleFactor ?? profile.dpr;
    const touch = input.touch ?? profile.touch;
    const colorScheme = input.colorScheme ?? "no-preference";
    let session = current?.session;
    const created = !session;
    const original = current?.original ?? await dimensions();
    const chromeVersion = /Chrome\/([\d.]+)/u.exec(original.userAgent)?.[1];
    const mobileUA = chromeVersion && (input.preset === "mobile" || input.preset === "tablet")
      ? `Mozilla/5.0 (Linux; Android 14; ${input.preset === "mobile" ? "Pixel 7" : "Pixel Tablet"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} ${input.preset === "mobile" ? "Mobile " : ""}Safari/537.36`
      : original.userAgent;
    const userAgent = input.userAgent ?? mobileUA;
    if (!session) {
      session = await page.context().newCDPSession(page);
      this.viewportSessions.set(page, { session, original: { userAgent: original.userAgent, platform: original.platform, colorScheme: original.colorScheme } });
      page.once("close", () => {
        void session?.detach().catch(() => undefined);
        this.viewportSessions.delete(page);
      });
    }
    try {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor, mobile: profile.mobile,
        screenWidth: width, screenHeight: height,
      });
      await session.send("Emulation.setTouchEmulationEnabled", {
        enabled: touch, maxTouchPoints: touch ? 5 : 1,
      });
      await session.send("Emulation.setEmulatedMedia", {
        media: "screen", features: [{ name: "prefers-color-scheme", value: colorScheme }],
      });
      await session.send("Emulation.setUserAgentOverride", {
        userAgent, platform: profile.mobile ? "Android" : original.platform,
      });
    } catch (error) {
      if (created) {
        await session.detach().catch(() => undefined);
        this.viewportSessions.delete(page);
      }
      throw error;
    }
    return { tabId: input.tabId, width, height, deviceScaleFactor,
      mobile: profile.mobile, touch, colorScheme, userAgent, emulated: true };
  }

  async dialog(input: BrowserDialogInput): Promise<BrowserDialogResult> {
    const page = this.requireCurrentPage();
    const current = this.observedDialogs.get(page);
    const describe = (entry: ObservedJsDialog | undefined): BrowserDialogResult => ({
      tabId: input.tabId,
      state: !entry ? "idle" : entry.dialog ? "open" : "armed",
      ...(entry?.dialog ? {
        dialogType: entry.dialog.type() as NonNullable<BrowserDialogResult["dialogType"]>,
        message: entry.dialog.message(),
      } : {}),
      ...(entry ? { expiresAt: entry.expiresAt } : {}),
    });
    if (input.action === "inspect") return describe(current);
    if (input.action === "cancel") {
      if (current?.dialog) await current.dialog.dismiss().catch(() => undefined);
      current?.cleanup();
      return describe(undefined);
    }
    if (input.action === "arm") {
      if (current) throw new AppError("EXECUTION_STATE_INVALID", "An observer is already armed for this tab.");
      const expiresAt = new Date(Date.now() + 30_000).toISOString();
      let state!: ObservedJsDialog;
      const cleanup = () => {
        clearTimeout(state.timer);
        page.off("dialog", state.onDialog);
        this.observedDialogs.delete(page);
      };
      const onDialog = (dialog: Dialog) => {
        if (dialog.message().length > 2_000) {
          void dialog.dismiss().catch(() => undefined).finally(cleanup);
          return;
        }
        state.dialog = dialog;
      };
      state = {
        expiresAt,
        cleanup,
        onDialog,
        timer: setTimeout(() => {
          if (state.dialog) void state.dialog.dismiss().catch(() => undefined).finally(cleanup);
          else cleanup();
        }, 30_000),
      };
      page.on("dialog", onDialog);
      this.observedDialogs.set(page, state);
      return describe(state);
    }
    if (!current?.dialog || input.expectedMessage === undefined ||
        input.expectedMessage !== current.dialog.message()) {
      throw new AppError("BROWSER_CONFIRMATION_INVALID", "Dialog is absent or its message changed.");
    }
    const dialog = current.dialog;
    if (input.promptText !== undefined && dialog.type() !== "prompt") {
      throw new AppError("INVALID_ARGUMENT", "Prompt text requires a prompt dialog.");
    }
    try {
      if (input.response === "accept") await dialog.accept(input.promptText);
      else await dialog.dismiss();
    } finally {
      current.cleanup();
    }
    return describe(undefined);
  }

  async drag(
    input: BrowserDragRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("drag", options, async (page) => {
      const locate = async (endpoint: BrowserDragRequest["from"]): Promise<{ x: number; y: number }> => {
        if (endpoint.target) {
          const rect = await this.refLocator(page, endpoint.target).boundingBox();
          if (!rect || rect.width <= 0 || rect.height <= 0) {
            throw new AppError("LOCATOR_NOT_FOUND", "Drag endpoint is not visible.");
          }
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
        if (endpoint.x === undefined || endpoint.y === undefined || !endpoint.role || endpoint.name === undefined) {
          throw new AppError("INVALID_ARGUMENT", "Coordinate drag endpoint must be classified.");
        }
        const found = await inspectSemanticPoint(page, endpoint.x, endpoint.y);
        if (!found || found.role !== endpoint.role || found.name !== endpoint.name) {
          throw new AppError("BROWSER_CONFIRMATION_INVALID", "Coordinate drag endpoint changed before action.");
        }
        return { x: endpoint.x, y: endpoint.y };
      };
      const source = await locate(input.from);
      const destination = await locate(input.to);
      const steps = input.steps ?? 10;
      await page.mouse.move(source.x, source.y);
      await page.mouse.down();
      try {
        for (let i = 1; i <= steps; i += 1) {
          this.assertNotAborted(options.signal);
          const factor = i / steps;
          await page.mouse.move(
            source.x + (destination.x - source.x) * factor,
            source.y + (destination.y - source.y) * factor,
            { steps: 1 },
          );
        }
      } finally {
        await page.mouse.up();
      }
      return this.pageResponse(page);
    });
  }

  async scroll(
    input: BrowserScrollRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("scroll", options, async (page) => {
      if (input.target) {
        const target = this.refLocator(page, input.target);
        await target.scrollIntoViewIfNeeded();
        const bounds = await target.boundingBox();
        if (!bounds) throw new AppError("LOCATOR_NOT_FOUND", "Scroll target is not visible.");
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      } else {
        const viewport = await page.evaluate(() => {
          const global = globalThis as unknown as { innerWidth: number; innerHeight: number };
          return { width: global.innerWidth, height: global.innerHeight };
        });
        const px = input.x ?? Math.floor(viewport.width / 2);
        const py = input.y ?? Math.floor(viewport.height / 2);
        if (!Number.isInteger(px) || !Number.isInteger(py) ||
            px < 0 || py < 0 || px >= viewport.width || py >= viewport.height) {
          throw new AppError("INVALID_ARGUMENT", "Scroll coordinates are outside the CSS viewport.");
        }
        await page.mouse.move(px, py);
      }
      const x = input.direction === "left" ? -input.amount : input.direction === "right" ? input.amount : 0;
      const y = input.direction === "up" ? -input.amount : input.direction === "down" ? input.amount : 0;
      await page.mouse.wheel(x, y);
      return this.pageResponse(page);
    });
  }

  async fill(
    input: BrowserFillRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("fill", options, async (page) => {
      const target = this.refLocator(page, input.target);
      await showActionPointer(target);
      await target.fill(input.text, {
        timeout: options.timeoutMs ?? this.config.actionTimeoutMs,
      });
      if (input.submit) await page.keyboard.press("Enter");
      return this.pageResponse(page);
    });
  }

  async formInput(
    input: { target: string; value: string | number | boolean | string[] },
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("formInput", options, async (page) => {
      const target = this.refLocator(page, input.target);
      if (typeof input.value === "boolean") {
        await target.setChecked(input.value, { timeout: options.timeoutMs ?? this.config.actionTimeoutMs });
      } else if (Array.isArray(input.value)) {
        await target.selectOption(input.value, { timeout: options.timeoutMs ?? this.config.actionTimeoutMs });
      } else if (typeof input.value === "number") {
        await target.fill(String(input.value), { timeout: options.timeoutMs ?? this.config.actionTimeoutMs });
      } else {
        const tag = await target.evaluate((element) => element.tagName.toLowerCase());
        if (tag === "select") {
          await target.selectOption(input.value, { timeout: options.timeoutMs ?? this.config.actionTimeoutMs });
        } else {
          await target.fill(input.value, { timeout: options.timeoutMs ?? this.config.actionTimeoutMs });
        }
      }
      return this.pageResponse(page);
    });
  }

  async type(
    input: { text: string; slowly?: boolean; submit?: boolean },
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("type", options, async (page) => {
      if (input.slowly) {
        if (Array.from(input.text).length > 2_000) {
          throw new AppError("LIMIT_EXCEEDED", "Slow typing is limited to 2,000 characters.");
        }
        await page.keyboard.type(input.text, { delay: 15 });
      } else {
        await page.keyboard.insertText(input.text);
      }
      if (input.submit) await page.keyboard.press("Enter");
      return this.pageResponse(page);
    });
  }

  async press(
    input: BrowserPressRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("press", options, async (page) => {
      const chords = input.key.trim().split(/\s+/u);
      for (let i = 0; i < (input.repeat ?? 1); i += 1) {
        for (const chord of chords) await page.keyboard.press(chord);
      }
      return this.pageResponse(page);
    });
  }

  async wait(
    input: BrowserWaitRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("wait", options, async (page) => {
      await this.waitFor(page, input);
      return this.pageResponse(page);
    });
  }

  async evaluate(
    input: BrowserEvaluateRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("evaluate", options, async (page) => {
      const value = input.target
        ? await evaluateLocatorFunction(
            this.resolveEvaluationLocator(page, input.target),
            input.function,
          )
        : await evaluatePageFunction(page, input.function);
      return this.pageResponse(page, undefined, value);
    });
  }

  async takeScreenshot(
    input: BrowserScreenshotRequest,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserDriverResponse> {
    return this.runOperation("screenshot", options, async (page) => {
      const filename = resolveBrowserPrivateOutputPath(
        this.config.privateDirectory,
        input.filename,
      );
      await mkdir(path.dirname(filename), { recursive: true });
      await page.screenshot({
        path: filename,
        type: input.type ?? "png",
        fullPage: input.fullPage ?? false,
        scale: input.scale ?? "css",
        ...(input.region ? { clip: input.region } : {}),
      });
      return this.pageResponse(page);
    });
  }

  async listTabs(): Promise<BrowserDriverTab[]> {
    this.requireContext();
    return this.tabSnapshot();
  }

  async newTab(url = "about:blank"): Promise<BrowserDriverTab[]> {
    const context = this.requireContext();
    const page = await context.newPage();
    this.attachPage(page);
    this.pageAllowedOrigins.delete(page);
    this.current = page;
    if (url !== "about:blank") {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.config.navigationTimeoutMs,
      });
    }
    await page.bringToFront();
    return this.tabSnapshot();
  }

  async selectTab(index: number): Promise<BrowserDriverTab[]> {
    const page = this.requirePageAt(index);
    this.current = page;
    await page.bringToFront();
    return this.tabSnapshot();
  }

  async selectTabByRemoteId(
    remoteTabId: string,
  ): Promise<{ tab: BrowserDriverTab; tabCount: number }> {
    const id = remoteTabId.includes(":page:")
      ? remoteTabId.slice(remoteTabId.indexOf(":page:") + 6)
      : remoteTabId;
    const page = this.pagesById.get(id);
    if (!page || page.isClosed() || this.crashedPages.has(page)) {
      throw new AppError(
        "STALE_TAB_ID",
        "The tabId cannot be mapped safely after the browser page was closed or crashed.",
      );
    }
    this.current = page;
    await page.bringToFront();
    const tabs = await this.tabSnapshot();
    const tab = tabs.find((candidate) => candidate.id === id);
    if (!tab) {
      throw new AppError(
        "STALE_TAB_ID",
        "The tabId cannot be reconstructed unambiguously.",
      );
    }
    return { tab, tabCount: tabs.length };
  }

  async liveFrame(
    remoteTabId: string,
    afterSeq: number,
  ): Promise<BrowserLiveFrame | null> {
    const id = remoteTabId.includes(":page:")
      ? remoteTabId.slice(remoteTabId.indexOf(":page:") + 6)
      : remoteTabId;
    const page = this.pagesById.get(id);
    if (!page || page.isClosed() || this.crashedPages.has(page)) {
      throw new AppError(
        "STALE_TAB_ID",
        "The browser page is no longer available for live viewing.",
      );
    }
    let stream = this.liveScreencasts.get(id);
    if (!stream) stream = await this.startLiveScreencast(id, page);
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.idleTimer = setTimeout(() => {
      void this.stopLiveScreencast(id);
    }, 10_000);
    stream.idleTimer.unref();
    const next = await stream.mailbox.read(afterSeq, 250);
    if (next) return next;

    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    const scale = Math.min(1, 1280 / viewport.width, 720 / viewport.height);
    for (const quality of [60, 45]) {
      const captured = await stream.session.send("Page.captureScreenshot", {
        format: "jpeg",
        quality,
        fromSurface: true,
        clip: {
          x: 0,
          y: 0,
          width: viewport.width,
          height: viewport.height,
          scale,
        },
      }).catch(() => null);
      if (typeof captured?.data !== "string" || captured.data.length > 512 * 1024) continue;
      const dimensions = jpegFrameDimensions(captured.data);
      if (!dimensions) continue;
      stream.mailbox.publish({ data: captured.data, ...dimensions });
      break;
    }
    return stream.mailbox.read(afterSeq, 1);
  }

  private async startLiveScreencast(
    id: string,
    page: Page,
  ): Promise<LiveScreencast> {
    const session = await this.requireContext().newCDPSession(page);
    const mailbox = new BrowserLiveFrameMailbox(
      { maxFrameBytes: 512 * 1024, minFrameIntervalMs: 150 },
      Date.now(),
    );
    const stream: LiveScreencast = {
      page,
      session,
      mailbox,
      idleTimer: undefined,
      onFrame: (event) => {
        if (event.data.length > 512 * 1024) {
          void session.send("Page.screencastFrameAck", {
            sessionId: event.sessionId,
          }).catch(() => undefined);
          return;
        }
        const dimensions = jpegFrameDimensions(event.data);
        if (dimensions) mailbox.publish({ data: event.data, ...dimensions });
        void session.send("Page.screencastFrameAck", {
          sessionId: event.sessionId,
        }).catch(() => undefined);
      },
    };
    session.on("Page.screencastFrame", stream.onFrame);
    try {
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: 1280,
        maxHeight: 720,
        everyNthFrame: 1,
      });
      this.liveScreencasts.set(id, stream);
      return stream;
    } catch (error) {
      session.off("Page.screencastFrame", stream.onFrame);
      await session.detach().catch(() => undefined);
      throw error;
    }
  }

  private async stopLiveScreencast(id: string): Promise<void> {
    const stream = this.liveScreencasts.get(id);
    if (!stream) return;
    this.liveScreencasts.delete(id);
    if (stream.idleTimer) clearTimeout(stream.idleTimer);
    stream.mailbox.close();
    stream.session.off("Page.screencastFrame", stream.onFrame);
    await stream.session.send("Page.stopScreencast").catch(() => undefined);
    await stream.session.detach().catch(() => undefined);
  }

  async closeTab(index: number): Promise<BrowserDriverTab[]> {
    const page = this.requirePageAt(index);
    const id = this.pageIds.get(page);
    if (id) await this.stopLiveScreencast(id);
    await page.close();
    if (this.current === page) {
      this.current = this.livePages()[0];
      await this.current?.bringToFront().catch(() => undefined);
    }
    return this.tabSnapshot();
  }

  async uploadFiles(paths: readonly string[]): Promise<BrowserDriverResponse> {
    const page = this.requireCurrentPage();
    const chooser = this.pendingFileChoosers.get(page);
    if (chooser) {
      this.pendingFileChoosers.delete(page);
      await chooser.setFiles([...paths]);
      return this.pageResponse(page);
    }
    const input = page.locator('input[type="file"]').first();
    if ((await input.count()) === 0) {
      throw new AppError("FILE_NOT_FOUND", "No pending file chooser or file input was found.");
    }
    await input.setInputFiles([...paths]);
    return this.pageResponse(page);
  }

  currentPage(): Page {
    return this.requireCurrentPage();
  }

  async probeExtraction(
    format: BrowserExtractionFormat,
    frameName?: string,
  ): Promise<BrowserExtractionProbe> {
    const source = extractionProbeEvaluation(format);
    const value = frameName === undefined
      ? await evaluatePageFunction(this.requireCurrentPage(), source)
      : await evaluateFrameFunction(await this.resolveFrame(frameName), source);
    return value as BrowserExtractionProbe;
  }

  async advanceExtractionScroll(frameName?: string): Promise<void> {
    if (frameName === undefined) {
      await evaluatePageFunction(this.requireCurrentPage(), EXTRACTION_SCROLL_EVALUATION);
      return;
    }
    await evaluateFrameFunction(
      await this.resolveFrame(frameName),
      EXTRACTION_SCROLL_EVALUATION,
    );
  }
  async stabilizePage(
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserPageStabilizationResult> {
    const page = this.requireCurrentPage();
    const stabilizer = new BrowserPageStabilizationService({
      probe: () => this.probePageStability(page),
    });
    return stabilizer.stabilize({
      timeoutMs: options.timeoutMs ?? DEFAULT_PAGE_STABILIZATION_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async stabilizeFrame(
    name: string,
    options: BrowserDriverCallOptions = {},
  ): Promise<BrowserPageStabilizationResult> {
    const page = this.requireCurrentPage();
    const frame = await this.resolveFrame(name);
    const stabilizer = new BrowserPageStabilizationService({
      probe: () => this.probeTargetFrameStability(page, frame),
    });
    return stabilizer.stabilize({
      timeoutMs: options.timeoutMs ?? DEFAULT_PAGE_STABILIZATION_TIMEOUT_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async resolveFrame(name: string): Promise<Frame> {
    const page = this.requireCurrentPage();
    const directChild = await this.resolveFramePath([name]).catch(
      () => undefined,
    );
    if (directChild) return directChild;
    const frame = page.frames().find((candidate) =>
      candidate.name() === name ||
      frameElementIdentity(candidate).includes(name),
    );
    if (!frame) throw new AppError("FRAME_NOT_FOUND", `Frame ${name} was not found.`);
    return frame;
  }

  async captureSemanticSnapshot(
    options: DirectSemanticSnapshotOptions = {},
  ): Promise<SemanticSnapshotCapture> {
    const page = this.requireCurrentPage();
    return this.snapshots.capture(page, {
      ...options,
      snapshot: async () => {
        let content = await page.ariaSnapshot({ mode: "ai" });
        if (isSparseSnapshot(content)) {
          this.legacySnapshotPages.add(page);
          const legacy = await captureLegacySummary(page);
          if (legacy) content = `${content}\n\n### Legacy DOM summary\n${legacy}`.trim();
        }
        if (hasBrowserCaptchaChallenge(content, page.frames().map((frame) => frame.url()))) {
          throw new AppError(
            "CAPTCHA_DETECTED",
            "A CAPTCHA requires manual completion in Chromium.",
          );
        }
        return content;
      },
      ...(this.incrementalSnapshots
        ? {
            trackedSnapshot: async () => {
              let content: string;
              try {
                content = await page.ariaSnapshot({
                  mode: "ai",
                  _track: "response",
                } as never);
              }
              catch {
                this.incrementalSnapshots = false;
                const fallbackContent = await page.ariaSnapshot({ mode: "ai" });
                if (hasBrowserCaptchaChallenge(fallbackContent, page.frames().map((frame) => frame.url()))) {
                  throw new AppError("CAPTCHA_DETECTED", "A CAPTCHA requires manual completion in Chromium.");
                }
                return { content: fallbackContent, kind: "full" as const };
              }
              if (this.legacySnapshotPages.has(page)) {
                const legacy = await captureLegacySummary(page);
                if (legacy) {
                  content = `${content}\n\n### Legacy DOM summary\n${legacy}`.trim();
                }
              }
              if (hasBrowserCaptchaChallenge(content, page.frames().map((frame) => frame.url()))) {
                throw new AppError("CAPTCHA_DETECTED", "A CAPTCHA requires manual completion in Chromium.");
              }
              return { content, kind: "delta" as const };
            },
          }
        : {}),
    });
  }

  engineStatus(): DirectPlaywrightEngineStatus {
    return {
      engine: "playwright-direct",
      engineVersion: "1.1.0-beta.1",
      protocolVersion: 3,
      playwrightVersion: "1.62.0-alpha-2026-06-29",
      browserChannel: this.config.browserChannel ?? "chromium",
      chromiumRevision: this.config.browserChannel === "chrome"
        ? "system-chrome"
        : managedChromiumRevision(),
      incrementalSnapshots: this.incrementalSnapshots,
    };
  }

  async readConsole(
    options: BrowserConsoleOptions = {},
  ): Promise<BrowserDiagnosticTextResult> {
    const page = this.requireCurrentPage();
    const entries = this.consoleEntries.get(page) ?? [];
    const level = options.onlyErrors ? "error" : options.level;
    const expression = options.pattern ? new RegExp(validateBrowserNetworkFilter(options.pattern)) : undefined;
    const filtered = entries.filter((entry) =>
      (!level || consoleEntryMeetsThreshold(entry, level)) &&
      (!expression || expression.test(entry)),
    );
    const limit = options.limit ?? this.config.diagnosticMaxEntries;
    const result = this.normalizeDiagnostic(filtered.slice(0, limit).join("\n"));
    if (options.clear) entries.splice(0);
    return result;
  }

  async listNetwork(
    options: BrowserNetworkOptions = {},
  ): Promise<BrowserDiagnosticTextResult> {
    const page = this.requireCurrentPage();
    const sourceEntries = this.networkEntries.get(page) ?? [];
    const filter = options.filter
      ? new RegExp(validateBrowserNetworkFilter(options.filter))
      : undefined;
    const entries = sourceEntries.filter((entry) =>
      options.includeStatic === true || !isStaticRequest(entry.request),
    ).filter((entry) => !filter || filter.test(entry.request.url()));
    const text = entries.map((entry, index) =>
      `${index + 1}. ${entry.request.method()} ${entry.request.url()} ` +
      `${entry.response?.status() ?? entry.failedText ?? "pending"}`,
    ).join("\n");
    const result = this.normalizeDiagnostic(text);
    if (options.clear) sourceEntries.splice(0);
    return result;
  }

  async inspectNetworkRequest(
    index: number,
    detail: BrowserNetworkDetail = "request",
  ): Promise<BrowserDiagnosticTextResult> {
    const entry = (this.networkEntries.get(this.requireCurrentPage()) ?? [])[index - 1];
    if (!entry) throw new AppError("INVALID_ARGUMENT", "Browser network request index was not found.");
    const request = entry.request;
    const response = entry.response;
    let value: unknown;
    switch (detail) {
      case "request":
        value = {
          method: request.method(),
          url: request.url(),
          resourceType: request.resourceType(),
          timestamp: entry.timestamp,
          failure: entry.failedText,
        };
        break;
      case "request-headers":
        value = await request.allHeaders();
        break;
      case "request-body":
        value = request.postData() ?? "";
        break;
      case "response-headers":
        value = response ? await response.allHeaders() : {};
        break;
      case "response-body":
        if (!response) {
          value = "[no response]";
          break;
        }
        {
          const mime = (response.headers()["content-type"] ?? "").toLowerCase();
          if (!/^(?:application\/(?:json|(?:[\w.-]+\+)?json|xml|(?:[\w.-]+\+)?xml|javascript|x-www-form-urlencoded)|text\/)/u.test(mime)) {
            value = "[binary response not available as text]";
            break;
          }
          const body = await response.body();
          value = body.byteLength > 256 * 1024
            ? body.subarray(0, 256 * 1024).toString("utf8") + "\n[truncated]"
            : body.toString("utf8");
        }
        break;
    }
    return this.normalizeDiagnostic(value);
  }

  async startTrace(): Promise<void> {
    if (this.traceActive) throw new AppError("INVALID_ARGUMENT", "Trace recording is already active.");
    await this.artifacts.prepare();
    await this.requireContext().tracing.start({
      screenshots: true,
      snapshots: true,
      sources: false,
    });
    this.traceActive = true;
  }

  async stopTrace(): Promise<BrowserArtifactCollection> {
    if (!this.traceActive) throw new AppError("INVALID_ARGUMENT", "Trace recording is not active.");
    const output = this.artifacts.resolveFilename(undefined, "trace", ".zip");
    try {
      await this.requireContext().tracing.stop({ path: output });
    } finally {
      this.traceActive = false;
    }
    const artifact = await this.artifacts.describe("trace", output);
    return {
      kind: "trace",
      files: [artifact],
      totalBytes: artifact.sizeBytes,
      createdAt: artifact.createdAt,
    };
  }

  async startVideo(options: BrowserVideoOptions = {}): Promise<{ path: string }> {
    if (this.screencast) {
      throw new AppError("INVALID_ARGUMENT", "Video recording is already active.");
    }
    const ffmpegPath = await resolvePlaywrightFfmpegPath();
    if (!ffmpegPath) {
      throw new AppError(
        "BROWSER_CAPABILITY_UNSUPPORTED",
        "The Playwright ffmpeg binary required for dynamic video is unavailable.",
      );
    }
    await this.artifacts.prepare();
    const outputPath = this.artifacts.resolveFilename(
      options.filename,
      "video",
      ".webm",
    );
    const frameDirectory = path.join(
      this.config.privateDirectory,
      "direct",
      "screencast",
      randomUUID(),
    );
    await mkdir(frameDirectory, { recursive: true });
    const session = await this.requireContext().newCDPSession(
      this.requireCurrentPage(),
    );
    const state: ActiveScreencast = {
      session,
      outputPath,
      frameDirectory,
      frameCount: 0,
      pendingWrites: Promise.resolve(),
      onFrame: () => undefined,
    };
    state.onFrame = (event) => {
      const frameNumber = state.frameCount;
      state.frameCount += 1;
      state.pendingWrites = state.pendingWrites.then(async () => {
        const filename = path.join(
          frameDirectory,
          `frame-${String(frameNumber).padStart(6, "0")}.jpg`,
        );
        try {
          await writeFile(filename, Buffer.from(event.data, "base64"), {
            flag: "wx",
          });
        } finally {
          await session.send("Page.screencastFrameAck", {
            sessionId: event.sessionId,
          }).catch(() => undefined);
        }
      });
    };
    session.on("Page.screencastFrame", state.onFrame);
    try {
      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 75,
        maxWidth: options.width ?? 1_280,
        maxHeight: options.height ?? 720,
        everyNthFrame: 1,
      });
      this.screencast = state;
      return { path: outputPath };
    } catch (error) {
      session.off("Page.screencastFrame", state.onFrame);
      await session.detach().catch(() => undefined);
      await rm(frameDirectory, { recursive: true, force: true }).catch(
        () => undefined,
      );
      throw normalizeBrowserDriverError(this.kind, "video-start", error);
    }
  }

  async stopVideo(): Promise<BrowserArtifact> {
    const state = this.screencast;
    if (!state) {
      throw new AppError("INVALID_ARGUMENT", "Video recording is not active.");
    }
    this.screencast = undefined;
    state.session.off("Page.screencastFrame", state.onFrame);
    try {
      await state.session.send("Page.stopScreencast").catch(() => undefined);
      await state.pendingWrites;
      const frameFiles = await listScreencastFrames(state.frameDirectory);
      if (frameFiles.length === 0) {
        const fallback = path.join(state.frameDirectory, "frame-000000.jpg");
        await this.requireCurrentPage().screenshot({
          path: fallback,
          type: "jpeg",
          quality: 75,
        });
      }
      const ffmpegPath = await resolvePlaywrightFfmpegPath();
      if (!ffmpegPath) {
        throw new AppError(
          "BROWSER_CAPABILITY_UNSUPPORTED",
          "The Playwright ffmpeg binary required to finalize video is unavailable.",
        );
      }
      await encodeScreencast(
        ffmpegPath,
        state.frameDirectory,
        state.outputPath,
      );
      return await this.artifacts.describe("video", state.outputPath);
    } finally {
      await state.session.detach().catch(() => undefined);
      await rm(state.frameDirectory, {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    }
  }

  async savePdf(options: BrowserPdfOptions = {}): Promise<BrowserArtifact> {
    await this.artifacts.prepare();
    const output = this.artifacts.resolveFilename(options.filename, "page", ".pdf");
    await this.requireCurrentPage().pdf({ path: output, printBackground: true });
    return this.artifacts.describe("pdf", output);
  }

  async collectDiagnostics(
    options: BrowserDiagnosticsOptions = {},
  ): Promise<BrowserDiagnosticsResult> {
    const [consoleResult, networkResult] = await Promise.all([
      this.readConsole({
        ...(options.consoleLevel ? { level: options.consoleLevel } : {}),
        ...(options.clearAfterRead === undefined
          ? {}
          : { clear: options.clearAfterRead }),
      }),
      this.listNetwork({
        ...(options.includeStaticRequests === undefined
          ? {}
          : { includeStatic: options.includeStaticRequests }),
        ...(options.requestFilter ? { filter: options.requestFilter } : {}),
        ...(options.clearAfterRead === undefined
          ? {}
          : { clear: options.clearAfterRead }),
      }),
    ]);
    return {
      console: consoleResult,
      network: networkResult,
      traceActive: this.traceActive,
      videoActive: this.screencast !== undefined,
      collectedAt: new Date().toISOString(),
    };
  }

  async getAdvancedReadiness(): Promise<BrowserAdvancedReadinessSnapshot> {
    const [ffmpegAvailable, metrics] = await Promise.all([
      this.dependencyProbe.isFfmpegAvailable(),
      this.artifacts.metrics(),
    ]);
    return {
      ffmpegAvailable,
      activeTraces: this.traceActive ? 1 : 0,
      activeVideos: this.screencast ? 1 : 0,
      artifactStorageBytes: metrics.artifactStorageBytes,
      artifactCount: metrics.artifactCount,
    };
  }

  private async connectInternal(): Promise<void> {
    const profileDirectory = this.config.userDataDirectory ??
      path.join(this.config.privateDirectory, "chrome-profile");
    await Promise.all([
      mkdir(profileDirectory, { recursive: true }),
      this.artifacts.prepare(),
    ]);
    try {
      this.networkGuard.beginQuarantine();
      const proxyUrl = await this.networkGuard.start();
      const proxyCredentials = this.networkGuard.credentials();
      const context = await chromium.launchPersistentContext(profileDirectory, {
        headless: this.config.headless ?? false,
        proxy: {
          server: proxyUrl.origin,
          username: proxyCredentials.username,
          password: proxyCredentials.password,
        },
        serviceWorkers: "block",
        ...(this.config.browserChannel === "chrome"
          ? { channel: "chrome" as const }
          : {}),
      });
      context.setDefaultTimeout(this.config.actionTimeoutMs);
      context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
      await context.route("**/*", (route) => this.guardRoute(route));
      this.context = context;
      for (const page of context.pages()) this.attachPage(page);
      context.on("page", (page) => this.attachPage(page));
      context.on("close", () => {
        if (this.context !== context) return;
        this.context = undefined;
        this.current = undefined;
        this.traceActive = false;
        this.incrementalSnapshots = false;
        this.pagesById.clear();
        void this.networkGuard.stop();
      });
      this.current = context.pages().find((page) => !page.isClosed());
      if (!this.current) {
        this.current = await context.newPage();
        this.attachPage(this.current);
      }
      this.networkGuard.endQuarantine();
      await this.current.bringToFront();
      this.incrementalSnapshots = await this.probeIncrementalSnapshot(this.current);
    } catch (error) {
      this.context = undefined;
      await this.networkGuard.stop().catch(() => undefined);
      throw normalizeBrowserDriverError(this.kind, "connect", error);
    }
  }

  private async probePageStability(
    page: Page,
  ): Promise<BrowserPageStabilitySample> {
    const mainFrame = page.mainFrame();
    const document = await probeDocumentStability(mainFrame);
    const childFrames = page.frames().filter((frame) => frame !== mainFrame);
    const inspectedFrames = childFrames.slice(0, MAX_STABILIZATION_FRAME_PROBES);
    const readyStates = await Promise.all(
      inspectedFrames.map((frame) => probeFrameReadyState(frame)),
    );
    const unreadyFrames =
      readyStates.filter((state) => state === "loading").length +
      Math.max(0, childFrames.length - inspectedFrames.length);
    return {
      ...document,
      navigationEpoch: this.frameNavigationEpochs.get(mainFrame) ?? 0,
      frameCount: childFrames.length + 1,
      unreadyFrames,
      pendingRelevantRequests: this.pendingRelevantRequestCount(page),
    };
  }

  private async probeTargetFrameStability(
    page: Page,
    frame: Frame,
  ): Promise<BrowserPageStabilitySample> {
    const document = await probeDocumentStability(frame);
    return {
      ...document,
      navigationEpoch: this.frameNavigationEpochs.get(frame) ?? 0,
      frameCount: 1,
      unreadyFrames: 0,
      pendingRelevantRequests: this.pendingRelevantRequestCount(page, frame),
    };
  }

  private pendingRelevantRequestCount(page: Page, frame?: Frame): number {
    const requests = this.relevantRequests.get(page);
    if (!requests || requests.size === 0) return 0;
    if (!frame) return requests.size;
    let count = 0;
    for (const request of requests) {
      try {
        if (request.frame() === frame) count += 1;
      } catch {}
    }
    return count;
  }

  private beginRelevantRequest(page: Page, request: Request): void {
    if (!STABILIZATION_RESOURCE_TYPES.has(request.resourceType())) return;
    const requests = this.relevantRequests.get(page) ?? new Set<Request>();
    requests.add(request);
    this.relevantRequests.set(page, requests);
  }

  private endRelevantRequest(page: Page, request: Request): void {
    this.relevantRequests.get(page)?.delete(request);
  }

  private attachPage(page: Page): void {
    if (this.pageIds.has(page)) return;
    const id = randomUUID();
    this.pageIds.set(page, id);
    this.pagesById.set(id, page);
    this.consoleEntries.set(page, []);
    this.networkEntries.set(page, []);
    if (!page.isClosed()) {
      void page
        .routeWebSocket("**/*", (route) => this.guardWebSocket(page, route))
        .catch(() => undefined);
    }
    page.on("close", () => {
      this.pagesById.delete(id);
      this.pageAllowedOrigins.delete(page);
      this.pageRequestPolicies.delete(page);
      this.pageSemanticPermitCounts.delete(page);
      this.snapshots.discard(page);
      if (this.current === page) this.current = this.usablePages()[0];
    });
    page.on("crash", () => {
      this.crashedPages.add(page);
      this.snapshots.invalidate(page);
    });
    page.on("frameattached", (frame) => {
      this.frameNavigationEpochs.set(frame, 0);
      this.snapshots.invalidate(page);
    });
    page.on("framedetached", (frame) => {
      this.frameNavigationEpochs.delete(frame);
      this.snapshots.invalidate(page);
    });
    page.on("framenavigated", (frame) => {
      this.frameNavigationEpochs.set(
        frame,
        (this.frameNavigationEpochs.get(frame) ?? 0) + 1,
      );
      this.snapshots.invalidate(page);
    });
    page.on("popup", (popup) => {
      const allowed = this.pageAllowedOrigins.get(page);
      if (allowed) this.pageAllowedOrigins.set(popup, new Map(allowed));
      const requestPolicy = this.pageRequestPolicies.get(page);
      if (requestPolicy) this.pageRequestPolicies.set(popup, requestPolicy);
      const permitCount = this.pageSemanticPermitCounts.get(page);
      if (permitCount) this.pageSemanticPermitCounts.set(popup, permitCount);
      this.attachPage(popup);
    });
    page.on("console", (message) => this.recordConsole(page, message));
    page.on("pageerror", (error) => {
      this.pushConsole(page, `[error] pageerror ${error.message}`);
      this.snapshots.recordEvent(page, {
        type: "pageerror",
        text: error.message.slice(0, 10_000),
      });
    });
    page.on("request", (request) => {
      this.beginRelevantRequest(page, request);
      this.recordRequest(page, request);
    });
    page.on("response", (response) => this.recordResponse(page, response));
    page.on("requestfinished", (request) => this.endRelevantRequest(page, request));
    page.on("requestfailed", (request) => {
      this.endRelevantRequest(page, request);
      this.recordRequestFailure(page, request);
    });
    page.on("dialog", (dialog) => {
      this.snapshots.recordEvent(page, {
        type: "dialog",
        text: `${dialog.type()}: ${dialog.message()}`.slice(0, 10_000),
      });
      void dialog.dismiss().catch(() => undefined);
    });
    page.on("download", (download) => {
      this.snapshots.recordEvent(page, {
        type: "download",
        text: download.suggestedFilename().slice(0, 10_000),
        url: download.url().slice(0, 20_000),
      });
    });
    page.on("filechooser", (chooser) => {
      this.pendingFileChoosers.set(page, chooser);
      this.snapshots.recordEvent(page, { type: "filechooser" });
    });
  }

  private recordConsole(page: Page, message: ConsoleMessage): void {
    if (this.suppressedDiagnosticPages.has(page)) return;
    const level = normalizeConsoleLevel(message.type());
    const text = `[${level}] ${message.text()}`.slice(0, 10_000);
    this.pushConsole(page, text);
    this.snapshots.recordEvent(page, { type: "console", text });
  }

  private pushConsole(page: Page, value: string): void {
    if (this.suppressedDiagnosticPages.has(page)) return;
    const entries = this.consoleEntries.get(page) ?? [];
    entries.push(value);
    if (entries.length > this.config.diagnosticMaxEntries) {
      entries.splice(0, entries.length - this.config.diagnosticMaxEntries);
    }
    this.consoleEntries.set(page, entries);
  }

  private recordRequest(page: Page, request: Request): void {
    if (this.suppressedDiagnosticPages.has(page)) return;
    const entries = this.networkEntries.get(page) ?? [];
    entries.push({ request, timestamp: new Date().toISOString() });
    if (entries.length > this.config.diagnosticMaxEntries) {
      entries.splice(0, entries.length - this.config.diagnosticMaxEntries);
    }
    this.networkEntries.set(page, entries);
    this.snapshots.recordEvent(page, {
      type: "request",
      text: request.method(),
      url: request.url().slice(0, 20_000),
    });
  }

  private recordResponse(page: Page, response: Response): void {
    if (this.suppressedDiagnosticPages.has(page)) return;
    const entry = [...(this.networkEntries.get(page) ?? [])]
      .reverse()
      .find((candidate) => candidate.request === response.request());
    if (entry) entry.response = response;
    this.snapshots.recordEvent(page, {
      type: "response",
      url: response.url().slice(0, 20_000),
      status: response.status(),
    });
  }

  private recordRequestFailure(page: Page, request: Request): void {
    if (this.suppressedDiagnosticPages.has(page)) return;
    const failure = request.failure()?.errorText ?? "request failed";
    const entry = [...(this.networkEntries.get(page) ?? [])]
      .reverse()
      .find((candidate) => candidate.request === request);
    if (entry) entry.failedText = failure;
    this.snapshots.recordEvent(page, {
      type: "requestfailed",
      text: failure.slice(0, 10_000),
      url: request.url().slice(0, 20_000),
    });
  }

  private async probeIncrementalSnapshot(page: Page): Promise<boolean> {
    try {
      const value = await page.ariaSnapshot({
        mode: "ai",
        _track: "response",
      } as never);
      return typeof value === "string";
    } catch {
      return false;
    }
  }

  private async pageResponse(
    page: Page,
    snapshot?: string,
    result?: unknown,
  ): Promise<BrowserDriverResponse> {
    return {
      page: {
        id: this.pageId(page),
        url: safePageUrl(page),
        title: await safePageTitle(page),
      },
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(result === undefined ? {} : { result }),
    };
  }

  private async runOperation<T>(
    operation: string,
    options: BrowserDriverCallOptions,
    execute: (page: Page) => Promise<T>,
  ): Promise<T> {
    this.assertNotAborted(options.signal);
    const page = this.requireCurrentPage();
    try {
      return await execute(page);
    } catch (error) {
      throw normalizeBrowserDriverError(this.kind, operation, error);
    }
  }

  private async tabSnapshot(): Promise<BrowserDriverTab[]> {
    const pages = this.livePages();
    return Promise.all(pages.map(async (page, index) => ({
      id: this.pageId(page),
      index,
      current: page === this.current,
      title: await safePageTitle(page),
      url: safePageUrl(page),
      crashed: this.crashedPages.has(page),
    })));
  }

  private async guardRoute(route: Route): Promise<void> {
    const request = route.request();
    const classification = this.classifyNetworkUrl(request.url());
    if (classification === "denied") {
      await route.abort("blockedbyclient");
      return;
    }
    let page: Page | undefined;
    try {
      page = request.frame().page();
    } catch {
      page = undefined;
    }
    const requestPolicy = page ? this.pageRequestPolicies.get(page) : undefined;
    if (requestPolicy) {
      if (!this.requestAllowedByPolicy(page!, requestPolicy, request)) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
      return;
    }
    if (classification === "public") {
      await route.continue();
      return;
    }
    if (!page || !this.pageAllowsOrigin(page, request.url())) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  }

  private guardWebSocket(page: Page, route: WebSocketRoute): void {
    const classification = this.classifyNetworkUrl(route.url());
    const requestPolicy = this.pageRequestPolicies.get(page);
    const policyAllows = requestPolicy
      ? this.urlAllowedByPolicy(page, requestPolicy, route.url(), "GET", "websocket", "top", false)
      : true;
    if (
      classification === "denied" ||
      !policyAllows ||
      (classification === "private" && !this.pageAllowsOrigin(page, route.url()))
    ) {
      void route.close({ code: 1008, reason: "Blocked by private-site policy" });
      return;
    }
    route.connectToServer();
  }

  private requestAllowedByPolicy(
    page: Page,
    policy: AuthorizedSitePolicy,
    request: Request,
  ): boolean {
    let frame = "top";
    try {
      frame = request.frame().name().trim() || "top";
    } catch {
      frame = "top";
    }
    return this.urlAllowedByPolicy(
      page,
      policy,
      request.url(),
      request.method(),
      request.resourceType(),
      frame,
      request.isNavigationRequest(),
    );
  }

  private urlAllowedByPolicy(
    page: Page,
    policy: AuthorizedSitePolicy,
    value: string,
    method: string,
    resourceType: string,
    frame: string,
    navigation: boolean,
  ): boolean {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (!this.pageAllowsOrigin(page, value)) return false;
    return isAuthorizedSiteRequestAllowed(policy, {
      origin: url.origin,
      method,
      pathname: url.pathname,
      queryKeys: [...url.searchParams.keys()],
      resourceType,
      frame,
      navigation,
      semanticPermit: (this.pageSemanticPermitCounts.get(page) ?? 0) > 0,
    });
  }

  private classifyNetworkUrl(value: string): "public" | "private" | "denied" {
    const origin = networkOrigin(value);
    if (!origin) return "public";
    if (this.deniedOrigins.has(origin)) return "denied";
    return this.privateOrigins.has(origin) ? "private" : "public";
  }

  private pageAllowsOrigin(page: Page, value: string): boolean {
    const origin = networkOrigin(value);
    if (origin === undefined) return false;
    const expiresAt = this.pageAllowedOrigins.get(page)?.get(origin);
    return expiresAt !== undefined && expiresAt > Date.now();
  }

  private usablePages(): Page[] {
    const context = this.context;
    if (!context) return [];
    try {
      return context.pages().filter(
        (page) => !page.isClosed() && !this.crashedPages.has(page),
      );
    } catch {
      return [];
    }
  }

  private livePages(): Page[] {
    return this.requireContext().pages().filter((page) => !page.isClosed());
  }

  private pageId(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    this.attachPage(page);
    return this.pageIds.get(page)!;
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new AppError("BROWSER_DISCONNECTED", "The direct browser engine is not connected.");
    return this.context;
  }

  private requireCurrentPage(): Page {
    const page = this.current;
    if (!page || page.isClosed() || this.crashedPages.has(page)) {
      throw new AppError("BROWSER_DISCONNECTED", "The direct browser engine has no active page.");
    }
    return page;
  }

  private requirePageAt(index: number): Page {
    const page = this.livePages()[index];
    if (!page || this.crashedPages.has(page)) {
      throw new AppError("TAB_NOT_FOUND", `Direct browser page index ${index} was not found.`);
    }
    return page;
  }

  private refLocator(page: Page, ref: string) {
    return page.locator(`aria-ref=${ref}`);
  }

  private resolveEvaluationLocator(page: Page, target: string) {
    return /^[A-Za-z][\w-]*$/.test(target)
      ? this.refLocator(page, target)
      : page.locator(target);
  }

  private async waitFor(
    page: Page,
    input: BrowserWaitRequest,
  ): Promise<void> {
    const timeout = input.time === undefined
      ? this.config.actionTimeoutMs
      : Math.max(0, Math.round(input.time * 1_000));
    if (input.text !== undefined) {
      await page.getByText(input.text, { exact: false }).first().waitFor({
        state: "visible",
        timeout,
      });
      return;
    }
    await page.waitForTimeout(timeout);
  }

  private normalizeDiagnostic(value: unknown): BrowserDiagnosticTextResult {
    return normalizeBrowserDiagnosticPayload(
      value,
      this.config.diagnosticMaxEntries,
      Math.min(this.config.outputMaxBytes, MAX_DIAGNOSTIC_BYTES),
    );
  }

  private assertNotAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw abortSignalError(signal, "Direct Playwright operation was cancelled.");
    }
  }
}

const DOCUMENT_STABILITY_EXPRESSION = `(() => {
  const body = document.body;
  const text = body?.textContent ?? "";
  const html = body?.innerHTML ?? "";
  const sample = (value) => value.length <= 200000
    ? value
    : value.slice(0, 100000) + "|" + value.slice(-100000);
  const source = text.length + ":" + html.length + ":" + document.getElementsByTagName("*").length + "|" + sample(text) + "|" + sample(html);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    readyState: document.readyState,
    signature: (hash >>> 0).toString(16).padStart(8, "0"),
  };
})()`;

async function probeDocumentStability(
  frame: Frame,
): Promise<Pick<BrowserPageStabilitySample, "readyState" | "signature">> {
  if (frame.isDetached()) {
    return { readyState: "loading", signature: "detached" };
  }
  try {
    const value = await frame.evaluate(DOCUMENT_STABILITY_EXPRESSION as never);
    if (
      typeof value === "object" &&
      value !== null &&
      "readyState" in value &&
      "signature" in value &&
      (value.readyState === "loading" ||
        value.readyState === "interactive" ||
        value.readyState === "complete") &&
      typeof value.signature === "string"
    ) {
      return {
        readyState: value.readyState,
        signature: value.signature,
      };
    }
    return { readyState: "loading", signature: "invalid" };
  } catch {
    return { readyState: "loading", signature: "unavailable" };
  }
}

async function probeFrameReadyState(frame: Frame): Promise<BrowserDocumentReadyState> {
  if (frame.isDetached()) return "loading";
  try {
    const value = await frame.evaluate("() => document.readyState" as never);
    return value === "interactive" || value === "complete" ? value : "loading";
  } catch {
    return "loading";
  }
}
export function isDirectPlaywrightDriver(
  driver: unknown,
): driver is DirectPlaywrightDriver {
  return driver instanceof DirectPlaywrightDriver;
}

async function evaluatePageFunction(
  page: Page,
  source: string,
): Promise<unknown> {
  return page.evaluate(
    (expression) => {
      const executable = globalThis.eval(`(${expression})`) as () => unknown;
      return executable();
    },
    source,
  );
}

async function evaluateFrameFunction(
  frame: Frame,
  source: string,
): Promise<unknown> {
  return frame.evaluate(
    (expression) => {
      const executable = globalThis.eval(`(${expression})`) as () => unknown;
      return executable();
    },
    source,
  );
}

async function evaluateLocatorFunction(
  locator: Locator,
  source: string,
): Promise<unknown> {
  return locator.evaluate(
    (element: unknown, expression: string) => {
      const executable = globalThis.eval(`(${expression})`) as (
        value: unknown,
      ) => unknown;
      return executable(element);
    },
    source,
  );
}

async function encodeScreencast(
  ffmpegPath: string,
  frameDirectory: string,
  outputPath: string,
): Promise<void> {
  const frames = await listScreencastFrames(frameDirectory);
  if (frames.length === 0) {
    throw new AppError(
      "RELAY_PROTOCOL_ERROR",
      "Dynamic video recording produced no frames.",
    );
  }
  const process = spawn(ffmpegPath, [
    "-loglevel",
    "error",
    "-y",
    "-f",
    "image2pipe",
    "-c:v",
    "mjpeg",
    "-r",
    "15",
    "-i",
    "pipe:0",
    "-c:v",
    "libvpx",
    "-b:v",
    "1200k",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outputPath,
  ], {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "ignore", "pipe"],
  });
  const completion = new Promise<void>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => {
      process.kill();
      reject(new AppError(
        "BROWSER_WORKER_TIMEOUT",
        "Dynamic video encoding exceeded 120 seconds.",
      ));
    }, 120_000);
    timer.unref();
    process.stderr.on("data", (chunk: Buffer | string) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    process.once("error", (error) => {
      clearTimeout(timer);
      reject(normalizeBrowserDriverError("direct", "video-encode", error));
    });
    process.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new AppError(
        "BROWSER_WORKER_UNAVAILABLE",
        `Dynamic video encoding failed with exit code ${code ?? "unknown"}: ${stderr.slice(0, 2_000)}`,
      ));
    });
  });
  try {
    for (const frame of frames) {
      const buffer = await readFile(path.join(frameDirectory, frame));
      if (!process.stdin.write(buffer)) {
        await once(process.stdin, "drain");
      }
    }
    process.stdin.end();
    await completion;
  } catch (error) {
    process.stdin.destroy();
    process.kill();
    throw error;
  }
}

async function listScreencastFrames(frameDirectory: string): Promise<string[]> {
  return (await readdir(frameDirectory))
    .filter((entry) => /^frame-\d{6}\.jpg$/.test(entry))
    .sort();
}

function safePageUrl(page: Page): string {
  try {
    return new URL(page.url() || "about:blank").href;
  } catch {
    return "about:blank";
  }
}

function managedChromiumRevision(): string {
  const match = /[\\/]chromium-(\d+)[\\/]/i.exec(chromium.executablePath());
  return match?.[1] ?? "unknown";
}

async function safePageTitle(page: Page): Promise<string> {
  if (page.url() === "about:blank") return "";
  return page.title().catch(() => "");
}

function frameElementIdentity(frame: Frame): string {
  return `${frame.name()} ${frame.url()}`;
}

function normalizeConsoleLevel(
  value: string,
): "error" | "warning" | "info" | "debug" {
  if (value === "error" || value === "assert") return "error";
  if (value === "warning" || value === "warn") return "warning";
  if (value === "debug" || value === "verbose") return "debug";
  return "info";
}

function consoleEntryMeetsThreshold(
  entry: string,
  threshold: "error" | "warning" | "info" | "debug",
): boolean {
  const severity = entry.startsWith("[error]")
    ? 0
    : entry.startsWith("[warning]")
      ? 1
      : entry.startsWith("[info]")
        ? 2
        : 3;
  const maximum = {
    error: 0,
    warning: 1,
    info: 2,
    debug: 3,
  }[threshold];
  return severity <= maximum;
}

interface LoginFormLocators {
  username: Locator;
  password: Locator;
  submit: Locator;
}

async function inspectAuthenticationPage(
  page: Page,
): Promise<BrowserAuthenticationInspection> {
  if (page.isClosed()) return { state: "unknown" };
  if (await hasInteractionSignal(page)) {
    return { state: "interaction-required", reason: "mfa-or-captcha" };
  }
  const password = await findVisibleLocator(page, [
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ]);
  if (password) return { state: "login-required" };
  if (page.url() !== "about:blank") return { state: "authenticated" };
  const body = await page.locator("body").innerHTML().catch(() => "");
  return body.trim().length === 0
    ? { state: "unknown" }
    : { state: "authenticated" };
}

async function findLoginForm(page: Page): Promise<LoginFormLocators | undefined> {
  for (const frame of page.frames()) {
    const password = await firstVisible(frame, [
      'input[type="password"]',
      'input[autocomplete="current-password"]',
    ]);
    if (!password) continue;
    const username = await firstVisible(frame, [
      'input[autocomplete="username"]',
      'input[type="email"]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[name*="login" i]',
      'input[id*="login" i]',
      'input[type="text"]',
    ]);
    const submit = await firstVisible(frame, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Entrar")',
      'button:has-text("Login")',
      'button:has-text("Acessar")',
      'input[type="button"][value*="Entrar" i]',
      'input[type="button"][value*="Login" i]',
    ]);
    if (username && submit) return { username, password, submit };
  }
  return undefined;
}

async function hasInteractionSignal(page: Page): Promise<boolean> {
  if (await findVisibleLocator(page, [
    'input[autocomplete="one-time-code"]',
    'input[name*="otp" i]',
    'input[id*="otp" i]',
    'input[name*="token" i]',
    '.g-recaptcha',
    '.h-captcha',
    '[data-sitekey]',
    'iframe[src*="captcha" i]',
    'iframe[title*="captcha" i]',
  ])) return true;
  return page.frames().some((frame) =>
    /captcha|recaptcha|hcaptcha/i.test(frame.url()),
  );
}

async function hasInvalidCredentialSignal(page: Page): Promise<boolean> {
  const pattern = /invalid|incorrect|denied|failed|inválid|incorret|negad|usuário ou senha|senha incorreta/i;
  for (const frame of page.frames()) {
    try {
      const text = await frame.locator("body").innerText({ timeout: 500 });
      if (pattern.test(text)) return true;
    } catch {
    }
  }
  return false;
}

async function findVisibleLocator(
  page: Page,
  selectors: readonly string[],
): Promise<Locator | undefined> {
  for (const frame of page.frames()) {
    const locator = await firstVisible(frame, selectors);
    if (locator) return locator;
  }
  return undefined;
}

async function firstVisible(
  frame: Frame,
  selectors: readonly string[],
): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const candidates = frame.locator(selector);
    const count = Math.min(await candidates.count().catch(() => 0), 10);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return undefined;
}

function allowedOriginMap(
  origins: readonly string[],
  expiresAt?: string,
): Map<string, number> {
  const expiry = expiresAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(expiresAt);
  return new Map(origins.map((origin) => [normalizeOrigin(origin), expiry]));
}

function normalizeOrigin(value: string): string {
  return new URL(value).origin.toLocaleLowerCase("en-US");
}

function networkOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "wss:") url.protocol = "https:";
    if (url.protocol === "ws:") url.protocol = "http:";
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.origin.toLocaleLowerCase("en-US");
  } catch {
    return undefined;
  }
}

function isStaticRequest(request: Request): boolean {
  return ["image", "media", "font", "stylesheet"].includes(
    request.resourceType(),
  );
}

function isSparseSnapshot(content: string): boolean {
  const refs = content.match(/\[ref=[^\]]+\]/g)?.length ?? 0;
  return refs < 3 || content.length < 160;
}

async function captureLegacySummary(page: Page): Promise<string> {
  const summaries: string[] = [];
  for (const [index, frame] of page.frames().entries()) {
    try {
      const summary = await evaluateFrameFunction(
        frame,
        LEGACY_SUMMARY_EVALUATION,
      );
      summaries.push(
        `Frame ${index} "${frame.name() || "main"}" ${frame.url()}\n` +
        JSON.stringify(summary),
      );
    } catch {
      summaries.push(`Frame ${index} "${frame.name() || "unnamed"}" ${frame.url()} [unavailable]`);
    }
  }
  return summaries.join("\n");
}

function extractionProbeEvaluation(format: BrowserExtractionFormat): string {
  return `() => {
    const root = document.scrollingElement || document.documentElement || document.body;
    const candidates = [root, ...Array.from(document.querySelectorAll("main,[role=main],div,section,article")).slice(0, 2000)]
      .filter(Boolean);
    let target = root;
    let bestScore = -1;
    for (const candidate of candidates) {
      const element = candidate;
      const range = Math.max(0, Number(element.scrollHeight || 0) - Number(element.clientHeight || 0));
      if (range <= 2) continue;
      if (element !== root) {
        const style = getComputedStyle(element);
        if (!/(auto|scroll|overlay)/.test(style.overflowY || "")) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) continue;
      }
      const viewport = element === root
        ? Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1)
        : Math.max(1, Number(element.clientHeight || 1));
      const score = range * Math.min(viewport, Math.max(1, window.innerHeight || viewport));
      if (score > bestScore) {
        bestScore = score;
        target = element;
      }
    }
    const text = document.body?.innerText ?? document.body?.textContent ?? "";
    const source = ${JSON.stringify(format)} === "html"
      ? document.documentElement?.outerHTML ?? ""
      : text;
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const relNext = document.querySelector('link[rel~="next"][href],a[rel~="next"][href]');
    let nextUrl;
    if (relNext) {
      const href = relNext.getAttribute("href");
      if (href) {
        try { nextUrl = new URL(href, location.href).href; } catch {}
      }
    }
    const isRoot = target === root;
    return {
      scrollTop: isRoot ? Math.max(0, window.scrollY || root.scrollTop || 0) : Math.max(0, target.scrollTop || 0),
      viewportSize: isRoot
        ? Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1)
        : Math.max(1, target.clientHeight || 1),
      scrollSize: Math.max(1, target.scrollHeight || 1),
      contentBytes: new TextEncoder().encode(source).byteLength,
      signature: (hash >>> 0).toString(16).padStart(8, "0") + ":" + source.length,
      ...(nextUrl ? { nextUrl } : {}),
    };
  }`;
}

const EXTRACTION_SCROLL_EVALUATION = `() => {
  const root = document.scrollingElement || document.documentElement || document.body;
  const candidates = [root, ...Array.from(document.querySelectorAll("main,[role=main],div,section,article")).slice(0, 2000)]
    .filter(Boolean);
  let target = root;
  let bestScore = -1;
  for (const candidate of candidates) {
    const element = candidate;
    const range = Math.max(0, Number(element.scrollHeight || 0) - Number(element.clientHeight || 0));
    if (range <= 2) continue;
    if (element !== root) {
      const style = getComputedStyle(element);
      if (!/(auto|scroll|overlay)/.test(style.overflowY || "")) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
    }
    const viewport = element === root
      ? Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1)
      : Math.max(1, Number(element.clientHeight || 1));
    const score = range * Math.min(viewport, Math.max(1, window.innerHeight || viewport));
    if (score > bestScore) {
      bestScore = score;
      target = element;
    }
  }
  const isRoot = target === root;
  const current = isRoot ? Math.max(0, window.scrollY || root.scrollTop || 0) : Math.max(0, target.scrollTop || 0);
  const viewport = isRoot
    ? Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1)
    : Math.max(1, target.clientHeight || 1);
  const limit = Math.max(0, Number(target.scrollHeight || 0) - viewport);
  const next = Math.min(limit, current + Math.max(1, Math.floor(viewport * 0.85)));
  if (isRoot) window.scrollTo(0, next);
  else target.scrollTop = next;
}`;
const LEGACY_SUMMARY_EVALUATION = `() => {
  const root = document.body || document.documentElement;
  const text = ((root && (root.innerText || root.textContent)) || "")
    .replace(/\\s+/g, " ")
    .trim()
    .slice(0, 10000);
  const controls = Array.from(document.querySelectorAll(
    "a,button,input,select,textarea,[onclick],[role=button],table"
  )).slice(0, 150).map((element) => {
    const isInput = element.tagName === "INPUT";
    const type = element.getAttribute("type") || "";
    const value = isInput && type.toLowerCase() === "password"
      ? "[redacted]"
      : (isInput ? element.value : element.getAttribute("value")) || "";
    return {
      tag: element.tagName.toLowerCase(),
      id: element.id || "",
      name: element.getAttribute("name") || "",
      type,
      text: (
        element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent ||
        ""
      ).replace(/\\s+/g, " ").trim().slice(0, 500),
      value: String(value).slice(0, 500),
    };
  });
  return { title: document.title, url: location.href, text, controls };
}`;
