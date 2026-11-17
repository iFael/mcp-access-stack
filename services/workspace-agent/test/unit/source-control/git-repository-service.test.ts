import { lstat, mkdir, readFile, readdir, rmdir, symlink, unlink } from "node:fs/promises";
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

describe("GitRepositoryService isolated worktrees", () => {
  async function setupRemote() {
    const { service, headSha } = await setupRepository();
    const source = fixture!.workspacePath;
    const remote = path.join(fixture!.basePath, "origin.git");
    git(fixture!.basePath, ["init", "--bare", remote]);
    git(source, ["remote", "add", "origin", remote]);
    git(source, ["push", "origin", "main"]);
    await mkdir(path.join(source, ".worktrees"));
    return { service, headSha, source };
  }

  it("creates a detached, clean worktree from verified origin/main without changing dirty source", async () => {
    const { service, headSha, source } = await setupRemote();
    await writeWorkspaceFile(source, "base.txt", "unsaved local edit\n");
    await writeWorkspaceFile(source, "private-untracked.txt", "preserve me\n");

    const result = await service.createWorktree({
      workspaceId: "test",
      destination: ".worktrees/clean-main",
      expectedHeadSha: headSha,
      expectedRemoteSha: headSha,
    });
    const target = path.join(source, ".worktrees", "clean-main");
    expect(result).toEqual({
      root: ".", destination: ".worktrees/clean-main",
      previousHeadSha: headSha, headSha, detached: true, created: true,
    });
    expect(git(target, ["rev-parse", "HEAD"]).trim()).toBe(headSha);
    expect(git(target, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("HEAD");
    expect(git(target, ["status", "--porcelain"]).trim()).toBe("");
    expect(git(source, ["rev-parse", "HEAD"]).trim()).toBe(headSha);
    expect(await readFile(path.join(source, "base.txt"), "utf8")).toBe("unsaved local edit\n");
    expect(await readFile(path.join(source, "private-untracked.txt"), "utf8")).toBe("preserve me\n");
    expect((await readFile(path.join(target, "base.txt"), "utf8")).replace(/\r\n/gu, "\n")).toBe("base\n");
  });

  it("rejects a stale local SHA or different remote SHA without creating a destination", async () => {
    const { service, headSha, source } = await setupRemote();
    const input = { workspaceId: "test", destination: ".worktrees/clean-main",
      expectedHeadSha: headSha, expectedRemoteSha: headSha };
    await expect(service.createWorktree({ ...input, expectedHeadSha: "f".repeat(40) }))
      .rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    await expect(service.createWorktree({ ...input, expectedRemoteSha: "e".repeat(40) }))
      .rejects.toMatchObject({ code: "GIT_REMOTE_CHANGED" });
    await expect(readFile(path.join(source, ".worktrees/clean-main/.git"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect(git(source, ["rev-parse", "HEAD"]).trim()).toBe(headSha);
  });

  it("rejects an existing destination, preserving its contents", async () => {
    const { service, headSha, source } = await setupRemote();
    await mkdir(path.join(source, ".worktrees/clean-main"));
    await writeWorkspaceFile(source, ".worktrees/clean-main/sentinel.txt", "keep this\n");
    await expect(service.createWorktree({
      workspaceId: "test", destination: ".worktrees/clean-main",
      expectedHeadSha: headSha, expectedRemoteSha: headSha,
    })).rejects.toMatchObject({ code: "GIT_BRANCH_CONFLICT" });
    expect(await readFile(path.join(source, ".worktrees/clean-main/sentinel.txt"), "utf8")).toBe("keep this\n");
  });

  it("rejects an invalid destination before any filesystem writes", async () => {
    const { service, headSha } = await setupRemote();
    for (const destination of ["../escape", ".worktrees/../escape", ".worktrees/a/b", ".worktrees/.git", "/tmp/escape"]) {
      await expect(service.createWorktree({
        workspaceId: "test", destination,
        expectedHeadSha: headSha, expectedRemoteSha: headSha,
      })).rejects.toThrow();
    }
  });

  it("rejects a symlinked worktree parent without touching the target", async () => {
    if (process.platform === "win32") return;
    const { service, headSha, source } = await setupRemote();
    const external = path.join(fixture!.basePath, "external");
    await mkdir(external);
    const linked = path.join(source, ".worktrees", "nested");
    await symlink(external, linked);
    await expect(service.createWorktree({
      workspaceId: "test", destination: ".worktrees/nested",
      expectedHeadSha: headSha, expectedRemoteSha: headSha,
    })).rejects.toMatchObject({ code: "GIT_BRANCH_CONFLICT" });
    expect(await readdir(external)).toEqual([]);
  });

  it("rejects a symlinked .worktrees parent before a fetch or write", async () => {
    if (process.platform === "win32") return;
    const { service, headSha, source } = await setupRemote();
    const external = path.join(fixture!.basePath, "external-parent");
    await mkdir(external);
    await rmdir(path.join(source, ".worktrees"));
    await symlink(external, path.join(source, ".worktrees"));
    await expect(service.createWorktree({
      workspaceId: "test", destination: ".worktrees/clean-main",
      expectedHeadSha: headSha, expectedRemoteSha: headSha,
    })).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });
    expect(await readdir(external)).toEqual([]);
  });
  it("removes only a registered clean worktree without changing a dirty source checkout", async () => {
    const { service, headSha, source } = await setupRemote();
    const destination = ".worktrees/clean-main";
    await service.createWorktree({ workspaceId: "test", destination,
      expectedHeadSha: headSha, expectedRemoteSha: headSha });
    const target = path.join(source, destination);
    await writeWorkspaceFile(source, "base.txt", "unsaved source change\n");
    await writeWorkspaceFile(source, "untracked-source.txt", "keep me\n");
    const removed = await service.removeWorktree({
      workspaceId: "test", destination,
      expectedSourceHeadSha: headSha, expectedWorktreeHeadSha: headSha,
    });
    expect(removed).toEqual({ root: ".", destination,
      sourceHeadSha: headSha, removedWorktreeHeadSha: headSha, removed: true });
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(git(source, ["worktree", "list", "--porcelain"])).not.toContain(target);
    expect(head()).toBe(headSha);
    expect(await readFile(path.join(source, "base.txt"), "utf8")).toBe("unsaved source change\n");
    expect(await readFile(path.join(source, "untracked-source.txt"), "utf8")).toBe("keep me\n");
  });

  it("refuses a stale SHA, modified files, untracked files and ignored files", async () => {
    const { service, headSha, source } = await setupRemote();
    const destination = ".worktrees/clean-main";
    await service.createWorktree({ workspaceId: "test", destination,
      expectedHeadSha: headSha, expectedRemoteSha: headSha });
    const target = path.join(source, destination);
    const input = { workspaceId: "test", destination,
      expectedSourceHeadSha: headSha, expectedWorktreeHeadSha: headSha };
    await expect(service.removeWorktree({ ...input, expectedSourceHeadSha: "f".repeat(40) }))
      .rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    await expect(service.removeWorktree({ ...input, expectedWorktreeHeadSha: "e".repeat(40) }))
      .rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    await writeWorkspaceFile(target, "base.txt", "changed\n");
    await expect(service.removeWorktree(input)).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });
    await writeWorkspaceFile(target, "base.txt", "base\n");
    await writeWorkspaceFile(target, "untracked.txt", "preserve\n");
    await expect(service.removeWorktree(input)).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });
    await unlink(path.join(target, "untracked.txt"));
    await writeWorkspaceFile(source, ".git/info/exclude", "ignored-cache/\n");
    await mkdir(path.join(target, "ignored-cache"));
    await writeWorkspaceFile(target, "ignored-cache/cache.txt", "preserve\n");
    await expect(service.removeWorktree(input)).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });
    expect(await readFile(path.join(target, "ignored-cache/cache.txt"), "utf8")).toBe("preserve\n");
  }, 120_000);

  it("rejects a missing Git marker, unsafe destination or target registration", async () => {
    const { service, headSha, source } = await setupRemote();
    const destination = ".worktrees/clean-main";
    const input = { workspaceId: "test", destination,
      expectedSourceHeadSha: headSha, expectedWorktreeHeadSha: headSha };
    await expect(service.removeWorktree(input)).rejects.toMatchObject({ code: "GIT_BRANCH_CONFLICT" });
    await service.createWorktree({ workspaceId: "test", destination,
      expectedHeadSha: headSha, expectedRemoteSha: headSha });
    await unlink(path.join(source, destination, ".git"));
    await expect(service.removeWorktree(input)).rejects.toMatchObject({ code: "GIT_BRANCH_CONFLICT" });
    for (const bad of ["../outside", ".worktrees/../escape", ".worktrees/a/b", ".worktrees/.git"]) {
      await expect(service.removeWorktree({ ...input, destination: bad })).rejects.toThrow();
    }
    expect(await readFile(path.join(source, destination, "base.txt"), "utf8")).toContain("base");
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

    const expectedHeadSha = head();
    const result = await service.stagePaths({
      workspaceId: "test",
      paths: ["a.txt"],
      expectedHeadSha,
      requireCleanIndex: true,
    });

    expect(result.paths).toEqual(["a.txt"]);
    expect(result.headSha).toBe(head());
    expect(result.indexTreeSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(git(fixture!.workspacePath, ["diff", "--cached", "--name-only"]).trim()).toBe(
      "a.txt",
    );
  });

  it("checks HEAD and a clean index before staging explicit commit paths", async () => {
    const { service } = await setupRepository({ branch: "feature/task4" });
    await writeWorkspaceFile(fixture!.workspacePath, "a.txt", "a\n");
    await writeWorkspaceFile(fixture!.workspacePath, "b.txt", "b\n");
    git(fixture!.workspacePath, ["add", "b.txt"]);
    const expectedHeadSha = head();

    await expect(
      service.stagePaths({
        workspaceId: "test",
        paths: ["a.txt"],
        expectedHeadSha,
        requireCleanIndex: true,
      }),
    ).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });
    expect(
      git(fixture!.workspacePath, ["diff", "--cached", "--name-only"]).trim(),
    ).toBe("b.txt");

    git(fixture!.workspacePath, ["restore", "--staged", "b.txt"]);
    await expect(
      service.stagePaths({
        workspaceId: "test",
        paths: ["a.txt"],
        expectedHeadSha: "f".repeat(40),
        requireCleanIndex: true,
      }),
    ).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    expect(
      git(fixture!.workspacePath, ["diff", "--cached", "--name-only"]).trim(),
    ).toBe("");
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

  it("enforces dirty/non-fast-forward guards and permits exact fast-forward to main", async () => {
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
    const mainSha = head();
    await expect(service.mergeBranch({
      workspaceId: "test",
      sourceBranch: "feature/source",
      expectedTargetHeadSha: "f".repeat(40),
      expectedSourceHeadSha: sourceSha,
    })).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });

    const merged = await service.mergeBranch({
      workspaceId: "test",
      sourceBranch: "feature/source",
      expectedTargetHeadSha: mainSha,
      expectedSourceHeadSha: sourceSha,
    });
    expect(merged).toEqual({
      root: ".",
      branch: "main",
      previousHeadSha: mainSha,
      headSha: sourceSha,
      sourceHeadSha: sourceSha,
      fastForwarded: true,
    });
    expect(head()).toBe(sourceSha);
  });
});

