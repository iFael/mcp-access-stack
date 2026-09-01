import { createHash } from "node:crypto";
import path from "node:path";
import {
  AppError,
  disabledQualifiedCommandFeatureFlags,
  asAppError,
  cancelBackgroundTaskInputSchema,
  getBackgroundTaskInputSchema,
  waitBackgroundTaskInputSchema,
  listBackgroundTasksInputSchema,
  readBackgroundTaskLogsInputSchema,
  startBackgroundTaskInputSchema,
  inspectGitInputSchema,
  getWorkspaceContextInputSchema,
  listFilesInputSchema,
  listWorkspaceRootsInputSchema,
  patchFileInputSchema,
  readFileInputSchema,
  readBinaryFileInputSchema,
  runWorkspaceValidationInputSchema,
  runCommandInputSchema,
  runPowerShellInputSchema,
  writeFileInputSchema,
  searchFilesInputSchema,
  type BackgroundTaskListResult,
  type BackgroundTaskLogsLookupResult,
  type BackgroundTaskResult,
  type BackgroundTaskWaitResult,
  type CancelBackgroundTaskInput,
  type DirectRunCommandInput,
  type GetBackgroundTaskInput,
  type WaitBackgroundTaskInput,
  type ListBackgroundTasksInput,
  type ReadBackgroundTaskLogsInput,
  type StartBackgroundTaskInput,
  type PolicyFile,
  type QualifiedCommandFeatureFlags,
  type AuditEntry,
  type InspectGitInput,
  type InspectGitResult,
  type GetWorkspaceContextInput,
  type GetWorkspaceContextResult,
  type ListFilesInput,
  type ListFilesResult,
  type ListWorkspaceRootsInput,
  type ListWorkspaceRootsResult,
  type OperationContext,
  type PatchFileInput,
  type PatchFileResult,
  type ReadFileInput,
  type ReadFileResult,
  type ReadBinaryFileInput,
  type ReadBinaryFileResult,
  type RunWorkspaceValidationInput,
  type RunWorkspaceValidationResult,
  type RunCommandInput,
  type RunCommandResult,
  type RunPowerShellInput,
  type RunPowerShellResult,
  type SearchFilesInput,
  type SearchFilesResult,
  type WriteFileInput,
  type WriteFileResult,
  type WorkspaceSummary,
} from "@vs-code-gpt/shared";
import {
  TypedConfirmationRegistry,
  assertSourceControlCapability,
  assertTypedGitBranchMutationAllowed,
  canonicalSourceControlArgumentsDigest,
  gitCommitInputSchema,
  gitCommitResultSchema,
  gitCreateBranchInputSchema,
  gitCreateBranchResultSchema,
  gitMergeBranchInputSchema,
  gitMergeBranchResultSchema,
  gitPushBranchInputSchema,
  gitPushBranchResultSchema,
  gitStagePathsInputSchema,
  gitStagePathsResultSchema,
  gitUnstagePathsInputSchema,
  gitUnstagePathsResultSchema,
  githubCreatePullRequestInputSchema,
  githubCreatePullRequestResultSchema,
  githubCreateRepositoryInputSchema,
  githubCreateRepositoryResultSchema,
  githubGetPullRequestInputSchema,
  githubGetRepositoryInputSchema,
  githubMergePullRequestInputSchema,
  githubMergePullRequestResultSchema,
  githubPullRequestResultSchema,
  githubRepositoryFullNameSchema,
  githubRepositoryResultSchema,
  type GitCommitInput,
  type GitCommitResult,
  type GitCreateBranchInput,
  type GitCreateBranchResult,
  type GitHubCreatePullRequestInput,
  type GitHubCreatePullRequestResult,
  type GitHubCreateRepositoryInput,
  type GitHubCreateRepositoryResult,
  type GitHubExecutor,
  type GitHubGetPullRequestInput,
  type GitHubGetRepositoryInput,
  type GitHubMergePullRequestInput,
  type GitHubMergePullRequestResult,
  type GitHubPullRequestResult,
  type GitHubRepositoryResult,
  type GitMergeBranchInput,
  type GitMergeBranchResult,
  type GitPushBranchInput,
  type GitPushBranchResult,
  type GitRepositoryExecutor,
  type GitStagePathsInput,
  type GitStagePathsResult,
  type GitUnstagePathsInput,
  type GitUnstagePathsResult,
  type MutationReceiptStore,
  type SourceControlCapability,
  type SourceControlOperationName,
} from "@vs-code-gpt/shared";
import { AuditLogger } from "./audit-log.js";
import type { ResolvedWorkspace } from "./internal-types.js";
import { FileService } from "./filesystem/service.js";
import { GitService } from "./git/service.js";
import { routeRunCommandInput } from "./shell/qualified-command-compatibility.js";
import { QualifiedCommandOrchestrator } from "./shell/qualified/command-orchestrator.js";
import { QualifiedCommandPlanQualifier } from "./shell/qualified/command-plan-qualifier.js";
import type { QualifiedCommandProvider } from "./shell/qualified/command-provider.js";
import { CommandInvocationRegistry } from "./shell/qualified/invocation-registry.js";
import {
  QualifiedCommandMetrics,
  type QualifiedCommandMetricsSnapshot,
  type QualifiedCommandTelemetryEvent,
} from "./shell/qualified/qualified-command-metrics.js";
import { ShellService } from "./shell/service.js";
import { terminateProcessTreeByPid } from "./shell/process-runner.js";
import { BackgroundTaskManager } from "./tasks/background-task-manager.js";
import { ValidationService } from "./validation/service.js";
import { assertPermission, type WorkspaceOperation } from "./permission-profile.js";
import { buildWorkspaceContext } from "./workspace-context-service.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import { FileMutationReceiptStore } from "./source-control/file-mutation-receipt-store.js";
import { GhCliUserCredentialProvider } from "./source-control/gh-cli-user-credential-provider.js";
import { GitHubHttpClient } from "./source-control/github-http-client.js";
import { GitHubService } from "./source-control/github-service.js";
import { GitRepositoryService } from "./source-control/git-repository-service.js";

interface AuditMetadata {
  path?: string;
  query?: string;
  sourceControlCapability?: SourceControlCapability;
  targetResource?: string;
  expectedSha?: string;
  resultSha?: string;
  idempotencyOutcome?: "executed" | "completed_replay" | "confirmation_required";
}

interface GitOriginResolver {
  canonicalOriginUrl(workspaceId: string, root?: string, signal?: AbortSignal): Promise<string>;
}

