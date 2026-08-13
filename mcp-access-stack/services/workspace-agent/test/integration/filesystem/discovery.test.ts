import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import {
  collectAuthorizedFiles,
  listAuthorizedWorkspaceRoots,
} from "../../../src/filesystem/discovery.js";
import { PathSecurity } from "../../../src/path-security.js";
import { WorkspaceRegistry } from "../../../src/workspace-registry.js";
import {
  createFixture,
  type Fixture,
  writeWorkspaceFile,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

jest.setTimeout(15_000);

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("filesystem discovery", () => {
  test("applies authorized roots, blocked paths, globs and stable ordering", async () => {
    fixture = await createFixture({ blockedGlobs: ["blocked/**"] });
    await writeWorkspaceFile(fixture.workspacePath, "src/b.ts", "b\n");
    await writeWorkspaceFile(fixture.workspacePath, "src/a.ts", "a\n");
    await writeWorkspaceFile(fixture.workspacePath, "src/readme.md", "readme\n");
    await writeWorkspaceFile(fixture.workspacePath, "blocked/secret.ts", "secret\n");

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const security = new PathSecurity(workspace);
    const result = await collectAuthorizedFiles(
      workspace,
      security,
      { root: ".", glob: "**/*.ts" },
    );

    expect(security.isSubtreeBlocked("blocked")).toBe(true);
    expect(security.isSubtreeBlocked("src")).toBe(false);
    expect(security.isSubtreeBlocked("node_modules")).toBe(true);
    expect(result).toMatchObject({ truncated: false });
    expect(result.files.map((file) => file.logicalPath)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  test("matches glob against the full workspace-relative logical path", async () => {
    fixture = await createFixture();
    await writeWorkspaceFile(fixture.workspacePath, "repo-a/package.json", "{}\n");

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const security = new PathSecurity(workspace);

    const basenameOnly = await collectAuthorizedFiles(workspace, security, {
      root: "repo-a",
      glob: "package.json",
    });
    expect(basenameOnly.files).toEqual([]);

    const fullLogicalPath = await collectAuthorizedFiles(workspace, security, {
      root: "repo-a",
      glob: "repo-a/package.json",
    });
    expect(fullLogicalPath.files.map((file) => file.logicalPath)).toEqual([
      "repo-a/package.json",
    ]);

    const recursiveGlob = await collectAuthorizedFiles(workspace, security, {
      root: "repo-a",
      glob: "**/package.json",
    });
    expect(recursiveGlob.files.map((file) => file.logicalPath)).toEqual([
      "repo-a/package.json",
    ]);
  });

  test("stops discovery at the configured listing limit", async () => {
    fixture = await createFixture({ limits: { maxListedFiles: 1 } });
    await writeWorkspaceFile(fixture.workspacePath, "src/a.ts", "a\n");
    await writeWorkspaceFile(fixture.workspacePath, "src/b.ts", "b\n");

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const result = await collectAuthorizedFiles(
      workspace,
      new PathSecurity(workspace),
      { root: "src", glob: "**/*.ts" },
    );

    expect(result.truncated).toBe(true);
    expect(result.files.map((file) => file.logicalPath)).toEqual(["src/a.ts"]);
  });

  test("skips operational artifact directories for implicit discovery but allows explicit roots", async () => {
    fixture = await createFixture();
    await writeWorkspaceFile(fixture.workspacePath, "src/code.ts", "source\n");
    await writeWorkspaceFile(fixture.workspacePath, "runtime/report.txt", "runtime\n");
    await writeWorkspaceFile(fixture.workspacePath, "releases/r1/manifest.txt", "release\n");
    await writeWorkspaceFile(fixture.workspacePath, ".runtime-tools/tool/version.txt", "tool\n");

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const security = new PathSecurity(workspace);

    const implicit = await collectAuthorizedFiles(workspace, security, {});
    expect(implicit.files.map((file) => file.logicalPath)).toContain("src/code.ts");
    expect(implicit.files.some((file) => file.logicalPath.startsWith("runtime/"))).toBe(false);
    expect(implicit.files.some((file) => file.logicalPath.startsWith("releases/"))).toBe(false);
    expect(implicit.files.some((file) => file.logicalPath.startsWith(".runtime-tools/"))).toBe(false);

    const explicitRuntime = await collectAuthorizedFiles(
      workspace,
      security,
      { root: "runtime" },
    );
    expect(explicitRuntime.files.map((file) => file.logicalPath)).toEqual([
      "runtime/report.txt",
    ]);
  });
  test("treats explicit dot root like an omitted root", async () => {
    fixture = await createFixture();
    await writeWorkspaceFile(fixture.workspacePath, "src/code.ts", "source\n");
    await writeWorkspaceFile(fixture.workspacePath, "runtime/report.txt", "runtime\n");

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const security = new PathSecurity(workspace);

    const implicit = await collectAuthorizedFiles(workspace, security, {});
    const explicitDot = await collectAuthorizedFiles(workspace, security, { root: "." });

    expect(explicitDot).toEqual(implicit);
    expect(explicitDot.files.map((file) => file.logicalPath)).toEqual(["src/code.ts"]);
  });

  test("requires a concrete root for recursive discovery in aggregate workspaces", async () => {
    fixture = await createFixture({ workspaceKind: "aggregate" });
    await writeWorkspaceFile(fixture.workspacePath, "repo-a/src/a.ts", "a\n");
    await writeWorkspaceFile(fixture.workspacePath, "repo-b/src/b.ts", "b\n");
    await writeWorkspaceFile(fixture.workspacePath, "runtime/report.txt", "runtime\n");

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const security = new PathSecurity(workspace);

    await expect(collectAuthorizedFiles(workspace, security, {})).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(
      collectAuthorizedFiles(workspace, security, { root: "." }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });

    const roots = await listAuthorizedWorkspaceRoots(workspace, security);
    expect(roots).toEqual({ roots: ["repo-a", "repo-b"], truncated: false });

    const bounded = await collectAuthorizedFiles(workspace, security, { root: "repo-a" });
    expect(bounded).toMatchObject({ truncated: false });
    expect(bounded.files.map((file) => file.logicalPath)).toEqual(["repo-a/src/a.ts"]);
  });

  test("truncates discovery when the raw entry budget is exhausted", async () => {
    fixture = await createFixture({ limits: { maxDiscoveryEntries: 2 } });
    await writeWorkspaceFile(fixture.workspacePath, "a.txt", "a\n");
    await writeWorkspaceFile(fixture.workspacePath, "b.txt", "b\n");
    await writeWorkspaceFile(fixture.workspacePath, "c.txt", "c\n");

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const result = await collectAuthorizedFiles(
      workspace,
      new PathSecurity(workspace),
      {},
    );

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(2);
  });

  test("truncates discovery when the directory budget is exhausted", async () => {
    fixture = await createFixture({ limits: { maxDiscoveryDirectories: 1 } });
    await writeWorkspaceFile(fixture.workspacePath, "a/a.txt", "a\n");
    await writeWorkspaceFile(fixture.workspacePath, "b/b.txt", "b\n");

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const result = await collectAuthorizedFiles(
      workspace,
      new PathSecurity(workspace),
      {},
    );

    expect(result.truncated).toBe(true);
    expect(result.files).toEqual([]);
  });
  test("honors cancellation before recursive traversal", async () => {
    fixture = await createFixture();
    await writeWorkspaceFile(fixture.workspacePath, "src/a.ts", "needle\n");

    const registry = await WorkspaceRegistry.load(fixture.policyPath);
    const workspace = registry.get("test");
    const controller = new AbortController();
    controller.abort(new AppError("AGENT_TIMEOUT", "deadline reached"));

    await expect(
      collectAuthorizedFiles(
        workspace,
        new PathSecurity(workspace),
        { root: "." },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });
  });
});
