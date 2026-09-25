import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  AppError,
  type CreateRepositoryInput,
  type DiscoverLocalRepositoriesInput,
  type DiscoverLocalRepositoriesResult,
  type GetOnboardingStateInput,
  type GetRepositoryInput,
  type ImportRepositoriesInput,
  type ImportRepositoriesResult,
  type ListDevicesInput,
  type ListDevicesResult,
  type ListRepositoriesInput,
  type ListRepositoriesResult,
  type MaterializeRepositoryInput,
  type MaterializeRepositoryResult,
  type OnboardingState,
  type OperationContext,
  type PolicyFile,
  type RepositoryDetails,
  type RepositoryExecutor,
  type RepositoryMaterialization,
  type RevokeDeviceInput,
  type RevokeDeviceResult,
  type SyncRepositoryInput,
  type SyncRepositoryResult,
  type WorkspaceSummary,
} from "@vs-code-gpt/shared";

const STATE_VERSION = 1 as const;
const MAX_DISCOVERY_DIRECTORIES = 2_000;
const DEFAULT_DISCOVERY_DEPTH = 4;
const MAX_GIT_OUTPUT_BYTES = 1_000_000;

type LocalRepositoryRecord = {
  repositoryId: string;
  name: string;
  path: string;
  workspaceId: string;
  remoteUrls: string[];
  managed: boolean;
};

type LocalRepositoryState = {
  version: typeof STATE_VERSION;
  deviceId?: string;
  repositories: LocalRepositoryRecord[];
};

export type RepositoryBinding = {
  repositoryId: string;
  name: string;
  path: string;
  workspaceId: string;
  remoteUrls: string[];
  managed?: boolean;
};

export interface LocalRepositoryManagerOptions {
  stateDirectory?: string;
  homeDirectory?: string;
  managedRoot?: string;
  platform?: NodeJS.Platform;
  gitExecutable?: string;
  gitEnvironment?: NodeJS.ProcessEnv;
  onChanged?: () => Promise<void>;
}

export class LocalRepositoryManager implements RepositoryExecutor {
  readonly stateDirectory: string;
  readonly managedRoot: string;
  private readonly homeDirectory: string;
  private readonly platform: NodeJS.Platform;
  private readonly gitExecutable: string;
  private readonly statePath: string;
  private state: LocalRepositoryState = { version: STATE_VERSION, repositories: [] };

  private constructor(private readonly options: LocalRepositoryManagerOptions) {
    this.platform = options.platform ?? process.platform;
    this.homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
    this.stateDirectory = path.resolve(options.stateDirectory ?? defaultStateDirectory(this.platform));
    this.managedRoot = path.resolve(options.managedRoot ?? path.join(this.homeDirectory, "MCP V3", "Repositórios"));
    this.gitExecutable = options.gitExecutable ?? "git";
    this.statePath = path.join(this.stateDirectory, "repositories.v1.json");
  }

  static async create(options: LocalRepositoryManagerOptions = {}): Promise<LocalRepositoryManager> {
    const manager = new LocalRepositoryManager(options);
    await mkdir(manager.stateDirectory, { recursive: true });
    await mkdir(manager.managedRoot, { recursive: true });
    await manager.load();
    return manager;
  }

  getDeviceId(): string | undefined {
    return this.state.deviceId;
  }

  async setDeviceId(deviceId: string): Promise<void> {
    if (!/^dev_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(deviceId)) {
      throw new AppError("INVALID_ARGUMENT", "Device id is invalid.");
    }
    if (this.state.deviceId === deviceId) return;
    this.state = { ...this.state, deviceId };
    await this.persist();
  }

  listBindings(): RepositoryBinding[] {
    return this.state.repositories.map((repository) => ({ ...repository, remoteUrls: [...repository.remoteUrls] }));
  }

