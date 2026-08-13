import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { describe, expect, it } from "@jest/globals";
import { createGatewayApplication } from "../../../src/app.js";
import { listen, makeGatewayConfig, silentLogger } from "../../support/helpers.js";

const collectedAt = "2026-07-02T00:00:00.000Z";
const workerToken = "w".repeat(32);
const validAuth: AuthInfo = {
  token: "valid",
  clientId: "browser-tools-http-call-test",
  scopes: ["workspaces:read"],
  expiresAt: Math.floor(Date.now() / 1_000) + 300,
  extra: { subject: "allowed-user" },
};

interface WorkerCall {
  operation: string;
  input: Record<string, unknown>;
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe("advanced browser tools HTTP calls", () => {
  it("routes every public advanced action through the authenticated Browser Worker client", async () => {
    const worker = await startBrowserWorkerFixture();
    const gateway = createGatewayApplication(
      makeGatewayConfig({
        browserWorker: {
          url: worker.url,
          token: workerToken,
          timeoutMs: 5_000,
          maxPayloadBytes: 2 * 1024 * 1024,
        },
      }),
      {
        logger: silentLogger(),
        tokenVerifier: { verify: async () => validAuth },
      },
    );
    const http = await listen(gateway.app);

    try {
      await expect(callTool(http.url, 1, "browser_console", {
        tabId: "tab-1",
        level: "debug",
      })).resolves.toMatchObject({
        structuredContent: { tabId: "tab-1", text: "console output" },
      });
      await callTool(http.url, 2, "browser_network", {
        action: "list",
        tabId: "tab-1",
        includeStatic: true,
      });
      await callTool(http.url, 3, "browser_network", {
        action: "inspect",
        tabId: "tab-1",
        index: 1,
        detail: "response-headers",
      });
      await expect(callTool(http.url, 4, "browser_trace", {
        action: "start",
        tabId: "tab-1",
      })).resolves.toMatchObject({
        structuredContent: { action: "start", active: true },
      });
      await expect(callTool(http.url, 5, "browser_trace", {
        action: "stop",
        tabId: "tab-1",
      })).resolves.toMatchObject({
        structuredContent: { action: "stop", kind: "trace", totalBytes: 100 },
      });
      await expect(callTool(http.url, 6, "browser_video", {
        action: "start",
        tabId: "tab-1",
        filename: "video.webm",
        width: 800,
        height: 600,
      })).resolves.toMatchObject({
        structuredContent: { action: "start", active: true },
      });
      await expect(callTool(http.url, 7, "browser_video", {
        action: "stop",
        tabId: "tab-1",
      })).resolves.toMatchObject({
        structuredContent: { action: "stop", kind: "video", sizeBytes: 200 },
      });
      await expect(callTool(http.url, 8, "browser_pdf", {
        tabId: "tab-1",
        filename: "page.pdf",
      })).resolves.toMatchObject({
        structuredContent: { kind: "pdf", sizeBytes: 300 },
      });
      await expect(callTool(http.url, 9, "browser_diagnostics", {
        tabId: "tab-1",
        consoleLevel: "warning",
        includeStaticRequests: true,
      })).resolves.toMatchObject({
        structuredContent: {
          tabId: "tab-1",
          traceActive: false,
          videoActive: false,
        },
      });

      expect(worker.calls).toEqual([
        { operation: "console", input: { tabId: "tab-1", level: "debug" } },
        {
          operation: "networkList",
          input: { tabId: "tab-1", includeStatic: true },
        },
        {
          operation: "networkInspect",
          input: { tabId: "tab-1", index: 1, detail: "response-headers" },
        },
        { operation: "traceStart", input: { tabId: "tab-1" } },
        { operation: "traceStop", input: { tabId: "tab-1" } },
        {
          operation: "videoStart",
          input: {
            tabId: "tab-1",
            filename: "video.webm",
            width: 800,
            height: 600,
          },
        },
        { operation: "videoStop", input: { tabId: "tab-1" } },
        {
          operation: "pdf",
          input: { tabId: "tab-1", filename: "page.pdf" },
        },
        {
          operation: "diagnostics",
          input: {
            tabId: "tab-1",
            consoleLevel: "warning",
            includeStaticRequests: true,
          },
        },
      ]);
    } finally {
      gateway.relay.close();
      await http.close();
      await worker.close();
    }
  });
});

async function callTool(
  gatewayUrl: URL,
  id: number,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<McpToolResult> {
  const response = await fetch(new URL("/mcp", gatewayUrl), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer valid",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  });
  const body = await response.json() as { result: McpToolResult };
  expect(response.status).toBe(200);
  expect(body.result.isError).not.toBe(true);
  return body.result;
}

async function startBrowserWorkerFixture(): Promise<{
  url: URL;
  calls: WorkerCall[];
  close(): Promise<void>;
}> {
  const calls: WorkerCall[] = [];
  const server = createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/operations" ||
      request.headers.authorization !== `Bearer ${workerToken}`
    ) {
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as WorkerCall;
    calls.push(payload);
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      ok: true,
      result: workerResult(payload.operation, payload.input),
    }));
  });
  await listenServer(server);
  const address = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${address.port}`),
    calls,
    close: () => closeServer(server),
  };
}

function workerResult(
  operation: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const tabId = String(input.tabId);
  switch (operation) {
    case "console":
      return {
        tabId,
        text: "console output",
        truncated: false,
        collectedAt,
      };
    case "networkList":
    case "networkInspect":
      return {
        tabId,
        text: "network output",
        truncated: false,
        collectedAt,
      };
    case "traceStart":
      return { tabId, active: true };
    case "traceStop":
      return {
        tabId,
        kind: "trace",
        files: [{
          kind: "trace",
          path: "C:/private/trace.zip",
          sizeBytes: 100,
          createdAt: collectedAt,
        }],
        totalBytes: 100,
        createdAt: collectedAt,
      };
    case "videoStart":
      return {
        tabId,
        path: "C:/private/video.webm",
        active: true,
      };
    case "videoStop":
      return {
        tabId,
        kind: "video",
        path: "C:/private/video.webm",
        sizeBytes: 200,
        createdAt: collectedAt,
      };
    case "pdf":
      return {
        tabId,
        kind: "pdf",
        path: "C:/private/page.pdf",
        sizeBytes: 300,
        createdAt: collectedAt,
      };
    case "diagnostics":
      return {
        tabId,
        console: {
          text: "console output",
          truncated: false,
          collectedAt,
        },
        network: {
          text: "network output",
          truncated: false,
          collectedAt,
        },
        traceActive: false,
        videoActive: false,
        collectedAt,
      };
    default:
      throw new Error(`Unexpected Browser Worker operation: ${operation}`);
  }
}

function listenServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
