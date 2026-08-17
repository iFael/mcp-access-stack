import { readFile as readLocalFile, writeFile as writeLocalFile } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  mandatoryBlockedGlobs,
  policyFileSchema,
  type BackgroundTaskListResult,
  type BackgroundTaskLogsLookupResult,
  type BackgroundTaskResult,
  type CancelBackgroundTaskInput,
  type GetBackgroundTaskInput,
  type GetWorkspaceContextInput,
  type GetWorkspaceContextResult,
  type InspectGitInput,
  type InspectGitResult,
  type ListBackgroundTasksInput,
  type ListFilesInput,
  type ListFilesResult,
  type ListWorkspaceRootsInput,
  type ListWorkspaceRootsResult,
  type OperationContext,
  type PatchFileInput,
  type PatchFileResult,
  type ReadBackgroundTaskLogsInput,
  type ReadBinaryFileInput,
  type ReadBinaryFileResult,
  type ReadFileInput,
  type ReadFileResult,
  type RunCommandInput,
  type RunCommandResult,
  type RunPowerShellInput,
  type RunPowerShellResult,
  type RunWorkspaceValidationInput,
  type RunWorkspaceValidationResult,
  type SearchFilesInput,
  type SearchFilesResult,
  type ShellName,
  type StartBackgroundTaskInput,
  type WorkspaceExecutor,
  type WorkspacePolicy,
  type WorkspaceSummary,
  type WriteFileInput,
  type WriteFileResult,
} from "@vs-code-gpt/shared";
import { minimatch } from "minimatch";
import {
  countOccurrences,
  detectLineEnding,
  encodeTextPreservingFormat,
  hashBuffer,
  normalizeReplacementLineEndings,
} from "../filesystem/text-file.js";
import { decodeBufferToText } from "../filesystem/text-encoding.js";
import {
  classifyCommandRisk,
  classifyGitPushIntent,
  protectedGitPushReason,
} from "../shell/command-risk.js";
import { CommandConfirmationRegistry } from "../shell/confirmation.js";
import { BackgroundTaskManager } from "../tasks/background-task-manager.js";
import {
  SshWindowsTransport,
  type SshWindowsTransportConfig,
} from "./ssh-windows-transport.js";

const IMPLICIT_OPERATIONAL_DIRECTORIES = new Set([
  ".runtime-tools",
  "releases",
  "runtime",
]);

interface RemoteWorkspace extends WorkspacePolicy {
  blockedGlobs: string[];
}

export interface SshWorkspaceExecutorOptions {
  policyPath?: string;
  policy?: unknown;
  transport?: SshWindowsTransport;
  transportConfig?: SshWindowsTransportConfig;
  backgroundStateDirectory: string;
}

export class SshWorkspaceExecutor implements WorkspaceExecutor {
  private readonly workspaces: Map<string, RemoteWorkspace>;
  private readonly transport: SshWindowsTransport;
  private readonly confirmations = new CommandConfirmationRegistry();
  private readonly background: BackgroundTaskManager;
  private ready = false;

  private constructor(policy: unknown, options: SshWorkspaceExecutorOptions) {
    const parsed = policyFileSchema.parse(policy);
    this.workspaces = new Map(
      parsed.workspaces.map((workspace) => [
        workspace.id,
        {
          ...workspace,
          blockedGlobs: [
            ...new Set([...mandatoryBlockedGlobs, ...workspace.blockedGlobs]),
          ],
        },
      ]),
    );
    this.transport =
      options.transport ??
      new SshWindowsTransport(requireTransportConfig(options.transportConfig));
    this.background = new BackgroundTaskManager({
      stateDirectory: options.backgroundStateDirectory,
      runner: {
        start: async (input, signal, execution) => {
          const result = await this.executeDirect(
            this.workspace(input.workspaceId),
            input.shell,
            input.command,
            input.cwd ?? ".",
            input.timeoutMs,
            signal,
          );
          await Promise.all([
            writeLocalFile(execution.stdoutPath, result.stdout, "utf8"),
            writeLocalFile(execution.stderrPath, result.stderr, "utf8"),
          ]);
          return result;
        },
      },
    });
  }

