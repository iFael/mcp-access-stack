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
    pushBranch: jest.fn<GitRepositoryExecutor["pushBranch"]>(async (input) => ({
      status: "completed" as const,
      root: input.root ?? ".",
      remote: input.remote ?? "origin",
      branch: input.branch,
      localSha: input.expectedLocalSha.toLowerCase(),
      remoteSha: input.expectedLocalSha.toLowerCase(),
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

  it("blocks commit and merge on current main and push of main before backend mutation", async () => {
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
      (agent as any).gitPushBranch({
        workspaceId: "test",
        branch: "main",
        expectedLocalSha: SHA_A,
      }),
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
  });
});

describe("LocalAgent typed confirmation and mutation receipts", () => {
  it("returns confirmation-required, executes once, then replays completed push without backend re-execution", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.remote.push"] });
    const input = {
      workspaceId: "test",
      branch: "feature/task6",
      expectedLocalSha: SHA_A,
      remote: "origin",
    };

    const pending = await (agent as any).gitPushBranch(input, { invocationId: "push-invocation" });
    expect(pending).toMatchObject({
      status: "confirmation_required",
      operation: "git_push_branch",
    });
    expect(gitExecutor.pushBranch).not.toHaveBeenCalled();

    const confirmedInput = { ...input, confirmationId: pending.confirmationId };
    const completed = await (agent as any).gitPushBranch(confirmedInput, {
      invocationId: "push-invocation",
    });
    expect(completed).toMatchObject({ status: "completed", remoteSha: SHA_A });
    expect(gitExecutor.pushBranch).toHaveBeenCalledTimes(1);

    const replay = await (agent as any).gitPushBranch(confirmedInput, {
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

describe("LocalAgent trusted-workspace typed confirmation policy", () => {
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

  it("keeps repository creation and pull-request merge confirmation-bound", async () => {
    const { agent, githubExecutor } = await setupAgent({
      capabilities: ["github.repository.create", "github.pull_request.merge"],
      accountOwners: ["octo"],
      confirmationMode: "trusted-workspace",
    });

    await expect(
      (agent as any).githubCreateRepository(
        { workspaceId: "test", owner: "octo", name: "trusted-repo", visibility: "private" },
        { invocationId: "trusted-repo-create" },
      ),
    ).resolves.toMatchObject({ status: "confirmation_required" });
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
    ).resolves.toMatchObject({ status: "confirmation_required" });
    expect(githubExecutor.createRepository).not.toHaveBeenCalled();
    expect(githubExecutor.mergePullRequest).not.toHaveBeenCalled();
  });
});
describe("LocalAgent confirmation and receipt completeness", () => {
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
  ])("requires typed confirmation for $name before backend invocation", async (candidate) => {
    const { agent, githubExecutor } = await setupAgent({
      capabilities: candidate.capabilities,
      ...(candidate.accountOwners === undefined ? {} : { accountOwners: candidate.accountOwners }),
    });

    const pending = await (agent as any)[candidate.method](candidate.input, {
      invocationId: `confirm-${candidate.operation}`,
    });

    expect(pending).toMatchObject({
      status: "confirmation_required",
      operation: candidate.operation,
    });
    expect((githubExecutor as any)[candidate.backend]).not.toHaveBeenCalled();
  });

  it("does not consume or accept a typed confirmation when arguments or target change", async () => {
    const { agent, gitExecutor } = await setupAgent({ capabilities: ["git.remote.push"] });
    const input = {
      workspaceId: "test",
      branch: "feature/task6",
      expectedLocalSha: SHA_A,
      remote: "origin",
    };
    const pending = await (agent as any).gitPushBranch(input, { invocationId: "changed-grant" });

    await expect(
      (agent as any).gitPushBranch(
        { ...input, branch: "feature/other", confirmationId: pending.confirmationId },
        { invocationId: "changed-grant" },
      ),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_CONFIRMATION_INVALID" });
    expect(gitExecutor.pushBranch).not.toHaveBeenCalled();

    await expect(
      (agent as any).gitPushBranch(
        { ...input, confirmationId: pending.confirmationId },
        { invocationId: "changed-grant" },
      ),
    ).resolves.toMatchObject({ status: "completed" });
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
