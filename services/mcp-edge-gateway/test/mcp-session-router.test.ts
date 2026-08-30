import { describe, expect, it } from "@jest/globals";
import { createMcpSessionRouter } from "../src/control-plane/mcp-session-router.js";

describe("MCP Durable Object request routing", () => {
  it("routes POST /mcp to the Edge control plane before any execution relay", async () => {
    const calls: string[] = [];
    const router = createMcpSessionRouter({
      oauth: {
        handle: async () => null,
      },
      controlPlane: {
        handle: async () => {
          calls.push("control-plane");
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    });

    const response = await router.route(new Request("https://edge.example/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }));

    expect(response?.status).toBe(200);
    expect(calls).toEqual(["control-plane"]);
  });

  it("keeps Owner OAuth routes local and leaves backend transport routes unclaimed", async () => {
    const router = createMcpSessionRouter({
      oauth: {
        handle: async (request) => {
          const pathname = new URL(request.url).pathname;
          return pathname === "/token"
            ? new Response(JSON.stringify({ token: "redacted-fixture" }), { status: 200 })
            : null;
        },
      },
      controlPlane: {
        handle: async () => new Response(null, { status: 500 }),
      },
    });

    expect((await router.route(new Request("https://edge.example/token", { method: "POST" })))?.status).toBe(200);
    expect(await router.route(new Request("https://edge.example/mcp", { method: "GET" }))).toBeNull();
    expect(await router.route(new Request("https://edge.example/not-owned", { method: "GET" }))).toBeNull();
  });
});