  static async create(options: SshWorkspaceExecutorOptions): Promise<SshWorkspaceExecutor> {
    const policy =
      options.policy ??
      JSON.parse(await readLocalFile(requirePolicyPath(options.policyPath), "utf8"));
    const executor = new SshWorkspaceExecutor(policy, options);
    await executor.probe();
    return executor;
  }

  isReady(): boolean {
    return this.ready;
  }

  async probe(signal?: AbortSignal): Promise<void> {
    for (const workspace of this.workspaces.values()) {
      if (!workspace.enabled) continue;
      const probe = await this.transport.probeRoot(workspace.rootPath, signal);
      if (probe.kind !== "directory") {
        throw new AppError("POLICY_INVALID", `SSH workspace root is not a directory: ${workspace.id}`);
      }
    }
    this.ready = true;
  }

  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return [...this.workspaces.values()]
      .filter((workspace) => workspace.enabled)
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        workspaceKind: workspace.workspaceKind ?? "repository",
        enabled: true as const,
        permissionProfile: workspace.permissionProfile,
        confirmationMode: workspace.confirmationMode,
        writesEnabled:
          workspace.permissionProfile === "full-repo-write" && workspace.allowWrites.length > 0,
        shellsEnabled:
          workspace.permissionProfile === "full-repo-write" && workspace.allowShell.length > 0,
        allowedShells: workspace.allowedShells,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async listWorkspaceRoots(
    input: ListWorkspaceRootsInput,
    context: OperationContext = {},
  ): Promise<ListWorkspaceRootsResult> {
    const workspace = this.workspace(input.workspaceId);
    if ((workspace.workspaceKind ?? "repository") !== "aggregate") {
      return { roots: ["."], truncated: false };
    }
    const result = await this.transport.list(
      workspace.rootPath,
      ".",
      {
        recursive: false,
        directoriesOnly: true,
        maxEntries: workspace.limits.maxDiscoveryEntries ?? workspace.limits.maxListedFiles * 4,
        excludedPrefixes: blockedTraversalPrefixes(workspace, true),
      },
      context.signal,
    );
    const roots = result.entries
      .map((entry) => entry.path)
      .filter((entry) => !this.isBlocked(workspace, entry))
      .filter((entry) => !IMPLICIT_OPERATIONAL_DIRECTORIES.has(entry.toLocaleLowerCase("en-US")))
      .slice(0, workspace.limits.maxListedFiles);
    return {
      roots,
      truncated: result.truncated || roots.length >= workspace.limits.maxListedFiles,
    };
  }

  async listFiles(
    input: ListFilesInput,
    context: OperationContext = {},
  ): Promise<ListFilesResult> {
    const workspace = this.workspace(input.workspaceId);
    const root = this.authorizeRead(workspace, input.root ?? ".", true);
    const implicitRoot = input.root === undefined || root === ".";
    const budget = Math.max(
      workspace.limits.maxListedFiles * 8,
      workspace.limits.maxDiscoveryEntries ?? 0,
      1_000,
    );
    const result = await this.transport.list(
      workspace.rootPath,
      root,
      {
        recursive: true,
        maxEntries: budget,
        excludedPrefixes: blockedTraversalPrefixes(workspace, implicitRoot),
      },
      context.signal,
    );
    const files: string[] = [];
    for (const entry of result.entries) {
      if (entry.kind !== "file") continue;
      if (this.isBlocked(workspace, entry.path)) continue;
      if (implicitRoot && isUnderImplicitOperationalDirectory(entry.path)) continue;
      if (input.glob && !minimatch(entry.path, input.glob, { dot: true, nocase: true })) continue;
      files.push(entry.path);
      if (files.length >= workspace.limits.maxListedFiles) break;
    }
    return {
      files,
      truncated: result.truncated || files.length >= workspace.limits.maxListedFiles,
    };
  }

