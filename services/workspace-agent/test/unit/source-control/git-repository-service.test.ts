import { lstat, mkdir, readFile, readdir, rmdir, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { AppError, type GitStashPathsInput } from "@vs-code-gpt/shared";
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
  it("detaches a clean registered worktree at the same SHA, preserving its branch and ignored runtime", async () => {
    const { service, headSha, source } = await setupRemote();
    const destination = ".worktrees/old-main";
    const target = path.join(source, destination);
    git(source, ["switch", "-c", "feature/current"]);
    git(source, ["worktree", "add", target, "main"]);
    await writeWorkspaceFile(source, ".git/info/exclude", ".worktrees/\nruntime/\n");
    await writeWorkspaceFile(target, "runtime/keep.txt", "preserve\n");
    const input = { workspaceId: "test", destination, expectedSourceHeadSha: headSha,
      expectedWorktreeHeadSha: headSha, expectedBranch: "main" };

    await expect(service.detachWorktree(input)).resolves.toEqual({
      root: ".", destination, sourceHeadSha: headSha, headSha,
      previousBranch: "main", detached: true,
    });
    expect(git(target, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("HEAD");
    expect(git(target, ["rev-parse", "HEAD"]).trim()).toBe(headSha);
    expect(git(source, ["rev-parse", "refs/heads/main"]).trim()).toBe(headSha);
    expect(currentBranch()).toBe("feature/current");
    expect(await readFile(path.join(target, "runtime/keep.txt"), "utf8")).toBe("preserve\n");
    expect(await readFile(path.join(target, "base.txt"), "utf8")).toBe("base\n");
    git(source, ["switch", "main"]);
    expect(currentBranch()).toBe("main");
  });

  it("refuses detach for stale source, target or branch identity and for dirty worktrees", async () => {
    const { service, headSha, source } = await setupRemote();
    const destination = ".worktrees/old-feature";
    const target = path.join(source, destination);
    git(source, ["worktree", "add", "-b", "feature/old", target, headSha]);
    const input = { workspaceId: "test", destination, expectedSourceHeadSha: headSha,
      expectedWorktreeHeadSha: headSha, expectedBranch: "feature/old" };

    await expect(service.detachWorktree({ ...input, expectedSourceHeadSha: "f".repeat(40) }))
      .rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    await expect(service.detachWorktree({ ...input, expectedWorktreeHeadSha: "e".repeat(40) }))
      .rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    await expect(service.detachWorktree({ ...input, expectedBranch: "feature/wrong" }))
      .rejects.toMatchObject({ code: "GIT_BRANCH_CONFLICT" });
    await writeWorkspaceFile(target, "base.txt", "local change\n");
    await expect(service.detachWorktree(input)).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });
    expect(await readFile(path.join(target, "base.txt"), "utf8")).toBe("local change\n");
    await writeWorkspaceFile(target, "base.txt", "base\n");
    await writeWorkspaceFile(target, "untracked.txt", "local file\n");
    await expect(service.detachWorktree(input)).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });
    expect(git(target, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feature/old");
    expect(await readFile(path.join(target, "untracked.txt"), "utf8")).toBe("local file\n");
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

  it("prunes only allowlisted ignored build caches when explicitly requested", async () => {
    const { service, headSha, source } = await setupRemote();
    const destination = ".worktrees/clean-main";
    await service.createWorktree({ workspaceId: "test", destination,
      expectedHeadSha: headSha, expectedRemoteSha: headSha });
    const target = path.join(source, destination);
    await writeWorkspaceFile(source, ".git/info/exclude", "node_modules/\npackages/*/dist/\n");
    await writeWorkspaceFile(target, "node_modules/cache.txt", "generated\n");
    await writeWorkspaceFile(target, "packages/mcp-core/dist/index.js", "generated\n");

    await expect(service.removeWorktree({ workspaceId: "test", destination,
      expectedSourceHeadSha: headSha, expectedWorktreeHeadSha: headSha,
    })).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });

    const removed = await service.removeWorktree({ workspaceId: "test", destination,
      expectedSourceHeadSha: headSha, expectedWorktreeHeadSha: headSha,
      pruneGeneratedArtifacts: true,
    });
    expect(removed.removed).toBe(true);
    await expect(lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not prune any generated cache when protected ignored data is present", async () => {
    const { service, headSha, source } = await setupRemote();
    const destination = ".worktrees/clean-main";
    await service.createWorktree({ workspaceId: "test", destination,
      expectedHeadSha: headSha, expectedRemoteSha: headSha });
    const target = path.join(source, destination);
    await writeWorkspaceFile(source, ".git/info/exclude", "node_modules/\n.codex/\n");
    await writeWorkspaceFile(target, "node_modules/cache.txt", "preserve until safe\n");
    await writeWorkspaceFile(target, ".codex/HANDOFF.md", "historical data\n");
    await expect(service.removeWorktree({ workspaceId: "test", destination,
      expectedSourceHeadSha: headSha, expectedWorktreeHeadSha: headSha,
      pruneGeneratedArtifacts: true,
    })).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });
    expect(await readFile(path.join(target, "node_modules/cache.txt"), "utf8")).toBe("preserve until safe\n");
    expect(await readFile(path.join(target, ".codex/HANDOFF.md"), "utf8")).toBe("historical data\n");
  });

  it("does not prune with untracked source files inside the worktree", async () => {
    const { service, headSha, source } = await setupRemote();
    const destination = ".worktrees/clean-main";
    await service.createWorktree({ workspaceId: "test", destination,
      expectedHeadSha: headSha, expectedRemoteSha: headSha });
    const target = path.join(source, destination);
    await writeWorkspaceFile(source, ".git/info/exclude", "node_modules/\n");
    await writeWorkspaceFile(target, "node_modules/cache.txt", "cache\n");
    await writeWorkspaceFile(target, "user-data.txt", "retain\n");
    await expect(service.removeWorktree({ workspaceId: "test", destination,
      expectedSourceHeadSha: headSha, expectedWorktreeHeadSha: headSha,
      pruneGeneratedArtifacts: true,
    })).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });
    expect(await readFile(path.join(target, "node_modules/cache.txt"), "utf8")).toBe("cache\n");
  });

  it("preserves tracked files co-located with ignored generated output", async () => {
    const { service, source } = await setupRemote();
    await writeWorkspaceFile(source, "packages/mcp-core/dist/tracked.txt", "tracked data\n");
    git(source, ["add", "packages/mcp-core/dist/tracked.txt"]);
    git(source, ["commit", "-m", "tracked artifact fixture"]);
    git(source, ["push", "origin", "main"]);
    const updatedHead = head();
    const destination = ".worktrees/clean-main";
    await service.createWorktree({ workspaceId: "test", destination,
      expectedHeadSha: updatedHead, expectedRemoteSha: updatedHead });
    const target = path.join(source, destination);
    await writeWorkspaceFile(source, ".git/info/exclude", "packages/*/dist/\n");
    await writeWorkspaceFile(target, "packages/mcp-core/dist/generated.js", "ignored\n");
    await expect(service.removeWorktree({ workspaceId: "test", destination,
      expectedSourceHeadSha: updatedHead, expectedWorktreeHeadSha: updatedHead,
      pruneGeneratedArtifacts: true,
    })).rejects.toMatchObject({ code: "GIT_INDEX_CHANGED" });
    expect((await readFile(path.join(target, "packages/mcp-core/dist/tracked.txt"), "utf8")).replace(/\r\n/gu, "\n")).toBe("tracked data\n");
    expect(await readFile(path.join(target, "packages/mcp-core/dist/generated.js"), "utf8")).toBe("ignored\n");
  });

  it("blocks symlinked generated directories before deleting external files", async () => {
    if (process.platform === "win32") return;
    const { service, headSha, source } = await setupRemote();
    const destination = ".worktrees/clean-main";
    await service.createWorktree({ workspaceId: "test", destination,
      expectedHeadSha: headSha, expectedRemoteSha: headSha });
    const target = path.join(source, destination);
    const external = path.join(fixture!.basePath, "external-cache");
    await mkdir(external);
    await writeWorkspaceFile(external, "sentinel.txt", "never delete\n");
    await writeWorkspaceFile(source, ".git/info/exclude", "node_modules\n");
    await symlink(external, path.join(target, "node_modules"), "dir");
    await expect(service.removeWorktree({ workspaceId: "test", destination,
      expectedSourceHeadSha: headSha, expectedWorktreeHeadSha: headSha,
      pruneGeneratedArtifacts: true,
    })).rejects.toMatchObject({ code: "INVALID_PATH" });
    expect(await readFile(path.join(external, "sentinel.txt"), "utf8")).toBe("never delete\n");
  });

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

