import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { BrowserWorkerClient } from "../../../src/browser/client.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
});

describe("BrowserWorkerClient operation observability", () => {
  it("propagates one opaque trace and logs only sanitized correlation fields", async () => {
    let traceHeader: string | undefined;
    const logger = { info: jest.fn(), warn: jest.fn() };
    const url = await listen((request, response) => {
      traceHeader = String(request.headers["x-mcp-operation-trace"]);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: browserStatusResult() }));
    });
    const client = new BrowserWorkerClient({
      url,
      token: "x".repeat(32),
      timeoutMs: 10_000,
      maxPayloadBytes: 1024 * 1024,
      logger,
    });

    await client.connect({}, {
      correlationId: "private-correlation-value",
      invocationId: "private-invocation-value",
      ownerScope: "private-owner-value",
    });

    expect(traceHeader).toMatch(/^[a-f0-9]{32}$/u);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: "browser_worker_call_started",
      operation: "connect",
      traceId: traceHeader,
    }));
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: "browser_worker_call_completed",
      operation: "connect",
      traceId: traceHeader,
      status: "success",
    }));
    const serializedLogs = JSON.stringify(logger.info.mock.calls);
    expect(serializedLogs).not.toContain("private-correlation-value");
    expect(serializedLogs).not.toContain("private-invocation-value");
    expect(serializedLogs).not.toContain("private-owner-value");
  });

  it("classifies idempotency conflicts without generating or logging a second identity", async () => {
    let requests = 0;
    const logger = { info: jest.fn(), warn: jest.fn() };
    const url = await listen((_request, response) => {
      requests += 1;
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
      correlationId: "private-correlation",
      invocationId: "private-invocation",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });

    expect(requests).toBe(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "browser_worker_call_failed",
      operation: "connect",
      failureLayer: "idempotency",
      errorCode: "IDEMPOTENCY_KEY_CONFLICT",
    }));
    const serializedLogs = JSON.stringify(logger.warn.mock.calls);
    expect(serializedLogs).not.toContain("private-correlation");
    expect(serializedLogs).not.toContain("private-invocation");
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

async function listen(handler: RequestListener): Promise<URL> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected server address.");
  return new URL(`http://127.0.0.1:${address.port}`);
}
