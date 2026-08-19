import { describe, expect, it } from "@jest/globals";
import {
  McpOperationRegistry,
  createGatewayOperationContextFactory,
} from "../../../src/mcp/operation-registry.js";

describe("gateway idempotency correlation", () => {
  it("keeps correlation diagnostic while distinct invocations remain independent", () => {
    const registry = new McpOperationRegistry();
    const factory = createGatewayOperationContextFactory({
      registry,
      principalKey: "principal-a",
      operationScopeKey: "request-scope-a",
      requestSignal: new AbortController().signal,
    });

    const first = factory(
      { signal: new AbortController().signal, requestId: "request-1" },
      60_000,
    );
    first.release();
    const second = factory(
      { signal: new AbortController().signal, requestId: "request-1" },
      60_000,
    );

    expect(first.context.correlationId).toBe("request-1");
    expect(second.context.correlationId).toBe("request-1");
    expect(first.context.invocationId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(second.context.invocationId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(first.context.invocationId).not.toBe(second.context.invocationId);
    expect(first.context.idempotencyKey).toBeUndefined();
    expect(second.context.idempotencyKey).toBeUndefined();

    second.release();
  });
});
