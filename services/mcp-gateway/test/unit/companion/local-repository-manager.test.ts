import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { assertSourceControlCapability, policyFileSchema } from "@vs-code-gpt/shared";
import { LocalAgent } from "@vs-code-gpt/local-agent";
import { LocalRepositoryManager, parseGitHubAccountOwners, withGlobalGitHubRepositoryCreatePolicy } from "../../../src/companion/local-repository-manager.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

describe("LocalRepositoryManager binding lifecycle", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("exposes an authorized computer home even without Git bindings", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-v3-computer-root-")));
    temporaryRoots.push(root);
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(root, "state"),
      managedRoot: path.join(root, "managed"),
      homeDirectory: root,
      platform: "win32",
      exposeComputerWorkspace: true,
      computerRoots: [root],
      githubAccountOwners: ["iFael"],
    });
    const policy = await manager.buildPolicy();
    expect(policy?.workspaces).toHaveLength(1);
    expect(policy?.workspaces[0]).toMatchObject({
      name: "Local computer",
      rootPath: root,
      workspaceKind: "aggregate",
      permissionProfile: "full-repo-write",
      allowedRoots: ["."],
      allowShell: ["."],
      allowWrites: ["."],
    });
    expect(policy?.workspaces[0]?.sourceControl).toMatchObject({
      capabilities: expect.arrayContaining(["git.branch.write", "git.commit.write"]),
      accountOwners: [],
      additionalRepositories: [],
    });
    expect(policy?.workspaces[0]?.sourceControl?.capabilities).not.toContain("github.repository.create");
    expect((await manager.listWorkspaceSummaries())[0]?.workspaceKind).toBe("aggregate");
    expect(manager.listMaterializationAnnouncements()).toEqual([]);
    expect(policyFileSchema.parse(policy)).toEqual(policy);
  });

  it("grants filesystem and Git access to the computer without repository bindings, while protecting secrets", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-v3-host-access-")));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "Documents"), { recursive: true });
    await mkdir(path.join(root, "MCP V3", "Local", "private"), { recursive: true });
    await mkdir(path.join(root, ".ssh"), { recursive: true });
    await writeFile(path.join(root, "Documents", "note.txt"), "available without Git\\n");
    const unregisteredGit = path.join(root, "Documents", "new-project");
    await mkdir(unregisteredGit);
    await execFileAsync("git", ["init", unregisteredGit]);
    await execFileAsync("git", ["-C", unregisteredGit, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
    await writeFile(path.join(root, "MCP V3", "Local", "private", "refresh.dat"), "not-readable");
    await writeFile(path.join(root, ".ssh", "config"), "not-readable");
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(root, "state"),
      managedRoot: path.join(root, "managed"),
      homeDirectory: root,
      exposeComputerWorkspace: true,
      computerRoots: [root],
    });
    const policy = (await manager.buildPolicy())!;
    const workspaceId = policy.workspaces[0]!.id;
    const agent = await LocalAgent.createFromPolicy(policy);
    expect((await agent.listWorkspaceRoots({ workspaceId })).roots).toContain("Documents");
    expect((await agent.readFile({ workspaceId, path: "Documents/note.txt" })).content).toBe("available without Git\\n");
    for (const blocked of ["MCP V3/Local/private/refresh.dat", ".ssh/config"]) {
      await expect(agent.readFile({ workspaceId, path: blocked })).rejects.toMatchObject({ code: "BLOCKED_PATH" });
    }
    await expect(agent.readFile({ workspaceId, path: "../elsewhere.txt" })).rejects.toMatchObject({
      code: expect.stringMatching(/INVALID_PATH|PATH_OUTSIDE_WORKSPACE/u),
    });
    expect(() => assertSourceControlCapability({
      policy: policy.workspaces[0]!, capability: "git.branch.write", mutation: true,
    })).not.toThrow();
    const inspected = await agent.inspectGit({ workspaceId, root: "Documents/new-project" });
    expect(inspected).toMatchObject({ branch: expect.any(String) });
    await expect(agent.inspectGit({ workspaceId, root: "Documents" })).rejects.toMatchObject({
      code: "NOT_GIT_REPOSITORY",
    });
  });

  it("makes every connected computer root available without registering each repository", async () => {
    const home = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-v3-home-drive-")));
    const otherDrive = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-v3-other-drive-")));
    temporaryRoots.push(home, otherDrive);
    const project = path.join(otherDrive, "unregistered-project");
    await mkdir(project);
    await execFileAsync("git", ["init", project]);
    await execFileAsync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]);
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(home, "state"),
      managedRoot: path.join(home, "managed"),
      homeDirectory: home,
      exposeComputerWorkspace: true,
      computerRoots: [home, otherDrive],
    });
    const policy = (await manager.buildPolicy())!;
    expect(policy.workspaces).toHaveLength(2);
    expect(new Set(policy.workspaces.map((workspace) => workspace.id)).size).toBe(2);
    expect(manager.listBindings()).toEqual([]);
    const agent = await LocalAgent.createFromPolicy(policy);
    const workspace = policy.workspaces.find((candidate) => candidate.rootPath === otherDrive)!;
    await expect(agent.inspectGit({ workspaceId: workspace.id, root: "unregistered-project" }))
      .resolves.toMatchObject({ branch: expect.any(String) });
  });

  it("automatically exposes the system drive on a real Windows host", async () => {
    if (process.platform !== "win32") return;
    const stateRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-v3-real-drives-")));
    temporaryRoots.push(stateRoot);
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(stateRoot, "state"),
      managedRoot: path.join(stateRoot, "managed"),
      homeDirectory: os.homedir(),
      exposeComputerWorkspace: true,
    });
    const systemDrive = path.win32.parse(os.homedir()).root.toLowerCase();
    expect((await manager.buildPolicy())!.workspaces.some((workspace) =>
      workspace.workspaceKind === "aggregate" && workspace.rootPath.toLowerCase() === systemDrive,
    )).toBe(true);
  });

  it("preserves folder and shell access after a bound repository loses .git", async () => {
    const fixture = await createGitFixture();
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
      exposeComputerWorkspace: true,
      computerRoots: [fixture.root],
    });
    await manager.bindRepositories([repositoryBinding(fixture.repository)]);
    await rm(path.join(fixture.repository, ".git"), { recursive: true });
    const policy = await manager.buildPolicy();
    const folder = policy?.workspaces.find((workspace) => workspace.id === "project");
    expect(folder).toMatchObject({
      rootPath: fixture.repository,
      allowWrites: ["."],
      allowShell: ["."],
      workspaceKind: "repository",
    });
    expect(folder?.sourceControl).toBeUndefined();
    expect(policy?.workspaces).toHaveLength(2);
    expect(manager.listBindings()).toHaveLength(1);
    expect(manager.listMaterializationAnnouncements()).toHaveLength(1);
    await writeFile(path.join(fixture.repository, ".git"), "gitdir: missing\\n");
    const brokenGitPolicy = await manager.buildPolicy();
    expect(brokenGitPolicy?.workspaces.find((workspace) => workspace.id === "project")?.sourceControl).toBeUndefined();
    expect(brokenGitPolicy?.workspaces.find((workspace) => workspace.id === "project")?.allowShell).toEqual(["."]);
  });

  it("skips broken .git markers and continues repository discovery", async () => {
    const root = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "mcp-v3-repository-discovery-")),
    );
    temporaryRoots.push(root);
    const valid = path.join(root, "valid");
    const broken = path.join(root, "broken");
    await mkdir(valid, { recursive: true });
    await mkdir(broken, { recursive: true });
    await execFileAsync("git", ["init", valid]);
    await writeFile(path.join(broken, ".git"), "gitdir: missing\n", "utf8");

    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(root, "state"),
      managedRoot: path.join(root, "managed"),
      homeDirectory: root,
    });

    const discovered = await manager.discoverLocalRepositories({
      root,
      maxDepth: 3,
    });

    expect(discovered.repositories.map((repository) => repository.path)).toEqual([
      await realpath(valid),
    ]);
  });

  it("validates bindings in dry-run mode without persisting state", async () => {
    const fixture = await createGitFixture();
    const onChanged = jest.fn(async () => undefined);
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
      onChanged,
    });

    const binding = repositoryBinding(fixture.repository);
    const prepared = await manager.bindRepositories([binding], undefined, true);

    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      repositoryId: binding.repositoryId,
      workspaceId: binding.workspaceId,
      path: fixture.repository,
    });
    expect(manager.listBindings()).toEqual([]);
    expect(onChanged).not.toHaveBeenCalled();

    const reloaded = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
    });
    expect(reloaded.listBindings()).toEqual([]);
  });

  it("persists one binding and keeps rebinding idempotent", async () => {
    const fixture = await createGitFixture();
    const onChanged = jest.fn(async () => undefined);
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
      onChanged,
    });
    const binding = repositoryBinding(fixture.repository);

    await manager.bindRepositories([binding]);
    await manager.bindRepositories([binding]);

    expect(manager.listBindings()).toHaveLength(1);
    expect(manager.listBindings()[0]).toMatchObject({
      repositoryId: binding.repositoryId,
      workspaceId: binding.workspaceId,
      path: fixture.repository,
    });

    const reloaded = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
    });
    expect(reloaded.listBindings()).toHaveLength(1);
    expect(reloaded.listBindings()[0]).toMatchObject({
      repositoryId: binding.repositoryId,
      workspaceId: binding.workspaceId,
      path: fixture.repository,
    });
  });

  it("resolves the canonical MCP Access Stack root from a persisted GitHub binding", async () => {
    const fixture = await createGitFixture();
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
    });
    const binding = {
      ...repositoryBinding(fixture.repository),
      name: "mcp-access-stack",
      workspaceId: "mcp-access-stack-local-test",
      remoteUrls: ["https://github.com/iFael/mcp-access-stack.git"],
    };

    expect(manager.resolveCanonicalStackRoot()).toBeUndefined();
    await manager.bindRepositories([binding]);
    expect(manager.resolveCanonicalStackRoot()).toBe(fixture.repository);
  });

  it("rebinds the same repository to a new workspace id without keeping the old binding", async () => {
    const fixture = await createGitFixture();
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
    });
    const original = repositoryBinding(fixture.repository);
    const migrated = {
      ...original,
      workspaceId: "project-local-deadbeef",
    };

    await manager.bindRepositories([original]);
    const rebound = await manager.bindRepositories([migrated]);

    expect(rebound).toHaveLength(1);
    expect(rebound[0]).toMatchObject({
      repositoryId: original.repositoryId,
      workspaceId: migrated.workspaceId,
      path: fixture.repository,
    });
    expect(manager.listBindings()).toEqual([
      expect.objectContaining({
        repositoryId: original.repositoryId,
        workspaceId: migrated.workspaceId,
        path: fixture.repository,
      }),
    ]);
  });

  it("copies a repository into the managed root only after dry-run validation", async () => {
    const fixture = await createGitFixture();
    await writeFile(path.join(fixture.repository, "local.txt"), "dirty working tree\n", "utf8");
    const managedRoot = path.join(fixture.root, "managed");
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot,
      homeDirectory: fixture.root,
    });
    const binding = repositoryBinding(fixture.repository);

    const prepared = await manager.bindRepositories(
      [binding],
      undefined,
      true,
      "copy-to-managed-root",
    );
    expect(prepared[0]?.path).toContain(managedRoot);
    await expect(stat(prepared[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });

    const bound = await manager.bindRepositories(
      [binding],
      undefined,
      false,
      "copy-to-managed-root",
    );
    expect(bound[0]).toMatchObject({
      repositoryId: binding.repositoryId,
      managed: true,
      path: prepared[0]!.path,
    });
    await expect(readFile(path.join(bound[0]!.path, "local.txt"), "utf8"))
      .resolves.toBe("dirty working tree\n");
    expect(manager.listBindings()[0]?.path).toBe(bound[0]!.path);
  });

  it("removes a managed copy when runtime reload fails", async () => {
    const fixture = await createGitFixture();
    const managedRoot = path.join(fixture.root, "managed");
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot,
      homeDirectory: fixture.root,
      onChanged: async () => {
        throw new Error("reload failed");
      },
    });
    const binding = repositoryBinding(fixture.repository);
    const prepared = await manager.bindRepositories(
      [binding],
      undefined,
      true,
      "copy-to-managed-root",
    );

    await expect(
      manager.bindRepositories(
        [binding],
        undefined,
        false,
        "copy-to-managed-root",
      ),
    ).rejects.toThrow("reload failed");

    expect(manager.listBindings()).toEqual([]);
    await expect(stat(prepared[0]!.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes a cloud repository into the managed root from a safe HTTPS remote", async () => {
    const fixture = await createCloneRemoteFixture();
    const gitConfigPath = path.join(fixture.root, "gitconfig");
    await writeFile(
      gitConfigPath,
      `[url "${pathToFileURL(fixture.remoteRoot + path.sep).href}"]\n\tinsteadOf = https://fixture.invalid/\n`,
      "utf8",
    );
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
      gitEnvironment: {
        GIT_CONFIG_GLOBAL: gitConfigPath,
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    const input = {
      repositoryId: "repo_00000000-0000-4000-8000-000000000010",
      name: "cloud-project",
      remoteUrls: ["https://fixture.invalid/project.git"],
    };

    const prepared = await manager.materializeRepositoryFromCloud(
      input,
      undefined,
      true,
    );
    await expect(stat(prepared.path)).rejects.toMatchObject({ code: "ENOENT" });

    const materialized = await manager.materializeRepositoryFromCloud(input);
      expect(materialized).toMatchObject({
        repositoryId: input.repositoryId,
        workspaceId: prepared.workspaceId,
        path: prepared.path,
        managed: true,
      });
      await expect(readFile(path.join(materialized.path, "tracked.txt"), "utf8"))
        .resolves.toBe("tracked\n");
      await expect(
        execFileAsync("git", ["-C", materialized.path, "remote", "get-url", "origin"]),
      ).resolves.toMatchObject({
        stdout: expect.stringContaining("https://fixture.invalid/project.git"),
      });

    const again = await manager.materializeRepositoryFromCloud(input);
    expect(again.path).toBe(materialized.path);
    expect(manager.listBindings()).toHaveLength(1);
  }, 15_000);

  it("rejects unsafe Git transports for cloud materialization", async () => {
    const fixture = await createGitFixture();
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
    });

    await expect(manager.materializeRepositoryFromCloud({
      repositoryId: "repo_00000000-0000-4000-8000-000000000011",
      name: "unsafe",
      remoteUrls: ["ext::sh -c touch /tmp/should-not-run"],
    }, undefined, true)).rejects.toThrow(
      "no supported HTTPS or SSH remote",
    );
  });

  it("fails closed on synchronization when the working tree is dirty", async () => {
    const fixture = await createGitFixture();
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
    });
    const binding = repositoryBinding(fixture.repository);
    await manager.bindRepositories([binding]);
    await writeFile(path.join(fixture.repository, "dirty.txt"), "dirty\n", "utf8");

    await expect(manager.syncRepository({
      repositoryId: binding.repositoryId,
      mode: "status",
    })).resolves.toMatchObject({
      repositoryId: binding.repositoryId,
      status: "dirty",
    });

    for (const mode of ["fetch", "pull-fast-forward", "push"] as const) {
      await expect(manager.syncRepository({
        repositoryId: binding.repositoryId,
        mode,
      })).resolves.toMatchObject({
        repositoryId: binding.repositoryId,
        status: "blocked",
        detail: expect.stringContaining("local changes"),
      });
    }
  }, 15_000);

  it("automatically exposes WSL alongside PowerShell and CMD on Windows", async () => {
    const fixture = await createGitFixture();
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
      platform: "win32",
    });
    await manager.bindRepositories([repositoryBinding(fixture.repository)]);

    const policy = await manager.buildPolicy();
    expect(policy?.workspaces[0]?.allowedShells).toEqual(["powershell", "cmd", "wsl"]);
    const workspaces = await manager.listWorkspaceSummaries();
    expect(workspaces[0]?.allowedShells).toEqual(["powershell", "cmd", "wsl"]);
  }, 15_000);

  it("advertises native POSIX shells on Linux and macOS", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const fixture = await createGitFixture();
      const manager = await LocalRepositoryManager.create({
        stateDirectory: path.join(fixture.root, "state"),
        managedRoot: path.join(fixture.root, "managed"),
        homeDirectory: fixture.root,
        platform,
      });
      await manager.bindRepositories([repositoryBinding(fixture.repository)]);
      const workspaces = await manager.listWorkspaceSummaries();
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0]?.allowedShells).toEqual(["sh", "bash"]);
    }
  }, 15_000);

  it("advertises repository-scoped typed source-control capabilities", async () => {
    const fixture = await createGitFixture();
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
    });
    await manager.bindRepositories([repositoryBinding(fixture.repository)]);

    const policy = await manager.buildPolicy();
    expect(policy?.workspaces[0]?.sourceControl).toEqual({
      capabilities: [
        "git.branch.write",
        "git.index.write",
        "git.commit.write",
        "git.merge.write",
        "git.remote.push",
        "github.repository.read",
        "github.pull_request.read",
        "github.pull_request.create",
        "github.pull_request.close",
        "github.pull_request.merge",
        "github.issue.write",
      ],
      accountOwners: [],
      additionalRepositories: [],
    });
    expect(policy?.workspaces[0]?.sourceControl?.capabilities).not.toContain(
      "github.repository.create",
    );
  }, 15_000);

  it("validates the configured global owner allowlist and fails closed", () => {
    expect(parseGitHubAccountOwners(undefined)).toEqual([]);
    expect(parseGitHubAccountOwners("  iFael, example-org  ")).toEqual(["iFael", "example-org"]);
    for (const invalid of ["*", "iFael,", "iFael,IFAEL", "iFael/other", "-owner"]) {
      expect(() => parseGitHubAccountOwners(invalid)).toThrow();
    }
  });

  it("applies the global owner to current and future imported repositories only when configured", async () => {
    const fixture = await createGitFixture();
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
      githubAccountOwners: ["iFael"],
    });
    const initial = repositoryBinding(fixture.repository);
    await manager.bindRepositories([initial]);
    const initialPolicy = await manager.buildPolicy();
    expect(initialPolicy?.workspaces[0]?.sourceControl?.capabilities).toContain("github.repository.create");
    expect(initialPolicy?.workspaces[0]?.sourceControl?.accountOwners).toEqual(["iFael"]);

    const nextRepo = path.join(fixture.root, "future-project");
    await mkdir(nextRepo);
    await execFileAsync("git", ["init", nextRepo]);
    await manager.bindRepositories([{
      ...initial,
      repositoryId: "repo_00000000-0000-4000-8000-000000000002",
      name: "future-project",
      workspaceId: "future-project",
      path: nextRepo,
    }]);
    const updated = await manager.buildPolicy();
    expect(updated?.workspaces).toHaveLength(2);
    for (const workspace of updated!.workspaces) {
      expect(workspace.sourceControl?.capabilities).toContain("github.repository.create");
      expect(workspace.sourceControl?.accountOwners).toEqual(["iFael"]);
      expect(workspace.sourceControl?.additionalRepositories).toEqual([]);
      expect(() => assertSourceControlCapability({
        policy: {
          permissionProfile: workspace.permissionProfile,
          ...(workspace.sourceControl === undefined ? {} : { sourceControl: workspace.sourceControl }),
        },
        capability: "github.repository.create",
        accountOwner: "iFael",
        mutation: true,
      })).not.toThrow();
      expect(() => assertSourceControlCapability({
        policy: {
          permissionProfile: workspace.permissionProfile,
          ...(workspace.sourceControl === undefined ? {} : { sourceControl: workspace.sourceControl }),
        },
        capability: "github.repository.create",
        accountOwner: "unapproved-org",
        mutation: true,
      })).toThrow();
    }
  }, 15_000);

  it("grants create on primary/managed workspaces without changing other capabilities", () => {
    const base = policyFileSchema.parse({
      version: 1,
      workspaces: [{
        id: "primary",
        name: "primary",
        rootPath: ".",
        enabled: true,
        permissionProfile: "full-repo-write" as const,
        allowedRoots: ["."],
        blockedGlobs: [],
        limits: {
          maxFileBytes: 1000, maxSearchResults: 10, maxSearchSnippetBytes: 100,
          maxDiffBytes: 1000, maxListedFiles: 100,
        },
        allowWrites: ["."],
        allowShell: ["."],
        allowedShells: ["bash" as const],
        sourceControl: {
          capabilities: ["github.repository.read" as const],
          accountOwners: ["ExistingOrg"],
          additionalRepositories: ["ExistingOrg/other"],
        },
      }],
    });
    const updated = withGlobalGitHubRepositoryCreatePolicy(base, ["iFael"]);
    expect(updated.workspaces[0]?.sourceControl).toEqual({
      capabilities: ["github.repository.read", "github.repository.create"],
      accountOwners: ["ExistingOrg", "iFael"],
      additionalRepositories: ["ExistingOrg/other"],
    });
    expect(withGlobalGitHubRepositoryCreatePolicy(updated, ["iFael"])).toEqual(updated);
    expect(withGlobalGitHubRepositoryCreatePolicy(base, [])).toEqual(base);
    expect(() => assertSourceControlCapability({
      policy: {
        permissionProfile: base.workspaces[0]!.permissionProfile,
        ...(base.workspaces[0]!.sourceControl === undefined ? {} : { sourceControl: base.workspaces[0]!.sourceControl }),
      },
      capability: "github.repository.create",
      accountOwner: "iFael",
      mutation: true,
    })).toThrow();
  });

  it("restores the previous persisted state when runtime reload fails", async () => {
    const fixture = await createGitFixture();
    const onChanged = jest.fn(async () => {
      throw new Error("reload failed");
    });
    const manager = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
      onChanged,
    });

    await expect(
      manager.bindRepositories([repositoryBinding(fixture.repository)]),
    ).rejects.toThrow("reload failed");

    expect(manager.listBindings()).toEqual([]);
    const reloaded = await LocalRepositoryManager.create({
      stateDirectory: path.join(fixture.root, "state"),
      managedRoot: path.join(fixture.root, "managed"),
      homeDirectory: fixture.root,
    });
    expect(reloaded.listBindings()).toEqual([]);
  });
});

