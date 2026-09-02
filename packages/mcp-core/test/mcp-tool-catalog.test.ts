import { describe, expect, it } from "@jest/globals";
import {
  MCP_FULL_TOOL_CATALOG_METADATA,
  MCP_FULL_TOOL_CATALOG_NAMES,
  MCP_TOOL_CATALOG_CONTRACT_REVISION,
  createMcpServerVersion,
  createMcpToolCatalogMetadata,
  createMcpToolSetRevision,
} from "../src/mcp-tool-catalog.js";
import { SOURCE_CONTROL_TOOL_NAMES } from "../src/mcp-workspace-tools.js";

const staleConnectorMissingTools = [
  ...SOURCE_CONTROL_TOOL_NAMES,
  "list_workspace_roots",
  "start_background_task",
  "get_background_task",
  "wait_background_task",
  "list_background_tasks",
  "cancel_background_task",
  "read_background_task_logs",
  "browser_open_authorized_site",
  "browser_profile_page",
  "browser_dom_index",
  "browser_frame_sequence",
  "browser_navigate_path",
] as const;

describe("MCP tool catalog identity", () => {
  it("identifies the complete 61-tool catalog", () => {
    expect(MCP_FULL_TOOL_CATALOG_NAMES).toHaveLength(61);
    expect(new Set(MCP_FULL_TOOL_CATALOG_NAMES).size).toBe(61);
    expect(MCP_TOOL_CATALOG_CONTRACT_REVISION).toMatch(/^[a-f0-9]{64}$/u);
    expect(MCP_FULL_TOOL_CATALOG_METADATA).toMatchObject({
      toolCount: 61,
      contractRevision: MCP_TOOL_CATALOG_CONTRACT_REVISION,
    });
    expect(MCP_FULL_TOOL_CATALOG_METADATA.serverVersion).toMatch(
      /^0\.4\.0-catalog\.c[a-f0-9]{12}\.s[a-f0-9]{12}$/u,
    );
  });

  it("reproduces the currently stale 38-tool connector catalog exactly", () => {
    const missing = new Set<string>(staleConnectorMissingTools);
    const staleNames = MCP_FULL_TOOL_CATALOG_NAMES.filter(
      (name) => !missing.has(name),
    );

    expect(staleConnectorMissingTools).toHaveLength(23);
    expect(staleNames).toHaveLength(38);
    expect(MCP_FULL_TOOL_CATALOG_NAMES).toEqual(
      expect.arrayContaining([...staleConnectorMissingTools]),
    );

    const stale = createMcpToolCatalogMetadata(staleNames);
    expect(stale.toolSetRevision).not.toBe(
      MCP_FULL_TOOL_CATALOG_METADATA.toolSetRevision,
    );
    expect(stale.serverVersion).not.toBe(
      MCP_FULL_TOOL_CATALOG_METADATA.serverVersion,
    );
  });

  it("identifies a 60-tool connector missing only list_workspace_roots as stale", () => {
    const staleNames = MCP_FULL_TOOL_CATALOG_NAMES.filter(
      (name) => name !== "list_workspace_roots",
    );

    expect(staleNames).toHaveLength(60);
    const stale = createMcpToolCatalogMetadata(staleNames);
    expect(stale.toolSetRevision).not.toBe(
      MCP_FULL_TOOL_CATALOG_METADATA.toolSetRevision,
    );
    expect(stale.serverVersion).not.toBe(
      MCP_FULL_TOOL_CATALOG_METADATA.serverVersion,
    );
    expect(MCP_FULL_TOOL_CATALOG_NAMES).toContain("list_workspace_roots");
  });

  it("keeps tool-set identity deterministic regardless of registration order", () => {
    const names = ["tool-c", "tool-a", "tool-b"];
    expect(createMcpToolSetRevision(names)).toBe(
      createMcpToolSetRevision([...names].reverse()),
    );
    expect(createMcpServerVersion(names)).toBe(
      createMcpServerVersion([...names].reverse()),
    );
  });
});
