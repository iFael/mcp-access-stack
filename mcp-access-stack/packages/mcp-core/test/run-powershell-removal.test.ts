import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "@jest/globals";
import type { WorkspaceExecutor } from "../src/workspace-executor.js";
import {
  WORKSPACE_TOOL_NAMES,
  registerWorkspaceTools,
} from "../src/mcp-workspace-tools.js";

describe("run_powershell removal", () => {
  it("does not publish run_powershell in the workspace MCP catalog", () => {
    expect(WORKSPACE_TOOL_NAMES).not.toContain("run_powershell");

    const server = new McpServer(
      { name: "test", version: "0.0.0" },
      { capabilities: { tools: {} } },
    );
    registerWorkspaceTools(server, {} as WorkspaceExecutor, {
      securitySchemes: [{ type: "noauth" }],
    });

    const tools = (server as unknown as {
      _registeredTools: Record<string, unknown>;
    })._registeredTools;
    expect(tools).not.toHaveProperty("run_powershell");
  });
});