async function createGitFixture(): Promise<{
  root: string;
  repository: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-repository-manager-"));
  temporaryRoots.push(root);
  const repository = path.join(root, "project");
  await mkdir(repository, { recursive: true });
  await execFileAsync("git", ["init", repository]);
  return {
    root: await realpath(root),
    repository: await realpath(repository),
  };
}

async function createCloneRemoteFixture(): Promise<{
  root: string;
  remoteRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-clone-remote-"));
  temporaryRoots.push(root);
  const source = path.join(root, "source");
  const remoteRoot = path.join(root, "remotes");
  const bare = path.join(remoteRoot, "project.git");
  await mkdir(source, { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await execFileAsync("git", ["init", source]);
  await writeFile(path.join(source, "tracked.txt"), "tracked\n", "utf8");
  await execFileAsync("git", ["-C", source, "add", "tracked.txt"]);
  await execFileAsync("git", [
    "-C", source,
    "-c", "user.name=MCP V3 Test",
    "-c", "user.email=mcp-v3@example.invalid",
    "commit", "-m", "initial",
  ]);
  await execFileAsync("git", ["clone", "--bare", source, bare]);
  return { root, remoteRoot };
}

function repositoryBinding(repository: string) {
  return {
    repositoryId: "repo_00000000-0000-4000-8000-000000000001",
    name: "project",
    path: repository,
    workspaceId: "project",
    remoteUrls: [],
    managed: false,
  };
}
