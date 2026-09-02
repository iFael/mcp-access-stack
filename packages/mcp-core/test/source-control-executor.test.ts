import { describe, expect, test } from "@jest/globals";
import type {
  GitHubCreatePullRequestInput,
  GitHubCreateRepositoryInput,
  GitHubGetPullRequestInput,
  GitHubGetRepositoryInput,
  GitHubMergePullRequestInput,
  GitCommitInput,
  GitCreateBranchInput,
  GitMergeBranchInput,
  GitPushBranchInput,
  GitStagePathsInput,
  GitUnstagePathsInput,
} from "../src/source-control-contracts.js";
import * as sourceControlExecutorModule from "../src/source-control-executor.js";
import type {
  GitHubExecutor,
  GitRepositoryExecutor,
} from "../src/source-control-executor.js";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);

describe("source-control executor ports", () => {
  test("publishes the source-control executor module", () => {
    expect(sourceControlExecutorModule).toBeDefined();
  });

  test("keeps GitRepositoryExecutor limited to exactly six typed methods", async () => {
    const calls: string[] = [];
    const executor: GitRepositoryExecutor = {
      async createBranch(input: GitCreateBranchInput) {
        calls.push("createBranch");
        return { root: input.root ?? ".", branch: input.branch, headSha: input.expectedHeadSha };
      },
      async stagePaths(input: GitStagePathsInput) {
        calls.push("stagePaths");
        return { root: input.root ?? ".", headSha: shaA, indexTreeSha: shaB, paths: input.paths };
      },
      async unstagePaths(input: GitUnstagePathsInput) {
        calls.push("unstagePaths");
        return { root: input.root ?? ".", headSha: input.expectedHeadSha, indexTreeSha: shaA, paths: input.paths };
      },
      async commit(input: GitCommitInput) {
        calls.push("commit");
        return { root: input.root ?? ".", branch: "feature/x", commitSha: shaB };
      },
      async mergeBranch(input: GitMergeBranchInput) {
        calls.push("mergeBranch");
        return {
          root: input.root ?? ".",
          branch: "feature/target",
          previousHeadSha: input.expectedTargetHeadSha,
          headSha: input.expectedSourceHeadSha,
          sourceHeadSha: input.expectedSourceHeadSha,
          fastForwarded: true,
        };
      },
      async pushBranch(input: GitPushBranchInput) {
        calls.push("pushBranch");
        return {
          status: "completed",
          root: input.root ?? ".",
          remote: input.remote ?? "origin",
          branch: input.branch,
          localSha: input.expectedLocalSha,
          remoteSha: input.expectedLocalSha,
        };
      },
    };

    expect(Object.keys(executor).sort()).toEqual([
      "commit",
      "createBranch",
      "mergeBranch",
      "pushBranch",
      "stagePaths",
      "unstagePaths",
    ]);

    await executor.createBranch({ workspaceId: "repo", branch: "feature/x", expectedHeadSha: shaA });
    await executor.stagePaths({ workspaceId: "repo", paths: ["src/a.ts"] });
    await executor.unstagePaths({ workspaceId: "repo", paths: ["src/a.ts"], expectedHeadSha: shaA, expectedIndexTreeSha: shaB });
    await executor.commit({ workspaceId: "repo", message: "commit", expectedHeadSha: shaA, expectedIndexTreeSha: shaB });
    await executor.mergeBranch({ workspaceId: "repo", sourceBranch: "feature/x", expectedTargetHeadSha: shaA, expectedSourceHeadSha: shaB });
    await executor.pushBranch({ workspaceId: "repo", branch: "feature/x", expectedLocalSha: shaB });

    expect(calls).toEqual([
      "createBranch",
      "stagePaths",
      "unstagePaths",
      "commit",
      "mergeBranch",
      "pushBranch",
    ]);
  });

  test("keeps GitHubExecutor limited to exactly five typed methods", async () => {
    const calls: string[] = [];
    const executor: GitHubExecutor = {
      async getRepository(input: GitHubGetRepositoryInput) {
        calls.push("getRepository");
        return {
          owner: input.owner,
          name: input.repository,
          fullName: `${input.owner}/${input.repository}`,
          defaultBranch: "main",
          visibility: "private",
          url: `https://github.com/${input.owner}/${input.repository}`,
        };
      },
      async createRepository(input: GitHubCreateRepositoryInput) {
        calls.push("createRepository");
        return {
          status: "completed",
          owner: input.owner,
          name: input.name,
          fullName: `${input.owner}/${input.name}`,
          defaultBranch: "main",
          visibility: input.visibility,
          url: `https://github.com/${input.owner}/${input.name}`,
        };
      },
      async getPullRequest(input: GitHubGetPullRequestInput) {
        calls.push("getPullRequest");
        return {
          number: input.pullNumber,
          state: "open",
          title: "Feature",
          url: `https://github.com/${input.owner}/${input.repository}/pull/${input.pullNumber}`,
          headSha: shaA,
          baseSha: shaB,
          merged: false,
        };
      },
      async createPullRequest(input: GitHubCreatePullRequestInput) {
        calls.push("createPullRequest");
        return {
          status: "completed",
          number: 7,
          state: "open",
          title: input.title,
          url: `https://github.com/${input.owner}/${input.repository}/pull/7`,
          headSha: shaA,
          baseSha: shaB,
          merged: false,
        };
      },
      async mergePullRequest(input: GitHubMergePullRequestInput) {
        calls.push("mergePullRequest");
        return {
          status: "completed",
          number: input.pullNumber,
          merged: true,
          mergeSha: shaB,
        };
      },
    };

    expect(Object.keys(executor).sort()).toEqual([
      "createPullRequest",
      "createRepository",
      "getPullRequest",
      "getRepository",
      "mergePullRequest",
    ]);

    await executor.getRepository({ workspaceId: "repo", owner: "acme", repository: "app" });
    await executor.createRepository({ workspaceId: "repo", owner: "acme", name: "app-2", visibility: "private" });
    await executor.getPullRequest({ workspaceId: "repo", owner: "acme", repository: "app", pullNumber: 7 });
    await executor.createPullRequest({ workspaceId: "repo", owner: "acme", repository: "app", title: "Feature", head: "feature/x", base: "main" });
    await executor.mergePullRequest({ workspaceId: "repo", owner: "acme", repository: "app", pullNumber: 7, expectedPullRequestHeadSha: shaA, mergeMethod: "squash" });

    expect(calls).toEqual([
      "getRepository",
      "createRepository",
      "getPullRequest",
      "createPullRequest",
      "mergePullRequest",
    ]);
  });
});
