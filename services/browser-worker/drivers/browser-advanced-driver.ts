import {
  AppError,
  browserConsoleLevelSchema,
  browserNetworkDetailSchema,
  type BrowserArtifact,
  type BrowserArtifactCollection,
  type BrowserConsoleLevel,
  type BrowserDiagnosticTextResult,
  type BrowserNetworkDetail,
} from "@vs-code-gpt/shared";
export type {
  BrowserArtifact,
  BrowserArtifactCollection,
  BrowserArtifactKind,
  BrowserConsoleLevel,
  BrowserDiagnosticTextResult,
  BrowserNetworkDetail,
} from "@vs-code-gpt/shared";
import type { BrowserDriver } from "./browser-driver.js";
import type { BrowserAdvancedReadinessSnapshot } from "../services/browser-readiness.js";

export const browserConsoleLevels = browserConsoleLevelSchema.options;
export const browserNetworkDetails = browserNetworkDetailSchema.options;

export interface BrowserConsoleOptions {
  level?: BrowserConsoleLevel;
  clear?: boolean;
}

export interface BrowserNetworkOptions {
  includeStatic?: boolean;
  filter?: string;
  clear?: boolean;
}

export interface BrowserVideoOptions {
  filename?: string;
  width?: number;
  height?: number;
}

export interface BrowserPdfOptions {
  filename?: string;
}

export interface BrowserDiagnosticsOptions {
  consoleLevel?: BrowserConsoleLevel;
  includeStaticRequests?: boolean;
  requestFilter?: string;
  clearAfterRead?: boolean;
}

export interface BrowserDiagnosticsResult {
  console: BrowserDiagnosticTextResult;
  network: BrowserDiagnosticTextResult;
  traceActive: boolean;
  videoActive: boolean;
  collectedAt: string;
}

export interface BrowserAdvancedDriver extends BrowserDriver {
  readConsole(options?: BrowserConsoleOptions): Promise<BrowserDiagnosticTextResult>;
  listNetwork(options?: BrowserNetworkOptions): Promise<BrowserDiagnosticTextResult>;
  inspectNetworkRequest(
    index: number,
    detail?: BrowserNetworkDetail,
  ): Promise<BrowserDiagnosticTextResult>;
  startTrace(): Promise<void>;
  stopTrace(): Promise<BrowserArtifactCollection>;
  startVideo(options?: BrowserVideoOptions): Promise<{ path: string }>;
  stopVideo(): Promise<BrowserArtifact>;
  savePdf(options?: BrowserPdfOptions): Promise<BrowserArtifact>;
  collectDiagnostics(
    options?: BrowserDiagnosticsOptions,
  ): Promise<BrowserDiagnosticsResult>;
  getAdvancedReadiness?(): Promise<BrowserAdvancedReadinessSnapshot>;
}

export function isBrowserAdvancedDriver(
  driver: BrowserDriver,
): driver is BrowserAdvancedDriver {
  const candidate = driver as BrowserDriver & Partial<BrowserAdvancedDriver>;
  return (
    typeof candidate.readConsole === "function" &&
    typeof candidate.listNetwork === "function" &&
    typeof candidate.inspectNetworkRequest === "function" &&
    typeof candidate.startTrace === "function" &&
    typeof candidate.stopTrace === "function" &&
    typeof candidate.startVideo === "function" &&
    typeof candidate.stopVideo === "function" &&
    typeof candidate.savePdf === "function" &&
    typeof candidate.collectDiagnostics === "function"
  );
}

export function requireBrowserAdvancedDriver(
  driver: BrowserDriver,
): BrowserAdvancedDriver {
  if (isBrowserAdvancedDriver(driver)) return driver;
  throw new AppError(
    "BROWSER_CAPABILITY_UNSUPPORTED",
    "The direct browser engine does not support advanced diagnostics.",
  );
}

export function normalizeBrowserDiagnosticPayload(
  payload: unknown,
  maxEntries: number,
  maxBytes: number,
): BrowserDiagnosticTextResult {
  const raw = extractDiagnosticText(payload).replaceAll("\r\n", "\n");
  const sanitized = sanitizeBrowserDiagnosticText(raw);
  const lines = sanitized.split("\n");
  const entriesTruncated = lines.length > maxEntries;
  const entryLimited = entriesTruncated
    ? lines.slice(0, maxEntries).join("\n")
    : sanitized;
  const buffer = Buffer.from(entryLimited, "utf8");
  const bytesTruncated = buffer.byteLength > maxBytes;
  const text = bytesTruncated
    ? buffer.subarray(0, maxBytes).toString("utf8")
    : entryLimited;
  return {
    text: text.trim(),
    truncated: entriesTruncated || bytesTruncated,
    collectedAt: new Date().toISOString(),
  };
}

export function sanitizeBrowserDiagnosticResult(
  result: BrowserDiagnosticTextResult,
): BrowserDiagnosticTextResult {
  return {
    ...result,
    text: sanitizeBrowserDiagnosticText(result.text),
  };
}

export function sanitizeBrowserDiagnosticText(value: string): string {
  return value
    .replace(
      /(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
      "$1[redacted]",
    )
    .replace(/((?:set-)?cookie\s*[:=]\s*)[^\r\n]+/gi, "$1[redacted]")
    .replace(/((?:x-)?api-key\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(
      /([?&](?:access_?token|token|api_?key|secret|session|password)=)[^&\s]+/gi,
      "$1[redacted]",
    )
    .replace(
      /("(?:access_?token|token|apiKey|api_key|secret|password|cookie|authorization)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2",
    )
    .replace(
      /((?:access_?token|token|api_?key|secret|password)\s*[=:]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    );
}

export function validateBrowserNetworkFilter(filter: string): string {
  if (filter.length > 500 || /[\r\n\0]/.test(filter)) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Browser network filter is invalid or exceeds 500 characters.",
    );
  }
  try {
    void new RegExp(filter);
  } catch (error) {
    throw new AppError("INVALID_ARGUMENT", "Browser network filter is not a valid regular expression.", {
      cause: error,
    });
  }
  return filter;
}

function extractDiagnosticText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    for (const key of ["result", "console", "network", "output", "text"]) {
      const value = record[key];
      if (typeof value === "string") return value;
      if (value !== undefined) return JSON.stringify(value, null, 2);
    }
  }
  return JSON.stringify(payload ?? {}, null, 2);
}