  listMaterializationAnnouncements(): Array<{ repositoryId: string; workspaceId: string; path: string }> {
    return this.state.repositories.map((repository) => ({
      repositoryId: repository.repositoryId,
      workspaceId: repository.workspaceId,
      path: repository.path,
    }));
  }

  async bindRepositories(
    bindings: RepositoryBinding[],
    signal?: AbortSignal,
    dryRun = false,
    mode: "preserve-path" | "copy-to-managed-root" = "preserve-path",
  ): Promise<LocalRepositoryRecord[]> {
    throwIfAborted(signal);
    const previous = this.state;
    const next = [...previous.repositories];
    const bound: LocalRepositoryRecord[] = [];
    const copies: Array<{ sourcePath: string; targetPath: string }> = [];

    for (const binding of bindings) {
      throwIfAborted(signal);
      if (!/^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(binding.repositoryId)) {
        throw new AppError("INVALID_ARGUMENT", "Repository id is invalid.");
      }
      const inspected = await this.inspectRepository(binding.path, signal);
      let canonicalPath = inspected.path;
      let managed = binding.managed ?? isInside(this.managedRoot, canonicalPath, this.platform);

      if (mode === "copy-to-managed-root" && !managed) {
        const targetPath = path.join(
          this.managedRoot,
          managedRepositoryDirectoryName(binding.name || inspected.name, binding.repositoryId),
        );
        const existing = next.find((entry) =>
          entry.repositoryId === binding.repositoryId &&
          samePath(entry.path, targetPath, this.platform)
        );
        if (await directoryExists(targetPath)) {
          if (!existing) {
            throw new AppError(
              "INVALID_PATH",
              "Managed repository destination already exists and is not bound to this repository.",
            );
          }
        } else if (!dryRun) {
          copies.push({ sourcePath: inspected.path, targetPath });
        }
        canonicalPath = targetPath;
        managed = true;
      }

      const workspaceId = sanitizeWorkspaceId(binding.workspaceId || binding.name, canonicalPath);
      const conflicting = next.find(
        (entry) => entry.workspaceId === workspaceId && entry.repositoryId !== binding.repositoryId,
      );
      if (conflicting) {
        throw new AppError("INVALID_ARGUMENT", "Workspace id is already used by another local repository.");
      }

      const record: LocalRepositoryRecord = {
        repositoryId: binding.repositoryId,
        name: binding.name.trim() || inspected.name,
        path: canonicalPath,
        workspaceId,
        remoteUrls: uniqueStrings(binding.remoteUrls.length > 0 ? binding.remoteUrls : inspected.remoteUrls),
        managed,
      };
      const existingIndex = next.findIndex((entry) => entry.repositoryId === binding.repositoryId);
      if (existingIndex >= 0) next.splice(existingIndex, 1);
      next.push(record);
      bound.push(record);
    }

    if (dryRun) return bound;

    const createdTargets: string[] = [];
    let stateChanged = false;
    try {
      for (const copy of copies) {
        throwIfAborted(signal);
        const temporaryPath = `${copy.targetPath}.mcp-v3-${randomUUID()}.tmp`;
        try {
          await cp(copy.sourcePath, temporaryPath, {
            recursive: true,
            force: false,
            errorOnExist: true,
            dereference: false,
            preserveTimestamps: true,
            verbatimSymlinks: true,
          });
          throwIfAborted(signal);
          await rename(temporaryPath, copy.targetPath);
          createdTargets.push(copy.targetPath);
        } catch (error) {
          await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      }

      this.state = { ...previous, repositories: sortRecords(next) };
      stateChanged = true;
      await this.persist();
      await this.options.onChanged?.();
      return bound;
    } catch (error) {
      if (stateChanged) {
        this.state = previous;
        await this.persist().catch(() => undefined);
        await this.options.onChanged?.().catch(() => undefined);
      }
      for (const targetPath of createdTargets.reverse()) {
        await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async materializeRepositoryFromCloud(
    input: {
      repositoryId: string;
      name: string;
      remoteUrls: string[];
      targetName?: string;
      workspaceId?: string;
    },
    signal?: AbortSignal,
    dryRun = false,
  ): Promise<LocalRepositoryRecord> {
    throwIfAborted(signal);
    if (!/^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.repositoryId)) {
      throw new AppError("INVALID_ARGUMENT", "Repository id is invalid.");
    }

    const existing = this.state.repositories.find(
      (entry) => entry.repositoryId === input.repositoryId,
    );
    if (existing && await directoryExists(existing.path)) {
      await this.inspectRepository(existing.path, signal);
      return { ...existing, remoteUrls: [...existing.remoteUrls] };
    }
    if (existing && !existing.managed) {
      throw new AppError(
        "INVALID_PATH",
        "Existing unmanaged repository materialization is unavailable on this device.",
      );
    }

    const remoteUrl = selectSafeCloneRemote(input.remoteUrls);
    if (!remoteUrl) {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Repository has no supported HTTPS or SSH remote for managed materialization.",
      );
    }

    const displayName = input.targetName?.trim() || input.name.trim() || "repository";
    const targetPath = existing?.path ?? path.join(
      this.managedRoot,
      managedRepositoryDirectoryName(displayName, input.repositoryId),
    );
    if (!isInside(this.managedRoot, targetPath, this.platform)) {
      throw new AppError("PATH_OUTSIDE_ALLOWED_ROOTS", "Managed repository path escaped the MCP V3 repository root.");
    }

    const workspaceId = existing?.workspaceId ??
      input.workspaceId ??
      sanitizeWorkspaceId(displayName, targetPath);
    const conflicting = this.state.repositories.find(
      (entry) =>
        entry.repositoryId !== input.repositoryId &&
        entry.workspaceId === workspaceId,
    );
    if (conflicting) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "Workspace id is already used by another local repository.",
      );
    }

    const planned: LocalRepositoryRecord = {
      repositoryId: input.repositoryId,
      name: input.name.trim() || displayName,
      path: targetPath,
      workspaceId,
      remoteUrls: uniqueStrings(input.remoteUrls),
      managed: true,
    };
    if (dryRun) {
      if (await directoryExists(targetPath) && !existing) {
        throw new AppError(
          "INVALID_PATH",
          "Managed repository destination already exists and is not bound to this repository.",
        );
      }
      return planned;
    }

    if (await directoryExists(targetPath)) {
      if (!existing) {
        throw new AppError(
          "INVALID_PATH",
          "Managed repository destination already exists and is not bound to this repository.",
        );
      }
      await this.inspectRepository(targetPath, signal);
      return planned;
    }

    const previous = this.state;
    const temporaryPath = `${targetPath}.mcp-v3-${randomUUID()}.tmp`;
    let targetCreated = false;
    let stateChanged = false;
    try {
      await this.runGit(
        this.managedRoot,
        ["clone", "--", remoteUrl, temporaryPath],
        signal,
      );
      throwIfAborted(signal);
      await this.inspectRepository(temporaryPath, signal);
      await rename(temporaryPath, targetPath);
      targetCreated = true;

      const next = previous.repositories.filter(
        (entry) => entry.repositoryId !== input.repositoryId,
      );
      next.push(planned);
      this.state = { ...previous, repositories: sortRecords(next) };
      stateChanged = true;
      await this.persist();
      await this.options.onChanged?.();
      return planned;
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined);
      if (stateChanged) {
        this.state = previous;
        await this.persist().catch(() => undefined);
        await this.options.onChanged?.().catch(() => undefined);
      }
      if (targetCreated) {
        await rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  async buildPolicy(): Promise<PolicyFile | null> {
    const repositories: LocalRepositoryRecord[] = [];
    for (const record of this.state.repositories) {
      try {
        const inspected = await this.inspectRepository(record.path);
        repositories.push({ ...record, path: inspected.path });
      } catch {
        // Missing materializations remain in state but are not exposed as workspaces.
      }
    }
    if (repositories.length === 0) return null;
    return {
      version: 1,
      workspaces: repositories.map((repository) => ({
        id: repository.workspaceId,
        name: repository.name,
        rootPath: repository.path,
        workspaceKind: "repository" as const,
        enabled: true,
        permissionProfile: "full-repo-write" as const,
        confirmationMode: "standard" as const,
        allowedRoots: ["."],
        blockedGlobs: [],
        limits: {
          maxFileBytes: 8 * 1024 * 1024,
          maxSearchResults: 500,
          maxSearchSnippetBytes: 16 * 1024,
          maxDiffBytes: 4 * 1024 * 1024,
          maxListedFiles: 20_000,
          maxDiscoveryDirectories: 2_000,
          maxDiscoveryEntries: 50_000,
          maxDiscoveryDurationMs: 30_000,
        },
        allowWrites: ["."],
        allowShell: ["."],
        allowedShells: this.platform === "win32"
          ? ["powershell" as const, "cmd" as const]
          : ["sh" as const, "bash" as const],
      })),
    };
  }

  async listWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    const policy = await this.buildPolicy();
    if (!policy) return [];
    return policy.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      workspaceKind: workspace.workspaceKind,
      enabled: true,
      permissionProfile: workspace.permissionProfile,
      confirmationMode: workspace.confirmationMode,
      writesEnabled: true,
      shellsEnabled: true,
      allowedShells: [...workspace.allowedShells],
    }));
  }

  async getOnboardingState(_input: GetOnboardingStateInput, _context?: OperationContext): Promise<OnboardingState> {
    throw new AppError("AGENT_UNAVAILABLE", "Onboarding identity is managed by the MCP V3 cloud control plane.");
  }

  async listRepositories(_input: ListRepositoriesInput, _context?: OperationContext): Promise<ListRepositoriesResult> {
    throw new AppError("AGENT_UNAVAILABLE", "Repository listing is managed by the MCP V3 cloud control plane.");
  }

  async getRepository(_input: GetRepositoryInput, _context?: OperationContext): Promise<RepositoryDetails> {
    throw new AppError("AGENT_UNAVAILABLE", "Repository metadata is managed by the MCP V3 cloud control plane.");
  }

  async createRepository(_input: CreateRepositoryInput, _context?: OperationContext): Promise<RepositoryDetails> {
    throw new AppError("AGENT_UNAVAILABLE", "Repository creation is managed by the MCP V3 cloud control plane.");
  }

  async discoverLocalRepositories(
    input: DiscoverLocalRepositoriesInput,
    context?: OperationContext,
  ): Promise<DiscoverLocalRepositoriesResult> {
    throwIfAborted(context?.signal);
    const root = await this.resolveDiscoveryRoot(input.root);
    const maxDepth = input.maxDepth ?? DEFAULT_DISCOVERY_DEPTH;
    const queue: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }];
    const repositories: Awaited<ReturnType<LocalRepositoryManager["inspectRepository"]>>[] = [];
    let visited = 0;

    while (queue.length > 0) {
      throwIfAborted(context?.signal);
      const current = queue.shift()!;
      visited += 1;
      if (visited > MAX_DISCOVERY_DIRECTORIES) {
        throw new AppError("LIMIT_EXCEEDED", "Repository discovery exceeded the directory limit.");
      }

      if (await isGitRepositoryDirectory(current.directory)) {
        repositories.push(await this.inspectRepository(current.directory, context?.signal));
        continue;
      }
      if (current.depth >= maxDepth) continue;

      let entries;
      try {
        entries = await readdir(current.directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || shouldSkipDirectory(entry.name)) continue;
        const candidate = path.join(current.directory, entry.name);
        let canonical: string;
        try { canonical = await realpath(candidate); } catch { continue; }
        if (!isInside(root, canonical, this.platform)) continue;
        queue.push({ directory: canonical, depth: current.depth + 1 });
      }
    }

    const counts = new Map<string, number>();
    for (const repository of repositories) {
      counts.set(repository.name.toLocaleLowerCase("en-US"), (counts.get(repository.name.toLocaleLowerCase("en-US")) ?? 0) + 1);
    }
    return {
      repositories: repositories
        .map((repository) => ({
          name: repository.name,
          path: repository.path,
          workspaceId: counts.get(repository.name.toLocaleLowerCase("en-US")) === 1
            ? sanitizeWorkspaceId(repository.name, repository.path, false)
            : sanitizeWorkspaceId(repository.name, repository.path, true),
          git: true as const,
          remoteUrls: repository.remoteUrls,
          dirty: repository.dirty,
        }))
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
  }

  async importRepositories(
    _input: ImportRepositoriesInput,
    _context?: OperationContext,
  ): Promise<ImportRepositoriesResult> {
    throw new AppError("CAPABILITY_UNSUPPORTED", "Repository import is coordinated by the MCP V3 cloud control plane.");
  }

  async materializeRepository(
    input: MaterializeRepositoryInput,
    context?: OperationContext,
  ): Promise<MaterializeRepositoryResult> {
    throwIfAborted(context?.signal);
    const record = this.state.repositories.find((entry) => entry.repositoryId === input.repositoryId);
    if (record && await directoryExists(record.path)) {
      const inspected = await this.inspectRepository(record.path, context?.signal);
      return {
        repository: localRepositoryDetails(record, this.state.deviceId),
        materialization: localMaterialization(record, this.state.deviceId),
      };
    }
    throw new AppError("CAPABILITY_UNSUPPORTED", "Repository materialization requires a registered remote source and cloud orchestration.");
  }

  async syncRepository(
    input: SyncRepositoryInput,
    context?: OperationContext,
  ): Promise<SyncRepositoryResult> {
    throwIfAborted(context?.signal);
    const record = this.state.repositories.find((entry) => entry.repositoryId === input.repositoryId);
    if (!record) throw new AppError("WORKSPACE_NOT_FOUND", "Repository is not materialized on this device.");
    const inspected = await this.inspectRepository(record.path, context?.signal);
    if (input.mode === "status") {
      return {
        repositoryId: record.repositoryId,
        status: inspected.dirty ? "dirty" : "clean",
        detail: inspected.dirty ? "Working tree contains local changes." : "Working tree is clean.",
      };
    }
    if (inspected.dirty) {
      return {
        repositoryId: record.repositoryId,
        status: "blocked",
        detail: "Synchronization is blocked because the working tree contains local changes.",
      };
    }
    if (input.mode === "fetch") {
      await this.runGit(record.path, ["fetch", "--prune"], context?.signal);
      return { repositoryId: record.repositoryId, status: "fetched" };
    }
    if (input.mode === "pull-fast-forward") {
      const result = await this.runGit(record.path, ["pull", "--ff-only"], context?.signal, true);
      if (result.exitCode !== 0) {
        return { repositoryId: record.repositoryId, status: "conflict", detail: bounded(result.stderr || result.stdout) };
      }
      return { repositoryId: record.repositoryId, status: "updated", detail: bounded(result.stdout) };
    }
    if (input.mode === "push") {
      const result = await this.runGit(record.path, ["push"], context?.signal, true);
      if (result.exitCode !== 0) {
        return { repositoryId: record.repositoryId, status: "blocked", detail: bounded(result.stderr || result.stdout) };
      }
      return { repositoryId: record.repositoryId, status: "pushed", detail: bounded(result.stdout) };
    }
    throw new AppError("INVALID_ARGUMENT", "Unsupported repository synchronization mode.");
  }

  async listDevices(_input: ListDevicesInput, _context?: OperationContext): Promise<ListDevicesResult> {
    throw new AppError("AGENT_UNAVAILABLE", "Device listing is managed by the MCP V3 cloud control plane.");
  }

  async revokeDevice(_input: RevokeDeviceInput, _context?: OperationContext): Promise<RevokeDeviceResult> {
    throw new AppError("AGENT_UNAVAILABLE", "Device revocation is managed by the MCP V3 cloud control plane.");
  }

  private async resolveDiscoveryRoot(input: string): Promise<string> {
    if (!path.isAbsolute(input)) throw new AppError("INVALID_PATH", "Repository discovery root must be absolute.");
    let canonical: string;
    try {
      canonical = await realpath(input);
      if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new AppError("INVALID_PATH", "Repository discovery root was not found.", { cause: error });
    }
    if (!isInside(this.homeDirectory, canonical, this.platform)) {
      throw new AppError(
        "PATH_OUTSIDE_ALLOWED_ROOTS",
        "Repository discovery is limited to the current user's home directory until an external location is explicitly approved by the MCP V3 app.",
      );
    }
    return canonical;
  }

  private async inspectRepository(repositoryPath: string, signal?: AbortSignal) {
    const canonical = await realpath(repositoryPath);
    if (!(await stat(canonical)).isDirectory() || !(await isGitRepositoryDirectory(canonical))) {
      throw new AppError("NOT_GIT_REPOSITORY", "Selected directory is not a Git repository.");
    }
    const remoteResult = await this.runGit(canonical, ["config", "--get-regexp", "^remote\\..*\\.url$"], signal, true);
    const remoteUrls = remoteResult.exitCode === 0
      ? uniqueStrings(remoteResult.stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u).slice(1).join(" ")).filter(Boolean))
      : [];
    const statusResult = await this.runGit(canonical, ["status", "--porcelain=v1", "--untracked-files=normal"], signal);
    return {
      name: path.basename(canonical),
      path: canonical,
      remoteUrls,
      dirty: statusResult.stdout.trim().length > 0,
    };
  }

  private async runGit(
    cwd: string,
    args: string[],
    signal?: AbortSignal,
    allowFailure = false,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitExecutable, args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...(this.options.gitEnvironment === undefined
          ? {}
          : { env: { ...process.env, ...this.options.gitEnvironment } }),
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error, exitCode = child.exitCode ?? -1): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else {
          const out = Buffer.concat(stdout).toString("utf8");
          const err = Buffer.concat(stderr).toString("utf8");
          if (!allowFailure && exitCode !== 0) {
            reject(new AppError("GIT_ERROR", `Git command failed: ${bounded(err || out)}`));
          } else resolve({ exitCode, stdout: out, stderr: err });
        }
      };
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        bytes += chunk.length;
        if (bytes > MAX_GIT_OUTPUT_BYTES) {
          try { child.kill(); } catch { /* already stopped */ }
          finish(new AppError("LIMIT_EXCEEDED", "Git output exceeded the repository manager limit."));
          return;
        }
        chunks.push(Buffer.from(chunk));
      };
      const abort = (): void => {
        try { child.kill(); } catch { /* already stopped */ }
        finish(new AppError("OPERATION_CANCELLED", "Repository operation was cancelled."));
      };
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => finish(new AppError("GIT_ERROR", "Git executable is unavailable.", { cause: error })));
      child.once("close", (code) => finish(undefined, code ?? -1));
    });
  }

  private async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.statePath, "utf8"));
      if (!isState(parsed)) throw new Error("invalid state");
      this.state = {
        version: STATE_VERSION,
        ...(parsed.deviceId === undefined ? {} : { deviceId: parsed.deviceId }),
        repositories: sortRecords(parsed.repositories.map((record) => ({ ...record, remoteUrls: [...record.remoteUrls] }))),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new AppError("INTERNAL_ERROR", "Local repository state is invalid.", { cause: error });
    }
  }

  private async persist(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.statePath);
  }
}

