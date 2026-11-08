import { describe, expect, it } from "@jest/globals";
import {
  MCP_FULL_TOOL_CATALOG_NAMES,
  MCP_REPOSITORY_TOOL_NAMES,
  createMcpServerVersion,
  createMcpToolCatalogMetadata,
  createMcpToolContractRevision,
  createMcpToolSetRevision,
} from "../src/mcp-tool-catalog.js";

describe("MCP tool catalog identity", () => {
  it("keeps the public tool-name set complete and unique", () => {
    expect(MCP_FULL_TOOL_CATALOG_NAMES).toHaveLength(126);
    expect(new Set(MCP_FULL_TOOL_CATALOG_NAMES).size).toBe(126);
    expect(MCP_FULL_TOOL_CATALOG_NAMES).toEqual(
      expect.arrayContaining([
        ...MCP_REPOSITORY_TOOL_NAMES,
        "oracle_list_instances",
        "oracle_disk_audit",
        "oracle_disk_audit_provision",
        "service_get_status",
        "service_start",
        "prune_releases",
        "git_publish_tag",
        "github_materialize_actions_artifact",
        "delete_file",
        "get_operation_guide",
        "github_read",
        "github_issue_write",
        "oracle_grant_github_ready_permission",
        "http_get",
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

  it("changes contract revision for UI resource routing, not incidental display text", () => {
    const resource = (uri: string, invoking = "Working") => [{
      name: "browser_progress",
      inputSchema: { type: "object" },
      _meta: {
        ui: { resourceUri: uri },
        "openai/outputTemplate": uri,
        "openai/toolInvocation/invoking": invoking,
      },
    }];
    const original = createMcpToolContractRevision(resource("ui://mcp-v3/progress-v8.html"));
    const updated = createMcpToolContractRevision(resource("ui://mcp-v3/progress-v9.html"));
    expect(updated).not.toBe(original);
    expect(createMcpToolContractRevision(resource("ui://mcp-v3/progress-v9.html", "Doing work"))).toBe(updated);
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
