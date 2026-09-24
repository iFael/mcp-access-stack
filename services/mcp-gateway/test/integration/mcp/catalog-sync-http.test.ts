import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "@jest/globals";
import {
  MCP_TOOL_CATALOG_META_KEY,
  createMcpToolContractRevision,
} from "@vs-code-gpt/shared";
import { createGatewayApplication } from "../../../src/app.js";
import { listen, makeGatewayConfig, silentLogger } from "../../support/helpers.js";

const lateToolNames = [
  "patch_file",
  "patch_files",
  "run_workspace_validations",
  "git_commit_paths",
  "read_files",
  "search_files_batch",
  "list_workspace_roots",
  "start_background_task",
  "get_background_task",
  "get_background_tasks",
  "wait_background_task",
  "wait_background_tasks",
  "list_background_tasks",
  "cancel_background_task",
  "read_background_task_logs",
  "write_background_task_stdin",
  "read_background_task_output",
  "browser_open_authorized_site",
  "browser_profile_page",
  "browser_dom_index",
  "browser_frame_sequence",
  "browser_navigate_path",
] as const;

describe("stateless MCP catalog identity", () => {
  it("keeps initialize and tools/list on the same descriptor-derived revision over separate requests", async () => {
    const gateway = createGatewayApplication(
      makeGatewayConfig({
        browserWorker: {
          url: new URL("http://127.0.0.1:3350"),
          token: "x".repeat(32),
          timeoutMs: 1_000,
          maxPayloadBytes: 2 * 1024 * 1024,
        },
      }),
      { logger: silentLogger() },
    );
    const http = await listen(gateway.app);

    try {
      const initialize = await postMcp(http.url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "catalog-sync-http-test", version: "0.0.0" },
        },
      });
      const listed = await postMcp(http.url, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });

      const initializeResult = initialize.result as Record<string, unknown>;
      const serverInfo = initializeResult.serverInfo as Record<string, unknown>;
      const capabilities = initializeResult.capabilities as Record<string, unknown>;
      const experimental = capabilities.experimental as Record<string, unknown>;
      const initializeCatalog = experimental[MCP_TOOL_CATALOG_META_KEY] as Record<string, unknown>;
      const listResult = listed.result as Record<string, unknown>;
      const tools = listResult.tools as Array<{ name: string }>;
      const listMeta = listResult._meta as Record<string, unknown>;
      const listCatalog = listMeta[MCP_TOOL_CATALOG_META_KEY] as Record<string, unknown>;
      const contractRevision = createMcpToolContractRevision(tools);

      expect(capabilities).toMatchObject({ tools: { listChanged: true } });
      expect(tools).toHaveLength(75);
      expect(tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([...lateToolNames]),
      );
      expect(initializeCatalog).toEqual(listCatalog);
      expect(listCatalog).toMatchObject({
        contractRevision,
        toolCount: 75,
      });
      expect(listCatalog).not.toHaveProperty("descriptorRevision");
      expect(serverInfo).toEqual({
        name: "vs-code-gpt",
        version: listCatalog.serverVersion,
      });
    } finally {
      gateway.relay!.close();
      await http.close();
    }
  });
});

async function postMcp(
  baseUrl: URL,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}
