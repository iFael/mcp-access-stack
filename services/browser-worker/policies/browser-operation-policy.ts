import {
  AppError,
  type BrowserOperation,
} from "@vs-code-gpt/shared";
import type { BrowserDriver } from "../drivers/browser-driver.js";
import { isBrowserAdvancedDriver } from "../drivers/browser-advanced-driver.js";
import {
  resolveBrowserOperationMode,
  type BrowserOperationMode,
} from "./browser-operation-mode.js";

const browserAdvancedOperations = new Set<BrowserOperation>([
  "console",
  "networkList",
  "networkInspect",
  "traceStart",
  "traceStop",
  "videoStart",
  "videoStop",
  "pdf",
  "diagnostics",
]);

const browserBasicObservabilityOperations = new Set<BrowserOperation>([
  "console",
  "networkList",
  "diagnostics",
]);
export type BrowserAdvancedOperation =
  | "console"
  | "networkList"
  | "networkInspect"
  | "traceStart"
  | "traceStop"
  | "videoStart"
  | "videoStop"
  | "pdf"
  | "diagnostics";

export function isBrowserAdvancedOperation(
  operation: BrowserOperation,
): operation is BrowserAdvancedOperation {
  return browserAdvancedOperations.has(operation);
}

export function assertBrowserOperationAllowed(
  operation: BrowserOperation,
  mode: BrowserOperationMode,
  driver: BrowserDriver,
): void {
  if (!isBrowserAdvancedOperation(operation)) return;

  if (!isBrowserAdvancedDriver(driver)) {
    throw new AppError(
      "BROWSER_CAPABILITY_UNSUPPORTED",
      "The direct browser engine does not expose advanced diagnostics.",
    );
  }

  const profile = resolveBrowserOperationMode(mode);
  const allowsBasicInteractiveObservability =
    mode === "interactive" && browserBasicObservabilityOperations.has(operation);
  if (!profile.allowAdvancedOperations && !allowsBasicInteractiveObservability) {
    throw new AppError(
      "BROWSER_OPERATION_MODE_UNSUPPORTED",
      `Browser operation ${operation} requires diagnostic mode; the active session uses ${mode}.`,
    );
  }
}
