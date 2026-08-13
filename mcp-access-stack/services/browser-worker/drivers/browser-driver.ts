import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import type { BrowserWorkerConfig } from "../config/browser-worker-config.js";
import type { AuthorizedSitePolicy } from "../domain/authorized-site-policy.js";

export type BrowserDriverKind = "direct";

export interface BrowserDriverTab {
  id?: string;
  index: number;
  current: boolean;
  title: string;
  url: string;
  crashed: boolean;
}

export interface BrowserDriverPage {
  id?: string;
  url: string;
  title: string;
}

export interface BrowserDriverResponse {
  page: BrowserDriverPage;
  snapshot?: string;
  result?: unknown;
}

export interface BrowserDriverCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BrowserNavigateRequest {
  url: string;
  waitUntil?: "commit" | "domcontentloaded" | "load";
}

export interface BrowserClickRequest {
  target: string;
  element?: string;
}

export interface BrowserFillRequest {
  target: string;
  text: string;
  element?: string;
  slowly?: boolean;
  submit?: boolean;
}

export interface BrowserPressRequest {
  key: string;
}

export interface BrowserWaitRequest {
  text?: string;
  time?: number;
}

export interface BrowserEvaluateRequest {
  function: string;
  target?: string;
  element?: string;
}

export interface BrowserScreenshotRequest {
  filename: string;
  type?: "png" | "jpeg";
  scale?: "css" | "device";
  fullPage?: boolean;
}

export type BrowserAuthenticationInspection =
  | { state: "authenticated" }
  | { state: "login-required" }
  | { state: "interaction-required"; reason: "mfa-or-captcha" }
  | { state: "unknown" };

export interface BrowserCredentialInput {
  username: Buffer;
  password: Buffer;
}

export type BrowserCredentialAuthenticationResult =
  | { status: "performed" }
  | { status: "session-reused" }
  | { status: "interaction-required"; reason: "mfa-or-captcha" }
  | {
      status: "failed";
      reason:
        | "login-form-not-found"
        | "credentials-invalid"
        | "submit-outcome-unknown"
        | "postcondition-not-reached";
    };

export interface BrowserCredentialAuthenticationOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface BrowserDriver {
  readonly kind: BrowserDriverKind;
  isConnected(): boolean;
  hasUsablePage?(): boolean;
  enablePrivateOrigin?(origin: string, expiresAt?: string): void;
  disablePrivateOrigin?(origin: string): void;
  setActivePageAllowedOrigins?(
    origins: readonly string[],
    expiresAt?: string,
  ): void;
  setActivePageRequestPolicy?(policy: AuthorizedSitePolicy | undefined): void;
  acquireActivePageSemanticRequestPermit?(): () => void;
  newTabWithAllowedOrigins?(
    url: string,
    origins: readonly string[],
    expiresAt?: string,
  ): Promise<BrowserDriverTab[]>;
  inspectAuthenticationState?(): Promise<BrowserAuthenticationInspection>;
  authenticateWithCredential?(
    credential: BrowserCredentialInput,
    options: BrowserCredentialAuthenticationOptions,
  ): Promise<BrowserCredentialAuthenticationResult>;
  connect(): Promise<void>;
  close(): Promise<void>;
  navigate(
    input: BrowserNavigateRequest,
    options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse>;
  goBack(options?: BrowserDriverCallOptions): Promise<BrowserDriverResponse>;
  goForward(options?: BrowserDriverCallOptions): Promise<BrowserDriverResponse>;
  snapshot(options?: BrowserDriverCallOptions): Promise<BrowserDriverResponse>;
  click(
    input: BrowserClickRequest,
    options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse>;
  fill(
    input: BrowserFillRequest,
    options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse>;
  press(
    input: BrowserPressRequest,
    options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse>;
  wait(
    input: BrowserWaitRequest,
    options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse>;
  evaluate(
    input: BrowserEvaluateRequest,
    options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse>;
  takeScreenshot(
    input: BrowserScreenshotRequest,
    options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse>;
  listTabs(): Promise<BrowserDriverTab[]>;
  newTab(url?: string): Promise<BrowserDriverTab[]>;
  selectTab(index: number): Promise<BrowserDriverTab[]>;
  closeTab(index: number): Promise<BrowserDriverTab[]>;
  selectTabByRemoteId(
    remoteTabId: string,
  ): Promise<{ tab: BrowserDriverTab; tabCount: number }>;
  uploadFiles(paths: readonly string[]): Promise<BrowserDriverResponse>;
}

export type BrowserDriverFactory = (config: BrowserWorkerConfig) => BrowserDriver;

export function normalizeBrowserDriverError(
  kind: BrowserDriverKind,
  operation: string,
  error: unknown,
): AppError {
  if (error instanceof AppError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const safeOperation = sanitizeBrowserDriverMessage(operation);
  if (
    normalized.includes("request timed out") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout")
  ) {
    return new AppError(
      "BROWSER_WORKER_TIMEOUT",
      `${kind} browser operation ${safeOperation} timed out.`,
      { cause: error },
    );
  }
  if (
    normalized.includes("not connected") ||
    normalized.includes("browser has been closed") ||
    normalized.includes("target page") ||
    normalized.includes("session is not open")
  ) {
    return new AppError(
      "BROWSER_DISCONNECTED",
      `${kind} browser is not connected.`,
      { cause: error },
    );
  }
  return new AppError(
    "BROWSER_WORKER_UNAVAILABLE",
    `${kind} browser operation ${safeOperation} failed: ${sanitizeBrowserDriverMessage(message)}`,
    { cause: error },
  );
}

export function resolveBrowserPrivateOutputPath(
  root: string,
  value: string,
): string {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.resolve(absoluteRoot, value);
  const comparableRoot = process.platform === "win32"
    ? absoluteRoot.toLocaleLowerCase("en-US")
    : absoluteRoot;
  const comparablePath = process.platform === "win32"
    ? absolutePath.toLocaleLowerCase("en-US")
    : absolutePath;
  if (
    comparablePath !== comparableRoot &&
    !comparablePath.startsWith(comparableRoot + path.sep)
  ) {
    throw new AppError(
      "BLOCKED_PATH",
      "Browser output path is outside private storage.",
    );
  }
  return absolutePath;
}

export function sanitizeBrowserDriverMessage(message: string): string {
  return message
    .replace(/authorization:\s*bearer\s+[^\s]+/gi, "authorization: bearer [redacted]")
    .replace(/cookie:\s*[^\r\n]+/gi, "cookie: [redacted]")
    .replace(/([?&](?:access_)?token=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 2_000);
}
