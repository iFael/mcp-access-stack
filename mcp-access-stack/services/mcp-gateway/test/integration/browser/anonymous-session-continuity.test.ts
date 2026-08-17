import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "@jest/globals";
import { createGatewayApplication } from "../../../src/app.js";
import { listen, makeGatewayConfig, silentLogger } from "../../support/helpers.js";

const workerToken = "w".repeat(32);
const timestamp = "2026-08-06T12:00:00.000Z";

interface WorkerCall {
  operation: string;
  input: Record<string, unknown>;
  ownerScope: string;
}

interface McpToolResult {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

describe("anonymous MCP browser session continuity", () => {
  it("preserves ownership across open, wait and extract requests when the proxy IP changes", async () => {
    const worker = await startOwnershipWorker();
    const gateway = createGatewayApplication(
      makeGatewayConfig({
        authMode: "none",
        trustProxy: 1,
        browserWorker: {
          url: worker.url,
          token: workerToken,
          timeoutMs: 5_000,
          maxPayloadBytes: 2 * 1024 * 1024,
        },
      }),
      { logger: silentLogger() },
    );
    const http = await listen(gateway.app);

    try {
      const opened = await callTool(http.url, 1, "browser_open", {
        url: "https://example.test/report",
      }, "203.0.113.10");
      const tabId = readTabId(opened);
      const waited = await callTool(http.url, 2, "browser_wait", {
        tabId,
        text: "Report ready",
      }, "198.51.100.20");
      const extracted = await callTool(http.url, 3, "browser_extract", {
        tabId,
        format: "text",
      }, "192.0.2.30");

      expect(opened.isError).not.toBe(true);
      expect(waited.isError).not.toBe(true);
      expect(extracted.isError).not.toBe(true);
      expect(extracted.structuredContent).toMatchObject({
        tabId,
        format: "text",
        value: "hydrated report content",
      });
      expect(new Set(worker.calls.map((call) => call.ownerScope)).size).toBe(1);
    } finally {
      gateway.relay!.close();
      await http.close();
      await worker.close();
    }
  });

  it("reuses the same tab for the same URL and MCP session when the proxy IP changes", async () => {
    const worker = await startOwnershipWorker();
    const gateway = createGatewayApplication(
      makeGatewayConfig({
        authMode: "none",
        trustProxy: 1,
        browserWorker: {
          url: worker.url,
          token: workerToken,
          timeoutMs: 5_000,
          maxPayloadBytes: 2 * 1024 * 1024,
        },
      }),
      { logger: silentLogger() },
    );
    const http = await listen(gateway.app);

    try {
      const first = await callTool(http.url, 1, "browser_open", {
        url: "https://example.test/report",
        reusable: true,
      }, "203.0.113.10");
      const second = await callTool(http.url, 2, "browser_open", {
        url: "https://example.test/report",
        reusable: true,
      }, "198.51.100.20");

      expect(first.isError).not.toBe(true);
      expect(second.isError).not.toBe(true);
      expect(readTabId(second)).toBe(readTabId(first));
      expect(worker.createdTabCount()).toBe(1);
    } finally {
      gateway.relay!.close();
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
  forwardedFor: string,
): Promise<McpToolResult> {
  const response = await fetch(new URL("/mcp", gatewayUrl), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "x-openai-subject": "openai-subject-continuity-test",
      "x-openai-session": "stable-browser-session",
      "user-agent": "chatgpt-mcp-continuity-test",
      "x-forwarded-for": forwardedFor,
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
  return body.result;
}

function readTabId(result: McpToolResult): string {
  const tab = result.structuredContent?.tab;
  if (typeof tab !== "object" || tab === null || !("tabId" in tab)) {
    throw new Error("Expected browser_open to return a tabId.");
  }
  return String(tab.tabId);
}

async function startOwnershipWorker(): Promise<{
  url: URL;
  calls: WorkerCall[];
  createdTabCount(): number;
  close(): Promise<void>;
}> {
  const calls: WorkerCall[] = [];
  const ownerByTab = new Map<string, string>();
  const tabByOwnerAndUrl = new Map<string, string>();
  let createdTabs = 0;

  const server = createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      request.url !== "/operations" ||
      request.headers.authorization !== `Bearer ${workerToken}`
    ) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      operation: string;
      input: Record<string, unknown>;
    };
    const ownerScope = String(request.headers["x-mcp-owner-scope"] ?? "missing");
    calls.push({ ...payload, ownerScope });

    const result = workerResult(
      payload.operation,
      payload.input,
      ownerScope,
      ownerByTab,
      tabByOwnerAndUrl,
      () => {
        createdTabs += 1;
        return `tab-${createdTabs}`;
      },
    );
    response.statusCode = result.ok ? 200 : 409;
    response.setHeader("content-type", "application/json");
    response.setHeader("x-browser-engine-protocol", "3");
    response.end(JSON.stringify(result));
  });

  await listenServer(server);
  const address = server.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${address.port}`),
    calls,
    createdTabCount: () => createdTabs,
    close: () => closeServer(server),
  };
}

function workerResult(
  operation: string,
  input: Record<string, unknown>,
  ownerScope: string,
  ownerByTab: Map<string, string>,
  tabByOwnerAndUrl: Map<string, string>,
  createTabId: () => string,
): { ok: true; result: Record<string, unknown> } | {
  ok: false;
  error: { code: "TASK_OWNERSHIP_MISMATCH"; message: string };
} {
  if (operation === "open") {
    const url = String(input.url ?? "about:blank");
    const key = `${ownerScope}|${url}`;
    let tabId = tabByOwnerAndUrl.get(key);
    if (!tabId) {
      tabId = createTabId();
      tabByOwnerAndUrl.set(key, tabId);
      ownerByTab.set(tabId, ownerScope);
    }
    return {
      ok: true,
      result: {
        tab: {
          tabId,
          taskId: `task-${tabId}`,
          lifecycle: "task-scoped",
          ownership: "mcp",
          purpose: String(input.purpose ?? "mcp-default"),
          reusable: input.reusable !== false,
          protected: input.protected === true,
          sticky: input.sticky === true,
          createdAt: timestamp,
          lastUsedAt: timestamp,
          url,
          title: "Ownership fixture",
        },
      },
    };
  }

  const tabId = String(input.tabId ?? "missing");
  if (ownerByTab.get(tabId) !== ownerScope) {
    return {
      ok: false,
      error: {
        code: "TASK_OWNERSHIP_MISMATCH",
        message: "The browser task belongs to another owner scope.",
      },
    };
  }
  if (operation === "wait") {
    return { ok: true, result: { tabId, completed: true } };
  }
  if (operation === "extract") {
    return {
      ok: true,
      result: {
        tabId,
        format: String(input.format ?? "text"),
        value: "hydrated report content",
      },
    };
  }
  throw new Error(`Unexpected browser operation: ${operation}`);
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