export interface LocalAgentOptions {
  qualifiedCommandFeatures?: QualifiedCommandFeatureFlags;
  qualifiedInvocationStateDirectory?: string;
  qualifiedCommandProvider?: QualifiedCommandProvider;
  qualifiedCommandWorkspaceAllowlist?: readonly string[];
  qualifiedCommandTelemetry?: (event: QualifiedCommandTelemetryEvent) => void;
  gitRepositoryExecutor?: GitRepositoryExecutor;
  gitOriginResolver?: GitOriginResolver;
  githubExecutor?: GitHubExecutor;
  typedConfirmationRegistry?: TypedConfirmationRegistry;
  mutationReceiptStore?: MutationReceiptStore;
}

export class LocalAgent {
  private readonly fileService = new FileService();
  private readonly gitService = new GitService();
  private readonly shellService = new ShellService();
  private readonly qualifiedCommandFeatures: QualifiedCommandFeatureFlags;
  private readonly qualifiedCommandOrchestrator: QualifiedCommandOrchestrator;
  private readonly qualifiedCommandQualifier: QualifiedCommandPlanQualifier;
  private readonly qualifiedCommandMetrics: QualifiedCommandMetrics;
  private readonly qualifiedCommandWorkspaceAllowlist: ReadonlySet<string> | undefined;
  private readonly qualifiedCommandProvider: QualifiedCommandProvider | undefined;
  private readonly qualifiedCommandShadowQualifier: QualifiedCommandPlanQualifier;
  private readonly qualifiedInvocationRegistry: CommandInvocationRegistry;
  private readonly qualifiedShadowTasks = new Set<Promise<void>>();
  private readonly validationService = new ValidationService();
  private readonly backgroundTaskManager: BackgroundTaskManager;
  private readonly injectedGitRepositoryExecutor: GitRepositoryExecutor | undefined;
  private readonly injectedGitOriginResolver: GitOriginResolver | undefined;
  private readonly injectedGitHubExecutor: GitHubExecutor | undefined;
  private readonly typedConfirmationRegistry: TypedConfirmationRegistry;
  private readonly injectedMutationReceiptStore: MutationReceiptStore | undefined;
  private readonly mutationReceiptStores = new Map<string, MutationReceiptStore>();
  private gitRepositoryServicePromise: Promise<GitRepositoryService> | undefined;
  private gitHubExecutorPromise: Promise<GitHubExecutor> | undefined;

