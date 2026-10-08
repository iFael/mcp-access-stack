import { describe, expect, it, jest } from "@jest/globals";
import { InProcessWorkspaceExecutor } from "../../../src/in-process-workspace-executor.js";
import { SubprocessWorkspaceExecutor } from "../../../src/subprocess-workspace-executor.js";
import type { LocalAgent } from "../../../src/local-agent.js";

const cases = [
  ["createBranch", "gitCreateBranch"],
  ["stagePaths", "gitStagePaths"],
  ["unstagePaths", "gitUnstagePaths"],
  ["commit", "gitCommit"],
  ["mergeBranch", "gitMergeBranch"],
  ["pushBranch", "gitPushBranch"],
  ["publishTag", "gitPublishTag"],
  ["getRepository", "githubGetRepository"],
  ["getCommitChecks", "githubGetCommitChecks"],
  ["materializeActionsArtifact", "githubMaterializeActionsArtifact"],
  ["createRepository", "githubCreateRepository"],
  ["getPullRequest", "githubGetPullRequest"],
  ["createPullRequest", "githubCreatePullRequest"],
  ["closePullRequest", "githubClosePullRequest"],
  ["mergePullRequest", "githubMergePullRequest"],
] as const;

describe("source-control workspace executor parity", () => {
  it("InProcessWorkspaceExecutor maps the fourteen source-control ports to LocalAgent typed methods", async () => {
    const agent: Record<string, unknown> = {};
    for (const [, agentMethod] of cases) {
      agent[agentMethod] = jest.fn(async (input: unknown, context: unknown) => ({ input, context, agentMethod }));
    }
    const executor = new InProcessWorkspaceExecutor(agent as unknown as LocalAgent);
    const context = { correlationId: "corr-1", idempotencyKey: "idem-1" };

    for (const [method, agentMethod] of cases) {
      const input = { workspaceId: "test", marker: method };
      const result = method === "materializeActionsArtifact"
        ? await (executor as any)[method](input, ".", context)
        : await (executor as any)[method](input, context);
      expect((agent as any)[agentMethod]).toHaveBeenCalledWith(input, context);
      expect(result).toMatchObject({ input, context, agentMethod });
    }
  });

  it("SubprocessWorkspaceExecutor delegates the fourteen source-control ports only through its typed fallback", async () => {
    const fallback: Record<string, unknown> = {};
    for (const [method] of cases) {
      fallback[method] = jest.fn(async (...args: unknown[]) => ({ input: args[0], context: args[method === "materializeActionsArtifact" ? 2 : 1], method }));
    }
    const executor = new SubprocessWorkspaceExecutor(fallback as any);
    const context = { invocationId: "inv-1", idempotencyKey: "idem-1" };

    for (const [method] of cases) {
      const input = { workspaceId: "test", marker: method };
      const result = method === "materializeActionsArtifact"
        ? await (executor as any)[method](input, ".", context)
        : await (executor as any)[method](input, context);
      if (method === "materializeActionsArtifact") {
        expect((fallback as any)[method]).toHaveBeenCalledWith(input, ".", context);
      } else {
        expect((fallback as any)[method]).toHaveBeenCalledWith(input, context);
      }
      expect(result).toMatchObject({ input, context, method });
    }
  });
});
