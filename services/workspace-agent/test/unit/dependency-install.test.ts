import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { LocalAgent } from "../../src/local-agent.js";
import { WorkspaceRegistry } from "../../src/workspace-registry.js";
import { authorizeDependencyRoot, createDependencyInstallRunner, validateDependencyLock, validateDependencyManifest } from "../../src/tasks/dependency-install.js";
import { BackgroundTaskManager } from "../../src/tasks/background-task-manager.js";
import { createFixture, makeWorkspacePolicy, writePolicy, writeWorkspaceFile, type Fixture } from "../support/helpers.js";
import type { WorkspaceDependencyInstallInput } from "@vs-code-gpt/shared";

jest.setTimeout(45_000);
let fixture: Fixture | undefined;
afterEach(async () => { await fixture?.cleanup(); fixture = undefined; });
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const manifest = Buffer.from(JSON.stringify({ name: "editor-fixture", version: "1.0.0", private: true, devDependencies: { "is-number": "7.0.0" } }));
const fakeLock = Buffer.from(JSON.stringify({ lockfileVersion: 3, packages: {
  "": { devDependencies: { "is-number": "7.0.0" } },
  "node_modules/is-number": { version: "7.0.0", resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz", integrity: "sha512-" + "A".repeat(86) + "==" },
} }));
async function setup(enabled = true) {
  fixture = await createFixture({ profile: "full-repo-write", confirmationMode: "trusted-workspace" });
  await writePolicy(fixture.policyPath, [{ ...makeWorkspacePolicy(fixture.workspacePath, { profile: "full-repo-write", confirmationMode: "trusted-workspace" }),
    allowWrites: ["."], allowShell: ["."], allowedShells: ["bash"], ...(enabled ? { dependencyInstallRoots: ["fixtures/editors"] } : {}) }]);
  await writeWorkspaceFile(fixture.workspacePath, "fixtures/editors/package.json", manifest);
  const workspace = (await WorkspaceRegistry.load(fixture.policyPath)).get("test");
  const input: WorkspaceDependencyInstallInput = { workspaceId: "test", root: "fixtures/editors", action: "resolve",
    operationId: randomUUID(), expectedManifestSha256: sha(manifest), expectedLockSha256: null };
  const root = path.join(fixture.workspacePath, input.root);
  const manager = new BackgroundTaskManager({ stateDirectory: path.join(fixture.basePath, "tasks"),
    runner: { start: async () => { throw new Error("Shell runner must never execute typed dependency operations."); } } });
  return { input, workspace, root, manager };
}
function taskInput(input: WorkspaceDependencyInstallInput) {
  return { workspaceId: input.workspaceId, cwd: input.root, shell: "bash" as const,
    operation: "workspace_install_dependencies:" + input.action,
    command: "typed npm " + input.action + " " + input.expectedManifestSha256 + " " + (input.expectedLockSha256 ?? "absent"), timeoutMs: 300_000 };
}
async function fakeNpm(action: WorkspaceDependencyInstallInput["action"], cwd: string) {
  expect(await readFile(path.join(cwd, "package.json"))).toEqual(manifest);
  if (action === "resolve") await writeFile(path.join(cwd, "package-lock.json"), fakeLock);
  else {
    const dir = path.join(cwd, "node_modules/is-number");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "is-number", version: "7.0.0" }));
  }
}
const linux = process.platform === "linux" ? test : test.skip;

