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
  ["getRepository", "githubGetRepository"],
  ["createRepository", "githubCreateRepository"],
  ["getPullRequest", "githubGetPullRequest"],
  ["createPullRequest", "githubCreatePullRequest"],
  ["mergePullRequest", "githubMergePullRequest"],
] as const;

describe("source-control workspace executor parity", () => {
  it("InProcessWorkspaceExecutor maps the eleven Task 1 ports to LocalAgent typed methods", async () => {
    const agent: Record<string, unknown> = {};
    for (const [, agentMethod] of cases) {
      agent[agentMethod] = jest.fn(async (input: unknown, context: unknown) => ({ input, context, agentMethod }));
    }
    const executor = new InProcessWorkspaceExecutor(agent as unknown as LocalAgent);
    const context = { correlationId: "corr-1", idempotencyKey: "idem-1" };

    for (const [method, agentMethod] of cases) {
      const input = { workspaceId: "test", marker: method };
      const result = await (executor as any)[method](input, context);
      expect((agent as any)[agentMethod]).toHaveBeenCalledWith(input, context);
      expect(result).toMatchObject({ input, context, agentMethod });
    }
  });

  it("SubprocessWorkspaceExecutor delegates the eleven Task 1 ports only through its typed fallback", async () => {
    const fallback: Record<string, unknown> = {};
    for (const [method] of cases) {
      fallback[method] = jest.fn(async (input: unknown, context: unknown) => ({ input, context, method }));
    }
    const executor = new SubprocessWorkspaceExecutor(fallback as any);
    const context = { invocationId: "inv-1", idempotencyKey: "idem-1" };

    for (const [method] of cases) {
      const input = { workspaceId: "test", marker: method };
      const result = await (executor as any)[method](input, context);
      expect((fallback as any)[method]).toHaveBeenCalledWith(input, context);
      expect(result).toMatchObject({ input, context, method });
    }
  });
});
