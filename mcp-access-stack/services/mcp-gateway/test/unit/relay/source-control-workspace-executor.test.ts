import { describe, expect, test, jest } from "@jest/globals";
import type { OperationContext } from "@vs-code-gpt/shared";
import { RelayWorkspaceExecutor } from "../../../src/relay/workspace-executor.js";
import type { AgentRelay } from "../../../src/relay/service.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

const cases = [
  {
    method: "createBranch",
    operation: "gitCreateBranch",
    input: { workspaceId: "project", branch: "feature/x", expectedHeadSha: SHA_A },
    result: { root: ".", branch: "feature/x", headSha: SHA_A },
  },
  {
    method: "stagePaths",
    operation: "gitStagePaths",
    input: { workspaceId: "project", paths: ["a.ts"] },
    result: { root: ".", headSha: SHA_A, indexTreeSha: SHA_B, paths: ["a.ts"] },
  },
  {
    method: "unstagePaths",
    operation: "gitUnstagePaths",
    input: {
      workspaceId: "project",
      paths: ["a.ts"],
      expectedHeadSha: SHA_A,
      expectedIndexTreeSha: SHA_B,
    },
    result: { root: ".", headSha: SHA_A, indexTreeSha: SHA_C, paths: ["a.ts"] },
  },
  {
    method: "commit",
    operation: "gitCommit",
    input: {
      workspaceId: "project",
      message: "typed commit",
      expectedHeadSha: SHA_A,
      expectedIndexTreeSha: SHA_B,
    },
    result: { root: ".", branch: "feature/x", commitSha: SHA_C },
  },
  {
    method: "mergeBranch",
    operation: "gitMergeBranch",
    input: {
      workspaceId: "project",
      sourceBranch: "feature/source",
      expectedTargetHeadSha: SHA_A,
      expectedSourceHeadSha: SHA_B,
    },
    result: {
      root: ".",
      branch: "dev",
      previousHeadSha: SHA_A,
      headSha: SHA_B,
      sourceHeadSha: SHA_B,
      fastForwarded: true,
    },
  },
  {
    method: "pushBranch",
    operation: "gitPushBranch",
    input: {
      workspaceId: "project",
      branch: "feature/x",
      expectedLocalSha: SHA_A,
      confirmationId: "confirm-1",
    },
    result: {
      status: "completed",
      root: ".",
      remote: "origin",
      branch: "feature/x",
      localSha: SHA_A,
      remoteSha: SHA_A,
    },
  },
  {
    method: "getRepository",
    operation: "githubGetRepository",
    input: { workspaceId: "project", owner: "octo", repository: "repo" },
    result: {
      owner: "octo",
      name: "repo",
      fullName: "octo/repo",
      defaultBranch: "main",
      visibility: "private",
      url: "https://github.com/octo/repo",
    },
  },
  {
    method: "createRepository",
    operation: "githubCreateRepository",
    input: {
      workspaceId: "project",
      owner: "octo",
      name: "repo",
      visibility: "private",
      confirmationId: "confirm-2",
    },
    result: {
      status: "completed",
      owner: "octo",
      name: "repo",
      fullName: "octo/repo",
      defaultBranch: "main",
      visibility: "private",
      url: "https://github.com/octo/repo",
    },
  },
  {
    method: "getPullRequest",
    operation: "githubGetPullRequest",
    input: { workspaceId: "project", owner: "octo", repository: "repo", pullNumber: 7 },
    result: {
      number: 7,
      state: "open",
      title: "typed pr",
      url: "https://github.com/octo/repo/pull/7",
      headSha: SHA_B,
      baseSha: SHA_A,
      merged: false,
    },
  },
  {
    method: "createPullRequest",
    operation: "githubCreatePullRequest",
    input: {
      workspaceId: "project",
      owner: "octo",
      repository: "repo",
      title: "typed pr",
      head: "feature/x",
      base: "main",
      confirmationId: "confirm-3",
    },
    result: {
      status: "completed",
      number: 7,
      state: "open",
      title: "typed pr",
      url: "https://github.com/octo/repo/pull/7",
      headSha: SHA_B,
      baseSha: SHA_A,
      merged: false,
    },
  },
  {
    method: "mergePullRequest",
    operation: "githubMergePullRequest",
    input: {
      workspaceId: "project",
      owner: "octo",
      repository: "repo",
      pullNumber: 7,
      expectedPullRequestHeadSha: SHA_B,
      mergeMethod: "squash",
      confirmationId: "confirm-4",
    },
    result: { status: "completed", number: 7, merged: true, mergeSha: SHA_C },
  },
] as const;

describe("RelayWorkspaceExecutor typed source control", () => {
  test("maps every Task 1 source-control port method to exactly one strict internal relay call", async () => {
    const call = jest.fn(async (operation: string) => {
      const selected = cases.find((candidate) => candidate.operation === operation);
      if (!selected) throw new Error(`unexpected operation ${operation}`);
      return selected.result;
    });
    const executor = new RelayWorkspaceExecutor({ call } as unknown as AgentRelay);
    const context: OperationContext = {
      correlationId: "corr-1",
      invocationId: "inv-1",
      idempotencyKey: "idem-1",
      ownerScope: "owner-1",
    };

    for (const candidate of cases) {
      const result = await (executor as any)[candidate.method](candidate.input, context);
      expect(result).toEqual(candidate.result);
      expect(call).toHaveBeenLastCalledWith(candidate.operation, candidate.input, context);
    }
    expect(call).toHaveBeenCalledTimes(cases.length);
  });
});
