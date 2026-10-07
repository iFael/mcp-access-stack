import { describe, expect, it, jest } from "@jest/globals";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import { UPDATE_CONTROL_TOOL_MANIFEST } from "@mcp-access-stack/update-control-contract";
import { createUpdateControlMcpHandler } from "../../src/mcp.js";
import { createUpdateControlReadOnlyTools } from "../../src/tools.js";

const principal: AuthenticatedEdgePrincipal = {
  subject: "owner:test",
  scopes: ["update:read"],
  ownerScope: "owner",
  userId: "usr_update_control_owner",
};
const reader = {
  listRuns: async () => ({ runs: [], nextCursor: null, hasMore: false }),
  getRun: async () => { throw new Error("not used"); },
  waitEvents: async () => { throw new Error("not used"); },
};
const mcpRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://update-control.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

describe("Update Control MCP endpoint", () => {
  it("implements initialize and tools/list using the independent read-only catalog", async () => {
    const authenticate = jest.fn(async () => principal);
    const handle = createUpdateControlMcpHandler({
      authenticate,
      tools: createUpdateControlReadOnlyTools(reader),
    });

    const initialized = await handle(mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    }));
    const initializedBody = await initialized.json() as { result: { serverInfo: { name: string } } };
    expect(initialized.status).toBe(200);
    expect(initializedBody.result.serverInfo.name).toBe("mcp-v3-update-control");
    expect(initialized.headers.get("mcp-session-id")).toBeNull();

    const listed = await handle(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    const body = await listed.json() as {
      result: {
        tools: Array<{
          name: string;
          annotations: unknown;
          securitySchemes?: unknown;
          _meta?: { securitySchemes?: unknown };
        }>;
      };
    };
    expect(body.result.tools).toHaveLength(3);
    expect(body.result.tools.map((tool) => tool.name)).toEqual(
      UPDATE_CONTROL_TOOL_MANIFEST.map((tool) => tool.name),
    );
    expect(body.result.tools.every((tool) =>
      (tool.annotations as { readOnlyHint?: boolean }).readOnlyHint === true,
    )).toBe(true);
    expect(body.result.tools.every((tool) =>
      JSON.stringify(tool.securitySchemes) ===
        JSON.stringify([{ type: "oauth2", scopes: ["update:read"] }]) &&
      JSON.stringify(tool._meta?.securitySchemes) ===
        JSON.stringify([{ type: "oauth2", scopes: ["update:read"] }]),
    )).toBe(true);
  });

  it("routes calls only to the read-only handlers and never forwards unknown operations", async () => {
    const authenticate = jest.fn(async () => principal);
    const listRuns = jest.fn(async () => ({ runs: [], nextCursor: null, hasMore: false }));
    const tools = createUpdateControlReadOnlyTools({ ...reader, listRuns });
    const handle = createUpdateControlMcpHandler({ authenticate, tools });

    const known = await handle(mcpRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "update_list_runs", arguments: {} },
    }));
    expect((await known.json() as { result: { isError: boolean } }).result.isError).toBe(false);
    expect(listRuns).toHaveBeenCalledTimes(1);

    const unsupported = await handle(mcpRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "update_promote", arguments: {} },
    }));
    expect((await unsupported.json() as { result: { isError: boolean } }).result.isError).toBe(true);
    expect(listRuns).toHaveBeenCalledTimes(1);

    const mutationMethod = await handle(mcpRequest({ jsonrpc: "2.0", id: 5, method: "promote" }));
    expect((await mutationMethod.json() as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("preserves authentication errors and bounds request bodies before JSON parsing", async () => {
    const denied = createUpdateControlMcpHandler({
      authenticate: async () => {
        throw Object.assign(new Error("denied"), {
          name: "EdgeAuthenticationError",
          toResponse: () => new Response(JSON.stringify({ error: "invalid_token" }), {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://update-control.example/.well-known/oauth-protected-resource/mcp", scope="update:read", error="invalid_token"',
            },
          }),
        });
      },
      tools: createUpdateControlReadOnlyTools(reader),
    });
    const deniedResponse = await denied(mcpRequest({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(deniedResponse.status).toBe(401);

    const deniedGet = await denied(new Request("https://update-control.example/mcp"));
    expect(deniedGet.status).toBe(401);
    expect(deniedGet.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(deniedGet.headers.get("www-authenticate")).toContain('scope="update:read"');

    const authenticatedGet = createUpdateControlMcpHandler({
      authenticate: async () => principal,
      tools: createUpdateControlReadOnlyTools(reader),
    });
    const methodNotAllowed = await authenticatedGet(new Request("https://update-control.example/mcp"));
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("POST");

    const bounded = createUpdateControlMcpHandler({
      authenticate: async () => principal,
      tools: createUpdateControlReadOnlyTools(reader),
      maxRequestBytes: 64,
    });
    const large = await bounded(mcpRequest({
      jsonrpc: "2.0", id: 8, method: "tools/call", params: { data: "x".repeat(200) },
    }));
    expect(large.status).toBe(413);
    expect((await large.json() as { error: { code: number } }).error.code).toBe(-32600);
  });

  it("rejects content types and malformed requests without invoking the Oracle client", async () => {
    const authenticate = jest.fn(async () => principal);
    const listRuns = jest.fn(async () => ({ runs: [], nextCursor: null, hasMore: false }));
    const handle = createUpdateControlMcpHandler({
      authenticate,
      tools: createUpdateControlReadOnlyTools({ ...reader, listRuns }),
    });
    const wrongContent = await handle(new Request("https://update-control.example/mcp", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
    }));
    const malformed = await handle(new Request("https://update-control.example/mcp", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expect(wrongContent.status).toBe(415);
    expect(malformed.status).toBe(200);
    expect(listRuns).not.toHaveBeenCalled();
  });
});
