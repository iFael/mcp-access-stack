import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import {
  InMemoryMutationReceiptStore,
  canonicalSourceControlArgumentsDigest,
  TypedConfirmationRegistry,
  type GitHubExecutor,
  type GitRepositoryExecutor,
} from "@vs-code-gpt/shared";
import { LocalAgent } from "../../../src/local-agent.js";
import {
  createFixture,
  git,
  initializeGitRepository,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
  writeWorkspaceFile,
} from "../../support/helpers.js";

jest.setTimeout(30_000);

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

function sourceControlPolicy(capabilities: string[], options: {
  accountOwners?: string[];
  additionalRepositories?: string[];
} = {}) {
  return {
    capabilities,
    accountOwners: options.accountOwners ?? [],
    additionalRepositories: options.additionalRepositories ?? [],
  };
}

async function setupAgent(options: {
  capabilities: string[];
  accountOwners?: string[];
  additionalRepositories?: string[];
  origin?: string;
  branch?: string;
  gitExecutor?: GitRepositoryExecutor;
  githubExecutor?: GitHubExecutor;
  confirmationMode?: "standard" | "trusted-workspace";
}) {
  fixture = await createFixture({ profile: "full-repo-write" });
  initializeGitRepository(fixture.workspacePath);
  git(fixture.workspacePath, ["checkout", "-b", options.branch ?? "feature/task6"]);
  await writeWorkspaceFile(fixture.workspacePath, "base.txt", "base\n");
  git(fixture.workspacePath, ["add", "base.txt"]);
  git(fixture.workspacePath, ["commit", "-m", "baseline"]);
  if (options.origin) {
    git(fixture.workspacePath, ["remote", "add", "origin", options.origin]);
  }
  const workspace = {
    ...makeWorkspacePolicy(fixture.workspacePath, {
      profile: "full-repo-write",
      ...(options.confirmationMode === undefined
        ? {}
        : { confirmationMode: options.confirmationMode }),
    }),
    sourceControl: sourceControlPolicy(options.capabilities, {
      ...(options.accountOwners === undefined ? {} : { accountOwners: options.accountOwners }),
      ...(options.additionalRepositories === undefined ? {} : { additionalRepositories: options.additionalRepositories }),
    }),
  };
  await writePolicy(fixture.policyPath, [workspace]);

  const gitExecutor = options.gitExecutor ?? fakeGitExecutor();
  const githubExecutor = options.githubExecutor ?? fakeGitHubExecutor();
  const receiptStore = new InMemoryMutationReceiptStore();
  const confirmationRegistry = new TypedConfirmationRegistry({ ttlMs: 60_000 });
  const agent = await LocalAgent.create(fixture.policyPath, {
    gitRepositoryExecutor: gitExecutor,
    gitOriginResolver: {
      canonicalOriginUrl: async () => options.origin ?? "https://github.com/octo/repo.git",
    },
    githubExecutor,
    typedConfirmationRegistry: confirmationRegistry,
    mutationReceiptStore: receiptStore,
  } as never);

  return { agent, gitExecutor, githubExecutor, receiptStore, confirmationRegistry };
}