function defaultStateDirectory(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "MCP V3", "state");
  }
  if (platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "MCP V3", "state");
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "mcp-v3");
}

async function isGitRepositoryDirectory(directory: string): Promise<boolean> {
  try {
    const value = await stat(path.join(directory, ".git"));
    return value.isDirectory() || value.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try { return (await stat(directory)).isDirectory(); } catch { return false; }
}

function shouldSkipDirectory(name: string): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  return normalized === ".git" || normalized === "node_modules" || normalized === ".cache" ||
    normalized === "bin" || normalized === "obj" || normalized === "dist";
}

function isInside(root: string, candidate: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) => platform === "win32" ? path.resolve(value).toLocaleLowerCase("en-US") : path.resolve(value);
  const canonicalRoot = normalize(root);
  const canonicalCandidate = normalize(candidate);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sanitizeWorkspaceId(name: string, repositoryPath: string, forceHash = false): string {
  const base = name.trim().normalize("NFKD").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "repository";
  if (!forceHash && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(base)) return base;
  const hash = createHash("sha256").update(path.resolve(repositoryPath), "utf8").digest("hex").slice(0, 8);
  return `${base.slice(0, 70)}-${hash}`;
}

function selectSafeCloneRemote(values: string[]): string | null {
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value || /[\0\r\n]/u.test(value)) continue;
    if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/u.test(value)) {
      return value;
    }
    try {
      const url = new URL(value);
      if (url.password) continue;
      if (url.protocol === "https:" && !url.username) return value;
      if (url.protocol === "ssh:" && url.hostname && !url.password) return value;
    } catch {
      // Local paths and unsupported Git transports are intentionally rejected.
    }
  }
  return null;
}

