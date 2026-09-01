import { describe, expect, test } from "@jest/globals";
import * as core from "../src/index.js";
import { errorCodes } from "../src/errors.js";
import {
  confirmableSourceControlOperationNameSchema,
  gitBranchSchema,
  gitCommitInputSchema,
  gitCreateBranchInputSchema,
  gitMergeBranchInputSchema,
  gitMergeBranchResultSchema,
  gitPathSchema,
  gitPushBranchInputSchema,
  gitPushBranchResultSchema,
  gitShaSchema,
  gitStagePathsInputSchema,
  gitUnstagePathsInputSchema,
  gitUnstagePathsResultSchema,
  githubCreatePullRequestInputSchema,
  githubCreatePullRequestResultSchema,
  githubCreateRepositoryInputSchema,
  githubCreateRepositoryResultSchema,
  githubGetPullRequestInputSchema,
  githubGetRepositoryInputSchema,
  githubMergePullRequestInputSchema,
  githubMergePullRequestResultSchema,
  sourceControlCapabilities,
  sourceControlCapabilitySchema,
  sourceControlConfirmationRequiredSchema,
  sourceControlOperationNameSchema,
} from "../src/source-control-contracts.js";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const shaC = "c".repeat(40);
const confirmation = {
  status: "confirmation_required" as const,
  confirmationId: "confirmation-1",
  expiresAt: "2026-08-31T23:59:59.000Z",
  operation: "git_push_branch" as const,
  targetResource: "git:branch/feature/x",
};