  async readFile(
    input: ReadFileInput,
    context: OperationContext = {},
  ): Promise<ReadFileResult> {
    const workspace = this.workspace(input.workspaceId);
    const logicalPath = this.authorizeRead(workspace, input.path);
    const remote = await this.transport.readBytes(
      workspace.rootPath,
      logicalPath,
      workspace.limits.maxFileBytes,
      context.signal,
    );
    const buffer = Buffer.from(remote.contentBase64, "base64");
    if (buffer.includes(0) && !hasUtf16Bom(buffer)) {
      throw new AppError("BINARY_FILE", "Binary files are not supported.");
    }
    const decoded = decodeBufferToText(buffer);
    const lines = decoded.text.split(/\r?\n/u);
    const startLine = input.startLine ?? 1;
    const requestedEndLine = input.endLine ?? lines.length;
    const endLine = Math.min(requestedEndLine, lines.length);
    const content = startLine > lines.length
      ? ""
      : lines.slice(startLine - 1, endLine).join("\n");
    return {
      path: logicalPath,
      content,
      startLine,
      endLine: startLine > lines.length ? startLine - 1 : endLine,
      totalLines: lines.length,
      sizeBytes: buffer.byteLength,
      sha256: remote.sha256,
      encoding: decoded.encoding as ReadFileResult["encoding"],
      lineEnding: detectLineEnding(decoded.text),
    };
  }

  async readBinaryFile(
    input: ReadBinaryFileInput,
    context: OperationContext = {},
  ): Promise<ReadBinaryFileResult> {
    const workspace = this.workspace(input.workspaceId);
    const logicalPath = this.authorizeRead(workspace, input.path);
    const remote = await this.transport.readBytes(
      workspace.rootPath,
      logicalPath,
      workspace.limits.maxFileBytes,
      context.signal,
    );
    return { path: logicalPath, ...remote };
  }

  async writeFile(
    input: WriteFileInput,
    context: OperationContext = {},
  ): Promise<WriteFileResult> {
    const workspace = this.workspace(input.workspaceId);
    this.assertWritesEnabled(workspace);
    const logicalPath = this.authorizeWrite(workspace, input.path);
    const content = Buffer.from(input.content, "utf8");
    if (content.byteLength > workspace.limits.maxFileBytes) {
      throw new AppError("FILE_TOO_LARGE", "File exceeds the configured size limit.");
    }
    const result = await this.transport.writeBytes(
      workspace.rootPath,
      logicalPath,
      content,
      {},
      context.signal,
    );
    return { path: logicalPath, sizeBytes: result.sizeBytes, created: result.created };
  }