  private constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly audit: AuditLogger,
    options: LocalAgentOptions = {},
  ) {
    this.injectedGitRepositoryExecutor = options.gitRepositoryExecutor;
    this.injectedGitOriginResolver = options.gitOriginResolver;
    this.injectedGitHubExecutor = options.githubExecutor;
    this.typedConfirmationRegistry = options.typedConfirmationRegistry ?? new TypedConfirmationRegistry();
    this.injectedMutationReceiptStore = options.mutationReceiptStore;
    this.qualifiedCommandFeatures =
      options.qualifiedCommandFeatures ?? disabledQualifiedCommandFeatureFlags;
    this.qualifiedCommandMetrics = new QualifiedCommandMetrics(
      options.qualifiedCommandTelemetry,
    );
    this.qualifiedCommandWorkspaceAllowlist =
      options.qualifiedCommandWorkspaceAllowlist === undefined
        ? undefined
        : new Set(options.qualifiedCommandWorkspaceAllowlist);
    if (
      this.qualifiedCommandFeatures.providerEnabled === true &&
      options.qualifiedCommandProvider === undefined
    ) {
      throw new AppError(
        "POLICY_INVALID",
        "The command provider is enabled but not configured.",
      );
    }
    this.qualifiedCommandProvider =
      this.qualifiedCommandFeatures.providerEnabled === true
        ? options.qualifiedCommandProvider
        : undefined;
    this.qualifiedCommandQualifier = new QualifiedCommandPlanQualifier(
      undefined,
      undefined,
      undefined,
      this.qualifiedCommandProvider,
    );
    this.qualifiedCommandShadowQualifier = new QualifiedCommandPlanQualifier();
    this.qualifiedInvocationRegistry = new CommandInvocationRegistry({
      stateDirectory:
        options.qualifiedInvocationStateDirectory ??
        resolveQualifiedInvocationStateDirectory(),
    });
    this.qualifiedCommandOrchestrator = new QualifiedCommandOrchestrator({
      qualifier: this.qualifiedCommandQualifier,
      metrics: this.qualifiedCommandMetrics,
      ...(this.qualifiedCommandProvider === undefined
        ? {}
        : { repairProvider: this.qualifiedCommandProvider }),
      registry: this.qualifiedInvocationRegistry,
      shellService: this.shellService,
    });
    this.backgroundTaskManager = new BackgroundTaskManager({
      stateDirectory: resolveBackgroundTaskStateDirectory(),
      runner: {
        start: (input, signal, execution) => {
          const workspace = this.registry.get(input.workspaceId);
          return this.shellService.runCommandToFiles(
            workspace,
            input,
            {
              stdoutPath: execution.stdoutPath,
              stderrPath: execution.stderrPath,
              onPid: execution.onPid,
              ...(execution.transformOutput === undefined
                ? {}
                : { transformOutput: execution.transformOutput }),
            },
            signal,
          );
        },
        terminate: terminateProcessTreeByPid,
      },
    });
  }

  static async create(
    policyPath: string,
    options: LocalAgentOptions = {},
  ): Promise<LocalAgent> {
    const registry = await WorkspaceRegistry.load(policyPath);
    return LocalAgent.createFromRegistry(registry, options);
  }

  static async createFromPolicy(
    policy: PolicyFile,
    options: LocalAgentOptions = {},
  ): Promise<LocalAgent> {
    const registry = await WorkspaceRegistry.fromPolicy(policy);
    return LocalAgent.createFromRegistry(registry, options);
  }

  private static async createFromRegistry(
    registry: WorkspaceRegistry,
    options: LocalAgentOptions,
  ): Promise<LocalAgent> {
    const audit = await AuditLogger.create(registry.all());
    return new LocalAgent(registry, audit, options);
  }

  resolveWorkspaceConcurrencyKey(workspaceId: string): string {
    const workspace = this.registry.get(workspaceId);
    const canonical = path.resolve(workspace.canonicalRootPath);
    return process.platform === "win32"
      ? canonical.toLocaleLowerCase("en-US")
      : canonical;
  }

  async listWorkspaces(context: OperationContext = {}): Promise<WorkspaceSummary[]> {
    const startedAt = performance.now();
    try {
      const result = this.registry.listEnabled();
      await this.audit.write({
        timestamp: new Date().toISOString(),
        operation: "listWorkspaces",
        workspaceId: "-",
        ...(context.correlationId === undefined
          ? {}
          : { correlationId: context.correlationId }),
        resultSize: serializedSize(result),
        durationMs: elapsed(startedAt),
        status: "allowed",
      });
      return result;
    } catch (error) {
      const appError = asAppError(error);
      await this.audit.write({
        timestamp: new Date().toISOString(),
        operation: "listWorkspaces",
        workspaceId: "-",
        ...(context.correlationId === undefined
          ? {}
          : { correlationId: context.correlationId }),
        durationMs: elapsed(startedAt),
        status: "error",
        reason: appError.code,
      });
      throw appError;
    }
  }

  async listWorkspaceRoots(
    input: ListWorkspaceRootsInput,
    context: OperationContext = {},
  ): Promise<ListWorkspaceRootsResult> {
    return this.runValidatedAudited(
      "listWorkspaceRoots",
      "list",
      listWorkspaceRootsInputSchema,
      input,
      context,
      () => ({}),
      (workspace, _parsed, activeContext) =>
        this.fileService.listWorkspaceRoots(workspace, activeContext.signal),
    );
  }

  async listFiles(
    input: ListFilesInput,
    context: OperationContext = {},
  ): Promise<ListFilesResult> {
    return this.runValidatedAudited(
      "listFiles",
      "list",
      listFilesInputSchema,
      input,
      context,
      (parsed) => (parsed.root === undefined ? {} : { path: parsed.root }),
      (workspace, parsed, activeContext) =>
        this.fileService.listFiles(workspace, parsed, activeContext.signal),
    );
  }

  async readFile(
    input: ReadFileInput,
    context: OperationContext = {},
  ): Promise<ReadFileResult> {
    return this.runValidatedAudited(
      "readFile",
      "read",
      readFileInputSchema,
      input,
      context,
      (parsed) => ({ path: parsed.path }),
      (workspace, parsed) => this.fileService.readFile(workspace, parsed),
    );
  }

  async readBinaryFile(
    input: ReadBinaryFileInput,
    context: OperationContext = {},
  ): Promise<ReadBinaryFileResult> {
    return this.runValidatedAudited(
      "readBinaryFile",
      "read",
      readBinaryFileInputSchema,
      input,
      context,
      (parsed) => ({ path: parsed.path }),
      (workspace, parsed) => this.fileService.readBinaryFile(workspace, parsed),
    );
  }

  async writeFile(
    input: WriteFileInput,
    context: OperationContext = {},
  ): Promise<WriteFileResult> {
    return this.runValidatedAudited(
      "writeFile",
      "write",
      writeFileInputSchema,
      input,
      context,
      (parsed) => ({ path: parsed.path }),
      (workspace, parsed) => this.fileService.writeFile(workspace, parsed),
    );
  }

  async patchFile(
    input: PatchFileInput,
    context: OperationContext = {},
  ): Promise<PatchFileResult> {
    return this.runValidatedAudited(
      "patchFile",
      "write",
      patchFileInputSchema,
      input,
      context,
      (parsed) => ({ path: parsed.path }),
      (workspace, parsed) => this.fileService.patchFile(workspace, parsed),
    );
  }

  async runValidation(
    input: RunWorkspaceValidationInput,
    context: OperationContext = {},
  ): Promise<RunWorkspaceValidationResult> {
    return this.runValidatedAudited(
      "runValidation",
      "shell",
      runWorkspaceValidationInputSchema,
      input,
      context,
      (parsed) => ({ path: parsed.root, query: parsed.validation }),
      (workspace, parsed, activeContext) =>
        this.validationService.run(workspace, parsed, activeContext.signal),
    );
  }

  async runPowerShell(
    input: RunPowerShellInput,
    context: OperationContext = {},
  ): Promise<RunPowerShellResult> {
    return this.runValidatedAudited(
      "runPowerShell",
      "shell",
      runPowerShellInputSchema,
      input,
      context,
      (parsed) => (parsed.cwd === undefined ? {} : { path: parsed.cwd }),
      (workspace, parsed, activeContext) =>
        this.shellService.runPowerShell(workspace, parsed, activeContext),
    );
  }

  async runCommand(
    input: RunCommandInput,
    context: OperationContext = {},
  ): Promise<RunCommandResult> {
    return this.runValidatedAudited(
      "runCommand",
      "shell",
      runCommandInputSchema,
      input,
      context,
      (parsed) => (parsed.cwd === undefined ? {} : { path: parsed.cwd }),
      async (workspace, parsed, activeContext) => {
        const routed = routeRunCommandInput(
          parsed,
          this.qualifiedCommandFeatures,
        );
        if (routed.mode === "qualified") {
          this.assertQualifiedWorkspaceAllowed(workspace.id);
          this.qualifiedCommandMetrics.recordRoute("qualified", false);
          return this.runQualifiedCommand(
            workspace,
            routed.input,
            activeContext,
          );
        }
        const shadowEnabled =
          this.qualifiedCommandFeatures.shadowMode === true &&
          this.isQualifiedWorkspaceAllowed(workspace.id);
        this.qualifiedCommandMetrics.recordRoute("direct", shadowEnabled);
        if (shadowEnabled) {
          this.observeQualifiedShadow(
            workspace,
            routed.input,
            activeContext,
          );
        }
        return this.shellService.runCommand(
          workspace,
          routed.input,
          activeContext,
        );
      },
    );
  }

  async startBackgroundTask(
    input: StartBackgroundTaskInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskResult> {
    return this.runValidatedAudited(
      "startBackgroundTask",
      "shell",
      startBackgroundTaskInputSchema,
      input,
      context,
      (parsed) => ({ path: parsed.cwd ?? ".", query: parsed.operation }),
      async (workspace, parsed) => {
        await this.shellService.assertBackgroundCommandAllowed(workspace, parsed);
        return { task: await this.backgroundTaskManager.start_background_task(parsed) };
      },
    );
  }

  async getBackgroundTask(
    input: GetBackgroundTaskInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskResult> {
    return this.runValidatedAudited(
      "getBackgroundTask",
      "read",
      getBackgroundTaskInputSchema,
      input,
      context,
      (parsed) => ({ query: parsed.id }),
      async (_workspace, parsed) => {
        const task = await this.backgroundTaskManager.get_background_task(parsed.id);
        return { task: task?.workspaceId === parsed.workspaceId ? task : null };
      },
    );
  }

  async waitBackgroundTask(
    input: WaitBackgroundTaskInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskWaitResult> {
    return this.runValidatedAudited(
      "waitBackgroundTask",
      "read",
      waitBackgroundTaskInputSchema,
      input,
      context,
      (parsed) => ({ query: parsed.id }),
      async (_workspace, parsed, activeContext) => {
        const current = await this.backgroundTaskManager.get_background_task(parsed.id);
        if (current?.workspaceId !== parsed.workspaceId) {
          return { task: null, logs: null, timedOut: false, elapsedMs: 0 };
        }
        return this.backgroundTaskManager.wait_background_task(parsed.id, {
          timeoutMs: parsed.timeoutMs,
          maxBytes: parsed.maxBytes,
          ...(activeContext.signal === undefined
            ? {}
            : { signal: activeContext.signal }),
        });
      },
    );
  }

  async listBackgroundTasks(
    input: ListBackgroundTasksInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskListResult> {
    return this.runValidatedAudited(
      "listBackgroundTasks",
      "read",
      listBackgroundTasksInputSchema,
      input,
      context,
      () => ({}),
      async (_workspace, parsed) => ({
        tasks: await this.backgroundTaskManager.list_background_tasks({
          workspaceId: parsed.workspaceId,
          ...(parsed.state === undefined ? {} : { state: parsed.state }),
        }),
      }),
    );
  }

  async cancelBackgroundTask(
    input: CancelBackgroundTaskInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskResult> {
    return this.runValidatedAudited(
      "cancelBackgroundTask",
      "shell",
      cancelBackgroundTaskInputSchema,
      input,
      context,
      (parsed) => ({ query: parsed.id }),
      async (_workspace, parsed) => {
        const current = await this.backgroundTaskManager.get_background_task(parsed.id);
        if (current?.workspaceId !== parsed.workspaceId) return { task: null };
        return { task: await this.backgroundTaskManager.cancel_background_task(parsed.id) };
      },
    );
  }

  async readBackgroundTaskLogs(
    input: ReadBackgroundTaskLogsInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskLogsLookupResult> {
    return this.runValidatedAudited(
      "readBackgroundTaskLogs",
      "read",
      readBackgroundTaskLogsInputSchema,
      input,
      context,
      (parsed) => ({ query: parsed.id }),
      async (_workspace, parsed) => {
        const current = await this.backgroundTaskManager.get_background_task(parsed.id);
        if (current?.workspaceId !== parsed.workspaceId) return { logs: null };
        return {
          logs: await this.backgroundTaskManager.read_background_task_logs(
            parsed.id,
            parsed.maxBytes,
          ),
        };
      },
    );
  }

  async searchFiles(
    input: SearchFilesInput,
    context: OperationContext = {},
  ): Promise<SearchFilesResult> {
    return this.runValidatedAudited(
      "searchFiles",
      "search",
      searchFilesInputSchema,
      input,
      context,
      (parsed) => ({
        ...(parsed.root === undefined ? {} : { path: parsed.root }),
        query: parsed.query,
      }),
      (workspace, parsed, activeContext) =>
        this.fileService.searchFiles(workspace, parsed, activeContext.signal),
    );
  }

  async inspectGit(
    input: InspectGitInput,
    context: OperationContext = {},
  ): Promise<InspectGitResult> {
    return this.runValidatedAudited(
      "inspectGit",
      "diff",
      inspectGitInputSchema,
      input,
      context,
      (parsed) => ({ path: parsed.root }),
      (workspace, parsed, activeContext) =>
        this.gitService.inspect(workspace, parsed, activeContext.signal),
    );
  }

  async getWorkspaceContext(
    input: GetWorkspaceContextInput,
    context: OperationContext = {},
  ): Promise<GetWorkspaceContextResult> {
    return this.runValidatedAudited(
      "getWorkspaceContext",
      "list",
      getWorkspaceContextInputSchema,
      input,
      context,
      (parsed) => (parsed.root === undefined ? {} : { path: parsed.root }),
      (workspace, parsed, activeContext) =>
        buildWorkspaceContext(workspace, parsed.root, activeContext.signal),
    );
  }

  async gitCreateBranch(
    input: GitCreateBranchInput,
    context: OperationContext = {},
  ): Promise<GitCreateBranchResult> {
    return this.runSourceControlValidatedAudited(
      "gitCreateBranch",
      gitCreateBranchInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const root = parsed.root ?? ".";
        const targetResource = localGitRepositoryTarget(workspace.id, root);
        metadata.sourceControlCapability = "git.branch.write";
        metadata.targetResource = targetResource;
        metadata.expectedSha = parsed.expectedHeadSha;
        return this.executeSourceControlMutation({
          workspace,
          operation: "git_create_branch",
          capability: "git.branch.write",
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          resultSchema: gitCreateBranchResultSchema,
          backend: async () => (await this.getGitRepositoryExecutor()).createBranch(parsed, activeContext),
          resultSha: (result) => result.headSha,
        });
      },
    );
  }

  async gitStagePaths(
    input: GitStagePathsInput,
    context: OperationContext = {},
  ): Promise<GitStagePathsResult> {
    return this.runSourceControlValidatedAudited(
      "gitStagePaths",
      gitStagePathsInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const root = parsed.root ?? ".";
        const targetResource = localGitRepositoryTarget(workspace.id, root);
        metadata.sourceControlCapability = "git.index.write";
        metadata.targetResource = targetResource;
        return this.executeSourceControlMutation({
          workspace,
          operation: "git_stage_paths",
          capability: "git.index.write",
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          resultSchema: gitStagePathsResultSchema,
          backend: async () => (await this.getGitRepositoryExecutor()).stagePaths(parsed, activeContext),
          resultSha: (result) => result.indexTreeSha,
        });
      },
    );
  }

  async gitUnstagePaths(
    input: GitUnstagePathsInput,
    context: OperationContext = {},
  ): Promise<GitUnstagePathsResult> {
    return this.runSourceControlValidatedAudited(
      "gitUnstagePaths",
      gitUnstagePathsInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const root = parsed.root ?? ".";
        const targetResource = localGitRepositoryTarget(workspace.id, root);
        metadata.sourceControlCapability = "git.index.write";
        metadata.targetResource = targetResource;
        metadata.expectedSha = parsed.expectedHeadSha;
        return this.executeSourceControlMutation({
          workspace,
          operation: "git_unstage_paths",
          capability: "git.index.write",
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          resultSchema: gitUnstagePathsResultSchema,
          backend: async () => (await this.getGitRepositoryExecutor()).unstagePaths(parsed, activeContext),
          resultSha: (result) => result.indexTreeSha,
        });
      },
    );
  }

  async gitCommit(
    input: GitCommitInput,
    context: OperationContext = {},
  ): Promise<GitCommitResult> {
    return this.runSourceControlValidatedAudited(
      "gitCommit",
      gitCommitInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const root = parsed.root ?? ".";
        const targetResource = localGitRepositoryTarget(workspace.id, root);
        metadata.sourceControlCapability = "git.commit.write";
        metadata.targetResource = targetResource;
        metadata.expectedSha = parsed.expectedHeadSha;
        return this.executeSourceControlMutation({
          workspace,
          operation: "git_commit",
          capability: "git.commit.write",
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          beforeReceipt: async () => {
            const branch = await this.currentGitBranch(workspace, root, activeContext.signal);
            assertTypedGitBranchMutationAllowed({ operation: "git_commit", currentBranch: branch });
          },
          resultSchema: gitCommitResultSchema,
          backend: async () => (await this.getGitRepositoryExecutor()).commit(parsed, activeContext),
          resultSha: (result) => result.commitSha,
        });
      },
    );
  }

  async gitMergeBranch(
    input: GitMergeBranchInput,
    context: OperationContext = {},
  ): Promise<GitMergeBranchResult> {
    return this.runSourceControlValidatedAudited(
      "gitMergeBranch",
      gitMergeBranchInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const root = parsed.root ?? ".";
        const targetResource = localGitRepositoryTarget(workspace.id, root);
        metadata.sourceControlCapability = "git.merge.write";
        metadata.targetResource = targetResource;
        metadata.expectedSha = parsed.expectedTargetHeadSha;
        return this.executeSourceControlMutation({
          workspace,
          operation: "git_merge_branch",
          capability: "git.merge.write",
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          beforeReceipt: async () => {
            const branch = await this.currentGitBranch(workspace, root, activeContext.signal);
            assertTypedGitBranchMutationAllowed({ operation: "git_merge_branch", currentBranch: branch });
          },
          resultSchema: gitMergeBranchResultSchema,
          backend: async () => (await this.getGitRepositoryExecutor()).mergeBranch(parsed, activeContext),
          resultSha: (result) => result.headSha,
        });
      },
    );
  }

  async gitPushBranch(
    input: GitPushBranchInput,
    context: OperationContext = {},
  ): Promise<GitPushBranchResult> {
    return this.runSourceControlValidatedAudited(
      "gitPushBranch",
      gitPushBranchInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const root = parsed.root ?? ".";
        const remote = parsed.remote ?? "origin";
        const targetResource = `${localGitRepositoryTarget(workspace.id, root)}:${remote}:refs/heads/${parsed.branch}`;
        metadata.sourceControlCapability = "git.remote.push";
        metadata.targetResource = targetResource;
        metadata.expectedSha = parsed.expectedLocalSha;
        return this.executeSourceControlMutation({
          workspace,
          operation: "git_push_branch",
          confirmableOperation: "git_push_branch",
          capability: "git.remote.push",
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          beforeReceipt: () => {
            assertTypedGitBranchMutationAllowed({ operation: "git_push_branch", branch: parsed.branch });
          },
          resultSchema: gitPushBranchResultSchema,
          backend: async () => (await this.getGitRepositoryExecutor()).pushBranch(parsed, activeContext),
          resultSha: (result) => result.status === "completed" ? result.remoteSha : undefined,
        });
      },
    );
  }

  async githubGetRepository(
    input: GitHubGetRepositoryInput,
    context: OperationContext = {},
  ): Promise<GitHubRepositoryResult> {
    return this.runSourceControlValidatedAudited(
      "githubGetRepository",
      githubGetRepositoryInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const repository = `${parsed.owner}/${parsed.repository}`;
        const targetResource = `github:${repository}`;
        metadata.sourceControlCapability = "github.repository.read";
        metadata.targetResource = targetResource;
        await this.assertGitHubRepositoryCapability(
          workspace,
          "github.repository.read",
          repository,
          parsed.root ?? ".",
          false,
          activeContext.signal,
        );
        return githubRepositoryResultSchema.parse(
          await (await this.getGitHubExecutor()).getRepository(parsed, activeContext),
        );
      },
    );
  }

  async githubCreateRepository(
    input: GitHubCreateRepositoryInput,
    context: OperationContext = {},
  ): Promise<GitHubCreateRepositoryResult> {
    return this.runSourceControlValidatedAudited(
      "githubCreateRepository",
      githubCreateRepositoryInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const targetResource = `github:${parsed.owner}/${parsed.name}`;
        metadata.sourceControlCapability = "github.repository.create";
        metadata.targetResource = targetResource;
        return this.executeSourceControlMutation({
          workspace,
          operation: "github_create_repository",
          confirmableOperation: "github_create_repository",
          capability: "github.repository.create",
          accountOwner: parsed.owner,
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          resultSchema: githubCreateRepositoryResultSchema,
          backend: async () => (await this.getGitHubExecutor()).createRepository(parsed, activeContext),
        });
      },
    );
  }

  async githubGetPullRequest(
    input: GitHubGetPullRequestInput,
    context: OperationContext = {},
  ): Promise<GitHubPullRequestResult> {
    return this.runSourceControlValidatedAudited(
      "githubGetPullRequest",
      githubGetPullRequestInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const repository = `${parsed.owner}/${parsed.repository}`;
        metadata.sourceControlCapability = "github.pull_request.read";
        metadata.targetResource = `github:${repository}:pull/${parsed.pullNumber}`;
        await this.assertGitHubRepositoryCapability(
          workspace,
          "github.pull_request.read",
          repository,
          parsed.root ?? ".",
          false,
          activeContext.signal,
        );
        return githubPullRequestResultSchema.parse(
          await (await this.getGitHubExecutor()).getPullRequest(parsed, activeContext),
        );
      },
    );
  }

  async githubCreatePullRequest(
    input: GitHubCreatePullRequestInput,
    context: OperationContext = {},
  ): Promise<GitHubCreatePullRequestResult> {
    return this.runSourceControlValidatedAudited(
      "githubCreatePullRequest",
      githubCreatePullRequestInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const repository = `${parsed.owner}/${parsed.repository}`;
        const targetResource = `github:${repository}:pulls:${parsed.head}->${parsed.base}`;
        metadata.sourceControlCapability = "github.pull_request.create";
        metadata.targetResource = targetResource;
        await this.assertGitHubRepositoryCapability(
          workspace,
          "github.pull_request.create",
          repository,
          parsed.root ?? ".",
          true,
          activeContext.signal,
        );
        return this.executeSourceControlMutation({
          workspace,
          operation: "github_create_pull_request",
          confirmableOperation: "github_create_pull_request",
          capability: "github.pull_request.create",
          repository,
          canonicalRepositoryAlreadyAuthorized: true,
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          resultSchema: githubCreatePullRequestResultSchema,
          backend: async () => (await this.getGitHubExecutor()).createPullRequest(parsed, activeContext),
          resultSha: (result) => result.status === "completed" ? result.headSha : undefined,
        });
      },
    );
  }

  async githubMergePullRequest(
    input: GitHubMergePullRequestInput,
    context: OperationContext = {},
  ): Promise<GitHubMergePullRequestResult> {
    return this.runSourceControlValidatedAudited(
      "githubMergePullRequest",
      githubMergePullRequestInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const repository = `${parsed.owner}/${parsed.repository}`;
        const targetResource = `github:${repository}:pull/${parsed.pullNumber}`;
        metadata.sourceControlCapability = "github.pull_request.merge";
        metadata.targetResource = targetResource;
        metadata.expectedSha = parsed.expectedPullRequestHeadSha;
        await this.assertGitHubRepositoryCapability(
          workspace,
          "github.pull_request.merge",
          repository,
          parsed.root ?? ".",
          true,
          activeContext.signal,
        );
        return this.executeSourceControlMutation({
          workspace,
          operation: "github_merge_pull_request",
          confirmableOperation: "github_merge_pull_request",
          capability: "github.pull_request.merge",
          repository,
          canonicalRepositoryAlreadyAuthorized: true,
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          resultSchema: githubMergePullRequestResultSchema,
          backend: async () => (await this.getGitHubExecutor()).mergePullRequest(parsed, activeContext),
          resultSha: (result) => result.status === "completed" ? result.mergeSha : undefined,
        });
      },
    );
  }
  async awaitQualifiedCommandShadow(): Promise<void> {
    await Promise.all([...this.qualifiedShadowTasks]);
  }

  async qualifiedCommandObservability(): Promise<{
    features: QualifiedCommandFeatureFlags;
    allowlistEnabled: boolean;
    metrics: QualifiedCommandMetricsSnapshot;
    invocationRegistry: Awaited<ReturnType<CommandInvocationRegistry["snapshot"]>>;
    recipeCache: ReturnType<QualifiedCommandPlanQualifier["recipeCacheSnapshot"]>;
    provider: {
      enabled: boolean;
      configured: boolean;
      name?: string;
      model?: string;
      metrics?: unknown;
    };
  }> {
    const providerSnapshot = this.qualifiedCommandProvider &&
      "snapshot" in this.qualifiedCommandProvider &&
      typeof this.qualifiedCommandProvider.snapshot === "function"
      ? this.qualifiedCommandProvider.snapshot()
      : undefined;
    return {
      features: {
        qualifiedExecution: this.qualifiedCommandFeatures.qualifiedExecution,
        safeAutoCorrection: this.qualifiedCommandFeatures.safeAutoCorrection,
        shadowMode: this.qualifiedCommandFeatures.shadowMode ?? false,
        providerEnabled: this.qualifiedCommandFeatures.providerEnabled ?? false,
      },
      allowlistEnabled: this.qualifiedCommandWorkspaceAllowlist !== undefined,
      metrics: this.qualifiedCommandMetrics.snapshot(),
      invocationRegistry: await this.qualifiedInvocationRegistry.snapshot(),
      recipeCache: this.qualifiedCommandQualifier.recipeCacheSnapshot(),
      provider: {
        enabled: this.qualifiedCommandFeatures.providerEnabled === true,
        configured: this.qualifiedCommandProvider !== undefined,
        ...(this.qualifiedCommandProvider === undefined
          ? {}
          : {
              name: this.qualifiedCommandProvider.identity.name,
              model: this.qualifiedCommandProvider.identity.model,
            }),
        ...(providerSnapshot === undefined ? {} : { metrics: providerSnapshot }),
      },
    };
  }

  private async runSourceControlValidatedAudited<
    TInput extends { workspaceId: string },
    TResult,
  >(
    operationName: string,
    schema: {
      safeParse(value: unknown):
        | { success: true; data: TInput }
        | { success: false };
    },
    input: unknown,
    context: OperationContext,
    action: (
      workspace: ResolvedWorkspace,
      parsed: TInput,
      context: OperationContext,
      metadata: AuditMetadata,
    ) => Promise<TResult>,
  ): Promise<TResult> {
    const startedAt = performance.now();
    let workspaceId = getUntrustedWorkspaceId(input);
    let permissionProfile: ResolvedWorkspace["permissionProfile"] | undefined;
    const metadata: AuditMetadata = {};
    try {
      const parsed = parseInput(schema, input);
      workspaceId = parsed.workspaceId;
      const workspace = this.registry.get(workspaceId);
      permissionProfile = workspace.permissionProfile;
      const result = await action(workspace, parsed, context, metadata);
      await this.audit.write(
        makeAuditEntry({
          operationName,
          workspaceId,
          ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
          permissionProfile,
          metadata,
          resultSize: serializedSize(result),
          startedAt,
          status: "allowed",
        }),
      );
      return result;
    } catch (error) {
      const appError = asAppError(error);
      await this.audit.write(
        makeAuditEntry({
          operationName,
          workspaceId,
          ...(context.correlationId === undefined ? {} : { correlationId: context.correlationId }),
          permissionProfile,
          metadata,
          startedAt,
          status: isDenied(appError) ? "denied" : "error",
          reason: appError.code,
        }),
      );
      throw appError;
    }
  }

  private async executeSourceControlMutation<TInput extends { workspaceId: string }, TResult>(
    options: {
      workspace: ResolvedWorkspace;
      operation: SourceControlOperationName;
      confirmableOperation?:
        | "git_push_branch"
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
      metadata: AuditMetadata;
      beforeReceipt?: () => void | Promise<void>;
      resultSchema: { parse(value: unknown): TResult };
      backend: () => Promise<unknown>;
      resultSha?: (result: TResult) => string | undefined;
    },
  ): Promise<TResult> {
    if (!options.canonicalRepositoryAlreadyAuthorized) {
      assertSourceControlCapability({
        policy: options.workspace,
        capability: options.capability,
        ...(options.repository === undefined ? {} : { repository: options.repository }),
        ...(options.accountOwner === undefined ? {} : { accountOwner: options.accountOwner }),
        mutation: true,
      });
    }
    await options.beforeReceipt?.();

    const digest = canonicalSourceControlArgumentsDigest(options.input);
    const idempotencyKey = deriveSourceControlIdempotencyKey(options.input, options.context);
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
        options.metadata.idempotencyOutcome = "completed_replay";
        const result = options.resultSchema.parse(reservation.receipt.result);
        const resultSha = options.resultSha?.(result);
        if (resultSha !== undefined) options.metadata.resultSha = resultSha;
        return result;
      }
      throw new AppError(
        "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
        "The source-control mutation requires reconciliation before another backend invocation.",
      );
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
        options.metadata.idempotencyOutcome = "confirmation_required";
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
      options.metadata.idempotencyOutcome = "completed_replay";
      return options.resultSchema.parse(reservation.receipt.result);
    }
    if (reservation.disposition !== "execute") {
      throw new AppError(
        "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
        "The source-control mutation requires reconciliation before another backend invocation.",
      );
    }
    await store.markExecuting(identity);
    try {
      const result = options.resultSchema.parse(await options.backend());
      await store.markCompleted(identity, result);
      options.metadata.idempotencyOutcome = "executed";
      const resultSha = options.resultSha?.(result);
      if (resultSha !== undefined) options.metadata.resultSha = resultSha;
      return result;
    } catch (error) {
      try {
        await store.markReconciliationRequired(identity);
      } catch {}
      throw error;
    }
  }

  private async assertGitHubRepositoryCapability(
    workspace: ResolvedWorkspace,
    capability: SourceControlCapability,
    repository: string,
    root: string,
    mutation: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const configuredAdditional = workspace.sourceControl?.additionalRepositories.some(
      (candidate) => candidate.toLocaleLowerCase("en-US") === repository.toLocaleLowerCase("en-US"),
    ) ?? false;
    const canonicalRepository = configuredAdditional
      ? undefined
      : await this.canonicalGitHubRepository(workspace.id, root, signal);
    assertSourceControlCapability({
      policy: workspace,
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
      const origin = await (await this.getGitOriginResolver()).canonicalOriginUrl(
        workspaceId,
        root,
        signal,
      );
      return parseGitHubRepositoryOrigin(origin);
    } catch {
      return undefined;
    }
  }

  private async currentGitBranch(
    workspace: ResolvedWorkspace,
    root: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.gitService.inspect(
      workspace,
      inspectGitInputSchema.parse({
        workspaceId: workspace.id,
        root,
        diffMode: "none",
      }),
      signal,
    );
    return result.branch;
  }

  private mutationReceiptStoreFor(workspace: ResolvedWorkspace): MutationReceiptStore {
    if (this.injectedMutationReceiptStore !== undefined) {
      return this.injectedMutationReceiptStore;
    }
    const existing = this.mutationReceiptStores.get(workspace.id);
    if (existing !== undefined) return existing;
    const store = new FileMutationReceiptStore(workspace.rootPath);
    this.mutationReceiptStores.set(workspace.id, store);
    return store;
  }

  private async getGitRepositoryService(): Promise<GitRepositoryService> {
    this.gitRepositoryServicePromise ??= GitRepositoryService.create(this.registry);
    return this.gitRepositoryServicePromise;
  }

  private async getGitRepositoryExecutor(): Promise<GitRepositoryExecutor> {
    return this.injectedGitRepositoryExecutor ?? this.getGitRepositoryService();
  }

  private async getGitOriginResolver(): Promise<GitOriginResolver> {
    return this.injectedGitOriginResolver ?? this.getGitRepositoryService();
  }

  private async getGitHubExecutor(): Promise<GitHubExecutor> {
    if (this.injectedGitHubExecutor !== undefined) return this.injectedGitHubExecutor;
    this.gitHubExecutorPromise ??= (async () => {
      const credentialProvider = await GhCliUserCredentialProvider.create();
      return new GitHubService(new GitHubHttpClient({ credentialProvider }));
    })();
    return this.gitHubExecutorPromise;
  }
  private async runQualifiedCommand(
    workspace: ResolvedWorkspace,
    input: Parameters<QualifiedCommandOrchestrator["run"]>[1],
    context: OperationContext,
  ): Promise<RunCommandResult> {
    try {
      const result = await this.qualifiedCommandOrchestrator.run(
        workspace,
        input,
        context,
      );
      this.qualifiedCommandMetrics.recordResult(result);
      return result;
    } catch (error) {
      this.qualifiedCommandMetrics.recordError(asAppError(error).code);
      throw error;
    }
  }

  private observeQualifiedShadow(
    workspace: ResolvedWorkspace,
    input: DirectRunCommandInput,
    context: OperationContext,
  ): void {
    const task = this.qualifyShadow(workspace, input, context)
      .catch(() => undefined)
      .finally(() => this.qualifiedShadowTasks.delete(task));
    this.qualifiedShadowTasks.add(task);
  }

  private async qualifyShadow(
    workspace: ResolvedWorkspace,
    input: DirectRunCommandInput,
    context: OperationContext,
  ): Promise<void> {
    const startedAt = performance.now();
    const {
      executionMode: _executionMode,
      confirmationId: _confirmationId,
      ...base
    } = input;
    try {
      const result = await this.qualifiedCommandShadowQualifier.qualify(workspace, {
        invocationId: shadowInvocationId(context.invocationId),
        workspaceId: workspace.id,
        input: {
          ...base,
          executionMode: "qualified",
          autoCorrection: "off",
        },
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      this.qualifiedCommandMetrics.recordShadow({
        status: result.status,
        durationMs: performance.now() - startedAt,
        ...(result.status === "qualified" ? { source: result.plan.source } : {}),
      });
    } catch {
      this.qualifiedCommandMetrics.recordShadow({
        status: "error",
        durationMs: performance.now() - startedAt,
      });
    }
  }

  private assertQualifiedWorkspaceAllowed(workspaceId: string): void {
    if (this.isQualifiedWorkspaceAllowed(workspaceId)) return;
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Qualified command execution is not enabled for this workspace.",
    );
  }

  private isQualifiedWorkspaceAllowed(workspaceId: string): boolean {
    return (
      this.qualifiedCommandWorkspaceAllowlist === undefined ||
      this.qualifiedCommandWorkspaceAllowlist.has(workspaceId)
    );
  }

  private async runValidatedAudited<TInput extends { workspaceId: string }, TResult>(
    operationName: string,
    operation: WorkspaceOperation,
    schema: {
      safeParse(value: unknown):
        | { success: true; data: TInput }
        | { success: false };
    },
    input: unknown,
    context: OperationContext,
    getMetadata: (parsed: TInput) => AuditMetadata,
    action: (
      workspace: ReturnType<WorkspaceRegistry["get"]>,
      parsed: TInput,
      context: OperationContext,
    ) => Promise<TResult>,
  ): Promise<TResult> {
    const startedAt = performance.now();
    let workspaceId = getUntrustedWorkspaceId(input);
    let metadata: AuditMetadata = {};
    let permissionProfile: ReturnType<WorkspaceRegistry["get"]>["permissionProfile"] | undefined;
    try {
      const parsed = parseInput(schema, input);
      workspaceId = parsed.workspaceId;
      metadata = getMetadata(parsed);
      const workspace = this.registry.get(workspaceId);
      permissionProfile = workspace.permissionProfile;
      assertPermission(permissionProfile, operation);
      const result = await action(workspace, parsed, context);
      await this.audit.write(
        makeAuditEntry({
          operationName,
          workspaceId,
          ...(context.correlationId === undefined
            ? {}
            : { correlationId: context.correlationId }),
          permissionProfile,
          metadata,
          resultSize: serializedSize(result),
          startedAt,
          status: "allowed",
        }),
      );
      return result;
    } catch (error) {
      const appError = asAppError(error);
      await this.audit.write(
        makeAuditEntry({
          operationName,
          workspaceId,
          ...(context.correlationId === undefined
            ? {}
            : { correlationId: context.correlationId }),
          permissionProfile,
          metadata,
          startedAt,
          status: isDenied(appError) ? "denied" : "error",
          reason: appError.code,
        }),
      );
      throw appError;
    }
  }
}

function localGitRepositoryTarget(workspaceId: string, root: string): string {
  return `git:${workspaceId}:${root}`;
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
  return githubRepositoryFullNameSchema.safeParse(fullName).success ? fullName : undefined;
}
function shadowInvocationId(value: string | undefined): string {
  return "shadow-" + createHash("sha256")
    .update(value ?? "anonymous", "utf8")
    .digest("hex")
    .slice(0, 32);
}
function resolveQualifiedInvocationStateDirectory(): string {
  const explicit = process.env.VS_CODE_GPT_COMMAND_INVOCATIONS_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const dataDirectory = process.env.VS_CODE_GPT_DATA_DIR?.trim();
  const runtimeRoot = dataDirectory
    ? path.resolve(dataDirectory)
    : path.resolve("runtime");
  return path.join(runtimeRoot, "command-invocations");
}

function resolveBackgroundTaskStateDirectory(): string {
  const explicit = process.env.VS_CODE_GPT_BACKGROUND_TASKS_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const dataDirectory = process.env.VS_CODE_GPT_DATA_DIR?.trim();
  const runtimeRoot = dataDirectory ? path.resolve(dataDirectory) : path.resolve("runtime");
  return path.join(runtimeRoot, "background-tasks");
}

function getUntrustedWorkspaceId(input: unknown): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "workspaceId" in input &&
    typeof input.workspaceId === "string" &&
    input.workspaceId.length > 0
  ) {
    return input.workspaceId;
  }
  return "-";
}

