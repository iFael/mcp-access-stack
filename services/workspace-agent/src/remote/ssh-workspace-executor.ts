import { createHash, randomUUID } from "node:crypto";
import { readFile as readLocalFile, writeFile as writeLocalFile } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  TypedConfirmationRegistry,
  assertSourceControlCapability,
  assertTypedGitBranchMutationAllowed,
  canonicalSourceControlArgumentsDigest,
  gitCommitInputSchema,
  gitCreateBranchInputSchema,
  gitMergeBranchInputSchema,
  gitPushBranchInputSchema,
  gitStagePathsInputSchema,
  gitUnstagePathsInputSchema,
  githubCreatePullRequestInputSchema,
  githubCreatePullRequestResultSchema,
  githubCreateRepositoryInputSchema,
  githubCreateRepositoryResultSchema,
  githubGetPullRequestInputSchema,
  githubGetRepositoryInputSchema,
  githubMergePullRequestInputSchema,
  githubMergePullRequestResultSchema,
  githubRepositoryFullNameSchema,
  mandatoryBlockedGlobs,
  policyFileSchema,
  readBackgroundTaskOutputInputSchema,
  startBackgroundTaskInputSchema,
  type BackgroundTaskListResult,
  type BackgroundTaskLogsLookupResult,
  type BackgroundTaskOutputResult,
  type BackgroundTaskResult,
  type BackgroundTaskStdinResult,
  type BackgroundTaskWaitResult,
  type CancelBackgroundTaskInput,
  type CommandConfirmationRequiredResult,
  type GetBackgroundTaskInput,
  type WaitBackgroundTaskInput,
  type GetWorkspaceContextInput,
  type GetWorkspaceContextResult,
  type GitCommitInput,
  type GitCommitResult,
  type GitCreateBranchInput,
  type GitCreateBranchResult,
  type GitMergeBranchInput,
  type GitMergeBranchResult,
  type GitPushBranchInput,
  type GitPushBranchResult,
  type GitStagePathsInput,
  type GitStagePathsResult,
  type GitUnstagePathsInput,
  type GitUnstagePathsResult,
  type GitHubCreatePullRequestInput,
  type GitHubCreatePullRequestResult,
  type GitHubCreateRepositoryInput,
  type GitHubCreateRepositoryResult,
  type GitHubGetPullRequestInput,
  type GitHubGetRepositoryInput,
  type GitHubMergePullRequestInput,
  type GitHubMergePullRequestResult,
  type GitHubPullRequestResult,
  type GitHubRepositoryResult,
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
  type GetReleaseStateInput,
  type GetReleaseStateResult,
  type PrepareReleaseInput,
  type PrepareReleaseResult,
  type PromoteReleaseInput,
  type PromoteReleaseResult,
  type ReadBackgroundTaskLogsInput,
  type ReadBackgroundTaskOutputInput,
  type ReadBinaryFileInput,
  type ReadBinaryFileResult,
  type ReadFileInput,
  type ReadFileResult,
  type RunCommandInput,
  type RunCommandResult,
  type RunWorkspaceValidationInput,
  type RunWorkspaceValidationResult,
  type SearchFilesInput,
  type SearchFilesResult,
  type ShellName,
  type StartBackgroundTaskInput,
  type StartBackgroundTaskResult,
  type WriteBackgroundTaskStdinInput,
  type WorkspaceExecutor,
  type GitRepositoryExecutor,
  type GitHubExecutor,
  type MutationReceiptStore,
  type SourceControlCapability,
  type SourceControlOperationName,
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
import { FileMutationReceiptStore } from "../source-control/file-mutation-receipt-store.js";
import { GitHubService } from "../source-control/github-service.js";
import { BackgroundTaskManager } from "../tasks/background-task-manager.js";
import { SshGitHubApiClient } from "./ssh-github-api-client.js";
import {
  SshWindowsTransport,
  type RemoteProcessResult,
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

interface RemoteGitRepositoryContext {
  workspace: RemoteWorkspace;
  logicalRoot: string;
}

export interface SshWorkspaceExecutorOptions {
  policyPath?: string;
  policy?: unknown;
  transport?: SshWindowsTransport;
  transportConfig?: SshWindowsTransportConfig;
  backgroundStateDirectory: string;
}

function backgroundTaskAccess(
  context: OperationContext,
): { ownerScope?: string } {
  return context.ownerScope === undefined
    ? {}
    : { ownerScope: context.ownerScope };
}

export class SshWorkspaceExecutor implements WorkspaceExecutor, GitRepositoryExecutor, GitHubExecutor {
  private readonly workspaces: Map<string, RemoteWorkspace>;
  private readonly transport: SshWindowsTransport;
  private readonly confirmations = new CommandConfirmationRegistry();
  private readonly typedConfirmationRegistry = new TypedConfirmationRegistry();
  private readonly mutationReceiptStores = new Map<string, MutationReceiptStore>();
  private readonly sourceControlStateDirectory: string;
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
    this.sourceControlStateDirectory = path.join(
      path.resolve(options.backgroundStateDirectory),
      "source-control",
    );
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

  async getReleaseState(
    _input: GetReleaseStateInput,
    _context: OperationContext = {},
  ): Promise<GetReleaseStateResult> {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Release lifecycle operations are available only on the local in-process workspace executor.",
    );
  }

  async prepareRelease(
    _input: PrepareReleaseInput,
    _context: OperationContext = {},
  ): Promise<PrepareReleaseResult> {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Release lifecycle operations are available only on the local in-process workspace executor.",
    );
  }

  async promoteRelease(
    _input: PromoteReleaseInput,
    _context: OperationContext = {},
  ): Promise<PromoteReleaseResult> {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Release lifecycle operations are available only on the local in-process workspace executor.",
    );
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
    const shell = resolveShell(input.shell, workspace.allowedShells);
    const cwd = this.authorizeShellCwd(workspace, input.cwd ?? ".");
    const authorization = this.authorizeCommandExecution({
      workspaceId: workspace.id,
      shell,
      cwd,
      command: input.command,
      ...(input.confirmationId === undefined ? {} : { confirmationId: input.confirmationId }),
      executionContext: "foreground",
      operation: "run_command",
    });
    if ("status" in authorization) return authorization;
    return this.executeDirect(
      workspace,
      shell,
      input.command,
      cwd,
      input.timeoutMs,
      context.signal,
    );
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

  async startBackgroundTask(
    input: StartBackgroundTaskInput,
    context: OperationContext = {},
  ): Promise<StartBackgroundTaskResult> {
    const parsed = startBackgroundTaskInputSchema.parse(input);
    const workspace = this.workspace(parsed.workspaceId);
    if (parsed.interactive) {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Interactive background tasks are not supported by the SSH workspace executor.",
      );
    }
    const shell = resolveShell(parsed.shell, workspace.allowedShells);
    const cwd = this.authorizeShellCwd(workspace, parsed.cwd ?? ".");
    const authorization = this.authorizeCommandExecution({
      workspaceId: workspace.id,
      shell,
      cwd,
      command: parsed.command,
      ...(parsed.confirmationId === undefined ? {} : { confirmationId: parsed.confirmationId }),
      executionContext: "background",
      operation: parsed.operation,
    });
    if ("status" in authorization) return authorization;
    const task = await this.background.start_background_task(
      {
        workspaceId: parsed.workspaceId,
        operation: parsed.operation,
        command: parsed.command,
        shell,
        cwd,
        timeoutMs: parsed.timeoutMs,
      },
      backgroundTaskAccess(context),
    );
    return { status: "background_task_started", task };
  }

  async getBackgroundTask(
    input: GetBackgroundTaskInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskResult> {
    this.workspace(input.workspaceId);
    const task = await this.background.get_background_task(
      input.id,
      backgroundTaskAccess(context),
    );
    return { task: task?.workspaceId === input.workspaceId ? task : null };
  }

  async waitBackgroundTask(
    input: WaitBackgroundTaskInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskWaitResult> {
    this.workspace(input.workspaceId);
    const access = backgroundTaskAccess(context);
    const task = await this.background.get_background_task(input.id, access);
    if (!task || task.workspaceId !== input.workspaceId) {
      return { task: null, logs: null, timedOut: false, elapsedMs: 0 };
    }
    return this.background.wait_background_task(
      input.id,
      {
        timeoutMs: input.timeoutMs ?? 60_000,
        maxBytes: input.maxBytes ?? 100_000,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      },
      access,
    );
  }
  async listBackgroundTasks(
    input: ListBackgroundTasksInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskListResult> {
    this.workspace(input.workspaceId);
    const tasks = await this.background.list_background_tasks(
      {
        workspaceId: input.workspaceId,
        ...(input.state === undefined ? {} : { state: input.state }),
      },
      backgroundTaskAccess(context),
    );
    return { tasks };
  }

  async cancelBackgroundTask(
    input: CancelBackgroundTaskInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskResult> {
    this.workspace(input.workspaceId);
    const task = await this.background.cancel_background_task(
      input.id,
      backgroundTaskAccess(context),
    );
    return { task: task?.workspaceId === input.workspaceId ? task : null };
  }

  async readBackgroundTaskLogs(
    input: ReadBackgroundTaskLogsInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskLogsLookupResult> {
    this.workspace(input.workspaceId);
    const access = backgroundTaskAccess(context);
    const task = await this.background.get_background_task(input.id, access);
    if (!task || task.workspaceId !== input.workspaceId) return { logs: null };
    return {
      logs: await this.background.read_background_task_logs(
        input.id,
        input.maxBytes ?? 100_000,
        access,
      ),
    };
  }

  async writeBackgroundTaskStdin(
    input: WriteBackgroundTaskStdinInput,
    _context: OperationContext = {},
  ): Promise<BackgroundTaskStdinResult> {
    this.workspace(input.workspaceId);
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Persistent background-task stdin is not supported by the SSH workspace executor.",
    );
  }

  async readBackgroundTaskOutput(
    input: ReadBackgroundTaskOutputInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskOutputResult> {
    this.workspace(input.workspaceId);
    const parsed = readBackgroundTaskOutputInputSchema.parse(input);
    const access = backgroundTaskAccess(context);
    const task = await this.background.get_background_task(parsed.id, access);
    if (!task || task.workspaceId !== parsed.workspaceId) {
      return { task: null, stdout: null, stderr: null };
    }
    return this.background.read_background_task_output(
      parsed.id,
      {
        stdoutOffset: parsed.stdoutOffset,
        stderrOffset: parsed.stderrOffset,
        maxBytes: parsed.maxBytes,
      },
      access,
    );
  }

  private authorizeCommandExecution(input: {
    workspaceId: string;
    shell: ShellName;
    cwd: string;
    command: string;
    confirmationId?: string;
    executionContext: "foreground" | "background";
    operation: string;
  }): { shell: ShellName; cwd: string } | CommandConfirmationRequiredResult {
    this.enforceGitPushPolicy(input.shell, input.command);
    const risk = classifyCommandRisk(input.shell, input.command);
    const binding = {
      workspaceId: input.workspaceId,
      shell: input.shell,
      cwd: input.cwd,
      command: input.command,
      executionContext: input.executionContext,
      operation: input.operation,
    };
    if (risk.destructive) {
      if (!input.confirmationId) {
        const confirmation = this.confirmations.create(binding);
        return {
          status: "confirmation_required",
          shell: input.shell,
          cwd: input.cwd,
          confirmationId: confirmation.confirmationId,
          expiresAt: confirmation.expiresAt,
          reasons: risk.reasons.length > 0
            ? risk.reasons
            : ["Potentially destructive remote command requires explicit confirmation."],
        };
      }
      this.confirmations.consume(input.confirmationId, binding);
    }
    return { shell: input.shell, cwd: input.cwd };
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

  private enforceGitPushPolicy(
    shell: ShellName,
    command: string,
  ): void {
    const intent = classifyGitPushIntent(shell, command);
    if (!intent.isPush) return;
    const blockedReason = protectedGitPushReason(intent);
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

  async createBranch(
    input: GitCreateBranchInput,
    context: OperationContext = {},
  ): Promise<GitCreateBranchResult> {
    const parsed = gitCreateBranchInputSchema.parse(input);
    const repository = await this.resolveGitRepository(
      parsed.workspaceId,
      parsed.root ?? ".",
      context.signal,
    );
    const actualHead = await this.gitHeadSha(repository, context.signal);
    assertGitSha(
      "GIT_HEAD_MISMATCH",
      parsed.expectedHeadSha,
      actualHead,
      "Git HEAD changed before branch creation.",
    );
    if ((await this.gitBranchSha(repository, parsed.branch, context.signal)) !== undefined) {
      throw new AppError("GIT_BRANCH_CONFLICT", "Git branch already exists.");
    }
    await this.gitSuccess(
      repository,
      this.gitMutationArgs(repository.workspace, [
        "switch",
        "-c",
        parsed.branch,
        parsed.expectedHeadSha,
      ]),
      context.signal,
    );
    const headSha = await this.gitHeadSha(repository, context.signal);
    assertGitSha(
      "GIT_HEAD_MISMATCH",
      parsed.expectedHeadSha,
      headSha,
      "Git branch creation produced an unexpected HEAD.",
    );
    return { root: repository.logicalRoot, branch: parsed.branch, headSha };
  }

  async stagePaths(
    input: GitStagePathsInput,
    context: OperationContext = {},
  ): Promise<GitStagePathsResult> {
    const parsed = gitStagePathsInputSchema.parse(input);
    const repository = await this.resolveGitRepository(
      parsed.workspaceId,
      parsed.root ?? ".",
      context.signal,
    );
    if (parsed.expectedHeadSha !== undefined) {
      const actualHead = await this.gitHeadSha(repository, context.signal);
      assertGitSha(
        "GIT_HEAD_MISMATCH",
        parsed.expectedHeadSha,
        actualHead,
        "Git HEAD changed before staging.",
      );
    }
    if (
      parsed.requireCleanIndex &&
      !(await this.gitIsClean(
        repository,
        ["diff", "--cached", "--quiet"],
        context.signal,
      ))
    ) {
      throw new AppError(
        "GIT_INDEX_CHANGED",
        "Git index must be clean before staging explicit commit paths.",
      );
    }
    const paths = this.authorizeGitPaths(repository, parsed.paths);
    await this.gitSuccess(
      repository,
      this.gitMutationArgs(repository.workspace, ["add", "--", ...paths]),
      context.signal,
    );
    return {
      root: repository.logicalRoot,
      headSha: await this.gitHeadSha(repository, context.signal),
      indexTreeSha: await this.gitWriteTree(repository, context.signal),
      paths,
    };
  }

  async unstagePaths(
    input: GitUnstagePathsInput,
    context: OperationContext = {},
  ): Promise<GitUnstagePathsResult> {
    const parsed = gitUnstagePathsInputSchema.parse(input);
    const repository = await this.resolveGitRepository(
      parsed.workspaceId,
      parsed.root ?? ".",
      context.signal,
    );
    const actualHead = await this.gitHeadSha(repository, context.signal);
    assertGitSha(
      "GIT_HEAD_MISMATCH",
      parsed.expectedHeadSha,
      actualHead,
      "Git HEAD changed before unstage.",
    );
    const actualIndex = await this.gitWriteTree(repository, context.signal);
    assertGitSha(
      "GIT_INDEX_CHANGED",
      parsed.expectedIndexTreeSha,
      actualIndex,
      "Git index changed before unstage.",
    );
    const paths = this.authorizeGitPaths(repository, parsed.paths);
    await this.gitSuccess(
      repository,
      this.gitMutationArgs(repository.workspace, ["restore", "--staged", "--", ...paths]),
      context.signal,
    );
    return {
      root: repository.logicalRoot,
      headSha: await this.gitHeadSha(repository, context.signal),
      indexTreeSha: await this.gitWriteTree(repository, context.signal),
      paths,
    };
  }

  async commit(
    input: GitCommitInput,
    context: OperationContext = {},
  ): Promise<GitCommitResult> {
    const parsed = gitCommitInputSchema.parse(input);
    const repository = await this.resolveGitRepository(
      parsed.workspaceId,
      parsed.root ?? ".",
      context.signal,
    );
    const branch = await this.gitCurrentBranch(repository, context.signal);
    assertTypedGitBranchMutationAllowed({ operation: "git_commit", currentBranch: branch });
    const actualHead = await this.gitHeadSha(repository, context.signal);
    assertGitSha(
      "GIT_HEAD_MISMATCH",
      parsed.expectedHeadSha,
      actualHead,
      "Git HEAD changed before commit.",
    );
    const actualIndex = await this.gitWriteTree(repository, context.signal);
    assertGitSha(
      "GIT_INDEX_CHANGED",
      parsed.expectedIndexTreeSha,
      actualIndex,
      "Git index changed before commit.",
    );
    await this.gitSuccess(
      repository,
      this.gitMutationArgs(repository.workspace, ["commit", "-m", parsed.message]),
      context.signal,
    );
    return {
      root: repository.logicalRoot,
      branch,
      commitSha: await this.gitHeadSha(repository, context.signal),
    };
  }

  async mergeBranch(
    input: GitMergeBranchInput,
    context: OperationContext = {},
  ): Promise<GitMergeBranchResult> {
    const parsed = gitMergeBranchInputSchema.parse(input);
    const repository = await this.resolveGitRepository(
      parsed.workspaceId,
      parsed.root ?? ".",
      context.signal,
    );
    const branch = await this.gitCurrentBranch(repository, context.signal);
    assertTypedGitBranchMutationAllowed({
      operation: "git_merge_branch",
      currentBranch: branch,
    });
    const targetHead = await this.gitHeadSha(repository, context.signal);
    assertGitSha(
      "GIT_HEAD_MISMATCH",
      parsed.expectedTargetHeadSha,
      targetHead,
      "Git target HEAD changed before merge.",
    );
    const sourceHead = await this.gitBranchSha(
      repository,
      parsed.sourceBranch,
      context.signal,
    );
    if (sourceHead === undefined || sourceHead !== parsed.expectedSourceHeadSha) {
      throw new AppError("GIT_HEAD_MISMATCH", "Git source branch changed before merge.");
    }
    if (
      !(await this.gitIsClean(repository, ["diff", "--cached", "--quiet"], context.signal)) ||
      !(await this.gitIsClean(repository, ["diff", "--quiet"], context.signal))
    ) {
      throw new AppError(
        "GIT_MERGE_NOT_FAST_FORWARD",
        "Git repository must have a clean index and worktree before merge.",
      );
    }
    if (
      !(await this.gitIsClean(
        repository,
        ["merge-base", "--is-ancestor", targetHead, sourceHead],
        context.signal,
      ))
    ) {
      throw new AppError(
        "GIT_MERGE_NOT_FAST_FORWARD",
        "Git source branch cannot fast-forward the current branch.",
      );
    }
    await this.gitSuccess(
      repository,
      this.gitMutationArgs(repository.workspace, ["merge", "--ff-only", sourceHead]),
      context.signal,
    );
    const headSha = await this.gitHeadSha(repository, context.signal);
    if (headSha !== sourceHead) {
      throw new AppError(
        "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
        "Git merge completed with an unexpected repository state.",
      );
    }
    return {
      root: repository.logicalRoot,
      branch,
      previousHeadSha: targetHead,
      headSha,
      sourceHeadSha: sourceHead,
      fastForwarded: true,
    };
  }

  async pushBranch(
    input: GitPushBranchInput,
    context: OperationContext = {},
  ): Promise<GitPushBranchResult> {
    const parsed = gitPushBranchInputSchema.parse(input);
    assertTypedGitBranchMutationAllowed({
      operation: "git_push_branch",
      branch: parsed.branch,
    });
    const repository = await this.resolveGitRepository(
      parsed.workspaceId,
      parsed.root ?? ".",
      context.signal,
    );
    const localSha = await this.gitBranchSha(repository, parsed.branch, context.signal);
    if (localSha === undefined || localSha !== parsed.expectedLocalSha) {
      throw new AppError("GIT_HEAD_MISMATCH", "Git branch changed before push.");
    }
    const remoteSha = await this.gitRemoteBranchSha(
      repository,
      parsed.remote,
      parsed.branch,
      context.signal,
    );
    if (parsed.expectedRemoteSha !== undefined && remoteSha !== parsed.expectedRemoteSha) {
      throw new AppError("GIT_REMOTE_CHANGED", "Git remote branch changed before push.");
    }

    try {
      await this.gitSuccess(
        repository,
        this.gitMutationArgs(repository.workspace, [
          "push",
          parsed.remote,
          `${localSha}:refs/heads/${parsed.branch}`,
        ]),
        context.signal,
        120_000,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === "OPERATION_CANCELLED") throw error;
      return this.reconcileGitPush(
        repository,
        parsed.remote,
        parsed.branch,
        localSha,
        context.signal,
      );
    }
    return this.reconcileGitPush(
      repository,
      parsed.remote,
      parsed.branch,
      localSha,
      context.signal,
    );
  }

  private async resolveGitRepository(
    workspaceId: string,
    root: string,
    signal?: AbortSignal,
    requireWrites = true,
  ): Promise<RemoteGitRepositoryContext> {
    const workspace = this.workspace(workspaceId);
    if (requireWrites) this.assertWritesEnabled(workspace);
    const logicalRoot = this.authorizeGitRoot(workspace, root);
    const inside = await this.gitInvoke(
      { workspace, logicalRoot },
      ["rev-parse", "--is-inside-work-tree"],
      [0, 128],
      signal,
    );
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      throw new AppError(
        "NOT_GIT_REPOSITORY",
        "The selected workspace root is not inside a Git worktree.",
      );
    }

    let topLevel: string;
    try {
      topLevel = (
        await this.gitSuccess(
          { workspace, logicalRoot },
          ["rev-parse", "--show-toplevel"],
          signal,
        )
      ).trim();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "GIT_ERROR") throw error;
      throw new AppError(
        "NOT_GIT_REPOSITORY",
        "Unable to resolve the selected Git repository.",
      );
    }
    const expectedTopLevel = logicalRoot === "."
      ? path.win32.normalize(workspace.rootPath)
      : path.win32.normalize(path.win32.join(workspace.rootPath, ...logicalRoot.split("/")));
    if (!sameWindowsPath(topLevel, expectedTopLevel)) {
      throw new AppError(
        "NOT_GIT_REPOSITORY",
        "Git mutations require the selected authorized root to be the repository top-level.",
      );
    }
    return { workspace, logicalRoot };
  }

  private authorizeGitRoot(workspace: RemoteWorkspace, value: string): string {
    const logical = normalizeRelativePath(value, true);
    if (this.isBlocked(workspace, logical)) {
      throw new AppError("BLOCKED_PATH", "Path is blocked by workspace policy.");
    }
    const authorized = workspace.allowedRoots.some((allowedRoot) => {
      const allowed = normalizeRelativePath(allowedRoot, true);
      return logicalContains(allowed, logical) || logicalContains(logical, allowed);
    });
    if (!authorized) {
      throw new AppError(
        "PATH_OUTSIDE_ALLOWED_ROOTS",
        "Git root must be an allowed path or an ancestor of an allowed root.",
      );
    }
    return logical;
  }

  private authorizeGitPaths(
    repository: RemoteGitRepositoryContext,
    paths: readonly string[],
  ): string[] {
    return paths.map((candidate) => {
      const normalized = normalizeRelativePath(candidate, false);
      this.authorizeWrite(
        repository.workspace,
        joinLogical(repository.logicalRoot, normalized),
      );
      return normalized;
    });
  }

  private async gitInvoke(
    repository: RemoteGitRepositoryContext,
    args: readonly string[],
    acceptedExitCodes: readonly number[] = [0],
    signal?: AbortSignal,
    timeoutMs = 60_000,
  ): Promise<RemoteProcessResult> {
    const result = await this.transport.exec(
      repository.workspace.rootPath,
      repository.logicalRoot,
      "git",
      args,
      timeoutMs,
      signal,
    );
    if (
      result.timedOut ||
      result.exitCode === null ||
      !acceptedExitCodes.includes(result.exitCode)
    ) {
      throw new AppError("GIT_ERROR", "Git command failed.");
    }
    return result;
  }

  private async gitSuccess(
    repository: RemoteGitRepositoryContext,
    args: readonly string[],
    signal?: AbortSignal,
    timeoutMs = 60_000,
  ): Promise<string> {
    return (await this.gitInvoke(repository, args, [0], signal, timeoutMs)).stdout;
  }

  private async gitHeadSha(
    repository: RemoteGitRepositoryContext,
    signal?: AbortSignal,
  ): Promise<string> {
    return parseGitSha(
      (
        await this.gitSuccess(repository, ["rev-parse", "HEAD"], signal)
      ).trim(),
    );
  }

  private async gitCurrentBranch(
    repository: RemoteGitRepositoryContext,
    signal?: AbortSignal,
  ): Promise<string> {
    return (
      await this.gitSuccess(
        repository,
        ["rev-parse", "--abbrev-ref", "HEAD"],
        signal,
      )
    ).trim();
  }

  private async gitBranchSha(
    repository: RemoteGitRepositoryContext,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const result = await this.gitInvoke(
      repository,
      ["rev-parse", "--verify", `refs/heads/${branch}`],
      [0, 128],
      signal,
    );
    return result.exitCode === 0 ? parseGitSha(result.stdout.trim()) : undefined;
  }

  private async gitWriteTree(
    repository: RemoteGitRepositoryContext,
    signal?: AbortSignal,
  ): Promise<string> {
    return parseGitSha(
      (await this.gitSuccess(repository, ["write-tree"], signal)).trim(),
    );
  }

  private async gitIsClean(
    repository: RemoteGitRepositoryContext,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    return (await this.gitInvoke(repository, args, [0, 1], signal)).exitCode === 0;
  }

  private async gitRemoteBranchSha(
    repository: RemoteGitRepositoryContext,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const output = (
      await this.gitSuccess(
        repository,
        ["ls-remote", "--heads", remote, branch],
        signal,
        120_000,
      )
    ).trim();
    if (output.length === 0) return undefined;
    const [sha] = output.split(/\s+/u);
    return sha === undefined ? undefined : parseGitSha(sha);
  }

  private async reconcileGitPush(
    repository: RemoteGitRepositoryContext,
    remote: string,
    branch: string,
    localSha: string,
    signal?: AbortSignal,
  ): Promise<GitPushBranchResult> {
    const reconciledRemoteSha = await this.gitRemoteBranchSha(
      repository,
      remote,
      branch,
      signal,
    );
    if (reconciledRemoteSha !== localSha) {
      throw new AppError(
        "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
        "Git push outcome requires reconciliation.",
      );
    }
    return {
      status: "completed",
      root: repository.logicalRoot,
      remote,
      branch,
      localSha,
      remoteSha: reconciledRemoteSha,
    };
  }

  private gitMutationArgs(
    workspace: RemoteWorkspace,
    args: readonly string[],
  ): readonly string[] {
    const disabledHooksPath = path.win32.join(
      workspace.rootPath,
      ".runtime-tools",
      `.mcp-git-disabled-hooks-${randomUUID()}`,
    );
    return [
      "-c",
      `core.hooksPath=${disabledHooksPath}`,
      "-c",
      "commit.gpgSign=false",
      "-c",
      "merge.gpgSign=false",
      ...args,
    ];
  }
  async getRepository(
    input: GitHubGetRepositoryInput,
    context: OperationContext = {},
  ): Promise<GitHubRepositoryResult> {
    const parsed = githubGetRepositoryInputSchema.parse(input);
    const workspace = this.workspace(parsed.workspaceId);
    const repository = `${parsed.owner}/${parsed.repository}`;
    await this.assertGitHubRepositoryCapability(
      workspace,
      "github.repository.read",
      repository,
      parsed.root ?? ".",
      false,
      context.signal,
    );
    return this.gitHubServiceFor(workspace).getRepository(parsed, context);
  }

  async createRepository(
    input: GitHubCreateRepositoryInput,
    context: OperationContext = {},
  ): Promise<GitHubCreateRepositoryResult> {
    const parsed = githubCreateRepositoryInputSchema.parse(input);
    const workspace = this.workspace(parsed.workspaceId);
    return this.executeGitHubMutation({
      workspace,
      operation: "github_create_repository",
      confirmableOperation: "github_create_repository",
      capability: "github.repository.create",
      accountOwner: parsed.owner,
      targetResource: `github:${parsed.owner}/${parsed.name}`,
      input: parsed,
      context,
      resultSchema: githubCreateRepositoryResultSchema,
      backend: () => this.gitHubServiceFor(workspace).createRepository(parsed, context),
    });
  }

  async getPullRequest(
    input: GitHubGetPullRequestInput,
    context: OperationContext = {},
  ): Promise<GitHubPullRequestResult> {
    const parsed = githubGetPullRequestInputSchema.parse(input);
    const workspace = this.workspace(parsed.workspaceId);
    const repository = `${parsed.owner}/${parsed.repository}`;
    await this.assertGitHubRepositoryCapability(
      workspace,
      "github.pull_request.read",
      repository,
      parsed.root ?? ".",
      false,
      context.signal,
    );
    return this.gitHubServiceFor(workspace).getPullRequest(parsed, context);
  }

  async createPullRequest(
    input: GitHubCreatePullRequestInput,
    context: OperationContext = {},
  ): Promise<GitHubCreatePullRequestResult> {
    const parsed = githubCreatePullRequestInputSchema.parse(input);
    const workspace = this.workspace(parsed.workspaceId);
    const repository = `${parsed.owner}/${parsed.repository}`;
    await this.assertGitHubRepositoryCapability(
      workspace,
      "github.pull_request.create",
      repository,
      parsed.root ?? ".",
      true,
      context.signal,
    );
    const confirmableOperation = sourceControlConfirmationOperation(
      workspace,
      "github_create_pull_request",
      parsed.head,
    );
    return this.executeGitHubMutation({
      workspace,
      operation: "github_create_pull_request",
      ...(confirmableOperation === undefined ? {} : { confirmableOperation }),
      capability: "github.pull_request.create",
      repository,
      canonicalRepositoryAlreadyAuthorized: true,
      targetResource: `github:${repository}:pulls:${parsed.head}->${parsed.base}`,
      input: parsed,
      context,
      resultSchema: githubCreatePullRequestResultSchema,
      backend: () => this.gitHubServiceFor(workspace).createPullRequest(parsed, context),
    });
  }

  async mergePullRequest(
    input: GitHubMergePullRequestInput,
    context: OperationContext = {},
  ): Promise<GitHubMergePullRequestResult> {
    const parsed = githubMergePullRequestInputSchema.parse(input);
    const workspace = this.workspace(parsed.workspaceId);
    const repository = `${parsed.owner}/${parsed.repository}`;
    await this.assertGitHubRepositoryCapability(
      workspace,
      "github.pull_request.merge",
      repository,
      parsed.root ?? ".",
      true,
      context.signal,
    );
    return this.executeGitHubMutation({
      workspace,
      operation: "github_merge_pull_request",
      confirmableOperation: "github_merge_pull_request",
      capability: "github.pull_request.merge",
      repository,
      canonicalRepositoryAlreadyAuthorized: true,
      targetResource: `github:${repository}:pull/${parsed.pullNumber}`,
      input: parsed,
      context,
      resultSchema: githubMergePullRequestResultSchema,
      backend: () => this.gitHubServiceFor(workspace).mergePullRequest(parsed, context),
    });
  }

  private gitHubServiceFor(workspace: RemoteWorkspace): GitHubService {
    return new GitHubService(
      new SshGitHubApiClient({
        transport: this.transport,
        rootPath: workspace.rootPath,
      }),
    );
  }

  private async assertGitHubRepositoryCapability(
    workspace: RemoteWorkspace,
    capability: SourceControlCapability,
    repository: string,
    root: string,
    mutation: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const configuredAdditional =
      workspace.sourceControl?.additionalRepositories.some(
        (candidate) =>
          candidate.toLocaleLowerCase("en-US") ===
          repository.toLocaleLowerCase("en-US"),
      ) ?? false;
    const canonicalRepository = configuredAdditional
      ? undefined
      : await this.canonicalGitHubRepository(workspace.id, root, signal);
    assertSourceControlCapability({
      policy: {
        permissionProfile: workspace.permissionProfile,
        ...(workspace.sourceControl === undefined
          ? {}
          : { sourceControl: workspace.sourceControl }),
      },
      capability,
      repository,
      ...(canonicalRepository === undefined ? {} : { canonicalRepository }),
      mutation,
    });
  }

  private async canonicalGitHubRepository(
    workspaceId: string,
    root: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    try {
      const repository = await this.resolveGitRepository(
        workspaceId,
        root,
        signal,
        false,
      );
      const origin = (
        await this.gitSuccess(
          repository,
          ["remote", "get-url", "origin"],
          signal,
        )
      ).trim();
      return parseGitHubRepositoryOrigin(origin);
    } catch {
      return undefined;
    }
  }

  private async executeGitHubMutation<
    TInput extends { workspaceId: string },
    TResult
  >(options: {
    workspace: RemoteWorkspace;
    operation: SourceControlOperationName;
    confirmableOperation?:
      | "github_create_repository"
      | "github_create_pull_request"
      | "github_merge_pull_request";
    capability: SourceControlCapability;
    repository?: string;
    canonicalRepositoryAlreadyAuthorized?: boolean;
    accountOwner?: string;
    targetResource: string;
    input: TInput;
    context: OperationContext;
    resultSchema: { parse(value: unknown): TResult };
    backend: () => Promise<unknown>;
  }): Promise<TResult> {
    if (!options.canonicalRepositoryAlreadyAuthorized) {
      assertSourceControlCapability({
        policy: {
          permissionProfile: options.workspace.permissionProfile,
          ...(options.workspace.sourceControl === undefined
            ? {}
            : { sourceControl: options.workspace.sourceControl }),
        },
        capability: options.capability,
        ...(options.repository === undefined
          ? {}
          : { repository: options.repository }),
        ...(options.accountOwner === undefined
          ? {}
          : { accountOwner: options.accountOwner }),
        mutation: true,
      });
    }

    const digest = canonicalSourceControlArgumentsDigest(options.input);
    const idempotencyKey = deriveSourceControlIdempotencyKey(
      options.input,
      options.context,
    );
    const identity = {
      workspaceId: options.workspace.id,
      operation: options.operation,
      targetResource: options.targetResource,
      canonicalArgumentsDigest: digest,
      idempotencyKey,
    };
    const store = this.mutationReceiptStoreFor(options.workspace);
    const existing = await store.get(idempotencyKey);
    if (existing !== undefined) {
      const reservation = await store.reserve(identity);
      if (reservation.disposition === "replay_completed") {
        return options.resultSchema.parse(reservation.receipt.result);
      }
      throw reconciliationRequired();
    }

    if (options.confirmableOperation !== undefined) {
      const binding = {
        workspaceId: options.workspace.id,
        operation: options.confirmableOperation,
        targetResource: options.targetResource,
        canonicalArgumentsDigest: digest,
      };
      const confirmationId = readConfirmationId(options.input);
      if (confirmationId === undefined) {
        const confirmation = this.typedConfirmationRegistry.create(binding);
        return options.resultSchema.parse({
          status: "confirmation_required",
          confirmationId: confirmation.confirmationId,
          expiresAt: confirmation.expiresAt,
          operation: options.confirmableOperation,
          targetResource: options.targetResource,
        });
      }
      this.typedConfirmationRegistry.consume(confirmationId, binding);
    }

    const reservation = await store.reserve(identity);
    if (reservation.disposition === "replay_completed") {
      return options.resultSchema.parse(reservation.receipt.result);
    }
    if (reservation.disposition !== "execute") {
      throw reconciliationRequired();
    }

    await store.markExecuting(identity);
    try {
      const result = options.resultSchema.parse(await options.backend());
      await store.markCompleted(identity, result);
      return result;
    } catch (error) {
      try {
        await store.markReconciliationRequired(identity);
      } catch {}
      throw error;
    }
  }

  private mutationReceiptStoreFor(
    workspace: RemoteWorkspace,
  ): MutationReceiptStore {
    const existing = this.mutationReceiptStores.get(workspace.id);
    if (existing !== undefined) return existing;
    const workspaceKey = createHash("sha256")
      .update(workspace.id)
      .digest("hex");
    const store = new FileMutationReceiptStore(
      path.join(this.sourceControlStateDirectory, workspaceKey),
    );
    this.mutationReceiptStores.set(workspace.id, store);
    return store;
  }
}

function deriveSourceControlIdempotencyKey(
  input: unknown,
  context: OperationContext,
): string {
  const confirmationId = readConfirmationId(input);
  const value =
    context.idempotencyKey ??
    confirmationId ??
    context.invocationId ??
    context.correlationId;
  if (value === undefined) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Source-control mutation requires an idempotency, invocation, correlation or confirmation identity.",
    );
  }
  return value;
}

function sourceControlConfirmationOperation(
  workspace: RemoteWorkspace,
  operation: "github_create_pull_request",
  sourceBranch: string,
): "github_create_pull_request" | undefined {
  const trusted =
    workspace.confirmationMode === "trusted-workspace" &&
    workspace.permissionProfile === "full-repo-write";
  const sourceIsProtectedMain =
    sourceBranch.toLocaleLowerCase("en-US") === "main";
  return trusted && !sourceIsProtectedMain ? undefined : operation;
}

function readConfirmationId(input: unknown): string | undefined {
  if (
    typeof input === "object" &&
    input !== null &&
    "confirmationId" in input &&
    typeof input.confirmationId === "string" &&
    input.confirmationId.length > 0
  ) {
    return input.confirmationId;
  }
  return undefined;
}

function parseGitHubRepositoryOrigin(origin: string): string | undefined {
  const value = origin.trim();
  if (value.length === 0 || value.includes("?") || value.includes("#")) {
    return undefined;
  }

  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/iu.exec(value);
  if (scp !== null) {
    return parseGitHubOwnerRepository(scp[1], scp[2]);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") ||
    parsed.hostname.toLocaleLowerCase("en-US") !== "github.com" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return undefined;
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) return undefined;
  return parseGitHubOwnerRepository(segments[0], segments[1]);
}

function parseGitHubOwnerRepository(
  owner: string | undefined,
  rawRepository: string | undefined,
): string | undefined {
  if (owner === undefined || rawRepository === undefined) return undefined;
  const repository = rawRepository.toLocaleLowerCase("en-US").endsWith(".git")
    ? rawRepository.slice(0, -4)
    : rawRepository;
  const fullName = `${owner}/${repository}`;
  return githubRepositoryFullNameSchema.safeParse(fullName).success
    ? fullName
    : undefined;
}

function reconciliationRequired(): AppError {
  return new AppError(
    "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
    "The source-control mutation requires reconciliation before another backend invocation.",
  );
}

function assertGitSha(
  code: "GIT_HEAD_MISMATCH" | "GIT_INDEX_CHANGED",
  expected: string,
  actual: string,
  message: string,
): void {
  if (expected !== actual) throw new AppError(code, message);
}

function parseGitSha(value: string): string {
  if (!/^[a-f0-9]{40}$/iu.test(value)) {
    throw new AppError("GIT_ERROR", "Git returned an invalid object id.");
  }
  return value.toLocaleLowerCase("en-US");
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.normalize(left).toLocaleLowerCase("en-US") ===
    path.win32.normalize(right).toLocaleLowerCase("en-US");
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
  requested: ShellName,
  allowed: readonly ShellName[],
): ShellName {
  if (!allowed.includes(requested)) {
    throw new AppError("SHELL_NOT_ALLOWED", "Workspace policy does not allow the requested shell.");
  }
  return requested;
}