  async patchFile(
    input: PatchFileInput,
    context: OperationContext = {},
  ): Promise<PatchFileResult> {
    const workspace = this.workspace(input.workspaceId);
    this.assertWritesEnabled(workspace);
    const logicalPath = this.authorizeWrite(workspace, input.path);
    const remote = await this.transport.readBytes(
      workspace.rootPath,
      logicalPath,
      workspace.limits.maxFileBytes,
      context.signal,
    );
    if (remote.sha256 !== input.expectedSha256.toLocaleLowerCase("en-US")) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "File changed after it was read; refresh the file and use its current SHA-256.",
      );
    }
    const original = Buffer.from(remote.contentBase64, "base64");
    if (original.includes(0) && !hasUtf16Bom(original)) {
      throw new AppError("BINARY_FILE", "Binary files are not supported.");
    }
    const decoded = decodeBufferToText(original);
    const lineEnding = detectLineEnding(decoded.text);
    let patched = decoded.text;
    let replacementsApplied = 0;
    for (const replacement of input.replacements) {
      const oldText = normalizeReplacementLineEndings(replacement.oldText, lineEnding);
      const newText = normalizeReplacementLineEndings(replacement.newText, lineEnding);
      const actualCount = countOccurrences(patched, oldText);
      const expectedCount = replacement.expectedCount ?? 1;
      if (actualCount !== expectedCount) {
        throw new AppError(
          "INVALID_ARGUMENT",
          `Replacement count mismatch: expected ${expectedCount}, found ${actualCount}.`,
        );
      }
      patched = patched.split(oldText).join(newText);
      replacementsApplied += actualCount;
    }
    const output = encodeTextPreservingFormat(
      patched,
      decoded.encoding as PatchFileResult["encoding"],
      readBom(original),
    );
    if (output.byteLength > workspace.limits.maxFileBytes) {
      throw new AppError("FILE_TOO_LARGE", "Patched file exceeds the configured size limit.");
    }
    const sha256After = hashBuffer(output);
    const changed = sha256After !== remote.sha256;
    const dryRun = input.dryRun ?? false;
    if (!dryRun && changed) {
      await this.transport.writeBytes(
        workspace.rootPath,
        logicalPath,
        output,
        { expectedSha256: remote.sha256 },
        context.signal,
      );
    }
    return {
      path: logicalPath,
      sha256Before: remote.sha256,
      sha256After,
      encoding: decoded.encoding as PatchFileResult["encoding"],
      lineEnding: detectLineEnding(patched),
      replacementsApplied,
      sizeBytes: output.byteLength,
      changed,
      dryRun,
    };
  }

  async searchFiles(
    input: SearchFilesInput,
    context: OperationContext = {},
  ): Promise<SearchFilesResult> {
    const workspace = this.workspace(input.workspaceId);
    const parsed = { ...input, caseSensitive: input.caseSensitive ?? false };
    const listed = await this.listFiles(
      {
        workspaceId: input.workspaceId,
        ...(input.root === undefined ? {} : { root: input.root }),
        ...(input.glob === undefined ? {} : { glob: input.glob }),
      },
      context,
    );
    const matches: SearchFilesResult["matches"] = [];
    let skippedFiles = 0;
    for (const logicalPath of listed.files) {
      if (context.signal?.aborted) {
        throw new AppError("OPERATION_CANCELLED", "Search operation was cancelled.");
      }
      let remote;
      try {
        remote = await this.transport.readBytes(
          workspace.rootPath,
          logicalPath,
          workspace.limits.maxFileBytes,
          context.signal,
        );
      } catch {
        skippedFiles += 1;
        continue;
      }
      const buffer = Buffer.from(remote.contentBase64, "base64");
      if (buffer.includes(0) && !hasUtf16Bom(buffer)) {
        skippedFiles += 1;
        continue;
      }
      const text = decodeBufferToText(buffer).text;
      const lines = text.split(/\r?\n/u);
      const needle = parsed.caseSensitive ? parsed.query : parsed.query.toLocaleLowerCase("en-US");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        const haystack = parsed.caseSensitive ? line : line.toLocaleLowerCase("en-US");
        const column = haystack.indexOf(needle);
        if (column < 0) continue;
        matches.push({
          path: logicalPath,
          line: index + 1,
          column: column + 1,
          snippet: truncateUtf8(line, workspace.limits.maxSearchSnippetBytes),
        });
        if (matches.length >= workspace.limits.maxSearchResults) {
          return { matches, truncated: true, skippedFiles };
        }
      }
    }
    return { matches, truncated: listed.truncated, skippedFiles };
  }

  async inspectGit(
    input: InspectGitInput,
    context: OperationContext = {},
  ): Promise<InspectGitResult> {
    const workspace = this.workspace(input.workspaceId);
    const root = this.authorizeRead(workspace, input.root ?? ".", true);
    const implicitRoot = input.root === undefined || root === ".";
    const diffMode = input.diffMode ?? "summary";
    const timeoutMs = input.timeoutMs ?? 60_000;
    const branchResult = await this.transport.exec(
      workspace.rootPath,
      root,
      "git",
      ["branch", "--show-current"],
      timeoutMs,
      context.signal,
    );
    if (branchResult.exitCode !== 0) {
      throw new AppError("INVALID_ARGUMENT", "Requested root is not a Git repository.");
    }
    const statusResult = await this.transport.exec(
      workspace.rootPath,
      root,
      "git",
      ["status", "--porcelain=v1"],
      timeoutMs,
      context.signal,
    );
    const status = parseGitStatus(statusResult.stdout);
    const maxDiffBytes = Math.min(input.maxDiffBytes ?? 40_000, workspace.limits.maxDiffBytes);
    const paths = (input.paths ?? []).map((value) => this.authorizeRead(workspace, value, true));
    const pathArgs = paths.length === 0 ? [] : ["--", ...paths];
    const staged = diffMode === "none"
      ? ""
      : (await this.transport.exec(
          workspace.rootPath,
          root,
          "git",
          ["diff", "--cached", ...(diffMode === "summary" ? ["--stat"] : []), ...pathArgs],
          timeoutMs,
          context.signal,
        )).stdout;
    const unstaged = diffMode === "none"
      ? ""
      : (await this.transport.exec(
          workspace.rootPath,
          root,
          "git",
          ["diff", ...(diffMode === "summary" ? ["--stat"] : []), ...pathArgs],
          timeoutMs,
          context.signal,
        )).stdout;
    const stagedTrim = truncateUtf8(staged, maxDiffBytes);
    const remaining = Math.max(0, maxDiffBytes - Buffer.byteLength(stagedTrim, "utf8"));
    const unstagedTrim = truncateUtf8(unstaged, remaining);
    return {
      workspaceId: workspace.id,
      root,
      branch: branchResult.stdout.trim() || "HEAD",
      diffMode,
      status,
      staged: stagedTrim,
      unstaged: unstagedTrim,
      truncated: stagedTrim !== staged || unstagedTrim !== unstaged,
    };
  }

  async getWorkspaceContext(
    input: GetWorkspaceContextInput,
    context: OperationContext = {},
  ): Promise<GetWorkspaceContextResult> {
    const workspace = this.workspace(input.workspaceId);
    const root = this.authorizeRead(workspace, input.root ?? ".", true);
    const implicitRoot = input.root === undefined || root === ".";
    const listed = await this.transport.list(
      workspace.rootPath,
      root,
      { recursive: false, maxEntries: 200 },
      context.signal,
    );
    const names = new Set(listed.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path));
    const instructionNames = ["AGENTS.md", "CLAUDE.md"];
    const instructionFiles = instructionNames
      .map((name) => ({ name, path: joinLogical(root, name) }))
      .filter((entry) => names.has(entry.path))
      .map((entry) => ({ ...entry, exists: true as const }));
    let git: GetWorkspaceContextResult["git"] = { isGitRepository: false };
    try {
      const inspected = await this.inspectGit(
        { workspaceId: workspace.id, root, diffMode: "none", paths: [], maxDiffBytes: 1, timeoutMs: 10_000 },
        context,
      );
      git = {
        isGitRepository: true,
        currentBranch: inspected.branch,
        isDirty: inspected.status.length > 0,
      };
    } catch {
      // Not every authorized workspace root is a Git repository.
    }
    return {
      workspaceId: workspace.id,
      rootPath: root,
      instructionFiles,
      availableInstructionFiles: instructionFiles.map((entry) => entry.path),
      skills: [],
      git,
    };
  }

  async runCommand(
    input: RunCommandInput,
    context: OperationContext = {},
  ): Promise<RunCommandResult> {
    const workspace = this.workspace(input.workspaceId);
    if (!input.command) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "SSH workspace backend currently requires an explicit command.",
      );
    }
    const preferredShell = "preferredShell" in input ? input.preferredShell : undefined;
    const shell = resolveShell(input.shell, preferredShell, workspace.allowedShells);
    const cwd = this.authorizeShellCwd(workspace, input.cwd ?? ".");
    const risk = classifyCommandRisk(shell, input.command);
    await this.enforceGitPushPolicy(workspace, shell, input.command, cwd, input.timeoutMs, context.signal);
    const binding = { workspaceId: workspace.id, shell, cwd, command: input.command };
    if (risk.destructive) {
      if (!input.confirmationId) {
        const confirmation = this.confirmations.create(binding);
        return {
          status: "confirmation_required",
          shell,
          cwd,
          confirmationId: confirmation.confirmationId,
          expiresAt: confirmation.expiresAt,
          reasons: risk.reasons.length > 0
            ? risk.reasons
            : ["Potentially destructive remote command requires explicit confirmation."],
          ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
        };
      }
      this.confirmations.consume(input.confirmationId, binding);
    }
    const result = await this.executeDirect(
      workspace,
      shell,
      input.command,
      cwd,
      input.timeoutMs,
      context.signal,
    );
    return {
      ...result,
      ...(input.executionMode === undefined ? {} : { executionMode: input.executionMode }),
    };
  }

  async runPowerShell(
    input: RunPowerShellInput,
    context: OperationContext = {},
  ): Promise<RunPowerShellResult> {
    return this.runCommand({ ...input, shell: "powershell", executionMode: "direct" }, context);
  }

  async runValidation(
    input: RunWorkspaceValidationInput,
    context: OperationContext = {},
  ): Promise<RunWorkspaceValidationResult> {
    const workspace = this.workspace(input.workspaceId);
    const root = this.authorizeRead(workspace, input.root ?? ".", true);
    const implicitRoot = input.root === undefined || root === ".";
    const startedAt = Date.now();
    if (input.validation === "diff-check") {
      const result = await this.transport.exec(
        workspace.rootPath,
        root,
        "git",
        ["diff", "--check", ...(input.scope === "paths" ? ["--", ...(input.paths ?? [])] : [])],
        input.timeoutMs ?? 60_000,
        context.signal,
      );
      const findings = result.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .slice(0, input.maxFindings ?? 100)
        .map((message) => ({
          ruleId: "git-diff-check",
          severity: "error" as const,
          message,
          path: root,
          source: "git" as const,
        }));
      return {
        workspaceId: workspace.id,
        root,
        validation: "diff-check",
        scope: input.scope ?? "changes",
        executed: true,
        passed: result.exitCode === 0,
        tool: { name: "git", available: true },
        filesScanned: 0,
        findings,
        findingsCount: findings.length,
        truncated: findings.length >= (input.maxFindings ?? 100),
        durationMs: Date.now() - startedAt,
        issues: result.exitCode === 0 ? [] : ["git diff --check reported whitespace errors."],
        warnings: [],
      };
    }
    return {
      workspaceId: workspace.id,
      root,
      validation: input.validation,
      scope: input.scope ?? "changes",
      executed: false,
      passed: false,
      tool: { name: input.validation, available: false },
      filesScanned: 0,
      findings: [],
      findingsCount: 0,
      truncated: false,
      durationMs: Date.now() - startedAt,
      issues: [`${input.validation} is not yet available through the SSH backend.`],
      warnings: [],
    };
  }

  async startBackgroundTask(input: StartBackgroundTaskInput): Promise<BackgroundTaskResult> {
    const workspace = this.workspace(input.workspaceId);
    this.authorizeShellCwd(workspace, input.cwd ?? ".");
    const risk = classifyCommandRisk(input.shell, input.command);
    if (risk.destructive) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Potentially destructive commands cannot be started as background tasks.",
      );
    }
    const task = await this.background.start_background_task(input);
    return { task };
  }

  async getBackgroundTask(input: GetBackgroundTaskInput): Promise<BackgroundTaskResult> {
    this.workspace(input.workspaceId);
    const task = await this.background.get_background_task(input.id);
    return { task: task?.workspaceId === input.workspaceId ? task : null };
  }

  async listBackgroundTasks(input: ListBackgroundTasksInput): Promise<BackgroundTaskListResult> {
    this.workspace(input.workspaceId);
    const tasks = await this.background.list_background_tasks({
      workspaceId: input.workspaceId,
      ...(input.state === undefined ? {} : { state: input.state }),
    });
    return { tasks };
  }

  async cancelBackgroundTask(input: CancelBackgroundTaskInput): Promise<BackgroundTaskResult> {
    this.workspace(input.workspaceId);
    const task = await this.background.cancel_background_task(input.id);
    return { task: task?.workspaceId === input.workspaceId ? task : null };
  }

  async readBackgroundTaskLogs(
    input: ReadBackgroundTaskLogsInput,
  ): Promise<BackgroundTaskLogsLookupResult> {
    this.workspace(input.workspaceId);
    const task = await this.background.get_background_task(input.id);
    if (!task || task.workspaceId !== input.workspaceId) return { logs: null };
    return {
      logs: await this.background.read_background_task_logs(input.id, input.maxBytes ?? 100_000),
    };
  }

  private async executeDirect(
    workspace: RemoteWorkspace,
    shell: ShellName,
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Extract<RunCommandResult, { status: "executed" }>> {
    const result = await this.transport.runShell(
      workspace.rootPath,
      cwd,
      shell,
      command,
      timeoutMs,
      signal,
    );
    return {
      status: "executed",
      shell,
      cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    };
  }

  private async enforceGitPushPolicy(
    workspace: RemoteWorkspace,
    shell: ShellName,
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const intent = classifyGitPushIntent(shell, command);
    if (!intent.isPush) return;
    let currentBranch: string | undefined;
    if (!intent.usesGitC) {
      const result = await this.transport.exec(
        workspace.rootPath,
        cwd,
        "git",
        ["branch", "--show-current"],
        Math.min(timeoutMs, 10_000),
        signal,
      );
      currentBranch = result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
    }
    const blockedReason = protectedGitPushReason(intent, currentBranch);
    if (blockedReason) throw new AppError("PERMISSION_DENIED", blockedReason);
  }

  private workspace(id: string): RemoteWorkspace {
    const workspace = this.workspaces.get(id);
    if (!workspace || !workspace.enabled) {
      throw new AppError("WORKSPACE_NOT_FOUND", "Workspace was not found.");
    }
    return workspace;
  }

  private assertWritesEnabled(workspace: RemoteWorkspace): void {
    if (workspace.permissionProfile !== "full-repo-write" || workspace.allowWrites.length === 0) {
      throw new AppError("WRITE_NOT_ALLOWED", "Workspace policy does not allow writes.");
    }
  }

  private authorizeRead(workspace: RemoteWorkspace, value: string, allowDot = false): string {
    const logical = normalizeRelativePath(value, allowDot);
    if (this.isBlocked(workspace, logical)) {
      throw new AppError("BLOCKED_PATH", "Path is blocked by workspace policy.");
    }
    if (!workspace.allowedRoots.some((root) => logicalContains(normalizeRelativePath(root, true), logical))) {
      throw new AppError("PATH_OUTSIDE_ALLOWED_ROOTS", "Path is outside workspace allowed roots.");
    }
    return logical;
  }

  private authorizeWrite(workspace: RemoteWorkspace, value: string): string {
    const logical = this.authorizeRead(workspace, value, false);
    if (!workspace.allowWrites.some((root) => logicalContains(normalizeRelativePath(root, true), logical))) {
      throw new AppError("WRITE_NOT_ALLOWED", "Path is outside workspace allowWrites policy.");
    }
    return logical;
  }

  private authorizeShellCwd(workspace: RemoteWorkspace, value: string): string {
    if (workspace.allowShell.length === 0) {
      throw new AppError("SHELL_NOT_ALLOWED", "Workspace policy does not allow shell execution.");
    }
    const logical = this.authorizeRead(workspace, value, true);
    if (!workspace.allowShell.some((root) => logicalContains(normalizeRelativePath(root, true), logical))) {
      throw new AppError("SHELL_NOT_ALLOWED", "Path is outside workspace allowShell policy.");
    }
    return logical;
  }

  private isBlocked(workspace: RemoteWorkspace, logicalPath: string): boolean {
    const candidate = logicalPath === "." ? "" : logicalPath;
    return workspace.blockedGlobs.some((pattern) =>
      minimatch(candidate, pattern, { dot: true, nocase: true, matchBase: false }),
    );
  }
}

