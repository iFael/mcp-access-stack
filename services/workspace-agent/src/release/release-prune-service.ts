import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AppError,
  pruneReleasesInputSchema,
  pruneReleasesResultSchema,
  windowsExecutionNodeStateSchema,
  type PruneReleasesInput,
  type PruneReleasesResult,
} from "@vs-code-gpt/shared";

const execFile = promisify(execFileCallback);
const SHA = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const RELEASE_ID = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?$/u;
const STAGE_ID = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9][A-Za-z0-9.-]*)?\.[A-Za-z0-9]{8}$/u;

type PruneOptions = {
  root: string;
  activeTasks: () => Promise<boolean>;
  processes?: () => Promise<string>;
  mountPoints?: () => Promise<string[]>;
  signal?: AbortSignal;
};
const deny = (message: string): never => {
  throw new AppError("PERMISSION_DENIED", message);
};
const conflict = (message: string): never => {
  throw new AppError("EXECUTION_STATE_INVALID", message);
};

/**
 * Scope-limited release reclamation. Never takes shell, paths, or glob patterns
 * from the caller. Uncertain locks remain in place for manual reconciliation.
 */
export class ReleasePruneService {
  constructor(private readonly options: PruneOptions) {}

  async prune(raw: PruneReleasesInput): Promise<PruneReleasesResult> {
    const input = pruneReleasesInputSchema.parse(raw);
    if (this.options.signal?.aborted) throw new AppError("OPERATION_CANCELLED", "Release prune was cancelled.");
    const root = path.resolve(this.options.root);
    await this.requirePhysicalDirectory(root, root);
    for (const child of ["releases", "staging", "state"]) {
      await this.requirePhysicalDirectory(path.join(root, child), path.join(root, child));
    }
    const stateFile = path.join(root, "state", "lifecycle-state.v1.json");
    const stateInfo = await lstat(stateFile);
    if (!stateInfo.isFile() || stateInfo.isSymbolicLink()) deny("Release lifecycle state is not a physical file.");
    const rawState = await readFile(stateFile);
    const stateSha256 = SHA(rawState);
    const state = windowsExecutionNodeStateSchema.parse(JSON.parse(rawState.toString("utf8")));
    if (input.expectedStateSha256 && input.expectedStateSha256 !== stateSha256) {
      conflict("Release lifecycle state changed since the prune plan.");
    }
    const active = state.active;
    const previous = state.previous;
    if (!active || !previous) throw new AppError("PERMISSION_DENIED", "Pruning requires active and previous releases.");
    const protectedIds = new Set(
      [active.releaseId, previous.releaseId, state.candidate?.releaseId].filter((v): v is string => !!v),
    );
    const receiptRoot = path.join(root, "state", "release-prune-receipts");
    const fingerprint = SHA(JSON.stringify({
      ...(input.selection ? { selection: input.selection } : {}),
      targets: input.targets,
      expectedStateSha256: input.expectedStateSha256,
      ...(input.expectedPlanSha256 ? { expectedPlanSha256: input.expectedPlanSha256 } : {}),
    }));
    const receiptFile = path.join(receiptRoot, input.operationId + ".json");
    if (!input.dryRun) {
      if (this.options.signal?.aborted) throw new AppError("OPERATION_CANCELLED", "Release prune was cancelled.");
      const receiptInfo = await lstat(receiptRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (receiptInfo) await this.requirePhysicalDirectory(receiptRoot, receiptRoot);
      const existing = await readFile(receiptFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (existing !== null) {
        const parsed = JSON.parse(existing) as { fingerprint?: string; result?: unknown };
        if (parsed.fingerprint !== fingerprint) conflict("Prune operationId was reused with different input.");
        return pruneReleasesResultSchema.parse(parsed.result);
      }
    }

    if (await this.options.activeTasks()) deny("Pruning is unavailable while background tasks are active.");
    const ps = await (this.options.processes ?? runningProcessArguments)();
    const mounts = await (this.options.mountPoints ?? mountedPaths)();
    const entries = await readdir(root, { withFileTypes: true });
    const current = await realpath(path.join(root, "current"));
    if (current !== path.join(root, "releases", active.releaseId)) {
      deny("Current symlink does not match the active release.");
    }
    const selected = input.selection === "eligible"
      ? await this.selectEligible(root, protectedIds)
      : input.targets!;
    const planSha256 = input.selection === "eligible"
      ? SHA(JSON.stringify({ stateSha256, targets: selected })) : undefined;
    if (!input.dryRun && input.selection === "eligible" &&
        input.expectedPlanSha256 !== planSha256) {
      conflict("Eligible release inventory changed since the dry-run plan.");
    }
    const resultItems: PruneReleasesResult["items"] = [];
    const targets: string[] = [];
    for (const target of selected) {
      const release = target.kind === "release";
      if (!(release ? RELEASE_ID : STAGE_ID).test(target.name) ||
          target.name.startsWith(".") || target.name.includes("..")) {
        deny("Prune target has an invalid generated release name.");
      }
      const releaseId = release ? target.name : target.name.slice(0, -9);
      if (protectedIds.has(releaseId)) deny("Prune target references a protected release.");
      const parent = path.join(root, release ? "releases" : "staging");
      const absolute = path.join(parent, target.name);
      if (await realpath(parent) !== parent) deny("Prune parent is not canonical.");
      const metadata = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!metadata || !metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new AppError("PERMISSION_DENIED", "Prune target is absent or is not a physical directory.");
      }
      if (metadata.dev !== (await lstat(parent)).dev) deny("Prune target is on an unexpected filesystem.");
      if (ps.includes(absolute)) deny("Prune target is referenced by a running process.");
      if (mounts.some(mount => mount === absolute || mount.startsWith(absolute + path.sep))) {
        deny("Prune target contains an active mountpoint.");
      }
      const siblings = await readdir(parent, { withFileTypes:true });
      if (siblings.some(sibling => sibling.isSymbolicLink())) deny("Release parent has unrecognized symlink references.");
      if (entries.some((entry) => entry.isSymbolicLink() && entry.name !== "current")) {
        // An unknown top-level symlink could reference an old runtime. Fail closed.
        deny("An unrecognized installation symlink requires review.");
      }
      if (current === absolute) deny("Current runtime cannot be pruned.");
      resultItems.push({ kind: target.kind, name: target.name, status: "eligible" });
      targets.push(absolute);
    }
    const planned = pruneReleasesResultSchema.parse({
      operationId: input.operationId, status: "planned", stateSha256,
      ...(planSha256 ? { planSha256 } : {}), items: resultItems,
    });
    if (input.dryRun) return planned;
    if (targets.length === 0) {
      return pruneReleasesResultSchema.parse({ ...planned, status: "completed" });
    }

    await mkdir(receiptRoot, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await this.requirePhysicalDirectory(receiptRoot, receiptRoot);
    const lockFile = path.join(root, "state", "release-prune.lock");
    const handle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") conflict("Another prune or unreconciled prune lock exists.");
        throw error;
      });
    // A crash leaves the lock in place deliberately: do not retry blindly.
    let success = false;
    try {
      await handle.writeFile(JSON.stringify({ operationId: input.operationId, fingerprint }));
      if (this.options.signal?.aborted) throw new AppError("OPERATION_CANCELLED", "Release prune was cancelled.");
      await handle.close();
      // Recheck lifecycle and process refs immediately before the first rename.
      if (SHA(await readFile(stateFile)) !== stateSha256 ||
          await this.options.activeTasks() ||
          (await (this.options.processes ?? runningProcessArguments)()).includes(targets[0]!)) {
        conflict("Prune state or process references changed after the plan.");
      }
      const finished: PruneReleasesResult["items"] = [];
      for (let i = 0; i < targets.length; i++) {
        if (this.options.signal?.aborted) throw new AppError("OPERATION_CANCELLED", "Release prune was cancelled.");
        const absolute = targets[i]!;
        const parent = path.dirname(absolute);
        if (await realpath(parent) !== parent || SHA(await readFile(stateFile)) !== stateSha256 ||
            await realpath(path.join(root, "current")) !== path.join(root, "releases", active.releaseId) ||
            await this.options.activeTasks()) {
          conflict("Prune preconditions changed during operation.");
        }
        const sourceStat = await lstat(absolute);
        if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) deny("Prune target changed type.");
        const live = await (this.options.processes ?? runningProcessArguments)();
        if (live.includes(absolute)) deny("A process began using the prune target.");
        const latestMounts = await (this.options.mountPoints ?? mountedPaths)();
        if (latestMounts.some(mount => mount === absolute || mount.startsWith(absolute + path.sep))) {
          deny("A mountpoint was added inside the prune target.");
        }
        const quarantine = path.join(parent, ".release-prune-" + input.operationId + "-" + i);
        await rename(absolute, quarantine);
        await rm(quarantine, { recursive: true, force: false, maxRetries: 0 });
        finished.push({ ...resultItems[i]!, status: "deleted" });
      }
      const completed = pruneReleasesResultSchema.parse({
        operationId: input.operationId, status: "completed", stateSha256,
        ...(planSha256 ? { planSha256 } : {}), items: finished,
      });
      const receiptTemp = path.join(receiptRoot, input.operationId + ".tmp");
      await writeFile(receiptTemp, JSON.stringify({ fingerprint, result: completed }), { flag: "wx", mode: 0o600 });
      await rename(receiptTemp, receiptFile);
      success = true;
      return completed;
    } finally {
      await handle.close().catch(() => undefined);
      if (success) await rm(lockFile, { force: true });
    }
  }

  private async selectEligible(
    root: string,
    protectedIds: ReadonlySet<string>,
  ): Promise<NonNullable<PruneReleasesInput["targets"]>> {
    const eligible: NonNullable<PruneReleasesInput["targets"]> = [];
    for (const kind of ["release", "staging"] as const) {
      const parent = path.join(root, kind === "release" ? "releases" : "staging");
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        const pattern = kind === "release" ? RELEASE_ID : STAGE_ID;
        if (!pattern.test(entry.name) || entry.name.includes("..")) continue;
        const releaseId = kind === "release" ? entry.name : entry.name.slice(0, -9);
        if (protectedIds.has(releaseId)) continue;
        // Let the existing physical-directory checks reject suspicious entries.
        eligible.push({ kind, name: entry.name });
      }
    }
    eligible.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    return eligible.slice(0, 5);
  }

  private async requirePhysicalDirectory(directory: string, canonical: string): Promise<void> {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== canonical) {
      deny("Release prune root is not a physical canonical directory.");
    }
  }
}

async function mountedPaths(): Promise<string[]> {
  const raw = await readFile("/proc/self/mountinfo", "utf8");
  return raw.split("\n").filter(Boolean).map(line => {
    const mount = line.split(" ")[4];
    if (!mount || !mount.startsWith("/")) throw new AppError("PERMISSION_DENIED", "Mount table could not be inspected safely.");
    return mount.replace(/\\([0-7]{3})/gu, (_value, octal: string) => String.fromCharCode(parseInt(octal, 8)));
  });
}

async function runningProcessArguments(): Promise<string> {
  const result = await execFile("/usr/bin/ps", ["-eo", "args="], {
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    encoding: "utf8",
  });
  return result.stdout;
}