function fakeGitExecutor(): GitRepositoryExecutor {
  return {
    createBranch: jest.fn<GitRepositoryExecutor["createBranch"]>(async (input) => ({
      root: input.root ?? ".",
      branch: input.branch,
      headSha: input.expectedHeadSha.toLowerCase(),
    })),
    stagePaths: jest.fn<GitRepositoryExecutor["stagePaths"]>(async (input) => ({
      root: input.root ?? ".",
      headSha: SHA_A,
      indexTreeSha: SHA_B,
      paths: input.paths,
    })),
    unstagePaths: jest.fn<GitRepositoryExecutor["unstagePaths"]>(async (input) => ({
      root: input.root ?? ".",
      headSha: input.expectedHeadSha.toLowerCase(),
      indexTreeSha: SHA_B,
      paths: input.paths,
    })),
    commit: jest.fn<GitRepositoryExecutor["commit"]>(async (input) => ({
      root: input.root ?? ".",
      branch: "feature/task6",
      commitSha: SHA_C,
    })),
    mergeBranch: jest.fn<GitRepositoryExecutor["mergeBranch"]>(async (input) => ({
      root: input.root ?? ".",
      branch: "feature/task6",
      previousHeadSha: input.expectedTargetHeadSha.toLowerCase(),
      headSha: input.expectedSourceHeadSha.toLowerCase(),
      sourceHeadSha: input.expectedSourceHeadSha.toLowerCase(),
      fastForwarded: true as const,
    })),
    syncBranch: jest.fn<GitRepositoryExecutor["syncBranch"]>(async (input) => ({
      root: input.root ?? ".",
      remote: input.remote,
      branch: input.branch,
      previousBranch: "feature/task6",
      previousHeadSha: SHA_A,
      previousTargetHeadSha: SHA_A,
      remoteSha: input.expectedRemoteSha.toLowerCase(),
      headSha: input.expectedRemoteSha.toLowerCase(),
      switched: true,
      fastForwarded: true,
      alreadyUpToDate: false,
    })),
    pushBranch: jest.fn<GitRepositoryExecutor["pushBranch"]>(async (input) => ({
      status: "completed" as const,
      root: input.root ?? ".",
      remote: input.remote ?? "origin",
      branch: input.branch,
      localSha: input.expectedLocalSha.toLowerCase(),
      remoteSha: input.expectedLocalSha.toLowerCase(),
    })),
    publishTag: jest.fn<GitRepositoryExecutor["publishTag"]>(async (input) => ({
      status: "completed" as const,
      root: input.root ?? ".",
      remote: input.remote ?? "origin",
      tag: input.tag,
      commitSha: input.expectedCommitSha.toLowerCase(),
      remoteSha: input.expectedCommitSha.toLowerCase(),
      alreadyPublished: false,
    })),
  };
}

function fakeGitHubExecutor(): GitHubExecutor {
  return {
    getRepository: jest.fn<GitHubExecutor["getRepository"]>(async (input) => ({
      owner: input.owner,
      name: input.repository,
      fullName: `${input.owner}/${input.repository}`,
      defaultBranch: "main",
      visibility: "private" as const,
      url: `https://github.com/${input.owner}/${input.repository}`,
    })),
    getCommitChecks: jest.fn<GitHubExecutor["getCommitChecks"]>(async (input) => ({
      owner: input.owner,
      repository: input.repository,
      commitSha: input.commitSha,
      totalCount: 1,
      returnedCount: 1,
      pendingCount: 0,
      successfulCount: 1,
      failingCount: 0,
      truncated: false,
      allCompleted: true,
      passed: true,
      checks: [{
        id: 1,
        name: "check",
        status: "completed" as const,
        conclusion: "success" as const,
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
      }],
    })),
    createRepository: jest.fn<GitHubExecutor["createRepository"]>(async (input) => ({
      status: "completed" as const,
      owner: input.owner,
      name: input.name,
      fullName: `${input.owner}/${input.name}`,
      defaultBranch: "main",
      visibility: input.visibility,
      url: `https://github.com/${input.owner}/${input.name}`,
    })),
    getPullRequest: jest.fn<GitHubExecutor["getPullRequest"]>(async (input) => ({
      number: input.pullNumber,
      state: "open" as const,
      title: "typed pr",
      url: `https://github.com/${input.owner}/${input.repository}/pull/${input.pullNumber}`,
      headSha: SHA_B,
      baseSha: SHA_A,
      merged: false,
    })),
    createPullRequest: jest.fn<GitHubExecutor["createPullRequest"]>(async (input) => ({
      status: "completed" as const,
      number: 7,
      state: "open" as const,
      title: input.title,
      url: `https://github.com/${input.owner}/${input.repository}/pull/7`,
      headSha: SHA_B,
      baseSha: SHA_A,
      merged: false,
    })),
    closePullRequest: jest.fn<GitHubExecutor["closePullRequest"]>(async (input) => ({
      status: "completed" as const,
      number: input.pullNumber,
      state: "closed" as const,
      title: "typed pr",
      url: `https://github.com/${input.owner}/${input.repository}/pull/${input.pullNumber}`,
      headSha: input.expectedPullRequestHeadSha,
      baseSha: SHA_A,
      merged: false as const,
    })),
    mergePullRequest: jest.fn<GitHubExecutor["mergePullRequest"]>(async (input) => ({
      status: "completed" as const,
      number: input.pullNumber,
      merged: true,
      mergeSha: SHA_C,
    })),
  };
}