describe("GitRepositoryService sync", () => {
  async function addBareOriginForSync(): Promise<string> {
    const remoteRoot = path.join(fixture!.basePath, "sync-remote.git");
    await mkdir(remoteRoot, { recursive: true });
    git(remoteRoot, ["init", "--bare"]);
    git(fixture!.workspacePath, ["remote", "add", "origin", remoteRoot]);
    return remoteRoot;
  }

  it("switches to an existing main branch and fast-forwards only to the exact remote SHA", async () => {
    const { service, headSha: baseSha } = await setupRepository();
    await addBareOriginForSync();
    git(fixture!.workspacePath, ["push", "origin", "main:refs/heads/main"]);

    git(fixture!.workspacePath, ["checkout", "-b", "remote-main"]);
    await writeWorkspaceFile(fixture!.workspacePath, "remote.txt", "remote\n");
    git(fixture!.workspacePath, ["add", "remote.txt"]);
    git(fixture!.workspacePath, ["commit", "-m", "remote main"]);
    const remoteSha = head();
    git(fixture!.workspacePath, ["push", "origin", "HEAD:refs/heads/main"]);

    git(fixture!.workspacePath, ["checkout", "main"]);
    git(fixture!.workspacePath, ["checkout", "-b", "feature/work"]);

    const result = await service.syncBranch({
      workspaceId: "test",
      branch: "main",
      remote: "origin",
      expectedRemoteSha: remoteSha,
    });

    expect(result).toEqual({
      root: ".",
      remote: "origin",
      branch: "main",
      previousBranch: "feature/work",
      previousHeadSha: baseSha,
      previousTargetHeadSha: baseSha,
      remoteSha,
      headSha: remoteSha,
      switched: true,
      fastForwarded: true,
      alreadyUpToDate: false,
    });
    expect(currentBranch()).toBe("main");
    expect(head()).toBe(remoteSha);
  }, 30_000);

  it("refuses synchronization when the repository has untracked files", async () => {
    const { service, headSha } = await setupRepository();
    await addBareOriginForSync();
    git(fixture!.workspacePath, ["push", "origin", "main:refs/heads/main"]);
    git(fixture!.workspacePath, ["checkout", "-b", "feature/work"]);
    await writeWorkspaceFile(fixture!.workspacePath, "untracked.txt", "dirty\n");

    await expect(
      service.syncBranch({
        workspaceId: "test",
        branch: "main",
        remote: "origin",
        expectedRemoteSha: headSha,
      }),
    ).rejects.toMatchObject({ code: "GIT_MERGE_NOT_FAST_FORWARD" });
    expect(currentBranch()).toBe("feature/work");
  }, 30_000);

  it("rejects a stale expected remote SHA before switching branches", async () => {
    const { service } = await setupRepository();
    await addBareOriginForSync();
    git(fixture!.workspacePath, ["push", "origin", "main:refs/heads/main"]);
    git(fixture!.workspacePath, ["checkout", "-b", "feature/work"]);

    await expect(
      service.syncBranch({
        workspaceId: "test",
        branch: "main",
        remote: "origin",
        expectedRemoteSha: "b".repeat(40),
      }),
    ).rejects.toMatchObject({ code: "GIT_REMOTE_CHANGED" });
    expect(currentBranch()).toBe("feature/work");
  }, 30_000);
});

