import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import {
  createFixture,
  git,
  initializeGitRepository,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
  writeWorkspaceFile,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

jest.setTimeout(15_000);

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("Git service", () => {
  test("returns staged, unstaged, binary and untracked state without blocked files", async () => {
    fixture = await createFixture();
    initializeGitRepository(fixture.workspacePath);
    await writeWorkspaceFile(fixture.workspacePath, "staged.txt", "base staged\n");
    await writeWorkspaceFile(fixture.workspacePath, "unstaged.txt", "base unstaged\n");
    await writeWorkspaceFile(fixture.workspacePath, "binary.bin", Buffer.from([1, 0, 3]));
    await writeWorkspaceFile(fixture.workspacePath, ".env", "old-secret\n");
    git(fixture.workspacePath, ["add", "."]);
    git(fixture.workspacePath, ["commit", "-m", "baseline"]);

    await writeWorkspaceFile(fixture.workspacePath, "staged.txt", "changed staged\n");
    git(fixture.workspacePath, ["add", "staged.txt"]);
    await writeWorkspaceFile(fixture.workspacePath, "unstaged.txt", "changed unstaged\n");
    await writeWorkspaceFile(fixture.workspacePath, "binary.bin", Buffer.from([9, 0, 7]));
    await writeWorkspaceFile(fixture.workspacePath, ".env", "new-secret\n");
    await writeWorkspaceFile(fixture.workspacePath, "untracked.txt", "new\n");
    const agent = await LocalAgent.create(fixture.policyPath);

    const result = await agent.inspectGit({ workspaceId: "test", root: ".", diffMode: "full", paths: [], maxDiffBytes: 40_000, timeoutMs: 120_000 });
    expect(result.status.map((entry) => entry.path).sort()).toEqual([
      "binary.bin",
      "staged.txt",
      "unstaged.txt",
      "untracked.txt",
    ]);
    expect(result.staged).toContain("changed staged");
    expect(result.unstaged).toContain("changed unstaged");
    expect(result.unstaged).toContain("GIT binary patch");
    expect(JSON.stringify(result)).not.toContain(".env");
    expect(JSON.stringify(result)).not.toContain("new-secret");
  });

  test("filters Git results by path and allowed roots", async () => {
    fixture = await createFixture({ allowedRoots: ["src"] });
    initializeGitRepository(fixture.workspacePath);
    await writeWorkspaceFile(fixture.workspacePath, "src/a.txt", "a\n");
    await writeWorkspaceFile(fixture.workspacePath, "other.txt", "other\n");
    git(fixture.workspacePath, ["add", "."]);
    git(fixture.workspacePath, ["commit", "-m", "baseline"]);
    await writeWorkspaceFile(fixture.workspacePath, "src/a.txt", "changed\n");
    await writeWorkspaceFile(fixture.workspacePath, "other.txt", "hidden\n");
    const agent = await LocalAgent.create(fixture.policyPath);

    const result = await agent.inspectGit({ workspaceId: "test", root: ".", paths: ["src"], diffMode: "full", maxDiffBytes: 40_000, timeoutMs: 120_000 });
    expect(result.status).toHaveLength(1);
    expect(result.status[0]?.path).toBe("src/a.txt");
    expect(result.unstaged).not.toContain("other.txt");
  });

  test("supports a workspace nested inside a Git worktree and excludes sibling changes", async () => {
    fixture = await createFixture();
    const repositoryRoot = path.join(fixture.basePath, "repository");
    const nestedWorkspace = path.join(repositoryRoot, "mcp-access-stack");
    await mkdir(nestedWorkspace, { recursive: true });
    initializeGitRepository(repositoryRoot);
    await writeWorkspaceFile(nestedWorkspace, "inside.txt", "base inside\n");
    await writeWorkspaceFile(repositoryRoot, "outside.txt", "base outside\n");
    git(repositoryRoot, ["add", "."]);
    git(repositoryRoot, ["commit", "-m", "baseline"]);

    await writeWorkspaceFile(nestedWorkspace, "inside.txt", "changed inside\n");
    await writeWorkspaceFile(repositoryRoot, "outside.txt", "hidden outside\n");
    await writePolicy(fixture.policyPath, [makeWorkspacePolicy(nestedWorkspace)]);
    const agent = await LocalAgent.create(fixture.policyPath);

    const result = await agent.inspectGit({ workspaceId: "test", root: ".", diffMode: "full", paths: [], maxDiffBytes: 40_000, timeoutMs: 120_000 });
    expect(result.status.map((entry) => entry.path)).toEqual(["inside.txt"]);
    expect(result.unstaged).toContain("changed inside");
    expect(result.unstaged).not.toContain("outside.txt");
    expect(result.unstaged).not.toContain("hidden outside");
  });

  test("supports a Git repository nested inside the workspace", async () => {
    fixture = await createFixture();
    const repositoryRoot = path.join(fixture.workspacePath, "XPNet", "ScriptsAd");
    await mkdir(repositoryRoot, { recursive: true });
    initializeGitRepository(repositoryRoot);
    git(repositoryRoot, ["checkout", "-b", "dev"]);
    await writeWorkspaceFile(repositoryRoot, "Financeiro/a.js", "var value = 1;\r\n");
    git(repositoryRoot, ["add", "."]);
    git(repositoryRoot, ["commit", "-m", "baseline"]);
    await writeWorkspaceFile(repositoryRoot, "Financeiro/a.js", "var value = 2;\r\n");
    await writeWorkspaceFile(fixture.workspacePath, "outside-repository.txt", "ignored\n");
    const agent = await LocalAgent.create(fixture.policyPath);

    const result = await agent.inspectGit({
      workspaceId: "test",
      root: "XPNet/ScriptsAd",
      diffMode: "full",
      paths: [],
      maxDiffBytes: 40_000,
      timeoutMs: 120_000,
    });

    expect(result.root).toBe("XPNet/ScriptsAd");
    expect(result.branch).toBe("dev");
    expect(result.status.map((entry) => entry.path)).toEqual(["Financeiro/a.js"]);
    expect(result.unstaged).toContain("var value = 2;");
    expect(result.unstaged).not.toContain("outside-repository.txt");
  }, 30_000);

  test("isolates sibling repositories inside the same workspace", async () => {
    fixture = await createFixture();
    const firstRoot = path.join(fixture.workspacePath, "first");
    const secondRoot = path.join(fixture.workspacePath, "second");
    await mkdir(firstRoot, { recursive: true });
    await mkdir(secondRoot, { recursive: true });
    initializeGitRepository(firstRoot);
    initializeGitRepository(secondRoot);
    await writeWorkspaceFile(firstRoot, "first.txt", "base first\n");
    await writeWorkspaceFile(secondRoot, "second.txt", "base second\n");
    git(firstRoot, ["add", "."]);
    git(firstRoot, ["commit", "-m", "first baseline"]);
    git(secondRoot, ["add", "."]);
    git(secondRoot, ["commit", "-m", "second baseline"]);
    await writeWorkspaceFile(firstRoot, "first.txt", "changed first\n");
    await writeWorkspaceFile(secondRoot, "second.txt", "changed second\n");
    const agent = await LocalAgent.create(fixture.policyPath);

    const first = await agent.inspectGit({
      workspaceId: "test",
      root: "first",
      diffMode: "full",
      paths: [],
      maxDiffBytes: 40_000,
      timeoutMs: 120_000,
    });
    const second = await agent.inspectGit({
      workspaceId: "test",
      root: "second",
      diffMode: "full",
      paths: [],
      maxDiffBytes: 40_000,
      timeoutMs: 120_000,
    });

    expect(first.status.map((entry) => entry.path)).toEqual(["first.txt"]);
    expect(first.unstaged).toContain("changed first");
    expect(first.unstaged).not.toContain("second.txt");
    expect(second.status.map((entry) => entry.path)).toEqual(["second.txt"]);
    expect(second.unstaged).toContain("changed second");
    expect(second.unstaged).not.toContain("first.txt");
  }, 30_000);

  test("supports none, summary, full and detached HEAD", async () => {
    fixture = await createFixture();
    initializeGitRepository(fixture.workspacePath);
    await writeWorkspaceFile(fixture.workspacePath, "file.txt", "base\n");
    git(fixture.workspacePath, ["add", "."]);
    git(fixture.workspacePath, ["commit", "-m", "baseline"]);
    await writeWorkspaceFile(fixture.workspacePath, "file.txt", "changed content\n");
    const agent = await LocalAgent.create(fixture.policyPath);
    const baseInput = {
      workspaceId: "test",
      root: ".",
      paths: [] as string[],
      maxDiffBytes: 40_000,
      timeoutMs: 120_000,
    };

    const none = await agent.inspectGit({ ...baseInput, diffMode: "none" });
    const summary = await agent.inspectGit({ ...baseInput, diffMode: "summary" });
    const full = await agent.inspectGit({ ...baseInput, diffMode: "full" });
    git(fixture.workspacePath, ["checkout", "--detach", "HEAD"]);
    const detached = await agent.inspectGit({ ...baseInput, diffMode: "none" });

    expect(none.staged).toBe("");
    expect(none.unstaged).toBe("");
    expect(summary.unstaged).toContain("file.txt");
    expect(summary.unstaged).not.toContain("changed content");
    expect(full.unstaged).toContain("changed content");
    expect(detached.branch).toBe("HEAD");
  }, 30_000);

  test("rejects non-Git workspaces", async () => {
    fixture = await createFixture();
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(agent.inspectGit({ workspaceId: "test", root: ".", diffMode: "full", paths: [], maxDiffBytes: 40_000, timeoutMs: 120_000 })).rejects.toMatchObject({
      code: "NOT_GIT_REPOSITORY",
    });
  });

  test("enforces the diff byte limit", async () => {
    fixture = await createFixture({ limits: { maxDiffBytes: 40 } });
    initializeGitRepository(fixture.workspacePath);
    await writeWorkspaceFile(fixture.workspacePath, "file.txt", "base\n");
    git(fixture.workspacePath, ["add", "."]);
    git(fixture.workspacePath, ["commit", "-m", "baseline"]);
    await writeWorkspaceFile(fixture.workspacePath, "file.txt", "x".repeat(500));
    const agent = await LocalAgent.create(fixture.policyPath);

    const result = await agent.inspectGit({
      workspaceId: "test",
      root: ".",
      diffMode: "full",
      paths: [],
      maxDiffBytes: 40,
      timeoutMs: 120_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.unstaged).toContain("...[diff truncated]");
  }, 60_000);

  test("does not put file contents in audit records", async () => {
    fixture = await createFixture();
    initializeGitRepository(fixture.workspacePath);
    await writeWorkspaceFile(fixture.workspacePath, "file.txt", "baseline\n");
    git(fixture.workspacePath, ["add", "."]);
    git(fixture.workspacePath, ["commit", "-m", "baseline"]);
    await writeWorkspaceFile(fixture.workspacePath, "file.txt", "audit-secret-value\n");
    const agent = await LocalAgent.create(fixture.policyPath);

    await agent.inspectGit({ workspaceId: "test", root: ".", diffMode: "full", paths: [], maxDiffBytes: 40_000, timeoutMs: 120_000 });
    const audit = await readFile(path.join(fixture.auditPath, "audit.ndjson"), "utf8");
    expect(audit).not.toContain("audit-secret-value");
  });
});
