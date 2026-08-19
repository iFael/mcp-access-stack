import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import type { AuthenticatedRequest } from "../../../src/http/mcp-middleware.js";
import {
  McpOperationRegistry,
  createGatewayOperationContextFactory,
  createMcpCancellationScopeKey,
  createMcpOperationScopeKey,
  createMcpPrincipalKey,
  extractMcpCancellationNotifications,
} from "../../../src/mcp/operation-registry.js";

describe("McpOperationRegistry", () => {
  it("isolates identical request ids between principals", () => {
    const registry = new McpOperationRegistry();
    const first = registry.begin("principal-a", 7);
    const second = registry.begin("principal-b", 7);

    expect(registry.cancel("principal-a", 7, "stop first")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);

    first.release();
    second.release();
    expect(registry.size).toBe(0);
  });

  it("preserves an early cancellation until the handler registers", () => {
    const registry = new McpOperationRegistry();

    expect(registry.cancel("principal", "request-1", "cancel early")).toBe(false);
    const registration = registry.begin("principal", "request-1");

    expect(registration.signal.aborted).toBe(true);
    expect(registration.signal.reason).toBe("cancel early");
    registration.release();
  });

  it("rejects duplicate in-flight request ids for the same principal", () => {
    const registry = new McpOperationRegistry();
    const registration = registry.begin("principal", 9);

    expect(() => registry.begin("principal", 9)).toThrow(AppError);

    registration.release();
  });
});

