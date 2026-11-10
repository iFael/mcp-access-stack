import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "@jest/globals";
import { LocalRepositoryManager } from "../../../src/companion/local-repository-manager.js";

const exec = promisify(execFile);
const roots: string[] = [];
const repositoryId = "repo_00000000-0000-4000-8000-000000000001";
const deviceId = "dev_00000000-0000-4000-8000-000000000004";

async function fixture(onChanged?: () => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "mcp-relocate-")));
  roots.push(root);
  const folder = path.join(root, "ciclo");
  await mkdir(folder);
  await exec("git", ["init", folder]);
  await writeFile(path.join(folder, "saved.txt"), "important local changes");
  const options = {
    stateDirectory: path.join(root, "state"),
    managedRoot: path.join(root, "managed"),
    homeDirectory: root,
    platform: "win32" as const,
    ...(onChanged ? { onChanged } : {}),
  };
  const manager = await LocalRepositoryManager.create(options);
  await manager.setDeviceId(deviceId);
  await manager.bindRepositories([{
    repositoryId, name: "ciclo", path: folder, workspaceId: "ciclo", remoteUrls: [], managed: false,
  }]);
  return { root, folder, manager, options };
}

const input = (oldPath: string, overrides: Record<string, string> = {}) => ({
  repositoryId,
  expectedWorkspaceId: "ciclo",
  expectedPath: oldPath,
  targetWorkspaceId: "recontei-app",
  targetDirectoryName: "Recontei App",
  ...overrides,
});

async function exists(p: string) {
  try { await stat(p); return true; } catch { return false; }
}

describe("native repository materialization relocation", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("validates without writes, then atomically moves the dirty Git tree and preserves its materialization ID", async () => {
    const { root, folder, manager, options } = await fixture();
    const before = manager.listMaterializationAnnouncements()[0]!;
    const destination = path.join(root, "Recontei App");
    const preview = await manager.relocateRepositoryBinding(input(folder));
    expect(preview).toMatchObject({
      before: { workspaceId: "ciclo", path: folder },
      after: { workspaceId: "recontei-app", path: destination },
    });
    expect(await exists(folder)).toBe(true);
    expect(await exists(destination)).toBe(false);

    const moved = await manager.relocateRepositoryBinding(input(folder), undefined, false);
    expect(moved).toEqual(preview);
    expect(await exists(folder)).toBe(false);
    expect(await readFile(path.join(destination, "saved.txt"), "utf8")).toBe("important local changes");
    expect((await exec("git", ["-C", destination, "status", "--porcelain"])).stdout).toContain("saved.txt");
    const after = manager.listMaterializationAnnouncements()[0]!;
    expect(after).toMatchObject({ repositoryId, workspaceId: "recontei-app", path: destination });
    expect(before.repositoryId).toBe(after.repositoryId);
    const reloaded = await LocalRepositoryManager.create(options);
    expect(reloaded.listMaterializationAnnouncements()).toEqual([
      { repositoryId, workspaceId: "recontei-app", path: destination },
    ]);
  });

  it("rejects conflicting workspace IDs, existing directories, invalid names and a stale source without changing files", async () => {
    const { root, folder, manager } = await fixture();
    const second = path.join(root, "second");
    await mkdir(second);
    await exec("git", ["init", second]);
    await manager.bindRepositories([{
      repositoryId: "repo_00000000-0000-4000-8000-000000000002",
      name: "second", path: second, workspaceId: "occupied", remoteUrls: [], managed: false,
    }]);
    await expect(manager.relocateRepositoryBinding(input(folder, { targetWorkspaceId: "occupied" }), undefined, false))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await mkdir(path.join(root, "Recontei App"));
    await expect(manager.relocateRepositoryBinding(input(folder), undefined, false))
      .rejects.toMatchObject({ code: "INVALID_PATH" });
    for (const unsafe of ["..", "../elsewhere", "COM1", "name."]) {
      await expect(manager.relocateRepositoryBinding(input(folder, { targetDirectoryName: unsafe }), undefined, false))
        .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    }
    await expect(manager.relocateRepositoryBinding(input(folder, { expectedPath: second }), undefined, false))
      .rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
    expect(await exists(folder)).toBe(true);
    expect(manager.listBindings().find((value) => value.repositoryId === repositoryId)?.workspaceId).toBe("ciclo");
  });

  it("restores disk path and registry if policy reload fails after the move", async () => {
    let failOnce = false;
    const { root, folder, manager, options } = await fixture(async () => {
      if (failOnce) { failOnce = false; throw new Error("policy reload failed"); }
    });
    failOnce = true;
    await expect(manager.relocateRepositoryBinding(input(folder), undefined, false))
      .rejects.toThrow("policy reload failed");
    expect(await exists(folder)).toBe(true);
    expect(await exists(path.join(root, "Recontei App"))).toBe(false);
    expect(manager.listMaterializationAnnouncements()[0]?.workspaceId).toBe("ciclo");
    const reload = await LocalRepositoryManager.create(options);
    expect(reload.listBindings()[0]?.path).toBe(folder);
  });

  it("rejects cancelled and overlapping relocations without losing the repository", async () => {
    const { root, folder, manager } = await fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(manager.relocateRepositoryBinding(input(folder), abort.signal, false))
      .rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    const [first, second] = await Promise.allSettled([
      manager.relocateRepositoryBinding(input(folder), undefined, false),
      manager.relocateRepositoryBinding(input(folder), undefined, false),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: { code: "AGENT_BUSY" } });
    expect(await readFile(path.join(root, "Recontei App", "saved.txt"), "utf8")).toBe("important local changes");
  });

  it("refuses to move a linked Git worktree with absolute gitdir references", async () => {
    const { root, manager } = await fixture();
    const source = path.join(root, "ciclo");
    await exec("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-m", "initial"]);
    const linked = path.join(root, "linked");
    await exec("git", ["-C", source, "worktree", "add", "-b", "linked-test", linked]);
    const linkedId = "repo_00000000-0000-4000-8000-000000000003";
    await manager.bindRepositories([{ repositoryId: linkedId, name: "linked", path: linked,
      workspaceId: "linked", remoteUrls: [], managed: false }]);
    await expect(manager.relocateRepositoryBinding({
      repositoryId: linkedId, expectedWorkspaceId: "linked", expectedPath: linked,
      targetWorkspaceId: "linked-new", targetDirectoryName: "linked-new",
    }, undefined, false)).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(await exists(linked)).toBe(true);
  });
});