describe("LocalAgent typed source-control authorization", () => {
  it("denies missing git.index.write before invoking the stage backend", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.commit.write"] });

    await expect(
      (agent as any).gitStagePaths(
        { workspaceId: "test", paths: ["base.txt"] },
        { idempotencyKey: "stage-1" },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
    expect(gitExecutor.stagePaths).not.toHaveBeenCalled();
  });

  it("rejects workspace identity mismatches before invoking the authorized mutation", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.index.write"] });

    await expect(
      (agent as any).gitStagePaths(
        { workspaceId: "outside-workspace", paths: ["base.txt"] },
        { idempotencyKey: "outside-workspace-stage" },
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    expect(gitExecutor.stagePaths).not.toHaveBeenCalled();
  });

  it("allows unstage with the shared git.index.write capability", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.index.write"] });

    await expect(
      (agent as any).gitUnstagePaths(
        {
          workspaceId: "test",
          paths: ["base.txt"],
          expectedHeadSha: SHA_A,
          expectedIndexTreeSha: SHA_B,
        },
        { idempotencyKey: "unstage-index-write" },
      ),
    ).resolves.toMatchObject({ paths: ["base.txt"] });
    expect(gitExecutor.unstagePaths).toHaveBeenCalledTimes(1);
  });
  it("requires git.merge.write independently of git.commit.write", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.commit.write"] });

    await expect(
      (agent as any).gitMergeBranch(
        {
          workspaceId: "test",
          sourceBranch: "feature/source",
          expectedTargetHeadSha: SHA_A,
          expectedSourceHeadSha: SHA_B,
        },
        { idempotencyKey: "merge-1" },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
    expect(gitExecutor.mergeBranch).not.toHaveBeenCalled();
  });

  it("blocks direct commit, merge and push on protected main", async () => {
    const { agent, gitExecutor } = await setupAgent({
      capabilities: ["git.branch.write", "git.commit.write", "git.merge.write", "git.remote.push"],
      branch: "main",
    });

    await expect(
      (agent as any).gitCommit({
        workspaceId: "test",
        message: "blocked",
        expectedHeadSha: SHA_A,
        expectedIndexTreeSha: SHA_B,
      }),
    ).rejects.toMatchObject({ code: "GIT_PROTECTED_BRANCH" });
    await expect(
      (agent as any).gitMergeBranch({
        workspaceId: "test",
        sourceBranch: "feature/source",
        expectedTargetHeadSha: SHA_A,
        expectedSourceHeadSha: SHA_B,
      }),
    ).rejects.toMatchObject({ code: "GIT_PROTECTED_BRANCH" });

    await expect(
      (agent as any).gitPushBranch(
        {
          workspaceId: "test",
          branch: "main",
          expectedLocalSha: SHA_A,
        },
        { invocationId: "main-push" },
      ),
    ).rejects.toMatchObject({ code: "GIT_PROTECTED_BRANCH" });
    expect(gitExecutor.commit).not.toHaveBeenCalled();
    expect(gitExecutor.mergeBranch).not.toHaveBeenCalled();
    expect(gitExecutor.pushBranch).not.toHaveBeenCalled();

    await expect(
      (agent as any).gitCreateBranch(
        {
          workspaceId: "test",
          branch: "feature/from-main",
          expectedHeadSha: SHA_A,
        },
        { idempotencyKey: "branch-from-main" },
      ),
    ).resolves.toMatchObject({ branch: "feature/from-main", headSha: SHA_A });
    expect(gitExecutor.createBranch).toHaveBeenCalledTimes(1);

    const syncInput = {
      workspaceId: "test",
      branch: "main",
      remote: "origin",
      expectedRemoteSha: SHA_B,
    };
    const synced = await (agent as any).gitSyncBranch(syncInput, {
      idempotencyKey: "sync-main",
    });
    expect(synced).toMatchObject({
      branch: "main",
      remote: "origin",
      headSha: SHA_B,
      fastForwarded: true,
    });
    expect(gitExecutor.syncBranch).toHaveBeenCalledTimes(1);

    const syncReplay = await (agent as any).gitSyncBranch(syncInput, {
      idempotencyKey: "sync-main",
    });
    expect(syncReplay).toEqual(synced);
    expect(gitExecutor.syncBranch).toHaveBeenCalledTimes(1);
  });
});

describe("LocalAgent direct authorization and mutation receipts", () => {
  it("preserves confirmation flow in standard mode", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.remote.push"] });
    const input = {
      workspaceId: "test",
      branch: "feature/task6",
      expectedLocalSha: SHA_A,
      remote: "origin",
    };

    await expect(
      (agent as any).gitPushBranch(input, { invocationId: "standard-push" }),
    ).resolves.toMatchObject({
      status: "confirmation_required",
      operation: "git_push_branch",
    });
    expect(gitExecutor.pushBranch).not.toHaveBeenCalled();
  });

  it("executes an authorized push directly and replays its receipt without backend re-execution", async () => {
    const { agent, gitExecutor } = await setupAgent({
      capabilities: ["git.remote.push"],
      confirmationMode: "trusted-workspace",
    });
    const input = {
      workspaceId: "test",
      branch: "feature/task6",
      expectedLocalSha: SHA_A,
      remote: "origin",
    };

    const completed = await (agent as any).gitPushBranch(input, {
      invocationId: "push-invocation",
    });
    expect(completed).toMatchObject({ status: "completed", remoteSha: SHA_A });
    expect(gitExecutor.pushBranch).toHaveBeenCalledTimes(1);

    const replay = await (agent as any).gitPushBranch(input, {
      invocationId: "push-invocation",
    });
    expect(replay).toEqual(completed);
    expect(gitExecutor.pushBranch).toHaveBeenCalledTimes(1);
  });

  it("rejects changed arguments under the same idempotency key before backend invocation", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.index.write"] });

    await (agent as any).gitStagePaths(
      { workspaceId: "test", paths: ["base.txt"] },
      { idempotencyKey: "same-key" },
    );
    await expect(
      (agent as any).gitStagePaths(
        { workspaceId: "test", paths: ["other.txt"] },
        { idempotencyKey: "same-key" },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_IDEMPOTENCY_CONFLICT" });
    expect(gitExecutor.stagePaths).toHaveBeenCalledTimes(1);
  });
});

describe("LocalAgent release tag receipts and authorization", () => {
  const tagInput = { workspaceId: "test", tag: "v1.1.0-beta.83", expectedCommitSha: SHA_A };

  it("rejects publication without remote push policy and never invokes the backend", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.commit.write"], confirmationMode: "trusted-workspace" });
    await expect((agent as any).gitPublishTag(tagInput, { idempotencyKey: "tag-denied" }))
      .rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
    expect(gitExecutor.publishTag).not.toHaveBeenCalled();
  });

  it("requires typed confirmation outside trusted workspaces", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.remote.push"] });
    await expect((agent as any).gitPublishTag(tagInput, { invocationId: "tag-standard" }))
      .resolves.toMatchObject({ status: "confirmation_required", operation: "git_publish_tag" });
    expect(gitExecutor.publishTag).not.toHaveBeenCalled();
  });

  it("publishes once and replays the same result for the same invocation identity", async () => {
    const { agent, gitExecutor } = await setupAgent({
      capabilities: ["git.remote.push"], confirmationMode: "trusted-workspace",
    });
    const first = await (agent as any).gitPublishTag(tagInput, { invocationId: "tag-publication-1" });
    expect(first).toMatchObject({ status: "completed", remoteSha: SHA_A });
    const repeated = await (agent as any).gitPublishTag(tagInput, { invocationId: "tag-publication-1" });
    expect(repeated).toEqual(first);
    expect(gitExecutor.publishTag).toHaveBeenCalledTimes(1);
    await expect((agent as any).gitPublishTag(
      { ...tagInput, expectedCommitSha: SHA_B }, { invocationId: "tag-publication-1" },
    )).rejects.toMatchObject({ code: "SOURCE_CONTROL_IDEMPOTENCY_CONFLICT" });
  });
});