describe("source-control contracts", () => {
  test("publishes exactly ten source-control capabilities", () => {
    expect(sourceControlCapabilities).toEqual([
      "git.branch.write",
      "git.index.write",
      "git.commit.write",
      "git.merge.write",
      "git.remote.push",
      "github.repository.read",
      "github.repository.create",
      "github.pull_request.read",
      "github.pull_request.create",
      "github.pull_request.merge",
    ]);
    expect(sourceControlCapabilitySchema.options).toEqual(sourceControlCapabilities);
  });

  test("publishes Task 1 contracts and typed error codes through the core boundary", () => {
    expect(core.gitCreateBranchInputSchema).toBe(gitCreateBranchInputSchema);
    expect(core.gitMergeBranchInputSchema).toBe(gitMergeBranchInputSchema);
    expect(core.githubMergePullRequestInputSchema).toBe(githubMergePullRequestInputSchema);
    expect(errorCodes).toEqual(expect.arrayContaining([
      "SOURCE_CONTROL_CAPABILITY_DENIED",
      "SOURCE_CONTROL_CONFIRMATION_INVALID",
      "SOURCE_CONTROL_IDEMPOTENCY_CONFLICT",
      "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
      "GIT_HEAD_MISMATCH",
      "GIT_BRANCH_CONFLICT",
      "GIT_INDEX_CHANGED",
      "GIT_REMOTE_CHANGED",
      "GIT_MERGE_NOT_FAST_FORWARD",
      "GIT_PROTECTED_BRANCH",
    ]));
  });

  test("publishes exactly eleven operation names and four confirmable operations", () => {
    expect(sourceControlOperationNameSchema.options).toEqual([
      "git_create_branch",
      "git_stage_paths",
      "git_unstage_paths",
      "git_commit",
      "git_merge_branch",
      "git_push_branch",
      "github_get_repository",
      "github_create_repository",
      "github_get_pull_request",
      "github_create_pull_request",
      "github_merge_pull_request",
    ]);
    expect(confirmableSourceControlOperationNameSchema.options).toEqual([
      "git_push_branch",
      "github_create_repository",
      "github_create_pull_request",
      "github_merge_pull_request",
    ]);
  });

  test("normalizes Git SHA and rejects invalid branch/path primitives", () => {
    expect(gitShaSchema.parse("A".repeat(40))).toBe(shaA);

    for (const invalid of [
      "../main",
      "-main",
      "feature..x",
      "feature@{x",
      "feature\\x",
      "feature~x",
      "feature^x",
      "feature:x",
      "feature?x",
      "feature*x",
      "feature[x",
      "feature.",
      "feature/",
      "feature/x.lock",
      "/feature",
      "feature/.hidden",
      "@",
    ]) {
      expect(() => gitBranchSchema.parse(invalid)).toThrow();
    }

    expect(gitPathSchema.parse("src\\feature\\a.ts")).toBe("src/feature/a.ts");
    expect(gitPathSchema.parse("./src/./a.ts")).toBe("src/a.ts");
    for (const invalid of ["../secret.txt", "/absolute.txt", "C:/absolute.txt", ".git/config"] ) {
      expect(() => gitPathSchema.parse(invalid)).toThrow();
    }
  });

  test("keeps create branch strict and preconditioned by expected HEAD", () => {
    expect(gitCreateBranchInputSchema.parse({
      workspaceId: "repo",
      branch: "feature/x",
      expectedHeadSha: shaA,
    })).toEqual({
      workspaceId: "repo",
      branch: "feature/x",
      expectedHeadSha: shaA,
    });

    expect(() => gitCreateBranchInputSchema.parse({
      workspaceId: "repo",
      branch: "feature/x",
      expectedHeadSha: shaA,
      command: "git switch -c feature/x",
    })).toThrow();
  });

  test("stages only a bounded unique set of explicit paths", () => {
    expect(gitStagePathsInputSchema.parse({
      workspaceId: "repo",
      paths: ["src/a.ts", "src/b.ts"],
    })).toEqual({
      workspaceId: "repo",
      paths: ["src/a.ts", "src/b.ts"],
    });

    expect(() => gitStagePathsInputSchema.parse({
      workspaceId: "repo",
      paths: ["src/a.ts", "src/a.ts"],
    })).toThrow();
    expect(() => gitStagePathsInputSchema.parse({
      workspaceId: "repo",
      paths: Array.from({ length: 201 }, (_, index) => `src/${index}.ts`),
    })).toThrow();
    expect(gitStagePathsInputSchema.parse({
      workspaceId: "repo",
      paths: ["src/A.ts", "src/a.ts"],
    })).toMatchObject({ paths: ["src/A.ts", "src/a.ts"] });
  });

  test("unstages only explicit paths with HEAD and index preconditions", () => {
    expect(gitUnstagePathsInputSchema.parse({
      workspaceId: "repo",
      paths: ["src/a.ts"],
      expectedHeadSha: shaA,
      expectedIndexTreeSha: shaB,
    })).toEqual({
      workspaceId: "repo",
      paths: ["src/a.ts"],
      expectedHeadSha: shaA,
      expectedIndexTreeSha: shaB,
    });

    expect(() => gitUnstagePathsInputSchema.parse({
      workspaceId: "repo",
      paths: ["src/a.ts"],
      expectedHeadSha: shaA,
      expectedIndexTreeSha: shaB,
      reset: true,
    })).toThrow();

    expect(gitUnstagePathsResultSchema.parse({
      root: ".",
      headSha: shaA,
      indexTreeSha: shaC,
      paths: ["src/a.ts"],
    })).toEqual({
      root: ".",
      headSha: shaA,
      indexTreeSha: shaC,
      paths: ["src/a.ts"],
    });
  });

  test("keeps commit strict and excludes amend/config escape hatches", () => {
    expect(gitCommitInputSchema.parse({
      workspaceId: "repo",
      message: "feat: add typed source control",
      expectedHeadSha: shaA,
      expectedIndexTreeSha: shaB,
    })).toMatchObject({ message: "feat: add typed source control" });

    for (const field of ["amend", "sign", "config", "argv"] as const) {
      expect(() => gitCommitInputSchema.parse({
        workspaceId: "repo",
        message: "feat: add typed source control",
        expectedHeadSha: shaA,
        expectedIndexTreeSha: shaB,
        [field]: true,
      })).toThrow();
    }
  });

  test("defines local merge as current-target fast-forward-only with exact source/target SHA", () => {
    expect(gitMergeBranchInputSchema.parse({
      workspaceId: "repo",
      sourceBranch: "feature/x",
      expectedTargetHeadSha: shaA,
      expectedSourceHeadSha: shaB,
    })).toEqual({
      workspaceId: "repo",
      sourceBranch: "feature/x",
      expectedTargetHeadSha: shaA,
      expectedSourceHeadSha: shaB,
    });

    for (const forbidden of [
      { targetBranch: "main" },
      { strategy: "ours" },
      { noFf: true },
      { squash: true },
      { rebase: true },
      { force: true },
      { argv: ["merge", "--no-ff"] },
    ]) {
      expect(() => gitMergeBranchInputSchema.parse({
        workspaceId: "repo",
        sourceBranch: "feature/x",
        expectedTargetHeadSha: shaA,
        expectedSourceHeadSha: shaB,
        ...forbidden,
      })).toThrow();
    }

    expect(gitMergeBranchResultSchema.parse({
      root: ".",
      branch: "feature/target",
      previousHeadSha: shaA,
      headSha: shaB,
      sourceHeadSha: shaB,
      fastForwarded: true,
    })).toMatchObject({ fastForwarded: true, headSha: shaB });
  });

  test("keeps push confirmation typed and forbids force/config/env escape hatches", () => {
    expect(gitPushBranchInputSchema.parse({
      workspaceId: "repo",
      branch: "feature/x",
      expectedLocalSha: shaA,
    })).toEqual({
      workspaceId: "repo",
      branch: "feature/x",
      expectedLocalSha: shaA,
      remote: "origin",
    });

    for (const forbidden of [
      { force: true },
      { forceWithLease: true },
      { argv: ["push"] },
      { config: { credential: "helper" } },
      { env: { GH_TOKEN: "opaque" } },
    ]) {
      expect(() => gitPushBranchInputSchema.parse({
        workspaceId: "repo",
        branch: "feature/x",
        expectedLocalSha: shaA,
        ...forbidden,
      })).toThrow();
    }

    expect(sourceControlConfirmationRequiredSchema.parse(confirmation)).toEqual(confirmation);
    expect(gitPushBranchResultSchema.parse(confirmation)).toEqual(confirmation);
    expect(() => gitPushBranchResultSchema.parse({ ...confirmation, operation: "github_create_repository" })).toThrow();
    expect(gitPushBranchResultSchema.parse({
      status: "completed",
      root: ".",
      remote: "origin",
      branch: "feature/x",
      localSha: shaA,
      remoteSha: shaA,
    })).toMatchObject({ status: "completed", remoteSha: shaA });
  });

  test("keeps GitHub repository operations on strict typed owner/repository fields", () => {
    expect(githubGetRepositoryInputSchema.parse({
      workspaceId: "repo",
      owner: "acme",
      repository: "app",
    })).toEqual({ workspaceId: "repo", owner: "acme", repository: "app" });

    for (const forbidden of [
      { url: "https://example.invalid/api" },
      { headers: { authorization: "Bearer opaque" } },
      { token: "opaque" },
      { method: "DELETE" },
    ]) {
      expect(() => githubGetRepositoryInputSchema.parse({
        workspaceId: "repo",
        owner: "acme",
        repository: "app",
        ...forbidden,
      })).toThrow();
    }

    expect(githubCreateRepositoryInputSchema.parse({
      workspaceId: "repo",
      owner: "acme",
      name: "app",
      visibility: "private",
    })).toMatchObject({ owner: "acme", name: "app", visibility: "private" });

    expect(githubCreateRepositoryResultSchema.parse({
      status: "confirmation_required",
      confirmationId: "confirmation-2",
      expiresAt: "2026-08-31T23:59:59.000Z",
      operation: "github_create_repository",
      targetResource: "github:repository/acme/app",
    })).toMatchObject({ status: "confirmation_required" });
  });

  test("keeps GitHub pull-request operations strict and merge SHA-preconditioned", () => {
    expect(githubGetPullRequestInputSchema.parse({
      workspaceId: "repo",
      owner: "acme",
      repository: "app",
      pullNumber: 7,
    })).toMatchObject({ pullNumber: 7 });

    expect(githubCreatePullRequestInputSchema.parse({
      workspaceId: "repo",
      owner: "acme",
      repository: "app",
      title: "Ship feature",
      head: "feature/x",
      base: "main",
    })).toMatchObject({ head: "feature/x", base: "main", draft: false });

    expect(githubCreatePullRequestResultSchema.parse({
      status: "confirmation_required",
      confirmationId: "confirmation-3",
      expiresAt: "2026-08-31T23:59:59.000Z",
      operation: "github_create_pull_request",
      targetResource: "github:pull-request/acme/app:feature/x->main",
    })).toMatchObject({ status: "confirmation_required" });

    expect(githubMergePullRequestInputSchema.parse({
      workspaceId: "repo",
      owner: "acme",
      repository: "app",
      pullNumber: 7,
      expectedPullRequestHeadSha: shaA,
      mergeMethod: "squash",
    })).toMatchObject({ expectedPullRequestHeadSha: shaA, mergeMethod: "squash" });

    expect(() => githubMergePullRequestInputSchema.parse({
      workspaceId: "repo",
      owner: "acme",
      repository: "app",
      pullNumber: 7,
      expectedPullRequestHeadSha: shaA,
      mergeMethod: "rebase",
    })).toThrow();

    expect(githubMergePullRequestResultSchema.parse({
      status: "completed",
      number: 7,
      merged: true,
      mergeSha: shaB,
    })).toMatchObject({ status: "completed", merged: true, mergeSha: shaB });
  });

  test("rejects unknown fields across every public input schema", () => {
    const fixtures: Array<[string, { parse(value: unknown): unknown }, Record<string, unknown>]> = [
      ["git_create_branch", gitCreateBranchInputSchema, { workspaceId: "repo", branch: "feature/x", expectedHeadSha: shaA }],
      ["git_stage_paths", gitStagePathsInputSchema, { workspaceId: "repo", paths: ["src/a.ts"] }],
      ["git_unstage_paths", gitUnstagePathsInputSchema, { workspaceId: "repo", paths: ["src/a.ts"], expectedHeadSha: shaA, expectedIndexTreeSha: shaB }],
      ["git_commit", gitCommitInputSchema, { workspaceId: "repo", message: "commit", expectedHeadSha: shaA, expectedIndexTreeSha: shaB }],
      ["git_merge_branch", gitMergeBranchInputSchema, { workspaceId: "repo", sourceBranch: "feature/x", expectedTargetHeadSha: shaA, expectedSourceHeadSha: shaB }],
      ["git_push_branch", gitPushBranchInputSchema, { workspaceId: "repo", branch: "feature/x", expectedLocalSha: shaA }],
      ["github_get_repository", githubGetRepositoryInputSchema, { workspaceId: "repo", owner: "acme", repository: "app" }],
      ["github_create_repository", githubCreateRepositoryInputSchema, { workspaceId: "repo", owner: "acme", name: "app", visibility: "private" }],
      ["github_get_pull_request", githubGetPullRequestInputSchema, { workspaceId: "repo", owner: "acme", repository: "app", pullNumber: 7 }],
      ["github_create_pull_request", githubCreatePullRequestInputSchema, { workspaceId: "repo", owner: "acme", repository: "app", title: "Ship", head: "feature/x", base: "main" }],
      ["github_merge_pull_request", githubMergePullRequestInputSchema, { workspaceId: "repo", owner: "acme", repository: "app", pullNumber: 7, expectedPullRequestHeadSha: shaA, mergeMethod: "merge" }],
    ];

    for (const [name, schema, fixture] of fixtures) {
      expect(() => schema.parse({ ...fixture, rawArgs: [name] })).toThrow();
    }
  });
});
