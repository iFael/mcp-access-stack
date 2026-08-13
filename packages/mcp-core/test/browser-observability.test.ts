import { describe, expect, it } from "@jest/globals";
import {
  BROWSER_OPERATION_TRACE_HEADER,
  createBrowserOperationTraceId,
  isBrowserOperationTraceId,
} from "../src/browser-observability.js";

describe("browser observability identity", () => {
  it("creates a stable opaque trace id without exposing invocation or fingerprint", () => {
    const invocationId = "invocation-sensitive-value";
    const fingerprint = "f".repeat(64);
    const first = createBrowserOperationTraceId(invocationId, fingerprint);
    const second = createBrowserOperationTraceId(invocationId, fingerprint);

    expect(BROWSER_OPERATION_TRACE_HEADER).toBe("x-mcp-operation-trace");
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{32}$/u);
    expect(first).not.toContain(invocationId);
    expect(first).not.toContain(fingerprint);
    expect(isBrowserOperationTraceId(first)).toBe(true);
  });

  it("separates distinct invocations and fingerprints", () => {
    const base = createBrowserOperationTraceId("invocation-a", "fingerprint-a");

    expect(createBrowserOperationTraceId("invocation-b", "fingerprint-a")).not.toBe(base);
    expect(createBrowserOperationTraceId("invocation-a", "fingerprint-b")).not.toBe(base);
    expect(isBrowserOperationTraceId("not-a-trace")).toBe(false);
  });
});
