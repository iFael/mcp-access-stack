import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "@jest/globals";
import {
  MCP_FULL_TOOL_CATALOG_METADATA,
  MCP_TOOL_CATALOG_CONTRACT_REVISION,
  MCP_TOOL_CATALOG_META_KEY,
  createMcpToolDescriptorRevision,
  type BrowserExecutor,
} from "@vs-code-gpt/shared";
import type { AgentRelay } from "../../../src/relay/service.js";
import { RelayWorkspaceExecutor } from "../../../src/relay/workspace-executor.js";
import { createMcpServer } from "../../../src/mcp/server.js";

const expectedLateTools = [
  "list_workspace_roots",
  "start_background_task",
  "get_background_task",
  "list_background_tasks",
  "cancel_background_task",
  "read_background_task_logs",
  "browser_open_authorized_site",
  "browser_profile_page",
  "browser_dom_index",
  "browser_frame_sequence",
  "browser_navigate_path",
] as const;

describe("MCP connector catalog synchronization", () => {
  it("publishes one coherent versioned identity for initialize and tools/list", async () => {
    const server = createFullServer();
    const client = createClient("catalog-sync-test");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      const serverVersion = client.getServerVersion();
      const capabilities = client.getServerCapabilities();
      const catalogMeta = listed._meta?.[MCP_TOOL_CATALOG_META_KEY] as
        | Record<string, unknown>
        | undefined;

      expect(listed.tools).toHaveLength(49);
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([...expectedLateTools]),
      );
      const descriptions = Object.fromEntries(
        listed.tools.map((tool) => [tool.name, tool.description ?? ""]),
      );
      expect(descriptions.list_workspace_roots).toContain("workspaceKind=aggregate");
      expect(descriptions.list_workspace_roots).toContain("root is already known");
      expect(descriptions.list_files).toContain("never call without a concrete root");
      expect(descriptions.list_files).toContain("full logical path relative to the workspace root");
      expect(descriptions.run_command).toContain("Preferred general command runner");
      expect(descriptions.run_powershell).toContain("Compatibility shortcut");
      expect(descriptions.search_files).toContain("file contents");
      expect(descriptions.inspect_workspace_git).toContain("exact branch, status");
      expect(descriptions.get_workspace_context).toContain("project instruction files");
      expect(serverVersion).toEqual({
        name: "vs-code-gpt",
        version: MCP_FULL_TOOL_CATALOG_METADATA.serverVersion,
      });
      expect(capabilities).toMatchObject({
        tools: { listChanged: false },
        experimental: {
          [MCP_TOOL_CATALOG_META_KEY]: MCP_FULL_TOOL_CATALOG_METADATA,
        },
      });
      expect(catalogMeta).toMatchObject({
        ...MCP_FULL_TOOL_CATALOG_METADATA,
        descriptorRevision: MCP_TOOL_CATALOG_CONTRACT_REVISION,
      });
      expect(createMcpToolDescriptorRevision(listed.tools)).toBe(
        MCP_TOOL_CATALOG_CONTRACT_REVISION,
      );
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("publishes a different server identity when the available tool set is reduced", async () => {
    const server = createMcpServer({ workspaceExecutor: new RelayWorkspaceExecutor({} as AgentRelay) });
    const client = createClient("workspace-only-catalog-test");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);
      const listed = await client.listTools();
      const catalogMeta = listed._meta?.[MCP_TOOL_CATALOG_META_KEY] as
        | Record<string, unknown>
        | undefined;

      expect(listed.tools).toHaveLength(16);
      expect(client.getServerVersion()?.version).not.toBe(
        MCP_FULL_TOOL_CATALOG_METADATA.serverVersion,
      );
      expect(catalogMeta).toMatchObject({ toolCount: 16 });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("fails closed when a registered tool disappears under the published identity", async () => {
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
        /catalog diverged from the server initialization identity/u,
      );
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("fails closed when a full-catalog descriptor changes without a new contract revision", async () => {
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
        /descriptors changed without updating the catalog contract revision/u,
      );
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});

function createFullServer() {
  return createMcpServer({
      workspaceExecutor: new RelayWorkspaceExecutor({} as AgentRelay),
    browser: {} as BrowserExecutor,
  });
}

function createClient(name: string): Client {
  return new Client(
    { name, version: "0.0.0" },
    { capabilities: {} },
  );
}
