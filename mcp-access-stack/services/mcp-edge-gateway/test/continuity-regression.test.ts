import { describe, expect, it } from "@jest/globals";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol/source";
import {
  createMcpControlPlane,
  type EdgeExecutionTransport,
} from "../src/control-plane/mcp-control-plane.js";
import {
  EDGE_MCP_CATALOG_METADATA,
  EDGE_MCP_SERVER_IDENTITY,
  EDGE_MCP_TOOL_MANIFEST,
} from "../src/generated/mcp-tool-manifest.js";

const principal: AuthenticatedEdgePrincipal = {
  subject: "owner:continuity",
  scopes: ["mcp:tools"],
  ownerScope: "owner",
};

class SwappableExecution implements EdgeExecutionTransport {
  ready = true;
  generation: number | null = 1;
  calls: Array<{ generation: number | null; principal: AuthenticatedEdgePrincipal }> = [];

  isReady(): boolean {
    return this.ready;
  }

  getGeneration(): number | null {
    return this.generation;
  }

  async execute(body: unknown, caller: AuthenticatedEdgePrincipal): Promise<Response> {
    this.calls.push({ generation: this.generation, principal: caller });
    const id = typeof body === "object" && body !== null && "id" in body
      ? (body as { id?: unknown }).id ?? null
      : null;
    return response({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `generation:${String(this.generation)}` }] },
    });
  }
}

describe("MCP control-plane continuity regression", () => {
  it("preserves the MCP identity and exact catalog across disconnect, new discovery, and reconnect", async () => {
    const execution = new SwappableExecution();
    const createSession = () => createMcpControlPlane({
      authenticator: { authenticate: async () => principal },
      execution,
      manifest: EDGE_MCP_TOOL_MANIFEST,
      catalogMetadata: EDGE_MCP_CATALOG_METADATA,
      serverIdentity: EDGE_MCP_SERVER_IDENTITY,
    });

    const firstSession = createSession();
    const initialIdentity = await json(firstSession.handle(request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "continuity-client", version: "1.0.0" },
    })));
    const initialCatalog = await tools(firstSession, 2);
    const firstExecution = await json(firstSession.handle(request(3, "tools/call", {
      name: "list_workspaces",
      arguments: {},
    })));
    expect(firstExecution).toMatchObject({ result: { content: [{ text: "generation:1" }] } });

    execution.ready = false;
    execution.generation = null;

    const disconnectedSession = createSession();
    const disconnectedIdentity = await json(disconnectedSession.handle(request(4, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "new-client-while-offline", version: "1.0.0" },
    })));
    const disconnectedCatalog = await tools(disconnectedSession, 5);
    expect((disconnectedIdentity as { result: unknown }).result).toEqual((initialIdentity as { result: unknown }).result);
    expect(disconnectedCatalog.tools).toEqual(initialCatalog.tools);
    expect(disconnectedCatalog.meta.toolSetRevision).toBe(initialCatalog.meta.toolSetRevision);

    const unavailable = await json(disconnectedSession.handle(request(6, "tools/call", {
      name: "list_workspaces",
      arguments: {},
    })));
    expect(unavailable).toMatchObject({
      error: {
        code: -32001,
        data: { code: "AGENT_UNAVAILABLE" },
      },
    });
    expect(execution.calls).toHaveLength(1);

    execution.ready = true;
    execution.generation = 2;

    const reconnectedCatalog = await tools(disconnectedSession, 7);
    expect(reconnectedCatalog.tools).toEqual(initialCatalog.tools);
    expect(reconnectedCatalog.meta.toolSetRevision).toBe(initialCatalog.meta.toolSetRevision);

    const secondExecution = await json(disconnectedSession.handle(request(8, "tools/call", {
      name: "list_workspaces",
      arguments: {},
    })));
    expect(secondExecution).toMatchObject({ result: { content: [{ text: "generation:2" }] } });
    expect(execution.calls).toEqual([
      { generation: 1, principal },
      { generation: 2, principal },
    ]);
  });
});

async function tools(controlPlane: ReturnType<typeof createMcpControlPlane>, id: number) {
  const body = await json(controlPlane.handle(request(id, "tools/list", {}))) as {
    result: {
      tools: unknown[];
      _meta: Record<string, typeof EDGE_MCP_CATALOG_METADATA>;
    };
  };
  return {
    tools: body.result.tools,
    meta: body.result._meta["io.github.ifael/mcp-tool-catalog"],
  };
}

function request(id: number, method: string, params: unknown): Request {
  return new Request("https://edge.example/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer opaque-fixture",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
}

async function json(responsePromise: Promise<Response>): Promise<unknown> {
  return (await responsePromise).json();
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
