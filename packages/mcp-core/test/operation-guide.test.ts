import { describe, expect, it } from "@jest/globals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MCP_AGENT_INSTRUCTIONS,
  MCP_FULL_TOOL_CATALOG_NAMES,
  OPERATION_GUIDE_TOPICS,
  describeReleaseNextStep,
  getOperationGuide,
  registerWorkspaceTools,
  type GetReleaseStateResult,
  type WorkspaceExecutor,
} from "../src/index.js";

const pointer = (releaseId: string) => ({
  releaseId,
  manifestSha256: "0".repeat(64),
  materializedAt: "2026-10-23T00:00:00.000Z",
});

function releaseState(
  active: string | null,
  candidate: string | null,
  bootstrap = { updateScriptPresent: true, cutoverScriptPresent: true },
): Pick<GetReleaseStateResult, "state" | "activeBootstrap"> {
  return {
    state: {
      version: 1,
      active: active === null ? null : pointer(active),
      candidate: candidate === null ? null : pointer(candidate),
      previous: null,
      updatedAt: "2026-10-23T00:00:00.000Z",
    },
    activeBootstrap: bootstrap,
  };
}

describe("operation guide", () => {
  it("returns every topic, and only names tools that the catalog publishes", () => {
    const published = new Set<string>(MCP_FULL_TOOL_CATALOG_NAMES);
    for (const topic of OPERATION_GUIDE_TOPICS) {
      const guide = getOperationGuide(topic);
      expect(guide.topic).toBe(topic);
      expect(guide.steps.length).toBeGreaterThan(0);
      expect(guide.otherTopics).not.toContain(topic);
      for (const tool of guide.tools) expect(published.has(tool)).toBe(true);
    }
    expect(getOperationGuide().topic).toBe("index");
  });

  it("keeps the release playbook on typed tools, in lifecycle order", () => {
    const release = getOperationGuide("release");
    const order = ["github_workflow_operation", "prepare_release", "promote_release"]
      .map((tool) => release.steps.findIndex((step) => step.includes(tool)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(release.rules.join(" ")).toMatch(/never run Update-McpAccessStack\.sh/iu);
  });

  it("points server instructions at the guide", () => {
    expect(MCP_AGENT_INSTRUCTIONS).toContain("get_operation_guide");
  });
});

describe("release next step", () => {
  it("names prepare_release when nothing is staged", () => {
    expect(describeReleaseNextStep(releaseState("1.0.0-a", null))).toMatchObject({ tool: "prepare_release" });
  });

  it("names promote_release with the staged candidate", () => {
    const next = describeReleaseNextStep(releaseState("1.0.0-a", "1.0.0-b"));
    expect(next.tool).toBe("promote_release");
    expect(next.summary).toContain("releaseId=1.0.0-b");
  });

  it("names no tool when the state needs the user", () => {
    expect(describeReleaseNextStep(releaseState(null, null)).tool).toBeNull();
    expect(describeReleaseNextStep(releaseState("1.0.0-a", "1.0.0-b",
      { updateScriptPresent: true, cutoverScriptPresent: false })).tool).toBeNull();
    expect(describeReleaseNextStep(releaseState("1.0.0-a", null,
      { updateScriptPresent: false, cutoverScriptPresent: true })).tool).toBeNull();
  });
});

describe("get_operation_guide tool", () => {
  it("serves a topic without touching the workspace executor", async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" }, { capabilities: { tools: {} } });
    registerWorkspaceTools(server, {} as WorkspaceExecutor, {
      includeTools: ["get_operation_guide"],
      securitySchemes: [{ type: "noauth" }],
    });
    const registered = (server as unknown as {
      _registeredTools: Record<string, { annotations?: unknown; handler: (input: unknown, extra: unknown) => Promise<{ structuredContent?: unknown }> }>;
    })._registeredTools;
    const tool = registered["get_operation_guide"]!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    const result = await tool.handler({ topic: "refusals" }, { signal: new AbortController().signal });
    expect(result.structuredContent).toMatchObject({ topic: "refusals" });
  });
});
