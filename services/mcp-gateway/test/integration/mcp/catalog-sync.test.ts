import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@jest/globals";
import {
  MCP_TOOL_CATALOG_META_KEY,
  createMcpToolContractRevision,
} from "@vs-code-gpt/shared";
import type { AgentRelay } from "../../../src/relay/service.js";
import { RelayWorkspaceExecutor } from "../../../src/relay/workspace-executor.js";
import { createMcpServer } from "../../../src/mcp/server.js";

const expectedLateTools = [
  "patch_file",
  "read_files",
  "search_files_batch",
  "list_workspace_roots",
  "start_background_task",
  "get_background_task",
  "get_background_tasks",
  "wait_background_task",
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
  "git_create_branch",
  "git_stage_paths",
  "git_unstage_paths",
  "git_commit",
  "git_merge_branch",
  "git_push_branch",
  "github_get_repository",
  "github_create_repository",
  "github_get_pull_request",
  "github_create_pull_request",
  "github_merge_pull_request",
] as const;

describe("MCP connector catalog synchronization", () => {
  it("publishes one descriptor-derived identity for initialize and tools/list", async () => {
    const server = createFullServer();
    const client = createClient("catalog-sync-test");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      const listedAgain = await client.listTools();
      const serverVersion = client.getServerVersion();
      const capabilities = client.getServerCapabilities();
      const catalogMeta = listed._meta?.[MCP_TOOL_CATALOG_META_KEY] as
        | Record<string, unknown>
        | undefined;
      const contractRevision = createMcpToolContractRevision(listed.tools);

      expect(listed.tools).toHaveLength(66);
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([...expectedLateTools]),
      );
      const descriptions = Object.fromEntries(
        listed.tools.map((tool) => [tool.name, tool.description ?? ""]),
      );
      expect(descriptions.list_workspace_roots).toContain("workspaceKind=aggregate");
      expect(descriptions.list_files).toContain("never call without a concrete root");
      expect(descriptions.run_command).toContain("Preferred general command runner");
      expect(descriptions.search_files).toContain("file contents");
      expect(descriptions.inspect_workspace_git).toContain("exact branch, status");
      expect(descriptions.get_workspace_context).toContain("project instruction files");
      expect(catalogMeta).toMatchObject({
        contractRevision,
        toolCount: 66,
      });
      expect(catalogMeta).not.toHaveProperty("descriptorRevision");
      expect(serverVersion).toEqual({
        name: "vs-code-gpt",
        version: catalogMeta?.serverVersion,
      });
      expect(capabilities).toMatchObject({
        tools: { listChanged: true },
        experimental: {
          [MCP_TOOL_CATALOG_META_KEY]: catalogMeta,
        },
      });
      expect(listedAgain.tools).toEqual(listed.tools);
      expect(listedAgain._meta?.[MCP_TOOL_CATALOG_META_KEY]).toEqual(
        listed._meta?.[MCP_TOOL_CATALOG_META_KEY],
      );
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("fails closed when a registered tool disappears after server construction", async () => {
    const server = createFullServer();
    const internals = server as unknown as {
      _registeredTools: Record<string, unknown>;
    };
    delete internals._registeredTools.browser_navigate_path;
    const client = createClient("catalog-set-drift-test");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await expect(client.listTools()).rejects.toThrow(
        /descriptors diverged from the server construction identity/u,
      );
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("fails closed when a registered descriptor changes after server construction", async () => {
    const server = createFullServer();
    const internals = server as unknown as {
      _registeredTools: Record<string, { description?: string }>;
    };
    const statusTool = internals._registeredTools.browser_status;
    if (!statusTool) throw new Error("Expected browser_status registration.");
    statusTool.description = `${statusTool.description ?? ""} drift`;
    const client = createClient("catalog-descriptor-drift-test");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      await expect(client.listTools()).rejects.toThrow(
        /descriptors diverged from the server construction identity/u,
      );
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

describe("MCP server instance catalog continuity", () => {
  it("preserves exact catalog identity across disconnect and reconnect", async () => {
    const server = createFullServer();
    const firstClient = createClient("catalog-reconnect-first");
    const [firstClientTransport, firstServerTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(firstServerTransport),
      firstClient.connect(firstClientTransport),
    ]);
    const firstList = await firstClient.listTools();
    const firstServerVersion = firstClient.getServerVersion();
    const firstCapabilities = firstClient.getServerCapabilities();
    await firstClient.close();

    const secondClient = createClient("catalog-reconnect-second");
    const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([
        server.connect(secondServerTransport),
        secondClient.connect(secondClientTransport),
      ]);
      const secondList = await secondClient.listTools();
      const secondServerVersion = secondClient.getServerVersion();
      const secondCapabilities = secondClient.getServerCapabilities();
      const names = secondList.tools.map((tool) => tool.name);
      const metadata = secondList._meta?.[MCP_TOOL_CATALOG_META_KEY] as
        | Record<string, unknown>
        | undefined;

      expect(secondList.tools).toEqual(firstList.tools);
      expect(secondList._meta?.[MCP_TOOL_CATALOG_META_KEY]).toEqual(
        firstList._meta?.[MCP_TOOL_CATALOG_META_KEY],
      );
      expect(secondServerVersion).toEqual(firstServerVersion);
      expect(secondCapabilities).toEqual(firstCapabilities);
      expect(names).toHaveLength(66);
      expect(new Set(names).size).toBe(66);
      expect(metadata?.contractRevision).toBe(
        createMcpToolContractRevision(secondList.tools),
      );
    } finally {
      await secondClient.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

function createFullServer() {
  const executor = new RelayWorkspaceExecutor({} as AgentRelay);
  return createMcpServer({
    workspaceExecutor: executor,
    sourceControlExecutor: executor,
  });
}

function createClient(name: string): Client {
  return new Client(
    { name, version: "0.0.0" },
    { capabilities: {} },
  );
}
