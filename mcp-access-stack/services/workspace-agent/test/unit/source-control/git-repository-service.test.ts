import { mkdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import { GitRepositoryService } from "../../../src/source-control/git-repository-service.js";
import type { GitProcessExecutor } from "../../../src/source-control/git-process-runner.js";
import { WorkspaceRegistry } from "../../../src/workspace-registry.js";
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

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

async function setupRepository(options: { branch?: string } = {}): Promise<{
  service: GitRepositoryService;
  registry: WorkspaceRegistry;
  headSha: string;
}> {
  fixture = await createFixture({ profile: "full-repo-write" });
  initializeGitRepository(fixture.workspacePath);
  git(fixture.workspacePath, ["checkout", "-b", options.branch ?? "main"]);
  await writeWorkspaceFile(fixture.workspacePath, "base.txt", "base\n");
  git(fixture.workspacePath, ["add", "base.txt"]);
  git(fixture.workspacePath, ["commit", "-m", "baseline"]);
  const registry = await WorkspaceRegistry.load(fixture.policyPath);
  return {
    service: await GitRepositoryService.create(registry),
    registry,
    headSha: git(fixture.workspacePath, ["rev-parse", "HEAD"]).trim(),
  };
}

function writeTree(): string {
  return git(fixture!.workspacePath, ["write-tree"]).trim();
}

function head(): string {
  return git(fixture!.workspacePath, ["rev-parse", "HEAD"]).trim();
}

function currentBranch(): string {
  return git(fixture!.workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

describe("GitRepositoryService repository isolation", () => {
  it("fails closed when the selected workspace is nested inside a larger Git worktree", async () => {
    fixture = await createFixture({ profile: "full-repo-write" });
    const repositoryRoot = path.join(fixture.basePath, "repository");
    const nestedWorkspace = path.join(repositoryRoot, "workspace");
    await mkdir(nestedWorkspace, { recursive: true });
    initializeGitRepository(repositoryRoot);
    git(repositoryRoot, ["checkout", "-b", "feature/task4"]);
    await writeWorkspaceFile(nestedWorkspace, "inside.txt", "inside\n");
    await writeWorkspaceFile(repositoryRoot, "outside.txt", "outside\n");
    git(repositoryRoot, ["add", "."]);
    git(repositoryRoot, ["commit", "-m", "baseline"]);
    await writePolicy(fixture.policyPath, [
      makeWorkspacePolicy(nestedWorkspace, { profile: "full-repo-write" }),
    ]);
    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const service = await GitRepositoryService.create(registry);

    await expect(
      service.stagePaths({ workspaceId: "test", paths: ["inside.txt"] }),
    ).rejects.toMatchObject({ code: "NOT_GIT_REPOSITORY" });
    expect(git(repositoryRoot, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });
});

describe("GitRepositoryService create/stage/unstage", () => {
  it("rejects stale create-branch HEAD and existing branch, but allows feature branch from main", async () => {
    const { service, headSha } = await setupRepository();

    await expect(
      service.createBranch({
        workspaceId: "test",
        branch: "feature/stale",
        expectedHeadSha: "f".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });

    const created = await service.createBranch({
      workspaceId: "test",
      branch: "feature/task4",
      expectedHeadSha: headSha,
    });
    expect(created).toEqual({
      root: ".",
      branch: "feature/task4",
      headSha,
    });
    expect(currentBranch()).toBe("feature/task4");

    git(fixture!.workspacePath, ["checkout", "main"]);
    await expect(
      service.createBranch({
        workspaceId: "test",
        branch: "feature/task4",
        expectedHeadSha: headSha,
      }),
    ).rejects.toMatchObject({ code: "GIT_BRANCH_CONFLICT" });
  });

  it("stages only explicit authorized paths and returns the index tree SHA", async () => {
    const { service } = await setupRepository({ branch: "feature/task4" });
    await writeWorkspaceFile(fixture!.workspacePath, "a.txt", "a\n");
    await writeWorkspaceFile(fixture!.workspacePath, "b.txt", "b\n");

    const result = await service.stagePaths({
      workspaceId: "test",
      paths: ["a.txt"],
    });

    expect(result.paths).toEqual(["a.txt"]);
    expect(result.headSha).toBe(head());
    expect(result.indexTreeSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(git(fixture!.workspacePath, ["diff", "--cached", "--name-only"]).trim()).toBe(
      "a.txt",
    );
  });

  it("blocks mandatory private paths before staging", async () => {
    const { service } = await setupRepository({ branch: "feature/task4" });
    await writeWorkspaceFile(fixture!.workspacePath, ".env", "TOP_SECRET=value\n");

    await expect(
      service.stagePaths({ workspaceId: "test", paths: [".env"] }),
    ).rejects.toMatchObject({ code: "BLOCKED_PATH" });
    expect(git(fixture!.workspacePath, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it("unstages only explicit paths after exact HEAD and index checks", async () => {
    const { service } = await setupRepository({ branch: "feature/task4" });
    await writeWorkspaceFile(fixture!.workspacePath, "a.txt", "a\n");
    await writeWorkspaceFile(fixture!.workspacePath, "b.txt", "b\n");
    git(fixture!.workspacePath, ["add", "a.txt", "b.txt"]);
    const expectedHeadSha = head();
    const expectedIndexTreeSha = writeTree();

    await expect(
      service.unstagePaths({
        workspaceId: "test",
        paths: ["a.txt"],
        expectedHeadSha: "e".repeat(40),
        expectedIndexTreeSha,
      }),
    ).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    await expect(
      service.unstagePaths({
        workspaceId: "test",
        paths: ["a.txt"],
        expectedHeadSha,
        expectedIndexTreeSha: "d".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });

    const result = await service.unstagePaths({
      workspaceId: "test",
      paths: ["a.txt"],
      expectedHeadSha,
      expectedIndexTreeSha,
    });
    expect(result.paths).toEqual(["a.txt"]);
    expect(git(fixture!.workspacePath, ["diff", "--cached", "--name-only"]).trim()).toBe(
      "b.txt",
    );
  });
});

describe("GitRepositoryService commit", () => {
  it("blocks commit on protected main before creating a commit", async () => {
    const { service, headSha } = await setupRepository();
    await writeWorkspaceFile(fixture!.workspacePath, "base.txt", "changed\n");
    git(fixture!.workspacePath, ["add", "base.txt"]);
    const before = head();

    await expect(
      service.commit({
        workspaceId: "test",
        message: "blocked",
        expectedHeadSha: headSha,
        expectedIndexTreeSha: writeTree(),
      }),
    ).rejects.toMatchObject({ code: "GIT_PROTECTED_BRANCH" });
    expect(head()).toBe(before);
  });

  it("checks expected HEAD and index tree before a normal commit", async () => {
    const { service } = await setupRepository({ branch: "feature/task4" });
    await writeWorkspaceFile(fixture!.workspacePath, "base.txt", "changed\n");
    git(fixture!.workspacePath, ["add", "base.txt"]);
    const expectedHeadSha = head();
    const expectedIndexTreeSha = writeTree();

    await expect(
      service.commit({
        workspaceId: "test",
        message: "stale head",
        expectedHeadSha: "a".repeat(40),
        expectedIndexTreeSha,
      }),
    ).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    await expect(
      service.commit({
        workspaceId: "test",
        message: "stale index",
        expectedHeadSha,
        expectedIndexTreeSha: "b".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });

    const result = await service.commit({
      workspaceId: "test",
      message: "feat: typed git commit",
      expectedHeadSha,
      expectedIndexTreeSha,
    });
    expect(result.root).toBe(".");
    expect(result.branch).toBe("feature/task4");
    expect(result.commitSha).toBe(head());
    expect(result.commitSha).not.toBe(expectedHeadSha);
  });
});

describe("GitRepositoryService fast-forward merge", () => {
  async function prepareFastForward(): Promise<{
    service: GitRepositoryService;
    targetSha: string;
    sourceSha: string;
  }> {
    const { service } = await setupRepository();
    git(fixture!.workspacePath, ["checkout", "-b", "dev"]);
    const targetSha = head();
    git(fixture!.workspacePath, ["checkout", "-b", "feature/source"]);
    await writeWorkspaceFile(fixture!.workspacePath, "feature.txt", "feature\n");
    git(fixture!.workspacePath, ["add", "feature.txt"]);
    git(fixture!.workspacePath, ["commit", "-m", "feature commit"]);
    const sourceSha = head();
    git(fixture!.workspacePath, ["checkout", "dev"]);
    return { service, targetSha, sourceSha };
  }

  it("fast-forwards only when target/source SHAs and cleanliness match", async () => {
    const { service, targetSha, sourceSha } = await prepareFastForward();

    await expect(
      service.mergeBranch({
        workspaceId: "test",
        sourceBranch: "feature/source",
        expectedTargetHeadSha: "a".repeat(40),
        expectedSourceHeadSha: sourceSha,
      }),
    ).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    await expect(
      service.mergeBranch({
        workspaceId: "test",
        sourceBranch: "feature/source",
        expectedTargetHeadSha: targetSha,
        expectedSourceHeadSha: "b".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });

    const result = await service.mergeBranch({
      workspaceId: "test",
      sourceBranch: "feature/source",
      expectedTargetHeadSha: targetSha,
      expectedSourceHeadSha: sourceSha,
    });
    expect(result).toEqual({
      root: ".",
      branch: "dev",
      previousHeadSha: targetSha,
      headSha: sourceSha,
      sourceHeadSha: sourceSha,
      fastForwarded: true,
    });
    expect(head()).toBe(sourceSha);
  });

  it("blocks protected main and dirty/non-fast-forward merge preconditions", async () => {
    const { service, targetSha, sourceSha } = await prepareFastForward();
    await writeWorkspaceFile(fixture!.workspacePath, "base.txt", "dirty\n");
    await expect(
      service.mergeBranch({
        workspaceId: "test",
        sourceBranch: "feature/source",
        expectedTargetHeadSha: targetSha,
        expectedSourceHeadSha: sourceSha,
      }),
    ).rejects.toMatchObject({ code: "GIT_MERGE_NOT_FAST_FORWARD" });

    git(fixture!.workspacePath, ["checkout", "--", "base.txt"]);
    await writeWorkspaceFile(fixture!.workspacePath, "dev.txt", "dev\n");
    git(fixture!.workspacePath, ["add", "dev.txt"]);
    git(fixture!.workspacePath, ["commit", "-m", "diverge dev"]);
    await expect(
      service.mergeBranch({
        workspaceId: "test",
        sourceBranch: "feature/source",
        expectedTargetHeadSha: head(),
        expectedSourceHeadSha: sourceSha,
      }),
    ).rejects.toMatchObject({ code: "GIT_MERGE_NOT_FAST_FORWARD" });

    git(fixture!.workspacePath, ["checkout", "main"]);
    await expect(
      service.mergeBranch({
        workspaceId: "test",
        sourceBranch: "feature/source",
        expectedTargetHeadSha: head(),
        expectedSourceHeadSha: sourceSha,
      }),
    ).rejects.toMatchObject({ code: "GIT_PROTECTED_BRANCH" });
  });
});

describe("GitRepositoryService push", () => {
  async function addBareOrigin(): Promise<string> {
    const remoteRoot = path.join(fixture!.basePath, "remote.git");
    await mkdir(remoteRoot, { recursive: true });
    git(remoteRoot, ["init", "--bare"]);
    git(fixture!.workspacePath, ["remote", "add", "origin", remoteRoot]);
    return remoteRoot;
  }

  it("pushes only the explicit feature branch and checks local/remote SHA preconditions", async () => {
    const { service } = await setupRepository();
    await addBareOrigin();
    git(fixture!.workspacePath, ["checkout", "-b", "feature/push"]);
    await writeWorkspaceFile(fixture!.workspacePath, "push.txt", "push\n");
    git(fixture!.workspacePath, ["add", "push.txt"]);
    git(fixture!.workspacePath, ["commit", "-m", "push commit"]);
    const localSha = head();

    await expect(
      service.pushBranch({
        workspaceId: "test",
        branch: "feature/push",
        expectedLocalSha: "a".repeat(40),
        remote: "origin",
      }),
    ).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });

    const pushed = await service.pushBranch({
      workspaceId: "test",
      branch: "feature/push",
      expectedLocalSha: localSha,
      remote: "origin",
    });
    expect(pushed).toEqual({
      status: "completed",
      root: ".",
      remote: "origin",
      branch: "feature/push",
      localSha,
      remoteSha: localSha,
    });

    await writeWorkspaceFile(fixture!.workspacePath, "push.txt", "push again\n");
    git(fixture!.workspacePath, ["add", "push.txt"]);
    git(fixture!.workspacePath, ["commit", "-m", "push again"]);
    await expect(
      service.pushBranch({
        workspaceId: "test",
        branch: "feature/push",
        expectedLocalSha: head(),
        remote: "origin",
        expectedRemoteSha: "b".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_CHANGED" });
  }, 30_000);

  it("blocks pushing main before touching a remote", async () => {
    const { service, headSha } = await setupRepository();
    await expect(
      service.pushBranch({
        workspaceId: "test",
        branch: "main",
        expectedLocalSha: headSha,
      }),
    ).rejects.toMatchObject({ code: "GIT_PROTECTED_BRANCH" });
  });

  it("reconciles an ambiguous push before deciding completion", async () => {
    const { registry } = await setupRepository({ branch: "feature/push" });
    const localSha = head();
    const oldRemoteSha = "c".repeat(40);
    let remoteReads = 0;
    const runner = {
      isInsideWorkTree: async () => true,
      showTopLevel: async () => fixture!.workspacePath,
      branchSha: async () => localSha,
      remoteBranchSha: async () => (++remoteReads === 1 ? oldRemoteSha : localSha),
      pushBranch: async () => {
        throw new AppError("GIT_ERROR", "Git command failed.", {
          details: { outcome: "unknown" },
        });
      },
    } as unknown as GitProcessExecutor;
    const service = new GitRepositoryService(registry, runner);

    const result = await service.pushBranch({
      workspaceId: "test",
      branch: "feature/push",
      expectedLocalSha: localSha,
      remote: "origin",
      expectedRemoteSha: oldRemoteSha,
    });

    expect(result).toMatchObject({ status: "completed", remoteSha: localSha });
    expect(remoteReads).toBe(2);
  });

  it("requires reconciliation when an ambiguous push resolves to a third SHA", async () => {
    const { registry } = await setupRepository({ branch: "feature/push" });
    const localSha = head();
    const oldRemoteSha = "c".repeat(40);
    const thirdSha = "d".repeat(40);
    let remoteReads = 0;
    const runner = {
      isInsideWorkTree: async () => true,
      showTopLevel: async () => fixture!.workspacePath,
      branchSha: async () => localSha,
      remoteBranchSha: async () => (++remoteReads === 1 ? oldRemoteSha : thirdSha),
      pushBranch: async () => {
        throw new AppError("GIT_ERROR", "Git command failed.", {
          details: { outcome: "unknown" },
        });
      },
    } as unknown as GitProcessExecutor;
    const service = new GitRepositoryService(registry, runner);

    await expect(
      service.pushBranch({
        workspaceId: "test",
        branch: "feature/push",
        expectedLocalSha: localSha,
        remote: "origin",
        expectedRemoteSha: oldRemoteSha,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_CONTROL_RECONCILIATION_REQUIRED" });
    expect(remoteReads).toBe(2);
  });
});
