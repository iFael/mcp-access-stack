import { describe, expect, it } from "@jest/globals";
import {
  SOURCE_CONTROL_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
} from "../src/mcp-workspace-tools.js";
import {
  gitCommitInputSchema,
  gitCommitPathsInputSchema,
  gitCreateBranchInputSchema,
  gitMergeBranchInputSchema,
  gitSyncBranchInputSchema,
  gitPushBranchInputSchema,
  gitPublishTagInputSchema,
  gitStagePathsInputSchema,
  gitUnstagePathsInputSchema,
  githubCreatePullRequestInputSchema,
  githubClosePullRequestInputSchema,
  githubCreateRepositoryInputSchema,
  githubGetCommitChecksInputSchema,
  githubMaterializeActionsArtifactInputSchema,
  githubGetCommitChecksWatchesInputSchema,
  githubStartCommitChecksWatchInputSchema,
  githubWaitCommitChecksWatchInputSchema,
  githubGetPullRequestInputSchema,
  githubGetRepositoryInputSchema,
  githubMergePullRequestInputSchema,
  sourceControlCapabilities,
  sourceControlOperationNameSchema,
} from "../src/source-control-contracts.js";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);

const expectedPublicSourceControlNames = [
  "git_commit",
  "git_commit_paths",
  "git_create_branch",
  "git_merge_branch",
  "git_sync_branch",
  "git_push_branch",
  "git_publish_tag",
  "git_stage_paths",
  "git_unstage_paths",
  "github_close_pull_request",
  "github_create_pull_request",
  "github_create_repository",
  "github_get_commit_checks",
  "github_materialize_actions_artifact",
  "github_get_commit_checks_watches",
  "github_start_commit_checks_watch",
  "github_wait_commit_checks_watch",
  "github_get_pull_request",
  "github_get_repository",
  "github_merge_pull_request",
] as const;

const expectedRelaySourceControlNames = expectedPublicSourceControlNames.filter(
  (name) => name !== "git_commit_paths",
);

const expectedSourceControlCapabilities = [
  "git.branch.write",
  "git.index.write",
  "git.commit.write",
  "git.merge.write",
  "git.remote.push",
  "github.repository.read",
  "github.artifact.materialize",
  "github.repository.create",
  "github.pull_request.read",
  "github.pull_request.create",
  "github.pull_request.close",
  "github.pull_request.merge",
] as const;

const forbiddenEscapeHatchValues = {
  command: "git status",
  args: ["status"],
  argv: ["status"],
  force: true,
  forceWithLease: true,
  url: "https://example.invalid/api",
  headers: { authorization: "Bearer caller-controlled" },
  authorization: "Bearer caller-controlled",
  token: "caller-controlled-token",
  strategy: "merge",
  rebase: true,
  reset: true,
} as const;

const inputCases = [
  {
    name: "git_create_branch",
    schema: gitCreateBranchInputSchema,
    input: { workspaceId: "repo", branch: "feature/task8", expectedHeadSha: shaA },
  },
  {
    name: "git_stage_paths",
    schema: gitStagePathsInputSchema,
    input: { workspaceId: "repo", paths: ["src/a.ts"] },
  },
  {
    name: "git_unstage_paths",
    schema: gitUnstagePathsInputSchema,
    input: {
      workspaceId: "repo",
      paths: ["src/a.ts"],
      expectedHeadSha: shaA,
      expectedIndexTreeSha: shaB,
    },
  },
  {
    name: "git_commit",
    schema: gitCommitInputSchema,
    input: {
      workspaceId: "repo",
      message: "task 8 invariant",
      expectedHeadSha: shaA,
      expectedIndexTreeSha: shaB,
    },
  },
  {
    name: "git_commit_paths",
    schema: gitCommitPathsInputSchema,
    input: {
      workspaceId: "repo",
      paths: ["src/a.ts"],
      message: "task 8 explicit paths",
      expectedHeadSha: shaA,
    },
  },
  {
    name: "git_merge_branch",
    schema: gitMergeBranchInputSchema,
    input: {
      workspaceId: "repo",
      sourceBranch: "feature/source",
      expectedTargetHeadSha: shaA,
      expectedSourceHeadSha: shaB,
    },
  },
  {
    name: "git_sync_branch",
    schema: gitSyncBranchInputSchema,
    input: {
      workspaceId: "repo",
      branch: "main",
      remote: "origin",
      expectedRemoteSha: shaB,
    },
  },
  {
    name: "git_push_branch",
    schema: gitPushBranchInputSchema,
    input: {
      workspaceId: "repo",
      branch: "feature/task8",
      expectedLocalSha: shaA,
    },
  },
  {
    name: "git_publish_tag",
    schema: gitPublishTagInputSchema,
    input: { workspaceId: "repo", tag: "v1.1.0-beta.83", expectedCommitSha: shaA },
  },
  {
    name: "github_get_repository",
    schema: githubGetRepositoryInputSchema,
    input: { workspaceId: "repo", owner: "octo", repository: "app" },
  },
  {
    name: "github_get_commit_checks",
    schema: githubGetCommitChecksInputSchema,
    input: {
      workspaceId: "repo",
      owner: "octo",
      repository: "app",
      commitSha: shaA,
    },
  },
  {
    name: "github_materialize_actions_artifact",
    schema: githubMaterializeActionsArtifactInputSchema,
    input: {
      workspaceId: "repo", owner: "octo", repository: "app",
      runId: 123, artifactName: "windows-companion-1.1.0-companion.123-" + shaA,
      expectedCommitSha: shaA, expectedArtifactSha256: "a".repeat(64),
    },
  },
  {
    name: "github_start_commit_checks_watch",
    schema: githubStartCommitChecksWatchInputSchema,
    input: {
      workspaceId: "repo",
      owner: "octo",
      repository: "app",
      commitSha: shaA,
      timeoutMs: 60_000,
    },
  },
  {
    name: "github_get_commit_checks_watches",
    schema: githubGetCommitChecksWatchesInputSchema,
    input: {
      workspaceId: "repo",
      ids: ["11111111-1111-4111-8111-111111111111"],
    },
  },
  {
    name: "github_wait_commit_checks_watch",
    schema: githubWaitCommitChecksWatchInputSchema,
    input: {
      workspaceId: "repo",
      id: "11111111-1111-4111-8111-111111111111",
      timeoutMs: 1_000,
    },
  },
  {
    name: "github_create_repository",
    schema: githubCreateRepositoryInputSchema,
    input: {
      workspaceId: "repo",
      owner: "octo",
      name: "app",
      visibility: "private" as const,
    },
  },
  {
    name: "github_get_pull_request",
    schema: githubGetPullRequestInputSchema,
    input: {
      workspaceId: "repo",
      owner: "octo",
      repository: "app",
      pullNumber: 7,
    },
  },
  {
    name: "github_create_pull_request",
    schema: githubCreatePullRequestInputSchema,
    input: {
      workspaceId: "repo",
      owner: "octo",
      repository: "app",
      title: "Task 8",
      head: "feature/task8",
      base: "main",
    },
  },
  {
    name: "github_close_pull_request",
    schema: githubClosePullRequestInputSchema,
    input: {
      workspaceId: "repo",
      owner: "octo",
      repository: "app",
      pullNumber: 7,
      expectedPullRequestHeadSha: shaB,
    },
  },
  {
    name: "github_merge_pull_request",
    schema: githubMergePullRequestInputSchema,
    input: {
      workspaceId: "repo",
      owner: "octo",
      repository: "app",
      pullNumber: 7,
      expectedPullRequestHeadSha: shaB,
      mergeMethod: "squash" as const,
    },
  },
] as const;