describe("isolated dependency metadata validation", () => {
  test("requires private manifest, exact versions and no script/config injection", () => {
    expect(validateDependencyManifest(manifest)).toEqual({ "is-number": "7.0.0" });
    for (const change of [{ private: false }, { scripts: { install: "unsafe" } }, { workspaces: ["*"] },
      { dependencies: { foo: "file:../outside" } }, { dependencies: { foo: "https://example.com/foo.tgz" } },
      { dependencies: { foo: "^1.0.0" } }, { overrides: { foo: "git+https://example.com/foo" } }]) {
      expect(() => validateDependencyManifest(Buffer.from(JSON.stringify({ ...JSON.parse(manifest.toString()), ...change })))).toThrow();
    }
  });
  test("rejects non-registry, linked, unverified and mismatched lock metadata", () => {
    expect(() => validateDependencyLock(fakeLock, manifest)).not.toThrow();
    for (const change of [{ resolved: "https://example.com/foo.tgz" }, { resolved: "file:../outside" },
      { integrity: "sha1-invalid" }, { link: true }]) {
      const lock = JSON.parse(fakeLock.toString());
      Object.assign(lock.packages["node_modules/is-number"], change);
      expect(() => validateDependencyLock(Buffer.from(JSON.stringify(lock)), manifest)).toThrow();
    }
    const lock = JSON.parse(fakeLock.toString());
    lock.packages[""].devDependencies["is-number"] = "6.0.0";
    expect(() => validateDependencyLock(Buffer.from(JSON.stringify(lock)), manifest)).toThrow();
  });
});

