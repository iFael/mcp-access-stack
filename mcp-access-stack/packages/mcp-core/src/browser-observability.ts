import { createHash } from "node:crypto";

export const BROWSER_OPERATION_TRACE_HEADER = "x-mcp-operation-trace";

const BROWSER_OPERATION_TRACE_VERSION = "browser-observability-v1";
const TRACE_ID_PATTERN = /^[a-f0-9]{32}$/u;

export function createBrowserOperationTraceId(
  invocationId: string,
  fingerprint: string,
): string {
  return createHash("sha256")
    .update(
      `${BROWSER_OPERATION_TRACE_VERSION}\0${invocationId}\0${fingerprint}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, 32);
}

export function isBrowserOperationTraceId(value: string): boolean {
  return TRACE_ID_PATTERN.test(value);
}
