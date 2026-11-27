import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppError, type WorkspaceDependencyInstallInput } from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../internal-types.js";
import { isContained, PathSecurity } from "../path-security.js";
import { terminateChildProcessTree } from "../process/process-tree.js";
import type { BackgroundTaskRunner } from "./background-task-manager.js";

const MAX_MANIFEST = 64 * 1024;
const MAX_LOCK = 4 * 1024 * 1024;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MANIFEST_KEYS = new Set(["name", "version", "private", "type", "description", "license", "dependencies", "devDependencies"]);
type JsonObject = Record<string, unknown>;
type NpmRunner = (action: WorkspaceDependencyInstallInput["action"], cwd: string, scratch: string,
  timeoutMs: number, signal: AbortSignal, onPid: (pid: number) => void) => Promise<void>;

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("INVALID_ARGUMENT", "Dependency metadata must be a JSON object.");
  }
  return value as JsonObject;
}
function parse(buffer: Buffer): JsonObject {
  try { return object(JSON.parse(buffer.toString("utf8"))); }
  catch { throw new AppError("INVALID_ARGUMENT", "Dependency metadata is not valid JSON."); }
}
function digest(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}
function dependencyMap(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const entries = Object.entries(object(value));
  if (entries.some(([name, version]) => !PACKAGE_NAME.test(name) || typeof version !== "string" || !VERSION.test(version))) {
    throw new AppError("INVALID_ARGUMENT", "Direct dependencies must use exact public registry package names and versions.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
export function validateDependencyManifest(buffer: Buffer): Record<string, string> {
  const manifest = parse(buffer);
  if (manifest.private !== true || Object.keys(manifest).some((key) => !MANIFEST_KEYS.has(key))) {
    throw new AppError("INVALID_ARGUMENT", "Dependency installation requires an isolated private manifest without scripts, workspaces or overrides.");
  }
  if (typeof manifest.name !== "string" || !PACKAGE_NAME.test(manifest.name) ||
      typeof manifest.version !== "string" || !VERSION.test(manifest.version)) {
    throw new AppError("INVALID_ARGUMENT", "Isolated manifest requires a valid package name and exact version.");
  }
  const prod = dependencyMap(manifest.dependencies);
  const dev = dependencyMap(manifest.devDependencies);
  if (Object.keys(prod).some((name) => Object.hasOwn(dev, name))) {
    throw new AppError("INVALID_ARGUMENT", "Dependency names must be unique across manifest sections.");
  }
  const all = { ...prod, ...dev };
  if (Object.keys(all).length < 1 || Object.keys(all).length > 32) {
    throw new AppError("INVALID_ARGUMENT", "Isolated manifest requires between one and 32 direct dependencies.");
  }
  return all;
}
export function validateDependencyLock(buffer: Buffer, manifest: Buffer): void {
  const lock = parse(buffer);
  if (lock.lockfileVersion !== 3) throw new AppError("INVALID_ARGUMENT", "Dependency lock must use npm lockfile version 3.");
  const packages = object(lock.packages);
  const root = object(packages[""]);
  const rootManifest = parse(manifest);
  for (const section of ["dependencies", "devDependencies"]) {
    const expected = dependencyMap(rootManifest[section]);
    const actual = dependencyMap(root[section]);
    if (Object.keys(expected).length !== Object.keys(actual).length ||
        Object.entries(expected).some(([key, value]) => actual[key] !== value)) {
      throw new AppError("INVALID_ARGUMENT", "Dependency lock root does not match the manifest.");
    }
  }
  const entries = Object.entries(packages).filter(([key]) => key !== "");
  if (entries.length > 5000) throw new AppError("INVALID_ARGUMENT", "Dependency lock exceeds the package count limit.");
  for (const [key, raw] of entries) {
    const parts = key.split("node_modules/").slice(1).map((part) => part.replace(/\/$/u, ""));
    const canonical = parts.map((part) => "node_modules/" + part).join("/");
    const entry = object(raw);
    if (!parts.length || canonical !== key || parts.some((part) => !PACKAGE_NAME.test(part)) ||
        entry.link === true || typeof entry.version !== "string" || !VERSION.test(entry.version) ||
        typeof entry.resolved !== "string" || typeof entry.integrity !== "string" ||
        !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity)) {
      throw new AppError("INVALID_ARGUMENT", "Dependency lock contains a non-registry, linked or unverified package.");
    }
    let url: URL;
    try { url = new URL(entry.resolved); }
    catch { throw new AppError("INVALID_ARGUMENT", "Dependency lock contains an invalid tarball URL."); }
    if (url.origin !== "https://registry.npmjs.org" || url.username || url.password || url.search || url.hash ||
        !url.pathname.endsWith(".tgz")) {
      throw new AppError("INVALID_ARGUMENT", "Dependency tarballs must use the public npm HTTPS registry.");
    }
  }
}

export async function authorizeDependencyRoot(workspace: ResolvedWorkspace, input: WorkspaceDependencyInstallInput): Promise<string> {
  if (process.platform !== "linux" || constants.O_DIRECTORY === undefined || constants.O_NOFOLLOW === undefined) {
    throw new AppError("CAPABILITY_UNSUPPORTED", "Isolated dependency publication currently requires Linux pinned directories.");
  }
  if (workspace.permissionProfile !== "full-repo-write" || workspace.confirmationMode !== "trusted-workspace" ||
      workspace.workspaceKind === "aggregate" || !workspace.dependencyInstallRoots?.includes(input.root) ||
      !workspace.allowShell.some((root) => root === "." || input.root === root || input.root.startsWith(root + "/")) ||
      input.root.split("/").some((part) => [".worktrees", ".git", "runtime", ".runtime-private", "node_modules"].includes(part.toLowerCase()))) {
    throw new AppError("PERMISSION_DENIED", "Dependency installation requires an explicitly opted-in trusted workspace subdirectory.");
  }
  const security = new PathSecurity(workspace);
  for (const suffix of ["", "/package.json", "/package-lock.json", "/node_modules"]) {
    security.authorizeWriteLogical(input.root + suffix);
  }
  const authorized = await security.authorizeExisting(input.root, "directory");
  if (authorized.canonicalRelativePath !== input.root || authorized.canonicalPath !== authorized.absolutePath) {
    throw new AppError("INVALID_PATH", "Dependency directory must not traverse links.");
  }
  return authorized.canonicalPath;
}

async function boundedRead(target: string, maximum: number): Promise<Buffer> {
  const namedBefore = await lstat(target);
  if (!namedBefore.isFile() || namedBefore.nlink !== 1 || namedBefore.size > maximum) {
    throw new AppError("INVALID_ARGUMENT", "Dependency metadata must be a bounded regular unlinked file.");
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const first = await handle.stat();
    if (!first.isFile() || first.nlink !== 1 || first.size > maximum ||
        first.dev !== namedBefore.dev || first.ino !== namedBefore.ino) {
      throw new AppError("INVALID_ARGUMENT", "Dependency metadata must be a bounded regular unlinked file.");
    }
    const buffer = Buffer.alloc(first.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) throw new AppError("INVALID_ARGUMENT", "Dependency metadata changed during read.");
      offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
    const last = await handle.stat();
    const named = await lstat(target);
    if (extra.bytesRead || last.size !== first.size || last.mtimeMs !== first.mtimeMs ||
        last.ctimeMs !== first.ctimeMs || named.dev !== last.dev || named.ino !== last.ino ||
        !named.isFile() || named.nlink !== 1) {
      throw new AppError("INVALID_ARGUMENT", "Dependency metadata changed during read.");
    }
    return buffer;
  } finally { await handle.close(); }
}

export function createDependencyInstallRunner(workspace: ResolvedWorkspace, input: WorkspaceDependencyInstallInput,
  runNpm: NpmRunner = executeNpm): BackgroundTaskRunner {
  return {
    async start(task, signal, execution) {
      if (signal.aborted) throw new AppError("OPERATION_CANCELLED", "Dependency installation cancelled.");
      const target = await authorizeDependencyRoot(workspace, input);
      const directory = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let scratch: string | undefined;
      try {
        const pinned = "/proc/self/fd/" + directory.fd;
        const check = async () => {
          if (signal.aborted) throw new AppError("OPERATION_CANCELLED", "Dependency installation cancelled.");
          if (await realpath(pinned) !== target || await authorizeDependencyRoot(workspace, input) !== target) {
            throw new AppError("INVALID_PATH", "Dependency directory changed before publication.");
          }
          const names = (await readdir(pinned)).sort();
          const expected = input.action === "resolve" ? ["package.json"] : ["package-lock.json", "package.json"];
          if (JSON.stringify(names) !== JSON.stringify(expected)) {
            throw new AppError("INVALID_ARGUMENT", "Isolated dependency directory must contain only its exact manifest and optional lock; existing node_modules is never replaced.");
          }
          const manifest = await boundedRead(path.join(pinned, "package.json"), MAX_MANIFEST);
          if (digest(manifest) !== input.expectedManifestSha256) throw new AppError("INVALID_ARGUMENT", "Dependency manifest SHA-256 changed.");
          const direct = validateDependencyManifest(manifest);
          const lock = input.action === "install" ? await boundedRead(path.join(pinned, "package-lock.json"), MAX_LOCK) : undefined;
          if (lock && digest(lock) !== input.expectedLockSha256) throw new AppError("INVALID_ARGUMENT", "Dependency lock SHA-256 changed.");
          if (lock) validateDependencyLock(lock, manifest);
          return { manifest, lock, direct };
        };
        const initial = await check();
        scratch = await mkdtemp("/tmp/mcp-npm-");
        const working = path.join(scratch, "project");
        await mkdir(working, { mode: 0o700 });
        if ((await lstat(working)).dev !== (await directory.stat()).dev) {
          throw new AppError("CAPABILITY_UNSUPPORTED", "Dependency scratch and target must be on the same filesystem.");
        }
        await writeFile(path.join(working, "package.json"), initial.manifest, { flag: "wx", mode: 0o600 });
        if (initial.lock) await writeFile(path.join(working, "package-lock.json"), initial.lock, { flag: "wx", mode: 0o600 });
        await runNpm(input.action, working, scratch, task.timeoutMs, signal, execution.onPid);
        if (digest(await boundedRead(path.join(working, "package.json"), MAX_MANIFEST)) !== input.expectedManifestSha256) {
          throw new AppError("INVALID_ARGUMENT", "npm unexpectedly changed the isolated manifest.");
        }
        const lock = await boundedRead(path.join(working, "package-lock.json"), MAX_LOCK);
        validateDependencyLock(lock, initial.manifest);
        const lockSha = digest(lock);
        if (input.action === "install" && lockSha !== input.expectedLockSha256) {
          throw new AppError("INVALID_ARGUMENT", "npm unexpectedly changed the isolated lock.");
        }
        if (input.action === "install") {
          const modules = path.join(working, "node_modules");
          const info = await lstat(modules);
          if (!info.isDirectory() || info.isSymbolicLink() || await realpath(modules) !== modules) {
            throw new AppError("INVALID_PATH", "npm did not produce a real isolated dependency directory.");
          }
          for (const [name, version] of Object.entries(initial.direct)) {
            const packageFile = path.join(modules, name, "package.json");
            if (!isContained(modules, await realpath(packageFile)) ||
                parse(await boundedRead(packageFile, MAX_MANIFEST)).version !== version) {
              throw new AppError("INVALID_ARGUMENT", "A direct dependency did not resolve to the exact requested version.");
            }
          }
        }
        await check(); // CAS again after all network/process work, before publication.
        if (input.action === "resolve") {
          // Link publication is atomic and cannot overwrite a concurrent lock.
          await link(path.join(working, "package-lock.json"), path.join(pinned, "package-lock.json"));
        } else {
          // The empty destination was proved absent. Nonempty replacement is
          // never overwritten by rename; no recursive removal is performed.
          await rename(path.join(working, "node_modules"), path.join(pinned, "node_modules"));
        }
        if (await realpath(pinned) !== target) {
          throw new AppError("EXECUTION_OUTCOME_UNKNOWN", "Dependency target moved during publication; inspect before retrying.");
        }
        const stdout = JSON.stringify({ action: input.action, root: input.root,
          manifestSha256: input.expectedManifestSha256, lockSha256: lockSha }) + "\n";
        await writeFile(execution.stdoutPath, stdout);
        return { status: "executed", shell: task.shell, cwd: input.root, exitCode: 0, stdout, stderr: "", timedOut: false };
      } finally {
        await directory.close();
        if (scratch) await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

async function executeNpm(action: WorkspaceDependencyInstallInput["action"], cwd: string, scratch: string,
  timeoutMs: number, signal: AbortSignal, onPid: (pid: number) => void): Promise<void> {
  const node = await realpath(process.execPath);
  const npmRoot = path.resolve(path.dirname(node), "../lib/node_modules/npm");
  const cli = path.join(npmRoot, "bin/npm-cli.js");
  const version = parse(await readFile(path.join(npmRoot, "package.json"))).version;
  // The currently shipped npm supports all four native source restrictions.
  // Do not silently run an older CLI which may ignore these flags.
  if (version !== "11.19.1" || await realpath(cli) !== cli) {
    throw new AppError("CAPABILITY_UNSUPPORTED", "The verified npm 11.19.1 runtime is required for bounded installation.");
  }
  const userConfig = path.join(scratch, "user.npmrc");
  const globalConfig = path.join(scratch, "global.npmrc");
  await writeFile(userConfig, "", { flag: "wx", mode: 0o600 });
  await writeFile(globalConfig, "", { flag: "wx", mode: 0o600 });
  const args = ["--max-old-space-size=512", cli, action === "resolve" ? "install" : "ci",
    ...(action === "resolve" ? ["--package-lock-only", "--lockfile-version=3"] : []),
    "--prefix=" + cwd, "--workspaces=false", "--global=false",
    "--ignore-scripts", "--no-audit", "--no-fund", "--no-bin-links",
    "--allow-git=none", "--allow-remote=none", "--allow-file=none", "--allow-directory=none",
    "--registry=https://registry.npmjs.org/", "--strict-ssl=true", "--include=dev",
    "--userconfig=" + userConfig, "--globalconfig=" + globalConfig, "--cache=" + path.join(scratch, "cache"),
    "--fetch-retries=1", "--fetch-timeout=30000", "--loglevel=error"];
  if (signal.aborted) throw new AppError("OPERATION_CANCELLED", "Dependency installation cancelled.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(node, args, { cwd, shell: false, detached: true, windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: { PATH: path.dirname(node), HOME: scratch, TMPDIR: scratch, LANG: "C", CI: "true" } });
    let termination: Promise<void> | undefined;
    let timedOut = false;
    const stop = () => {
      termination ??= terminateChildProcessTree(child);
      void termination.catch(() => undefined);
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timer.unref();
    signal.addEventListener("abort", stop, { once: true });
    if (child.pid) onPid(child.pid);
    if (signal.aborted) stop();
    child.once("error", () => { clearTimeout(timer); signal.removeEventListener("abort", stop);
      reject(new AppError("SHELL_FAILED", "The verified npm runtime could not start.")); });
    child.once("close", async (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      try {
        await termination;
        if (signal.aborted) throw new AppError("OPERATION_CANCELLED", "Dependency installation cancelled before publication.");
        if (timedOut) throw new AppError("AGENT_TIMEOUT", "Dependency installation exceeded its bounded deadline.");
        if (code !== 0) throw new AppError("SHELL_FAILED", "The bounded npm command failed; the target was not published.");
        resolve();
      } catch (error) { reject(error); }
    });
  });
}