describe("GitRepositoryService exact release tag publication", () => {
  async function prepareBareMain() {
    const setup = await setupRepository();
    const remoteRoot = path.join(fixture!.basePath, "tag-remote.git");
    await mkdir(remoteRoot, { recursive: true });
    git(remoteRoot, ["init", "--bare"]);
    git(fixture!.workspacePath, ["remote", "add", "origin", remoteRoot]);
    git(fixture!.workspacePath, ["push", "origin", "main:refs/heads/main"]);
    return { ...setup, remoteRoot };
  }

  const tag = "v1.1.0-beta.83";

  it("publishes exact local tag to matching remote main, and treats an identical remote tag as idempotent", async () => {
    const { service, headSha, remoteRoot } = await prepareBareMain();
    git(fixture!.workspacePath, ["tag", tag, headSha]);
    const input = { workspaceId: "test", tag, expectedCommitSha: headSha };
    const first = await service.publishTag(input);
    expect(first).toEqual({ status: "completed", root: ".", remote: "origin", tag,
      commitSha: headSha, remoteSha: headSha, alreadyPublished: false });
    expect(git(remoteRoot, ["rev-parse", `refs/tags/${tag}`]).trim()).toBe(headSha);
    const again = await service.publishTag(input);
    expect(again).toMatchObject({ status: "completed", alreadyPublished: true, remoteSha: headSha });
  }, 30_000);

  it("rejects incorrect local SHA and does not create a remote tag", async () => {
    const { service, headSha, remoteRoot } = await prepareBareMain();
    git(fixture!.workspacePath, ["tag", tag, headSha]);
    await expect(service.publishTag({
      workspaceId: "test", tag, expectedCommitSha: "a".repeat(40),
    })).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    expect(git(remoteRoot, ["tag", "--list", tag]).trim()).toBe("");
  });

  it("blocks stale remote main even if the local tag points to the expected SHA", async () => {
    const { service, headSha, remoteRoot } = await prepareBareMain();
    git(fixture!.workspacePath, ["tag", tag, headSha]);
    await writeWorkspaceFile(fixture!.workspacePath, "later.txt", "later\n");
    git(fixture!.workspacePath, ["add", "later.txt"]);
    git(fixture!.workspacePath, ["commit", "-m", "advance main"]);
    git(fixture!.workspacePath, ["push", "origin", "main:refs/heads/main"]);
    await expect(service.publishTag({
      workspaceId: "test", tag, expectedCommitSha: headSha,
    })).rejects.toMatchObject({ code: "GIT_REMOTE_CHANGED" });
    expect(git(remoteRoot, ["tag", "--list", tag]).trim()).toBe("");
  }, 30_000);

  it("never overwrites a conflicting remote tag", async () => {
    const { service, headSha, remoteRoot } = await prepareBareMain();
    git(fixture!.workspacePath, ["tag", tag, headSha]);
    await writeWorkspaceFile(fixture!.workspacePath, "new.txt", "new\n");
    git(fixture!.workspacePath, ["add", "new.txt"]);
    git(fixture!.workspacePath, ["commit", "-m", "other commit"]);
    const otherSha = head();
    git(fixture!.workspacePath, ["push", "origin", `${otherSha}:refs/tags/${tag}`]);
    await expect(service.publishTag({
      workspaceId: "test", tag, expectedCommitSha: headSha,
    })).rejects.toMatchObject({ code: "GIT_REMOTE_CHANGED" });
    expect(git(remoteRoot, ["rev-parse", `refs/tags/${tag}`]).trim()).toBe(otherSha);
  }, 30_000);

  it("does not retry when push outcome is unknown and remote tag is absent", async () => {
    const { registry, headSha } = await prepareBareMain();
    const runner = {
      isInsideWorkTree: async () => true,
      showTopLevel: async () => fixture!.workspacePath,
      localTagSha: async () => headSha,
      remoteTagSha: async () => undefined,
      remoteBranchSha: async () => headSha,
      pushTag: async () => {
        throw new AppError("GIT_ERROR", "Git command outcome unknown.", { details: { outcome: "unknown" } });
      },
    } as unknown as GitProcessExecutor;
    const service = new GitRepositoryService(registry, runner);
    await expect(service.publishTag({
      workspaceId: "test", tag, expectedCommitSha: headSha,
    })).rejects.toMatchObject({ code: "SOURCE_CONTROL_RECONCILIATION_REQUIRED" });
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

  it("blocks direct push to protected main", async () => {
    const { service, headSha } = await setupRepository();
    await addBareOrigin();

    await expect(
      service.pushBranch({
        workspaceId: "test",
        branch: "main",
        expectedLocalSha: headSha,
        remote: "origin",
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