describe("typed isolated npm task", () => {
  linux("resolves and installs via distinct persisted IDs, replays exact task without rerunning and refuses a changed identity", async () => {
    const { input, workspace, root, manager } = await setup();
    const run = jest.fn(fakeNpm);
    const first = await manager.startTypedTask(taskInput(input), input.operationId, createDependencyInstallRunner(workspace, input, run), { ownerScope: "owner" });
    expect(first.id).toBe(input.operationId);
    const done = await manager.wait_background_task(first.id, { timeoutMs: 15_000, maxBytes: 4000 }, { ownerScope: "owner" });
    expect(done.task?.state).toBe("succeeded");
    expect(await readFile(path.join(root, "package-lock.json"))).toEqual(fakeLock);
    expect((await manager.getTypedTask(taskInput(input), input.operationId, { ownerScope: "owner" }))?.state).toBe("succeeded");
    expect(await manager.getTypedTask(taskInput(input), input.operationId, { ownerScope: "other" })).toBeNull();
    expect((await manager.startTypedTask(taskInput(input), input.operationId, createDependencyInstallRunner(workspace, input, run), { ownerScope: "owner" })).state).toBe("succeeded");
    expect(run).toHaveBeenCalledTimes(1);
    await expect(manager.startTypedTask({ ...taskInput(input), command: "changed" }, input.operationId, createDependencyInstallRunner(workspace, input, run), { ownerScope: "owner" })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    const install: WorkspaceDependencyInstallInput = { ...input, operationId: randomUUID(), action: "install", expectedLockSha256: sha(fakeLock) };
    await manager.startTypedTask(taskInput(install), install.operationId, createDependencyInstallRunner(workspace, install, run));
    expect((await manager.wait_background_task(install.operationId, { timeoutMs: 15_000, maxBytes: 4000 })).task?.state).toBe("succeeded");
    expect(JSON.parse(await readFile(path.join(root, "node_modules/is-number/package.json"), "utf8")).version).toBe("7.0.0");
    expect(await readFile(path.join(root, "package.json"))).toEqual(manifest);
    expect(await readFile(path.join(root, "package-lock.json"))).toEqual(fakeLock);
    const repeat = { ...install, operationId: randomUUID() };
    await manager.startTypedTask(taskInput(repeat), repeat.operationId, createDependencyInstallRunner(workspace, repeat, run));
    expect((await manager.wait_background_task(repeat.operationId, { timeoutMs: 15_000, maxBytes: 4000 })).task?.state).toBe("failed");
    expect(run).toHaveBeenCalledTimes(2);
  });

  linux("preserves pre-existing task logs when a requested operation ID collides", async () => {
    const { input, workspace, manager } = await setup();
    const state = path.join(fixture!.basePath, "tasks");
    await mkdir(state, { recursive: true });
    const stderr = path.join(state, input.operationId + ".stderr.log");
    await writeFile(stderr, "preserved");
    const run = jest.fn(fakeNpm);
    await expect(manager.startTypedTask(taskInput(input), input.operationId, createDependencyInstallRunner(workspace, input, run))).rejects.toThrow();
    expect(await readFile(stderr, "utf8")).toBe("preserved");
    await expect(lstat(path.join(state, input.operationId + ".stdout.log"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(run).not.toHaveBeenCalled();
  });

  linux("rejects a stale manifest or any extra file without invoking npm", async () => {
    const { input, workspace, root, manager } = await setup();
    const run = jest.fn(fakeNpm);
    const stale = { ...input, expectedManifestSha256: "0".repeat(64) };
    await manager.startTypedTask(taskInput(stale), stale.operationId, createDependencyInstallRunner(workspace, stale, run));
    expect((await manager.wait_background_task(stale.operationId, { timeoutMs: 15_000, maxBytes: 4000 })).task?.state).toBe("failed");
    const changed = { ...input, operationId: randomUUID() };
    await writeFile(path.join(root, ".npmrc"), "registry=https://example.invalid/");
    await manager.startTypedTask(taskInput(changed), changed.operationId, createDependencyInstallRunner(workspace, changed, run));
    expect((await manager.wait_background_task(changed.operationId, { timeoutMs: 15_000, maxBytes: 4000 })).task?.state).toBe("failed");
    expect(run).not.toHaveBeenCalled();
  });

  linux("rechecks the manifest and pinned directory before publishing a lock", async () => {
    const { input, workspace, root, manager } = await setup();
    const run = async (action: WorkspaceDependencyInstallInput["action"], cwd: string) => {
      await fakeNpm(action, cwd);
      await rename(root, root + "-parked");
      await mkdir(root);
      await writeFile(path.join(root, "package.json"), manifest);
    };
    await manager.startTypedTask(taskInput(input), input.operationId, createDependencyInstallRunner(workspace, input, run));
    expect((await manager.wait_background_task(input.operationId, { timeoutMs: 15_000, maxBytes: 4000 })).task?.state).toBe("failed");
    expect(await readdir(root)).toEqual(["package.json"]);
    expect(await readdir(root + "-parked")).toEqual(["package.json"]);
  });

  linux("requires exact policy opt-in, even on a trusted writable workspace", async () => {
    const { input, workspace } = await setup(false);
    await expect(authorizeDependencyRoot(workspace, input)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  const realNpm = process.platform === "linux" && process.env.MCP_TEST_REAL_NPM === "1" ? test : test.skip;
  realNpm("uses the real packaged npm CLI against an isolated public package and replays the operation ID", async () => {
    const { input, root } = await setup();
    const agent = await LocalAgent.create(fixture!.policyPath);
    const started = await agent.workspaceInstallDependencies(input, { ownerScope: "test-owner" });
    expect(started.status).toBe("background_task_started");
    const resolved = await agent.waitBackgroundTask({ workspaceId: "test", id: input.operationId, timeoutMs: 30_000, maxBytes: 4000 }, { ownerScope: "test-owner" });
    if (resolved.task?.state !== "succeeded") throw new Error(JSON.stringify({ state: resolved.task?.state, error: resolved.task?.error, result: resolved.task?.result }));
    const lock = await readFile(path.join(root, "package-lock.json"));
    validateDependencyLock(lock, manifest);
    const replay = await agent.workspaceInstallDependencies(input, { ownerScope: "test-owner" });
    expect(replay).toMatchObject({ status: "background_task_started", task: { id: input.operationId, state: "succeeded" } });
    const install = { ...input, operationId: randomUUID(), action: "install" as const, expectedLockSha256: sha(lock) };
    await agent.workspaceInstallDependencies(install, { ownerScope: "test-owner" });
    const installed = await agent.waitBackgroundTask({ workspaceId: "test", id: install.operationId, timeoutMs: 30_000, maxBytes: 4000 }, { ownerScope: "test-owner" });
    if (installed.task?.state !== "succeeded") throw new Error(JSON.stringify({ state: installed.task?.state, error: installed.task?.error, result: installed.task?.result }));
    expect(JSON.parse(await readFile(path.join(root, "node_modules/is-number/package.json"), "utf8")).version).toBe("7.0.0");
    expect(await readFile(path.join(root, "package.json"))).toEqual(manifest);
  }, 90_000);
});