function managedRepositoryDirectoryName(name: string, repositoryId: string): string {
  const base = name
    .trim()
    .normalize("NFKD")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-")
    .replace(/[. ]+$/gu, "")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "repository";
  const suffix = repositoryId.replace(/^repo_/u, "").slice(0, 8);
  return `${base}-${suffix}`;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const normalize = (value: string) =>
    platform === "win32"
      ? path.resolve(value).toLocaleLowerCase("en-US")
      : path.resolve(value);
  return normalize(left) === normalize(right);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].slice(0, 32);
}

function sortRecords(records: LocalRepositoryRecord[]): LocalRepositoryRecord[] {
  return [...records].sort((left, right) => left.workspaceId.localeCompare(right.workspaceId));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError("OPERATION_CANCELLED", "Repository operation was cancelled.");
}

function bounded(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 4_000 ? trimmed : trimmed.slice(0, 4_000);
}

function localRepositoryDetails(record: LocalRepositoryRecord, deviceId?: string): RepositoryDetails {
  return {
    id: record.repositoryId,
    name: record.name,
    role: "owner",
    visibility: "private",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date().toISOString(),
    materializations: deviceId ? [localMaterialization(record, deviceId)] : [],
  };
}

function localMaterialization(record: LocalRepositoryRecord, deviceId?: string): RepositoryMaterialization {
  if (!deviceId) throw new AppError("AGENT_UNAVAILABLE", "Device identity has not been established.");
  const materializationId = `mat_${stableUuid(`${deviceId}:${record.repositoryId}`)}`;
  return {
    id: materializationId,
    repositoryId: record.repositoryId,
    deviceId,
    workspaceId: record.workspaceId,
    platform: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux",
    path: record.path,
    status: "online",
  };
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20, 32).join("")}`;
}

function isState(value: unknown): value is LocalRepositoryState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== STATE_VERSION || !Array.isArray(record.repositories)) return false;
  if (record.deviceId !== undefined && typeof record.deviceId !== "string") return false;
  return record.repositories.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const item = entry as Record<string, unknown>;
    return typeof item.repositoryId === "string" && typeof item.name === "string" &&
      typeof item.path === "string" && typeof item.workspaceId === "string" &&
      Array.isArray(item.remoteUrls) && item.remoteUrls.every((url) => typeof url === "string") &&
      typeof item.managed === "boolean";
  });
}