function requirePolicyPath(value: string | undefined): string {
  if (!value) throw new AppError("POLICY_INVALID", "SSH workspace policy path is required.");
  return value;
}

function requireTransportConfig(
  value: SshWindowsTransportConfig | undefined,
): SshWindowsTransportConfig {
  if (!value) throw new AppError("POLICY_INVALID", "SSH transport configuration is required.");
  return value;
}

function normalizeRelativePath(value: string, allowDot: boolean): string {
  if (!value || value.includes("\0")) throw new AppError("INVALID_PATH", "Path must be non-empty.");
  const portable = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:/u.test(portable) || portable.startsWith("/") || portable.startsWith("//")) {
    throw new AppError("INVALID_PATH", "Absolute paths are not allowed.");
  }
  const output: string[] = [];
  for (const segment of portable.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") throw new AppError("INVALID_PATH", "Path traversal is not allowed.");
    if (segment.includes(":") || /[. ]$/u.test(segment)) {
      throw new AppError("INVALID_PATH", "Path contains an invalid Windows segment.");
    }
    output.push(segment);
  }
  if (output.length === 0) {
    if (allowDot) return ".";
    throw new AppError("INVALID_PATH", "Path must identify a file or directory.");
  }
  return output.join("/");
}

function logicalContains(base: string, target: string): boolean {
  if (base === ".") return true;
  const left = base.toLocaleLowerCase("en-US");
  const right = target.toLocaleLowerCase("en-US");
  return right === left || right.startsWith(`${left}/`);
}