describe("GitRepositoryService explicit stash", () => {
  const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

  async function setupStash() {
    const { headSha } = await setupRepository({ branch: "feature/stash" });
    const root = fixture!.workspacePath;
    await writePolicy(fixture!.policyPath, [{
      ...makeWorkspacePolicy(root, { profile: "full-repo-write" }),
      allowWrites: ["."],
    }]);
    const service = await GitRepositoryService.create(await WorkspaceRegistry.load(fixture!.policyPath));
    await writeWorkspaceFile(root, ".git/info/exclude", "runtime/\n");
    await writeWorkspaceFile(root, "runtime/keep.txt", "ignored\n");
    await writeWorkspaceFile(root, "base.txt", "staged\n");
    git(root, ["add", "base.txt"]);
    await writeWorkspaceFile(root, "base.txt", "unstaged\n");
    await writeWorkspaceFile(root, "note[1].txt", "untracked\n");
    const input: GitStashPathsInput = {
      workspaceId: "test", expectedHeadSha: headSha, expectedBranch: "feature/stash",
      expectedIndexTreeSha: writeTree(), expectedStashSha: null,
      files: [{ path: "base.txt", status: "MM", expectedSha256: sha256("unstaged\n") },
        { path: "note[1].txt", status: "??", expectedSha256: sha256("untracked\n") }],
    };
    return { service, root, input };
  }

  it("preserves staged, unstaged and explicit untracked files in one native stash without touching ignored files", async () => {
    const { service, root, input } = await setupStash();
    const result = await service.stashPaths(input);
    expect(result).toMatchObject({ root: ".", branch: input.expectedBranch, headSha: input.expectedHeadSha,
      paths: ["base.txt", "note[1].txt"], previousStashSha: null, stashSha: expect.stringMatching(/^[a-f0-9]{40}$/u) });
    expect(git(root, ["rev-parse", "refs/stash"]).trim()).toBe(result.stashSha);
    expect(git(root, ["status", "--porcelain"]).trim()).toBe("");
    expect(await readFile(path.join(root, "runtime/keep.txt"), "utf8")).toBe("ignored\n");
    expect(head()).toBe(input.expectedHeadSha);
    expect(currentBranch()).toBe(input.expectedBranch);
    git(root, ["stash", "apply", "--index", result.stashSha]);
    expect(await readFile(path.join(root, "base.txt"), "utf8")).toBe("unstaged\n");
    expect(git(root, ["show", ":base.txt"])).toBe("staged\n");
    expect(await readFile(path.join(root, "note[1].txt"), "utf8")).toBe("untracked\n");
  });

  it("preserves a previously existing stash and checkpoints an explicit deletion", async () => {
    const { service, root, input } = await setupStash();
    const first = await service.stashPaths(input);
    await unlink(path.join(root, "base.txt"));
    const deletion: GitStashPathsInput = {
      ...input, expectedIndexTreeSha: writeTree(), expectedStashSha: first.stashSha,
      files: [{ path: "base.txt", status: " D", expectedSha256: null }],
    };
    const second = await service.stashPaths(deletion);
    expect(second.previousStashSha).toBe(first.stashSha);
    expect(second.stashSha).not.toBe(first.stashSha);
    expect(git(root, ["rev-parse", "stash@{1}"]).trim()).toBe(first.stashSha);
    expect(await readFile(path.join(root, "base.txt"), "utf8")).toBe("base\n");
    git(root, ["stash", "apply", "--index", second.stashSha]);
    await expect(lstat(path.join(root, "base.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(root, "runtime/keep.txt"), "utf8")).toBe("ignored\n");
  });

  it("refuses incomplete inventory, stale hashes, index, branch and stash CAS without clearing changes", async () => {
    const { service, root, input } = await setupStash();
    for (const invalid of [
      { ...input, files: input.files.slice(0, 1) },
      { ...input, expectedIndexTreeSha: "a".repeat(40) },
      { ...input, expectedHeadSha: "b".repeat(40) },
      { ...input, expectedBranch: "feature/wrong" },
      { ...input, expectedStashSha: "c".repeat(40) },
      { ...input, files: input.files.map((file) => ({ ...file, expectedSha256: "d".repeat(64) })) },
    ]) {
      await expect(service.stashPaths(invalid)).rejects.toThrow();
      expect(git(root, ["stash", "list"])).toBe("");
      expect(await readFile(path.join(root, "base.txt"), "utf8")).toBe("unstaged\n");
      expect(await readFile(path.join(root, "note[1].txt"), "utf8")).toBe("untracked\n");
      expect(writeTree()).toBe(input.expectedIndexTreeSha);
    }
  });

  it("refuses blocked and symbolic link paths before native stash", async () => {
    const { service, root, input } = await setupStash();
    await writeWorkspaceFile(root, ".env", "private\n");
    await expect(service.stashPaths({ ...input, files: [...input.files,
      { path: ".env", status: "??", expectedSha256: sha256("private\n") }] })).rejects.toMatchObject({ code: "BLOCKED_PATH" });
    await unlink(path.join(root, ".env"));
    if (process.platform !== "win32") {
      await symlink(path.join(root, "base.txt"), path.join(root, "link.txt"));
      await expect(service.stashPaths({ ...input, files: [...input.files,
        { path: "link.txt", status: "??", expectedSha256: sha256("unstaged\n") }] })).rejects.toThrow();
      expect((await lstat(path.join(root, "link.txt"))).isSymbolicLink()).toBe(true);
    }
    expect(git(root, ["stash", "list"])).toBe("");
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
