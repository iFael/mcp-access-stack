import { describe, expect, it } from "@jest/globals";
import {
  canonicalJson,
  createBrowserIdempotencyKey,
  createBrowserOperationFingerprint,
  createToolOperationContextLease,
} from "../src/index.js";

describe("browser idempotency identity", () => {
  it("canonicalizes object keys deterministically", () => {
    expect(canonicalJson({ beta: 2, alpha: { z: 1, a: true } })).toBe(
      canonicalJson({ alpha: { a: true, z: 1 }, beta: 2 }),
    );
  });

  it("generates stable keys for the same invocation and fingerprint", () => {
    const firstFingerprint = createBrowserOperationFingerprint("open", {
      purpose: "private-site",
      url: "https://dev-private.example.test/app",
    });
    const reorderedFingerprint = createBrowserOperationFingerprint("open", {
      url: "https://dev-private.example.test/app",
      purpose: "private-site",
    });

    expect(reorderedFingerprint).toBe(firstFingerprint);
    expect(createBrowserIdempotencyKey("invocation-1", firstFingerprint)).toBe(
      createBrowserIdempotencyKey("invocation-1", reorderedFingerprint),
    );
  });

  it("separates different operations and inputs", () => {
    const connect = createBrowserOperationFingerprint("connect", {});
    const open = createBrowserOperationFingerprint("open", {
      url: "https://dev-private.example.test/app",
    });
    const otherOpen = createBrowserOperationFingerprint("open", {
      url: "https://example.com/",
    });

    expect(connect).not.toBe(open);
    expect(open).not.toBe(otherOpen);
    expect(createBrowserIdempotencyKey("invocation-1", open)).not.toBe(
      createBrowserIdempotencyKey("invocation-2", open),
    );
  });

  it("creates a distinct invocation id while preserving correlation", () => {
    const extra = {
      signal: new AbortController().signal,
      requestId: "request-42",
    };
    const first = createToolOperationContextLease(undefined, extra);
    const second = createToolOperationContextLease(undefined, extra);

    expect(first.context.correlationId).toBe("request-42");
    expect(second.context.correlationId).toBe("request-42");
    expect(first.context.invocationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(second.context.invocationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.context.invocationId).not.toBe(second.context.invocationId);
  });
});
