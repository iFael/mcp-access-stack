import { describe, expect, it } from "@jest/globals";
import {
  createMcpControlPlane,
  type EdgeExecutionTransport,
} from "../src/control-plane/mcp-control-plane.js";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol/source";

const principal: AuthenticatedEdgePrincipal = {
  subject: "owner:test",
  scopes: ["mcp:tools"],
  ownerScope: "owner",
};

const manifest = [
  {
    name: "list_workspaces",
    description: "Lists enabled workspaces.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_workspace_context",
    description: "Returns workspace context.",
    inputSchema: {
      type: "object",
      properties: { workspaceId: { type: "string" } },
      required: ["workspaceId"],
      additionalProperties: false,
    },
  },
] as const;

const catalogMetadata = {
  contractRevision: "contract-test",
  toolSetRevision: "toolset-stable",
  toolCount: manifest.length,
  serverVersion: "0.0.0-control-plane-test",
  descriptorRevision: "descriptor-test",
} as const;

const serverIdentity = {
  name: "vs-code-gpt",
  version: catalogMetadata.serverVersion,
} as const;

class FakeExecutionTransport implements EdgeExecutionTransport {
  ready = false;
  generation: number | null = null;
  forwardedCalls: Array<{ body: unknown; principal: AuthenticatedEdgePrincipal }> = [];

  isReady(): boolean {
    return this.ready;
  }

  getGeneration(): number | null {
    return this.generation;
  }

  async execute(body: unknown, caller: AuthenticatedEdgePrincipal): Promise<Response> {
    this.forwardedCalls.push({ body, principal: caller });
    const request = body as { id?: unknown };
    return jsonResponse({
      jsonrpc: "2.0",
      id: request.id ?? null,
      result: {
        content: [{ type: "text", text: "executed" }],
      },
    });
  }
}

describe("Edge MCP control plane availability", () => {
  it("keeps discovery stable while execution disconnects and reconnects", async () => {
    const execution = new FakeExecutionTransport();
    const controlPlane = createMcpControlPlane({
      authenticator: { authenticate: async () => principal },
      execution,
      manifest,
      catalogMetadata,
      serverIdentity,
    });

    const initialized = await controlPlane.handle(mcpRequest(jsonRpc(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "offline-client", version: "1.0.0" },
    })));
    expect(initialized.status).toBe(200);
    expect((await initialized.json()) as Record<string, unknown>).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: serverIdentity },
    });

    const before = await controlPlane.handle(mcpRequest(jsonRpc(2, "tools/list", {})));
    expect(before.status).toBe(200);
    const beforeBody = await before.json() as {
      result: { tools: Array<{ name: string }>; _meta?: Record<string, unknown> };
    };
    expect(beforeBody.result.tools.map((tool) => tool.name)).toEqual(manifest.map((tool) => tool.name));
    expect(beforeBody.result._meta?.["io.github.ifael/mcp-tool-catalog"]).toEqual(catalogMetadata);

    const unavailable = await controlPlane.handle(mcpRequest(jsonRpc(3, "tools/call", {
      name: "list_workspaces",
      arguments: {},
    })));
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      error: {
        code: -32001,
        message: "Execution backend unavailable",
        data: { code: "AGENT_UNAVAILABLE" },
      },
    });
    expect(execution.forwardedCalls).toHaveLength(0);

    const secondClient = createMcpControlPlane({
      authenticator: { authenticate: async () => principal },
      execution,
      manifest,
      catalogMetadata,
      serverIdentity,
    });
    const secondInitialize = await secondClient.handle(mcpRequest(jsonRpc(4, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "new-offline-client", version: "1.0.0" },
    })));
    expect(secondInitialize.status).toBe(200);
    const secondDiscovery = await secondClient.handle(mcpRequest(jsonRpc(5, "tools/list", {})));
    const secondBody = await secondDiscovery.json() as {
      result: { tools: Array<{ name: string }>; _meta?: Record<string, unknown> };
    };
    expect(secondBody.result.tools).toEqual(beforeBody.result.tools);
    expect(secondBody.result._meta).toEqual(beforeBody.result._meta);

    execution.ready = true;
    execution.generation = 98;

    const after = await controlPlane.handle(mcpRequest(jsonRpc(6, "tools/list", {})));
    const afterBody = await after.json() as {
      result: { tools: Array<{ name: string }>; _meta?: Record<string, unknown> };
    };
    expect(afterBody.result.tools).toEqual(beforeBody.result.tools);
    expect(afterBody.result._meta).toEqual(beforeBody.result._meta);

    const executed = await controlPlane.handle(mcpRequest(jsonRpc(7, "tools/call", {
      name: "list_workspaces",
      arguments: {},
    })));
    expect(executed.status).toBe(200);
    expect(execution.forwardedCalls).toHaveLength(1);
    expect(execution.forwardedCalls[0]?.principal).toEqual(principal);
  });

  it("keeps ping and notifications/initialized local while execution is offline", async () => {
    const execution = new FakeExecutionTransport();
    const controlPlane = createMcpControlPlane({
      authenticator: { authenticate: async () => principal },
      execution,
      manifest,
      catalogMetadata,
      serverIdentity,
    });

    const ping = await controlPlane.handle(mcpRequest(jsonRpc(10, "ping", {})));
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ jsonrpc: "2.0", id: 10, result: {} });

    const initializedNotification = await controlPlane.handle(mcpRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }));
    expect(initializedNotification.status).toBe(204);
    expect(execution.forwardedCalls).toHaveLength(0);
  });
});

function jsonRpc(id: number, method: string, params: unknown) {
  return { jsonrpc: "2.0", id, method, params };
}

function mcpRequest(body: unknown): Request {
  return new Request("https://edge.example/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}