function blockedTraversalPrefixes(
  workspace: RemoteWorkspace,
  includeOperational: boolean,
): string[] {
  const prefixes = new Set<string>();
  for (const pattern of workspace.blockedGlobs) {
    if (!pattern.endsWith("/**")) continue;
    const prefix = pattern.slice(0, -3).replace(/^\.\//u, "");
    if (!prefix || /[*?\[\]{}]/u.test(prefix)) continue;
    prefixes.add(prefix);
  }
  if (includeOperational) {
    for (const name of IMPLICIT_OPERATIONAL_DIRECTORIES) prefixes.add(name);
  }
  return [...prefixes];
}
function isUnderImplicitOperationalDirectory(value: string): boolean {
  const first = value.split("/", 1)[0]?.toLocaleLowerCase("en-US") ?? "";
  return IMPLICIT_OPERATIONAL_DIRECTORIES.has(first);
}

function joinLogical(root: string, child: string): string {
  return root === "." ? child : `${root}/${child}`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

function hasUtf16Bom(buffer: Buffer): boolean {
  return buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) ||
      (buffer[0] === 0xfe && buffer[1] === 0xff));
}

function readBom(buffer: Buffer): Buffer {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return Buffer.from([0xef, 0xbb, 0xbf]);
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return Buffer.from([0xff, 0xfe]);
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return Buffer.from([0xfe, 0xff]);
  return Buffer.alloc(0);
}

function parseGitStatus(value: string): InspectGitResult["status"] {
  return value
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      const indexStatus = line[0] ?? " ";
      const workTreeStatus = line[1] ?? " ";
      const rawPath = line.slice(3);
      const renameParts = rawPath.split(" -> ");
      return renameParts.length === 2
        ? {
            path: renameParts[1] ?? rawPath,
            originalPath: renameParts[0] ?? rawPath,
            indexStatus,
            workTreeStatus,
          }
        : { path: rawPath, indexStatus, workTreeStatus };
    });
}

function resolveShell(
  requested: ShellName | undefined,
  preferred: string | undefined,
  allowed: readonly ShellName[],
): ShellName {
  const candidate = requested ?? (preferred && preferred !== "auto" ? preferred as ShellName : undefined) ?? allowed[0];
  if (!candidate || !allowed.includes(candidate)) {
    throw new AppError("SHELL_NOT_ALLOWED", "Workspace policy does not allow the requested shell.");
  }
  return candidate;
}