describe("LocalAgent trusted-workspace typed source-control authorization", () => {
  it("executes feature push without a confirmation round-trip", async () => {
    const { agent, gitExecutor } = await setupAgent({
      capabilities: ["git.remote.push"],
      confirmationMode: "trusted-workspace",
    });

    await expect(
      (agent as any).gitPushBranch(
        {
          workspaceId: "test",
          branch: "feature/task8",
          expectedLocalSha: SHA_A,
          remote: "origin",
        },
        { invocationId: "trusted-push" },
      ),
    ).resolves.toMatchObject({ status: "completed", remoteSha: SHA_A });
    expect(gitExecutor.pushBranch).toHaveBeenCalledTimes(1);
  });

  it("blocks direct main push even in a trusted workspace", async () => {
    const { agent, gitExecutor } = await setupAgent({
      capabilities: ["git.remote.push"],
      confirmationMode: "trusted-workspace",
    });
    const input = {
      workspaceId: "test",
      branch: "main",
      expectedLocalSha: SHA_A,
      remote: "origin",
    };

    await expect(
      (agent as any).gitPushBranch(input, { invocationId: "trusted-main-push" }),
    ).rejects.toMatchObject({ code: "GIT_PROTECTED_BRANCH" });
    expect(gitExecutor.pushBranch).not.toHaveBeenCalled();
  });

  it("executes pull-request creation from a non-main head without confirmation", async () => {
    const { agent, githubExecutor } = await setupAgent({
      capabilities: ["github.pull_request.create"],
      confirmationMode: "trusted-workspace",
    });

    await expect(
      (agent as any).githubCreatePullRequest(
        {
          workspaceId: "test",
          owner: "octo",
          repository: "repo",
          title: "trusted typed pr",
          head: "feature/task8",
          base: "main",
        },
        { invocationId: "trusted-pr-create" },
      ),
    ).resolves.toMatchObject({ status: "completed", number: 7 });
    expect(githubExecutor.createPullRequest).toHaveBeenCalledTimes(1);
  });

  it("executes authorized repository and pull-request mutations directly with functional preconditions", async () => {
    const { agent, githubExecutor } = await setupAgent({
      capabilities: ["github.repository.create", "github.pull_request.close", "github.pull_request.merge"],
      accountOwners: ["octo"],
      confirmationMode: "trusted-workspace",
    });

    await expect(
      (agent as any).githubCreateRepository(
        { workspaceId: "test", owner: "octo", name: "trusted-repo", visibility: "private" },
        { invocationId: "trusted-repo-create" },
      ),
    ).resolves.toMatchObject({
      status: "completed",
      owner: "octo",
      name: "trusted-repo",
    });
    await expect(
      (agent as any).githubClosePullRequest(
        {
          workspaceId: "test",
          owner: "octo",
          repository: "repo",
          pullNumber: 7,
          expectedPullRequestHeadSha: SHA_B,
        },
        { invocationId: "trusted-pr-close" },
      ),
    ).resolves.toMatchObject({ status: "completed", state: "closed" });
    await expect(
      (agent as any).githubMergePullRequest(
        {
          workspaceId: "test",
          owner: "octo",
          repository: "repo",
          pullNumber: 7,
          expectedPullRequestHeadSha: SHA_B,
          mergeMethod: "squash",
        },
        { invocationId: "trusted-pr-merge" },
      ),
    ).resolves.toMatchObject({ status: "completed", merged: true });
    expect(githubExecutor.createRepository).toHaveBeenCalledTimes(1);
    expect(githubExecutor.closePullRequest).toHaveBeenCalledTimes(1);
    expect(githubExecutor.mergePullRequest).toHaveBeenCalledTimes(1);
  });
});
describe("LocalAgent direct authorization and receipt completeness", () => {
  it.each([
    {
      name: "repository creation",
      capabilities: ["github.repository.create"],
      accountOwners: ["octo"],
      method: "githubCreateRepository",
      backend: "createRepository",
      operation: "github_create_repository",
      input: { workspaceId: "test", owner: "octo", name: "new-repo", visibility: "private" },
    },
    {
      name: "pull-request creation",
      capabilities: ["github.pull_request.create"],
      method: "githubCreatePullRequest",
      backend: "createPullRequest",
      operation: "github_create_pull_request",
      input: {
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
        title: "typed pr",
        head: "feature/task6",
        base: "main",
      },
    },
    {
      name: "pull-request close",
      capabilities: ["github.pull_request.close"],
      method: "githubClosePullRequest",
      backend: "closePullRequest",
      operation: "github_close_pull_request",
      input: {
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
        pullNumber: 7,
        expectedPullRequestHeadSha: SHA_B,
      },
    },
    {
      name: "pull-request merge",
      capabilities: ["github.pull_request.merge"],
      method: "githubMergePullRequest",
      backend: "mergePullRequest",
      operation: "github_merge_pull_request",
      input: {
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
        pullNumber: 7,
        expectedPullRequestHeadSha: SHA_B,
        mergeMethod: "squash",
      },
    },
  ])("executes authorized $name directly and replays it idempotently", async (candidate) => {
    const { agent, githubExecutor } = await setupAgent({
      capabilities: candidate.capabilities,
      ...(candidate.accountOwners === undefined ? {} : { accountOwners: candidate.accountOwners }),
      confirmationMode: "trusted-workspace",
    });
    const invocationId = `direct-${candidate.operation}`;

    const completed = await (agent as any)[candidate.method](candidate.input, {
      invocationId,
    });
    expect(completed).toMatchObject({ status: "completed" });
    expect((githubExecutor as any)[candidate.backend]).toHaveBeenCalledTimes(1);

    await expect(
      (agent as any)[candidate.method](candidate.input, { invocationId }),
    ).resolves.toEqual(completed);
    expect((githubExecutor as any)[candidate.backend]).toHaveBeenCalledTimes(1);
  });

  it("rejects changed arguments under a completed invocation ID and keeps replay idempotent", async () => {
    const { agent, gitExecutor } = await setupAgent({
      capabilities: ["git.remote.push"],
      confirmationMode: "trusted-workspace",
    });
    const input = {
      workspaceId: "test",
      branch: "feature/task6",
      expectedLocalSha: SHA_A,
      remote: "origin",
    };
    const completed = await (agent as any).gitPushBranch(input, {
      invocationId: "stable-push",
    });
    expect(completed).toMatchObject({ status: "completed" });
    expect(gitExecutor.pushBranch).toHaveBeenCalledTimes(1);

    await expect(
      (agent as any).gitPushBranch(
        { ...input, branch: "feature/other" },
        { invocationId: "stable-push" },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_IDEMPOTENCY_CONFLICT" });
    expect(gitExecutor.pushBranch).toHaveBeenCalledTimes(1);

    await expect(
      (agent as any).gitPushBranch(input, { invocationId: "stable-push" }),
    ).resolves.toEqual(completed);
    expect(gitExecutor.pushBranch).toHaveBeenCalledTimes(1);
  });

  it("does not blindly invoke a backend for an executing or reconciliation-required receipt", async () => {
    const { agent, gitExecutor, receiptStore } = await setupAgent({ capabilities: ["git.index.write"] });
    const input = { workspaceId: "test", paths: ["base.txt"] };
    const identity = {
      workspaceId: "test",
      operation: "git_stage_paths" as const,
      targetResource: "git:test:.",
      canonicalArgumentsDigest: canonicalSourceControlArgumentsDigest(input),
      idempotencyKey: "stuck-stage",
    };
    await receiptStore.reserve(identity);
    await receiptStore.markExecuting(identity);

    await expect(
      (agent as any).gitStagePaths(input, { idempotencyKey: "stuck-stage" }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_RECONCILIATION_REQUIRED" });
    expect(gitExecutor.stagePaths).not.toHaveBeenCalled();

    await receiptStore.markReconciliationRequired(identity);
    await expect(
      (agent as any).gitStagePaths(input, { idempotencyKey: "stuck-stage" }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_RECONCILIATION_REQUIRED" });
    expect(gitExecutor.stagePaths).not.toHaveBeenCalled();
  });

  it("fails closed when a mutation has no stable idempotency identity", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.index.write"] });
    await expect(
      (agent as any).gitStagePaths({ workspaceId: "test", paths: ["base.txt"] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(gitExecutor.stagePaths).not.toHaveBeenCalled();
  });
});
describe("LocalAgent GitHub commit-check watch authorization", () => {
  it("denies watch creation before any GitHub poll when repository read is not authorized", async () => {
    const { agent, githubExecutor } = await setupAgent({
      capabilities: [],
      additionalRepositories: ["octo/repo"],
    });

    await expect(
      (agent as any).githubStartCommitChecksWatch(
        {
          workspaceId: "test",
          owner: "octo",
          repository: "repo",
          commitSha: SHA_A,
          timeoutMs: 30_000,
        },
        { ownerScope: "owner-a" },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
    expect(githubExecutor.getCommitChecks).not.toHaveBeenCalled();
  });
});

describe("LocalAgent canonical GitHub targets", () => {
  for (const origin of [
    "git@github.com:octo/repo.git",
    "https://github.com/octo/repo.git",
    "ssh://git@github.com/octo/repo.git",
  ]) {
    it(`authorizes the canonical repository for ${origin}`, async () => {
      const { agent, githubExecutor } = await setupAgent({
        capabilities: ["github.repository.read"],
        origin,
      });

      const result = await (agent as any).githubGetRepository({
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
      });

      expect(result.fullName).toBe("octo/repo");
      expect(githubExecutor.getRepository).toHaveBeenCalledTimes(1);
    });
  }

  it.each([
    "https://github.com/octo/repo.git?ref=main",
    "github.com/octo/repo",
  ])("rejects malformed or query-bearing canonical origin %s before backend invocation", async (origin) => {
    const { agent, githubExecutor } = await setupAgent({
      capabilities: ["github.repository.read"],
      origin,
    });
    await expect(
      (agent as any).githubGetRepository({
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
    expect(githubExecutor.getRepository).not.toHaveBeenCalled();
  });

  it("denies a missing GitHub capability before backend invocation even for the canonical repository", async () => {
    const { agent, githubExecutor } = await setupAgent({
      capabilities: ["git.index.write"],
      origin: "https://github.com/octo/repo.git",
    });
    await expect(
      (agent as any).githubGetRepository({
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
    expect(githubExecutor.getRepository).not.toHaveBeenCalled();
  });

  it("denies owner and repository mismatches before direct GitHub mutations", async () => {
    const ownerMismatch = await setupAgent({
      capabilities: ["github.repository.create"],
      accountOwners: ["octo"],
    });
    await expect(
      (ownerMismatch.agent as any).githubCreateRepository({
        workspaceId: "test",
        owner: "other",
        name: "repo",
        visibility: "private",
      }, { invocationId: "wrong-owner" }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
    expect(ownerMismatch.githubExecutor.createRepository).not.toHaveBeenCalled();

    await fixture?.cleanup();
    fixture = undefined;
    const repositoryMismatch = await setupAgent({
      capabilities: ["github.pull_request.close"],
      origin: "https://github.com/octo/repo.git",
    });
    await expect(
      (repositoryMismatch.agent as any).githubClosePullRequest({
        workspaceId: "test",
        owner: "octo",
        repository: "outside",
        pullNumber: 7,
        expectedPullRequestHeadSha: SHA_B,
      }, { invocationId: "wrong-repository" }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
    expect(repositoryMismatch.githubExecutor.closePullRequest).not.toHaveBeenCalled();
  });
  it("rejects malformed/non-GitHub canonical origins unless repository is explicitly additional", async () => {
    const denied = await setupAgent({
      capabilities: ["github.repository.read"],
      origin: "https://gitlab.com/octo/repo.git",
    });
    await expect(
      (denied.agent as any).githubGetRepository({
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" });
    expect(denied.githubExecutor.getRepository).not.toHaveBeenCalled();

    await fixture?.cleanup();
    fixture = undefined;

    const allowed = await setupAgent({
      capabilities: ["github.repository.read"],
      origin: "https://gitlab.com/octo/repo.git",
      additionalRepositories: ["octo/repo"],
    });
    await expect(
      (allowed.agent as any).githubGetRepository({
        workspaceId: "test",
        owner: "octo",
        repository: "repo",
      }),
    ).resolves.toMatchObject({ fullName: "octo/repo" });
    expect(allowed.githubExecutor.getRepository).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("writes only sanitized source-control audit metadata", async () => {
    const { agent } = await setupAgent({ capabilities: ["git.index.write"] });

    await (agent as any).gitStagePaths(
      { workspaceId: "test", paths: ["base.txt"] },
      { idempotencyKey: "audit-stage", correlationId: "corr-1" },
    );

    const auditText = await readFile(`${fixture!.auditPath}/audit.ndjson`, "utf8");
    const entries = auditText.trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    const entry = entries.at(-1);
    expect(entry).toMatchObject({
      operation: "gitStagePaths",
      sourceControlCapability: "git.index.write",
      idempotencyOutcome: "executed",
      status: "allowed",
    });
    expect(JSON.stringify(entry)).not.toContain("confirmationId");
    expect(JSON.stringify(entry)).not.toContain("token");
    expect(JSON.stringify(entry)).not.toContain("Authorization");
  });
});
