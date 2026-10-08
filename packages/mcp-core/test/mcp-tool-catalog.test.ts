import { describe, expect, it } from "@jest/globals";
import {
  MCP_FULL_TOOL_CATALOG_NAMES,
  MCP_REPOSITORY_TOOL_NAMES,
  createMcpServerVersion,
  createMcpToolCatalogMetadata,
  createMcpToolSetRevision,
} from "../src/mcp-tool-catalog.js";

describe("MCP tool catalog identity", () => {
  it("keeps the public tool-name set complete and unique", () => {
    expect(MCP_FULL_TOOL_CATALOG_NAMES).toHaveLength(95);
    expect(new Set(MCP_FULL_TOOL_CATALOG_NAMES).size).toBe(95);
    expect(MCP_FULL_TOOL_CATALOG_NAMES).toEqual(
      expect.arrayContaining([
        ...MCP_REPOSITORY_TOOL_NAMES,
        "service_get_status",
        "service_start",
        "git_publish_tag",
        "github_materialize_actions_artifact",
      ]),
    );
  });

  it("changes diagnostic tool-set identity when a tool name disappears", () => {
    const complete = createMcpToolSetRevision(MCP_FULL_TOOL_CATALOG_NAMES);
    const reduced = createMcpToolSetRevision(
      MCP_FULL_TOOL_CATALOG_NAMES.filter((name) => name !== "list_workspace_roots"),
    );

    expect(reduced).not.toBe(complete);
  });

  it("keeps descriptor-derived metadata deterministic regardless of registration order", () => {
    const descriptors = [
      { name: "tool-c", inputSchema: { type: "object" } },
      { name: "tool-a", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
      { name: "tool-b", outputSchema: { type: "object" } },
    ];

    expect(createMcpToolCatalogMetadata(descriptors)).toEqual(
      createMcpToolCatalogMetadata([...descriptors].reverse()),
    );
    expect(createMcpServerVersion(descriptors)).toBe(
      createMcpServerVersion([...descriptors].reverse()),
    );
  });
});
