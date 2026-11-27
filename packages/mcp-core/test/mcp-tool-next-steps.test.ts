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

  it("does not rely on an unverified automatic chat wake", () => {
    expect(MCP_TOOL_NEXT_STEPS.mcp_update).toContain("same updateId");
    expect(MCP_TOOL_NEXT_STEPS.github_start_commit_checks_watch).toContain("same watchId");
    expect(MCP_TOOL_NEXT_STEPS.start_background_task).toContain("best-effort");
    expect(Object.values(MCP_TOOL_NEXT_STEPS).join(" ")).not.toMatch(/you are woken|wait to be woken/u);
  });

  it("tells agents that browser_click supports a bound destructive confirmation", () => {
    expect(MCP_TOOL_NEXT_STEPS.browser_click).toContain("ACTION_REQUIRES_CONFIRMATION");
    expect(MCP_TOOL_NEXT_STEPS.browser_click).toContain("confirmationId");
  });

  it("ends the description, and stays out of a tool that ends its job", () => {
    expect(withMcpToolNextStep("git_commit", "Commits.")).toBe("Commits. Next: git_push_branch.");
    expect(withMcpToolNextStep("browser_finish_task", "Finishes.")).toBe("Finishes.");
    expect(mcpToolNextStep("not_a_tool")).toBe("");
  });
});