function collectObjectKeys(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectObjectKeys(entry, output);
    return output;
  }
  if (value === null || typeof value !== "object") return output;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output.add(key);
    collectObjectKeys(entry, output);
  }
  return output;
}

describe("typed source-control public boundary", () => {
  it("exposes twenty public tools, nineteen relay operations and twelve capabilities", () => {
    expect([...SOURCE_CONTROL_TOOL_NAMES].sort()).toEqual(
      [...expectedPublicSourceControlNames].sort(),
    );
    expect([...sourceControlOperationNameSchema.options].sort()).toEqual(
      [...expectedRelaySourceControlNames].sort(),
    );
    expect([...sourceControlCapabilities].sort()).toEqual(
      [...expectedSourceControlCapabilities].sort(),
    );
    expect(SOURCE_CONTROL_TOOL_NAMES).toHaveLength(20);
    expect(sourceControlCapabilities).toHaveLength(12);

    for (const forbiddenName of [
      "source_control",
      "git_execute",
      "github_execute",
      "gh_api",
    ]) {
      expect(WORKSPACE_TOOL_NAMES).not.toContain(forbiddenName);
    }
  });

  it("keeps escape-hatch keys out of every typed input and rejects plausible values for them", () => {
    expect(inputCases.map(({ name }) => name).sort()).toEqual(
      [...expectedPublicSourceControlNames].sort(),
    );

    for (const { schema, input } of inputCases) {
      const fixtureKeys = collectObjectKeys(input);
      for (const [forbiddenKey, forbiddenValue] of Object.entries(forbiddenEscapeHatchValues)) {
        expect(fixtureKeys).not.toContain(forbiddenKey);
        expect(schema.safeParse({ ...input, [forbiddenKey]: forbiddenValue }).success).toBe(false);
      }
      expect(schema.safeParse(input).success).toBe(true);
    }
  });

  it("keeps optional legacy confirmationId accepted on confirmable inputs", () => {
    const confirmationId = "legacy-confirmation-id";
    const confirmableCases = [
      [gitPushBranchInputSchema, {
        workspaceId: "repo",
        branch: "feature/task8",
        expectedLocalSha: shaA,
        confirmationId,
      }],
      [githubCreateRepositoryInputSchema, {
        workspaceId: "repo",
        owner: "octo",
        name: "app",
        visibility: "private",
        confirmationId,
      }],
      [githubCreatePullRequestInputSchema, {
        workspaceId: "repo",
        owner: "octo",
        repository: "app",
        title: "Task 8",
        head: "feature/task8",
        base: "main",
        confirmationId,
      }],
      [githubClosePullRequestInputSchema, {
        workspaceId: "repo",
        owner: "octo",
        repository: "app",
        pullNumber: 7,
        expectedPullRequestHeadSha: shaB,
        confirmationId,
      }],
      [githubMergePullRequestInputSchema, {
        workspaceId: "repo",
        owner: "octo",
        repository: "app",
        pullNumber: 7,
        expectedPullRequestHeadSha: shaB,
        mergeMethod: "squash",
        confirmationId,
      }],
    ] as const;

    for (const [schema, input] of confirmableCases) {
      expect(schema.safeParse(input).success).toBe(true);
    }
  });
});
