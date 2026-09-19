import { describe, expect, it, jest } from "@jest/globals";
import {
  EDGE_INTERNAL_ASSERTION_HEADER,
  EDGE_INTERNAL_PRINCIPAL_HEADER,
} from "../../../src/edge/internal-trust.js";
import { assertLoopbackMcpCompatibility } from "../../../src/edge/loopback-health.js";

describe("loopback MCP health", () => {
  it("accepts stateless tools/list compatibility without creating a session", async () => {
    const fetchImpl = jest.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get(EDGE_INTERNAL_ASSERTION_HEADER)).toBe("a".repeat(43));
      expect(headers.get(EDGE_INTERNAL_PRINCIPAL_HEADER)).toBeTruthy();
      expect(headers.get("mcp-session-id")).toBeNull();
      expect(headers.get("accept")).toBe("application/json, text/event-stream");

      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: "loopback-health",
        result: { tools: [{ name: "list_workspaces" }] },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      assertLoopbackMcpCompatibility(
        new URL("http://127.0.0.1:43123/"),
        "a".repeat(43),
        fetchImpl as unknown as typeof fetch,
      ),
    ).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://127.0.0.1:43123/mcp");
  });

  it("rejects the pre-fix Server not initialized response", async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "loopback-health",
      error: { code: -32000, message: "Bad Request: Server not initialized" },
    }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }));

    await expect(
      assertLoopbackMcpCompatibility(
        new URL("http://127.0.0.1:43123/"),
        "a".repeat(43),
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("HTTP 400");
  });

  it("rejects an implicit session for a client that did not initialize", async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "loopback-health",
      result: { tools: [] },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "mcp-session-id": "unexpected-session",
      },
    }));

    await expect(
      assertLoopbackMcpCompatibility(
        new URL("http://127.0.0.1:43123/"),
        "a".repeat(43),
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow("unexpectedly created an MCP session");
  });
});
