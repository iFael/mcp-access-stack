import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, jest } from "@jest/globals";
import { COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL } from "@mcp-access-stack/edge-protocol";
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

      expect(listed.tools).toHaveLength(89);
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(["patch_file", "patch_files", "run_workspace_validations", "wait_background_tasks", "git_commit_paths", "git_sync_branch", "github_get_commit_checks", "github_start_commit_checks_watch", "github_get_commit_checks_watches", "github_wait_commit_checks_watch", "browser_status", "get_onboarding_state", "list_repositories", "create_repository", "discover_local_repositories", "import_repositories", "materialize_repository", "sync_repository", "list_devices", "revoke_device"]),
      );
      expect(metadata).toMatchObject({
        toolCount: 89,
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

  it("keeps companion-internal tools executable but outside the published MCP catalog", async () => {
    const executor = new RelayWorkspaceExecutor({} as AgentRelay);
    const bindRepositories = jest.fn(async (bindings: Array<{
      repositoryId: string;
      workspaceId: string;
      path: string;
    }>) => bindings.map((binding) => ({
      repositoryId: binding.repositoryId,
      workspaceId: binding.workspaceId,
      path: binding.path,
    })));
    const server = createMcpServer({
      workspaceExecutor: executor,
      sourceControlExecutor: executor,
      companionRepositoryBinder: { bindRepositories },
    });
    const client = new Client(
      { name: "companion-internal-catalog", version: "0.0.0" },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(89);
      expect(listed.tools.some((tool) => tool.name === COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL)).toBe(false);

      const repositoryId = "repo_11111111-1111-4111-8111-111111111111";
      const result = await client.callTool({
        name: COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL,
        arguments: {
          bindings: [{
            repositoryId,
            name: "fixture",
            path: "C:/fixture",
            workspaceId: "fixture",
            remoteUrls: ["https://example.invalid/fixture.git"],
            managed: false,
          }],
        },
      });

      expect(bindRepositories).toHaveBeenCalledTimes(1);
      expect(result.structuredContent).toEqual({
        bound: [{
          repositoryId,
          workspaceId: "fixture",
          path: "C:/fixture",
        }],
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
