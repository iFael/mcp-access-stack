import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { BrowserWorkerClient } from "../../../src/browser/client.js";
import { AppError, createOperationDeadline, createOperationLifecycle } from "@vs-code-gpt/shared";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("BrowserWorkerClient", () => {
  it("calls the authenticated loopback worker and validates the result", async () => {
    const { url } = await listen((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${"x".repeat(32)}`);
      expect(request.headers["x-browser-engine-protocol"]).toBe("3");
      expect(request.headers["x-mcp-owner-scope"]).toBe("principal:opaque");
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          ok: true,
          result: {
            state: "disconnected",
            ready: false,
            browser: "chrome",
            profile: "default",
            autoLaunch: true,
            tabGroup: "MCP",
            edgeFallback: "technical-necessity-only",
            tabCount: 0,
          },
        }),
      );
    });
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
    });
    await expect(client.status({}, { ownerScope: "principal:opaque" })).resolves.toMatchObject({
      state: "disconnected",
      ready: false,
    });
  });

  it("calls and validates private-site authorization", async () => {
    const { url } = await listen((request, response) => {
      expect(request.headers["x-mcp-owner-scope"]).toBe("principal:private");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        result: {
          status: "confirmation_required",
          taskId: "task-private",
          siteId: "private-site",
          confirmationId: "site-confirm-private",
          expiresAt: "2026-08-02T20:00:00.000Z",
          reasons: ["Authorize access."],
        },
      }));
    });
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 5_000,
      maxPayloadBytes: 1024 * 1024,
    });

    await expect(client.openAuthorizedSite({
      siteId: "private-site",
      purpose: "read-report",
    }, { ownerScope: "principal:private" })).resolves.toMatchObject({
      status: "confirmation_required",
      taskId: "task-private",
      siteId: "private-site",
    });
  });

  it("calls and validates the public diagnostics operation", async () => {
    const collectedAt = "2026-07-02T14:30:00.000Z";
    const { url } = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
        operation: "diagnostics",
        input: { tabId: "tab-1", consoleLevel: "warning" },
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        result: {
          tabId: "tab-1",
          console: { text: "console", truncated: false, collectedAt },
          network: { text: "network", truncated: false, collectedAt },
          traceActive: false,
          videoActive: false,
          collectedAt,
        },
      }));
    });
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
    });

    await expect(
      client.diagnostics({ tabId: "tab-1", consoleLevel: "warning" }),
    ).resolves.toMatchObject({
      tabId: "tab-1",
      traceActive: false,
      videoActive: false,
    });
  });

  it("preserves structured timeout diagnostics returned by the worker", async () => {
    const { url } = await listen((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: false,
        error: {
          code: "BROWSER_WORKER_TIMEOUT",
          message: "operation timed out",
          lifecycle: {
            requestedTimeoutMs: 60_000,
            effectiveTimeoutMs: 60_000,
            deadlineAt: "2026-07-26T12:01:00.000Z",
            elapsedMs: 60_000,
            terminatedBy: "executor",
            reason: "timeout",
          },
        },
      }));
    });
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 1_000,
      maxPayloadBytes: 1024 * 1024,
    });

    await expect(client.status({})).rejects.toMatchObject({
      code: "BROWSER_WORKER_TIMEOUT",
      lifecycle: {
        terminatedBy: "executor",
        reason: "timeout",
      },
    });
  });

  it("propagates an MCP cancellation into the browser worker HTTP request", async () => {
    const { url } = await listen(() => undefined);
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
    });
    const startedAt = Date.now();
    const deadline = createOperationDeadline(10_000, undefined, startedAt);
    const controller = new AbortController();
    const pending = client.status({}, { signal: controller.signal, deadline });

    controller.abort(
      new AppError("OPERATION_CANCELLED", "Browser request cancelled.", {
        lifecycle: createOperationLifecycle(deadline, startedAt, {
          layer: "mcp_server",
          reason: "cancelled",
          diagnostic: "Test cancellation.",
        }),
      }),
    );

    await expect(pending).rejects.toMatchObject({
      code: "OPERATION_CANCELLED",
      lifecycle: { reason: "cancelled", terminatedBy: "mcp_server" },
    });
  });

  it("maps an unavailable worker to a public browser error", async () => {
    const { url, server } = await listen((_request, response) => response.end());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 100,
      maxPayloadBytes: 1024 * 1024,
    });
    await expect(client.status({})).rejects.toMatchObject({
      code: "BROWSER_WORKER_UNAVAILABLE",
    });
  });

  it("maps worker timeouts without affecting workspace operations", async () => {
    const { url } = await listen(() => undefined);
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 20,
      maxPayloadBytes: 1024 * 1024,
    });
    await expect(client.status({})).rejects.toMatchObject({
      code: "BROWSER_WORKER_TIMEOUT",
      lifecycle: {
        terminatedBy: "http_client",
        reason: "upstream_timeout",
      },
    });
  });

  it("uses distinct idempotency keys for different operations under one correlation", async () => {
    const callIds: string[] = [];
    const { url } = await listen(async (request, response) => {
      callIds.push(String(request.headers["x-mcp-call-id"]));
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        operation: string;
      };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: true,
        result: body.operation === "connect"
          ? browserStatusResult()
          : {
              tab: {
                tabId: "tab-1",
                ownership: "mcp",
                purpose: "private-site",
                reusable: false,
                protected: true,
                sticky: true,
                createdAt: "2026-08-01T23:00:00.000Z",
                lastUsedAt: "2026-08-01T23:00:00.000Z",
                url: "https://dev-private.example.test/app",
                title: "LegacySite",
                lockedUrl: "https://dev-private.example.test/app",
              },
            },
      }));
    });
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
    });
    const context = {
      correlationId: "shared-request",
      invocationId: "shared-invocation",
    };

    await client.connect({}, context);
    await client.open({
      url: "https://dev-private.example.test/app",
      purpose: "private-site",
      reusable: false,
      protected: true,
      sticky: true,
    }, context);

    expect(callIds).toHaveLength(2);
    expect(callIds[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(callIds[1]).toMatch(/^[a-f0-9]{64}$/u);
    expect(callIds[0]).not.toBe(callIds[1]);
  });

  it("reuses the same idempotency key for a legitimate retry", async () => {
    const callIds: string[] = [];
    const { url } = await listen((request, response) => {
      callIds.push(String(request.headers["x-mcp-call-id"]));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: browserStatusResult() }));
    });
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
    });

    const context = {
      correlationId: "shared-request",
      invocationId: "retry-invocation",
    };

    await client.connect({}, context);
    await client.connect({}, context);

    expect(callIds).toHaveLength(2);
    expect(callIds[0]).toBe(callIds[1]);
  });

  it("fails closed on an idempotency conflict without generating a recovery key", async () => {
    const callIds: string[] = [];
    let attempts = 0;
    const logger = { warn: jest.fn() };
    const { url } = await listen((request, response) => {
      attempts += 1;
      callIds.push(String(request.headers["x-mcp-call-id"]));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        ok: false,
        error: {
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "conflict",
        },
      }));
    });
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      logger,
    });

    await expect(client.connect({}, {
      correlationId: "request-1",
      invocationId: "invocation-1",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });

    expect(attempts).toBe(1);
    expect(callIds).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "browser_worker_call_failed",
      operation: "connect",
      failureLayer: "idempotency",
      errorCode: "IDEMPOTENCY_KEY_CONFLICT",
    }));
  });
});

function browserStatusResult() {
  return {
    state: "disconnected",
    ready: false,
    browser: "chrome",
    profile: "default",
    autoLaunch: true,
    tabGroup: "MCP",
    edgeFallback: "technical-necessity-only",
    tabCount: 0,
  } as const;
}

async function listen(
  handler: RequestListener,
): Promise<{ url: URL; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected server address.");
  return {
    url: new URL(`http://127.0.0.1:${address.port}`),
    server,
  };
}
