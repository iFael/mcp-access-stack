import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@jest/globals";
import {
  MCP_TOOL_CATALOG_META_KEY,
  createMcpToolContractRevision,
} from "@vs-code-gpt/shared";
import type { AgentRelay } from "../../../src/relay/service.js";
import { RelayWorkspaceExecutor } from "../../../src/relay/workspace-executor.js";
import {
  createMcpServer,
  getMcpServerCatalogMetadata,
} from "../../../src/mcp/server.js";

describe("MCP public catalog stability", () => {
  it("publishes the complete catalog and advertises catalog changes even when browser execution is unavailable", async () => {
    const executor = new RelayWorkspaceExecutor({} as AgentRelay);
    const server = createMcpServer({
      workspaceExecutor: executor,
      sourceControlExecutor: executor,
    });
    const client = new Client(
      { name: "catalog-surface-stability", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      const metadata = listed._meta?.[MCP_TOOL_CATALOG_META_KEY] as
        | Record<string, unknown>
        | undefined;

      expect(listed.tools).toHaveLength(75);
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["patch_file", "patch_files", "run_workspace_validations", "wait_background_tasks", "git_commit_paths", "git_sync_branch", "browser_status"]),
      );
      expect(metadata).toMatchObject({
        toolCount: 75,
        contractRevision: createMcpToolContractRevision(listed.tools),
      });
      expect(getMcpServerCatalogMetadata(server)).toEqual(metadata);
      expect(client.getServerVersion()?.version).toBe(metadata?.serverVersion);
      expect(client.getServerCapabilities()).toMatchObject({
        tools: { listChanged: true },
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
