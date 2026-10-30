import { describe, expect, it } from "@jest/globals";
import { MCP_FULL_TOOL_CATALOG_NAMES } from "../src/mcp-tool-catalog.js";
import { MCP_TOOL_NEXT_STEPS, mcpToolNextStep, withMcpToolNextStep } from "../src/mcp-tool-next-steps.js";

// Words in an entry that look like tool names but are not tools.
const NOT_TOOLS = new Set(["run_jobs", "job_logs", "confirmation_required", "reconciliation_required"]);

describe("the next step of every tool", () => {
  it("covers exactly the published catalog", () => {
    expect(Object.keys(MCP_TOOL_NEXT_STEPS).sort()).toEqual([...MCP_FULL_TOOL_CATALOG_NAMES].sort());
  });

  it("names only tools of the catalog", () => {
    const tools = new Set<string>(MCP_FULL_TOOL_CATALOG_NAMES);
    for (const [name, next] of Object.entries(MCP_TOOL_NEXT_STEPS)) {
      for (const word of next.match(/\b[a-z]+(?:_[a-z]+)+\b/gu) ?? []) {
        if (!NOT_TOOLS.has(word)) expect({ name, word, known: tools.has(word) }).toEqual({ name, word, known: true });
      }
      expect(next.length).toBeLessThanOrEqual(220);
    }
  });

  it("ends the description, and stays out of a tool that ends its job", () => {
    expect(withMcpToolNextStep("git_commit", "Commits.")).toBe("Commits. Next: git_push_branch.");
    expect(withMcpToolNextStep("browser_finish_task", "Finishes.")).toBe("Finishes.");
    expect(mcpToolNextStep("not_a_tool")).toBe("");
  });
});
