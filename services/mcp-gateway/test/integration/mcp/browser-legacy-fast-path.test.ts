import { AppError, type BrowserExecutor } from "@vs-code-gpt/shared";
import { describe, expect, it } from "@jest/globals";
import { createGatewayApplication } from "../../../src/app.js";
import { listen, makeGatewayConfig, silentLogger } from "../../support/helpers.js";

const headers = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "mcp-protocol-version": "2025-06-18",
};

describe("legacy browser MCP fast path", () => {
  it("returns typed structured content and route metadata without the generic server", async () => {
    let calls = 0;
    const browser = {
      domIndex: async (input: { tabId: string }) => {
        calls += 1;
        return {
          tabId: input.tabId,
          framePath: [],
          pageSignature: "page-1",
          frameGraphSignature: "frames-1",
          items: [],
          truncated: false,
          telemetry: { totalMs: 1 },
        };
      },
    } as unknown as BrowserExecutor;
    const gateway = createGatewayApplication(
      makeGatewayConfig({ authMode: "none" }),
      { logger: silentLogger(), browser },
    );
    const http = await listen(gateway.app);

    try {
      const response = await fetch(new URL("/mcp", http.url), {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "browser_dom_index",
            arguments: { tabId: "tab-1" },
          },
        }),
      });
      const body = await response.json() as {
        result: {
          structuredContent: { tabId: string };
          _meta: Record<string, unknown>;
        };
      };

      expect(response.status).toBe(200);
      expect(calls).toBe(1);
      expect(body.result.structuredContent.tabId).toBe("tab-1");
      expect(body.result._meta).toEqual({
        "com.openai.gateway/route": "legacy-browser-fast-path-v1",
      });
    } finally {
      gateway.relay.close();
      await http.close();
    }
  });

  it("publishes detailed timing only for benchmark requests", async () => {
    const browser = {
      domIndex: async (input: { tabId: string }) => ({
        tabId: input.tabId,
        framePath: [],
        pageSignature: "page-1",
        frameGraphSignature: "frames-1",
        items: [],
        truncated: false,
        telemetry: { totalMs: 1 },
      }),
    } as unknown as BrowserExecutor;
    const gateway = createGatewayApplication(
      makeGatewayConfig({ authMode: "none" }),
      { logger: silentLogger(), browser },
    );
    const http = await listen(gateway.app);

    try {
      const response = await fetch(new URL("/mcp", http.url), {
        method: "POST",
        headers: {
          ...headers,
          "x-mcp-benchmark-timing": "1",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 70,
          method: "tools/call",
          params: {
            name: "browser_dom_index",
            arguments: { tabId: "tab-1" },
          },
        }),
      });
      const body = await response.json() as {
        result: {
          _meta: Record<string, unknown>;
        };
      };
      const timing = body.result._meta["com.openai.gateway/timing"] as
        Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.result._meta["com.openai.gateway/route"]).toBe(
        "legacy-browser-fast-path-v1",
      );
      expect(timing).toEqual(expect.objectContaining({
        requestToFastPathMs: expect.any(Number),
        dispatchMs: expect.any(Number),
        inputValidationMs: expect.any(Number),
        operationMs: expect.any(Number),
        outputValidationMs: expect.any(Number),
        serializationProbeMs: expect.any(Number),
        serverBeforeWriteMs: expect.any(Number),
        worker: null,
      }));
    } finally {
      gateway.relay.close();
      await http.close();
    }
  });

  it("falls back to SDK validation when fast-path arguments are invalid", async () => {
    let calls = 0;
    const browser = {
      domIndex: async () => {
        calls += 1;
        throw new Error("Invalid input must not reach the executor.");
      },
    } as unknown as BrowserExecutor;
    const gateway = createGatewayApplication(
      makeGatewayConfig({ authMode: "none" }),
      { logger: silentLogger(), browser },
    );
    const http = await listen(gateway.app);

    try {
      const response = await fetch(new URL("/mcp", http.url), {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 8,
          method: "tools/call",
          params: {
            name: "browser_dom_index",
            arguments: {},
          },
        }),
      });
      const body = await response.json() as {
        error?: { code?: number };
        result?: {
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
      };

      expect(response.status).toBe(200);
      expect(
        body.error?.code === -32602 ||
        (
          body.result?.isError === true &&
          body.result.content?.some((entry) =>
            entry.text?.includes("-32602"),
          ) === true
        ),
      ).toBe(true);
      expect(calls).toBe(0);
    } finally {
      gateway.relay.close();
      await http.close();
    }
  });

  it("preserves typed AppError results on the fast path", async () => {
    const browser = {
      domIndex: async () => {
        throw new AppError("FRAME_NOT_READY", "The requested frame is not ready.");
      },
    } as unknown as BrowserExecutor;
    const gateway = createGatewayApplication(
      makeGatewayConfig({ authMode: "none" }),
      { logger: silentLogger(), browser },
    );
    const http = await listen(gateway.app);

    try {
      const response = await fetch(new URL("/mcp", http.url), {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "browser_dom_index",
            arguments: { tabId: "tab-1" },
          },
        }),
      });
      const body = await response.json() as {
        result: {
          isError: boolean;
          content: Array<{ text: string }>;
          _meta: Record<string, unknown>;
        };
      };

      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toMatch(/^FRAME_NOT_READY:/u);
      expect(body.result._meta).toEqual({
        "com.openai.gateway/route": "legacy-browser-fast-path-v1",
      });
    } finally {
      gateway.relay.close();
      await http.close();
    }
  });
});