function parseInput<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError("INVALID_ARGUMENT", "Input does not match the operation schema.");
  }
  return result.data;
}

function serializedSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
}

function isDenied(error: AppError): boolean {
  return [
    "WORKSPACE_NOT_FOUND",
    "WORKSPACE_DISABLED",
    "PERMISSION_DENIED",
    "INVALID_PATH",
    "PATH_OUTSIDE_WORKSPACE",
    "PATH_OUTSIDE_ALLOWED_ROOTS",
    "BLOCKED_PATH",
    "WRITE_NOT_ALLOWED",
    "SHELL_NOT_ALLOWED",
    "COMMAND_CONFIRMATION_INVALID",
    "SOURCE_CONTROL_CAPABILITY_DENIED",
    "SOURCE_CONTROL_CONFIRMATION_INVALID",
    "GIT_PROTECTED_BRANCH",
  ].includes(error.code);
}

function makeAuditEntry(input: {
  operationName: string;
  workspaceId: string;
  correlationId?: string;
  permissionProfile: ReturnType<WorkspaceRegistry["get"]>["permissionProfile"] | undefined;
  metadata: AuditMetadata;
  resultSize?: number;
  startedAt: number;
  status: AuditEntry["status"];
  reason?: string;
}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    operation: input.operationName,
    workspaceId: input.workspaceId,
    ...(input.correlationId === undefined
      ? {}
      : { correlationId: input.correlationId }),
    ...(input.permissionProfile === undefined
      ? {}
      : { permissionProfile: input.permissionProfile }),
    ...(input.metadata.path === undefined ? {} : { path: input.metadata.path }),
    ...(input.metadata.sourceControlCapability === undefined ? {} : { sourceControlCapability: input.metadata.sourceControlCapability }),
    ...(input.metadata.targetResource === undefined ? {} : { targetResource: input.metadata.targetResource }),
    ...(input.metadata.expectedSha === undefined ? {} : { expectedSha: input.metadata.expectedSha }),
    ...(input.metadata.resultSha === undefined ? {} : { resultSha: input.metadata.resultSha }),
    ...(input.metadata.idempotencyOutcome === undefined ? {} : { idempotencyOutcome: input.metadata.idempotencyOutcome }),
    ...(input.metadata.query === undefined
      ? {}
      : {
          queryHash: createHash("sha256").update(input.metadata.query).digest("hex"),
          queryLength: input.metadata.query.length,
        }),
    ...(input.resultSize === undefined ? {} : { resultSize: input.resultSize }),
    durationMs: elapsed(input.startedAt),
    status: input.status,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}
