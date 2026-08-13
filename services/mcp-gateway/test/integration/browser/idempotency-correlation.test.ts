import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "@jest/globals";
import { BrowserWorkerClient } from "../../../src/browser/client.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("BrowserWorkerClient idempotency correlation", () => {
  it("reuses one call id only inside the same invocation", async () => {
    const callIds: string[] = [];
    const url = await listen((request, response) => {
      callIds.push(String(request.headers["x-mcp-call-id"]));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result: browserStatusResult() }));
    });
    const client = clientFor(url);
    const context = {
      correlationId: "shared-correlation",
      invocationId: "invocation-a",
    };

    await client.connect({}, context);
    await client.connect({}, context);
    await client.connect({}, {
      correlationId: "shared-correlation",
      invocationId: "invocation-b",
    });

    expect(callIds).toHaveLength(3);
    expect(callIds[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(callIds[1]).toBe(callIds[0]);
    expect(callIds[2]).not.toBe(callIds[0]);
  });
});

function clientFor(url: URL): BrowserWorkerClient {
  return new BrowserWorkerClient({
    url,
    token: "x".repeat(32),
    timeoutMs: 10_000,
    maxPayloadBytes: 1024 * 1024,
  });
}

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