describe("gateway MCP operation context", () => {
  it("creates a unique invocation id while preserving the MCP correlation id", () => {
    const registry = new McpOperationRegistry();
    const factory = createGatewayOperationContextFactory({
      registry,
      principalKey: "principal",
      operationScopeKey: "request-scope",
      cancellationScopeKey: "principal",
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
    expect(first.context.ownerScope).toBe("principal");
    expect(second.context.ownerScope).toBe("principal");
    expect(first.context.invocationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(second.context.invocationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(first.context.invocationId).not.toBe(second.context.invocationId);

    second.release();
  });

  it("maps a matched cancellation to a structured cancelled lifecycle", () => {
    const registry = new McpOperationRegistry();
    const requestController = new AbortController();
    const sdkController = new AbortController();
    const factory = createGatewayOperationContextFactory({
      registry,
      principalKey: "principal",
      operationScopeKey: "request-scope",
      cancellationScopeKey: "principal",
      requestSignal: requestController.signal,
    });
    const lease = factory(
      { signal: sdkController.signal, requestId: 11 },
      60_000,
    );

    registry.cancel("principal", 11, "user cancelled");

    expect(lease.context.signal?.aborted).toBe(true);
    expect(lease.context.signal?.reason).toMatchObject({
      code: "OPERATION_CANCELLED",
      lifecycle: {
        reason: "cancelled",
        terminatedBy: "mcp_server",
      },
    });
    lease.release();
    expect(registry.size).toBe(0);
  });

  it("maps an HTTP disconnect to client_disconnected", () => {
    const registry = new McpOperationRegistry();
    const requestController = new AbortController();
    const factory = createGatewayOperationContextFactory({
      registry,
      principalKey: "principal",
      operationScopeKey: "request-scope",
      cancellationScopeKey: "principal",
      requestSignal: requestController.signal,
    });
    const lease = factory(
      { signal: new AbortController().signal, requestId: "http-1" },
      60_000,
    );

    requestController.abort();

    expect(lease.context.signal?.reason).toMatchObject({
      code: "OPERATION_CANCELLED",
      lifecycle: {
        reason: "client_disconnected",
        terminatedBy: "mcp_server",
      },
    });
    lease.release();
  });
});

describe("MCP cancellation parsing and principal identity", () => {
  it("extracts cancellation notifications from single and batch payloads", () => {
    expect(
      extractMcpCancellationNotifications({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 12, reason: "stop" },
      }),
    ).toEqual([{ requestId: 12, reason: "stop" }]);

    expect(
      extractMcpCancellationNotifications([
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: "abc" },
        },
      ]),
    ).toEqual([{ requestId: "abc" }]);
  });

  it("keeps one anonymous MCP session stable across proxy IP changes", () => {
    const first = anonymousRequest("203.0.113.10", "stable-session");
    const second = anonymousRequest("198.51.100.20", "stable-session");

    const firstKey = createMcpPrincipalKey(first);
    const secondKey = createMcpPrincipalKey(second);

    expect(firstKey).toBe(secondKey);
    expect(firstKey).toMatch(/^openai:[a-f0-9]{64}$/);
    expect(firstKey).not.toContain("openai-subject-test");
    expect(firstKey).not.toContain("stable-session");
  });

  it("isolates anonymous MCP sessions sharing the same proxy identity", () => {
    const first = anonymousRequest("203.0.113.10", "session-a");
    const second = anonymousRequest("203.0.113.10", "session-b");

    expect(createMcpPrincipalKey(first)).not.toBe(createMcpPrincipalKey(second));
  });

  it("isolates OpenAI subjects even when the session identifier matches", () => {
    const first = anonymousRequest(
      "203.0.113.10",
      "shared-session",
      "openai-subject-a",
    );
    const second = anonymousRequest(
      "203.0.113.10",
      "shared-session",
      "openai-subject-b",
    );

    expect(createMcpPrincipalKey(first)).not.toBe(createMcpPrincipalKey(second));
  });

  it("uses an MCP session id when OpenAI identity headers are unavailable", () => {
    const first = requestWithHeaders("203.0.113.10", {
      "mcp-session-id": "portable-mcp-session",
      "user-agent": "generic-mcp-client",
    });
    const second = requestWithHeaders("198.51.100.20", {
      "mcp-session-id": "portable-mcp-session",
      "user-agent": "generic-mcp-client",
    });

    const firstKey = createMcpPrincipalKey(first);
    expect(firstKey).toBe(createMcpPrincipalKey(second));
    expect(firstKey).toMatch(/^session:[a-f0-9]{64}$/);
    expect(firstKey).not.toContain("portable-mcp-session");
  });

  it("does not collapse requests that contain only half of the OpenAI identity", () => {
    const first = requestWithHeaders("203.0.113.10", {
      "x-openai-subject": "openai-subject-test",
      "user-agent": "chatgpt-mcp-test",
    });
    const second = requestWithHeaders("198.51.100.20", {
      "x-openai-subject": "openai-subject-test",
      "user-agent": "chatgpt-mcp-test",
    });

    expect(createMcpPrincipalKey(first)).not.toBe(createMcpPrincipalKey(second));
  });

  it("derives stable identity-bound principals without exposing the token", () => {
    const auth: AuthInfo = {
      token: "secret-access-token",
      clientId: "client-a",
      scopes: ["workspaces:read"],
    };
    const request = {
      auth,
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      header: () => "test-agent",
    } as unknown as AuthenticatedRequest;

    const key = createMcpPrincipalKey(request);

    expect(key).toBe(createMcpPrincipalKey(request));
    expect(key).toMatch(/^identity:[a-f0-9]{64}$/);
    expect(key).not.toContain(auth.token);
  });

  it("isolates stateless duplicate detection while preserving principal-scoped cancellation", () => {
    const first = authenticatedRequest("http-request-a");
    const second = authenticatedRequest("http-request-b");
    const firstPrincipal = createMcpPrincipalKey(first);
    const secondPrincipal = createMcpPrincipalKey(second);

    expect(firstPrincipal).toBe(secondPrincipal);

    const firstScope = createMcpOperationScopeKey(first, firstPrincipal);
    const secondScope = createMcpOperationScopeKey(second, secondPrincipal);
    const firstCancellationScope = createMcpCancellationScopeKey(first, firstPrincipal);
    const secondCancellationScope = createMcpCancellationScopeKey(second, secondPrincipal);
    expect(firstScope).not.toBe(secondScope);
    expect(firstScope).toMatch(/^request:[a-f0-9]{64}$/u);
    expect(firstCancellationScope).toBe(secondCancellationScope);
    expect(firstCancellationScope).toBe(firstPrincipal);

    const registry = new McpOperationRegistry();
    const firstRegistration = registry.begin(firstScope, 7, firstCancellationScope);
    const secondRegistration = registry.begin(secondScope, 7, secondCancellationScope);

    expect(registry.cancel(firstCancellationScope, 7, "stop stateless request")).toBe(true);
    expect(firstRegistration.signal.aborted).toBe(true);
    expect(secondRegistration.signal.aborted).toBe(true);

    firstRegistration.release();
    secondRegistration.release();
    expect(registry.size).toBe(0);
  });

  it("keeps duplicate detection stable across requests that share an MCP session", () => {
    const first = authenticatedRequest("http-request-a", {
      "mcp-session-id": "session-a",
    });
    const second = authenticatedRequest("http-request-b", {
      "mcp-session-id": "session-a",
    });
    const principal = createMcpPrincipalKey(first);
    const firstScope = createMcpOperationScopeKey(first, principal);
    const secondScope = createMcpOperationScopeKey(second, principal);
    const cancellationScope = createMcpCancellationScopeKey(first, principal);

    expect(firstScope).toBe(secondScope);
    expect(firstScope).toMatch(/^mcp-session:[a-f0-9]{64}$/u);
    expect(cancellationScope).toBe(firstScope);

    const registry = new McpOperationRegistry();
    const registration = registry.begin(firstScope, 9, cancellationScope);
    expect(() => registry.begin(secondScope, 9, cancellationScope)).toThrow(AppError);
    registration.release();
  });
});

function anonymousRequest(
  ip: string,
  sessionId: string,
  subject = "openai-subject-test",
): AuthenticatedRequest {
  return requestWithHeaders(ip, {
    "x-openai-subject": subject,
    "x-openai-session": sessionId,
    "user-agent": "chatgpt-mcp-test",
  });
}

function requestWithHeaders(
  ip: string,
  headers: Record<string, string>,
): AuthenticatedRequest {
  return {
    ip,
    socket: { remoteAddress: ip },
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as AuthenticatedRequest;
}

function authenticatedRequest(
  mcpRequestId: string,
  headers: Record<string, string> = {},
): AuthenticatedRequest {
  const auth: AuthInfo = {
    token: "shared-access-token",
    clientId: "client-a",
    scopes: ["workspaces:read"],
  };
  return {
    auth,
    mcpRequestId,
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as AuthenticatedRequest;
}
