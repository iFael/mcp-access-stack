import { createHash } from "node:crypto";
import path from "node:path";
import {
  AppError,
  asAppError,
  cancelBackgroundTaskInputSchema,
  getBackgroundTaskInputSchema,
  waitBackgroundTaskInputSchema,
  listBackgroundTasksInputSchema,
  readBackgroundTaskLogsInputSchema,
  readBackgroundTaskOutputInputSchema,
  startBackgroundTaskInputSchema,
  writeBackgroundTaskStdinInputSchema,
  inspectGitInputSchema,
  getWorkspaceContextInputSchema,
  listFilesInputSchema,
  listWorkspaceRootsInputSchema,
  patchFileInputSchema,
  getReleaseStateInputSchema,
  prepareReleaseInputSchema,
  promoteReleaseInputSchema,
  readFileInputSchema,
  readBinaryFileInputSchema,
  runWorkspaceValidationInputSchema,
  runCommandInputSchema,
  writeFileInputSchema,
  searchFilesInputSchema,
  type BackgroundTaskListResult,
  type BackgroundTaskLogsLookupResult,
  type BackgroundTaskOutputResult,
  type BackgroundTaskResult,
  type BackgroundTaskStdinResult,
  type BackgroundTaskWaitResult,
  type CancelBackgroundTaskInput,
  type GetBackgroundTaskInput,
  type WaitBackgroundTaskInput,
  type ListBackgroundTasksInput,
  type ReadBackgroundTaskLogsInput,
  type ReadBackgroundTaskOutputInput,
  type StartBackgroundTaskInput,
  type StartBackgroundTaskResult,
  type WriteBackgroundTaskStdinInput,
  type PolicyFile,
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
  type GetReleaseStateInput,
  type GetReleaseStateResult,
  type PrepareReleaseInput,
  type PrepareReleaseResult,
  type PromoteReleaseInput,
  type PromoteReleaseResult,
  type ReadFileInput,
  type ReadFileResult,
  type ReadBinaryFileInput,
  type ReadBinaryFileResult,
  type RunWorkspaceValidationInput,
  type RunWorkspaceValidationResult,
  type RunCommandInput,
  type RunCommandResult,
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
  gitSyncBranchInputSchema,
  gitSyncBranchResultSchema,
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
  githubCommitChecksResultSchema,
  githubGetCommitChecksInputSchema,
  githubGetCommitChecksWatchesInputSchema,
  githubGetCommitChecksWatchesResultSchema,
  githubStartCommitChecksWatchInputSchema,
  githubStartCommitChecksWatchResultSchema,
  githubWaitCommitChecksWatchInputSchema,
  githubWaitCommitChecksWatchResultSchema,
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
  type GitHubCommitChecksResult,
  type GitHubExecutor,
  type GitHubGetCommitChecksInput,
  type GitHubGetCommitChecksWatchesInput,
  type GitHubGetCommitChecksWatchesResult,
  type GitHubStartCommitChecksWatchInput,
  type GitHubStartCommitChecksWatchResult,
  type GitHubWaitCommitChecksWatchInput,
  type GitHubWaitCommitChecksWatchResult,
  type GitHubGetPullRequestInput,
  type GitHubGetRepositoryInput,
  type GitHubMergePullRequestInput,
  type GitHubMergePullRequestResult,
  type GitHubPullRequestResult,
  type GitHubRepositoryResult,
  type GitMergeBranchInput,
  type GitMergeBranchResult,
  type GitSyncBranchInput,
  type GitSyncBranchResult,
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
import { ShellService } from "./shell/service.js";
import type { ElevationBroker } from "./shell/elevation-broker.js";
import { terminateProcessTreeByPid } from "./shell/process-runner.js";
import { BackgroundTaskManager } from "./tasks/background-task-manager.js";
import { ValidationService } from "./validation/service.js";
import { ReleaseLifecycleService } from "./release/release-lifecycle-service.js";
import { assertPermission, type WorkspaceOperation } from "./permission-profile.js";
import { buildWorkspaceContext } from "./workspace-context-service.js";
import { WorkspaceRegistry } from "./workspace-registry.js";
import { FileMutationReceiptStore } from "./source-control/file-mutation-receipt-store.js";
import { GhCliUserCredentialProvider } from "./source-control/gh-cli-user-credential-provider.js";
import { GitHubHttpClient } from "./source-control/github-http-client.js";
import { GitHubCommitChecksWatchManager } from "./source-control/github-checks-watch-manager.js";
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
  gitRepositoryExecutor?: GitRepositoryExecutor;
  gitOriginResolver?: GitOriginResolver;
  githubExecutor?: GitHubExecutor;
  typedConfirmationRegistry?: TypedConfirmationRegistry;
  mutationReceiptStore?: MutationReceiptStore;
  elevationBroker?: ElevationBroker;
}

function backgroundTaskAccess(
  context: OperationContext,
): { ownerScope?: string } {
  return context.ownerScope === undefined
    ? {}
    : { ownerScope: context.ownerScope };
}

export class LocalAgent {
  private readonly fileService = new FileService();
  private readonly gitService = new GitService();
  private readonly shellService: ShellService;
  private readonly validationService = new ValidationService();
  private readonly backgroundTaskManager: BackgroundTaskManager;
  private readonly releaseLifecycleService: ReleaseLifecycleService;
  private readonly githubChecksWatchManager: GitHubCommitChecksWatchManager;
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
    this.shellService = new ShellService(options.elevationBroker);
    this.injectedGitRepositoryExecutor = options.gitRepositoryExecutor;
    this.injectedGitOriginResolver = options.gitOriginResolver;
    this.injectedGitHubExecutor = options.githubExecutor;
    this.typedConfirmationRegistry = options.typedConfirmationRegistry ?? new TypedConfirmationRegistry();
    this.injectedMutationReceiptStore = options.mutationReceiptStore;
    this.backgroundTaskManager = new BackgroundTaskManager({
      stateDirectory: resolveBackgroundTaskStateDirectory(),
      runner: {
        start: (input, signal, execution) => {
          const workspace = this.registry.get(input.workspaceId);
          return this.shellService.runAuthorizedCommandToFiles(
            workspace,
            input,
            {
              stdoutPath: execution.stdoutPath,
              stderrPath: execution.stderrPath,
              onPid: execution.onPid,
              interactive: execution.interactive,
              onStdinControl: execution.onStdinControl,
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
    this.releaseLifecycleService = new ReleaseLifecycleService(
      this.shellService,
      this.backgroundTaskManager,
    );
    this.githubChecksWatchManager = new GitHubCommitChecksWatchManager({
      stateDirectory: path.join(resolveBackgroundTaskStateDirectory(), "github-check-watches"),
      poll: (input, context) => this.githubGetCommitChecks(input, context),
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
    const agent = new LocalAgent(registry, audit, options);
    await agent.githubChecksWatchManager.recover();
    return agent;
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
        ...(appError.lifecycle === undefined
          ? {}
          : { lifecycle: appError.lifecycle }),
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

  async getReleaseState(
    input: GetReleaseStateInput,
    context: OperationContext = {},
  ): Promise<GetReleaseStateResult> {
    return this.runValidatedAudited(
      "getReleaseState",
      "read",
      getReleaseStateInputSchema,
      input,
      context,
      () => ({}),
      (workspace) => this.releaseLifecycleService.getState(workspace),
    );
  }

  async prepareRelease(
    input: PrepareReleaseInput,
    context: OperationContext = {},
  ): Promise<PrepareReleaseResult> {
    return this.runValidatedAudited(
      "prepareRelease",
      "shell",
      prepareReleaseInputSchema,
      input,
      context,
      (parsed) => ({ query: parsed.tag }),
      async (workspace, parsed, activeContext) => {
        const repository = await this.canonicalGitHubRepository(
          workspace.id,
          ".",
          activeContext.signal,
        );
        if (repository === undefined) {
          throw new AppError(
            "CAPABILITY_UNSUPPORTED",
            "Release preparation requires the canonical workspace origin to be a GitHub repository.",
          );
        }
        return this.releaseLifecycleService.prepare(
          workspace,
          repository,
          parsed,
          activeContext,
        );
      },
    );
  }

  async promoteRelease(
    input: PromoteReleaseInput,
    context: OperationContext = {},
  ): Promise<PromoteReleaseResult> {
    return this.runValidatedAudited(
      "promoteRelease",
      "shell",
      promoteReleaseInputSchema,
      input,
      context,
      (parsed) => ({ query: parsed.releaseId }),
      (workspace, parsed, activeContext) =>
        this.releaseLifecycleService.promote(workspace, parsed, activeContext),
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
      (workspace, parsed, activeContext) =>
        this.shellService.runCommand(workspace, parsed, activeContext),
    );
  }

  async startBackgroundTask(
    input: StartBackgroundTaskInput,
    context: OperationContext = {},
  ): Promise<StartBackgroundTaskResult> {
    return this.runValidatedAudited(
      "startBackgroundTask",
      "shell",
      startBackgroundTaskInputSchema,
      input,
      context,
      (parsed) => ({ path: parsed.cwd ?? ".", query: parsed.operation }),
      async (workspace, parsed, activeContext) => {
        const authorization = await this.shellService.authorizeBackgroundCommand(
          workspace,
          parsed,
          activeContext.signal,
        );
        if ("status" in authorization) return authorization;
        return {
          status: "background_task_started" as const,
          task: await this.backgroundTaskManager.start_background_task(
            {
              workspaceId: parsed.workspaceId,
              operation: parsed.operation,
              command: parsed.command,
              shell: parsed.shell,
              cwd: authorization.logicalCwd,
              timeoutMs: parsed.timeoutMs,
              interactive: parsed.interactive,
            },
            backgroundTaskAccess(activeContext),
          ),
        };
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
      async (_workspace, parsed, activeContext) => {
        const task = await this.backgroundTaskManager.get_background_task(
          parsed.id,
          backgroundTaskAccess(activeContext),
        );
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
        const access = backgroundTaskAccess(activeContext);
        const current = await this.backgroundTaskManager.get_background_task(
          parsed.id,
          access,
        );
        if (current?.workspaceId !== parsed.workspaceId) {
          return { task: null, logs: null, timedOut: false, elapsedMs: 0 };
        }
        return this.backgroundTaskManager.wait_background_task(
          parsed.id,
          {
            timeoutMs: parsed.timeoutMs,
            maxBytes: parsed.maxBytes,
            ...(activeContext.signal === undefined
              ? {}
              : { signal: activeContext.signal }),
          },
          access,
        );
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
      async (_workspace, parsed, activeContext) => ({
        tasks: await this.backgroundTaskManager.list_background_tasks(
          {
            workspaceId: parsed.workspaceId,
            ...(parsed.state === undefined ? {} : { state: parsed.state }),
          },
          backgroundTaskAccess(activeContext),
        ),
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
      async (_workspace, parsed, activeContext) => {
        const access = backgroundTaskAccess(activeContext);
        const current = await this.backgroundTaskManager.get_background_task(
          parsed.id,
          access,
        );
        if (current?.workspaceId !== parsed.workspaceId) return { task: null };
        return {
          task: await this.backgroundTaskManager.cancel_background_task(
            parsed.id,
            access,
          ),
        };
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
      async (_workspace, parsed, activeContext) => {
        const access = backgroundTaskAccess(activeContext);
        const current = await this.backgroundTaskManager.get_background_task(
          parsed.id,
          access,
        );
        if (current?.workspaceId !== parsed.workspaceId) return { logs: null };
        return {
          logs: await this.backgroundTaskManager.read_background_task_logs(
            parsed.id,
            parsed.maxBytes,
            access,
          ),
        };
      },
    );
  }

  async writeBackgroundTaskStdin(
    input: WriteBackgroundTaskStdinInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskStdinResult> {
    return this.runValidatedAudited(
      "writeBackgroundTaskStdin",
      "shell",
      writeBackgroundTaskStdinInputSchema,
      input,
      context,
      (parsed) => ({ query: parsed.id }),
      async (_workspace, parsed, activeContext) => {
        const access = backgroundTaskAccess(activeContext);
        const current = await this.backgroundTaskManager.get_background_task(
          parsed.id,
          access,
        );
        if (current?.workspaceId !== parsed.workspaceId) {
          return { task: null, bytesWritten: 0, stdinClosed: false };
        }
        return this.backgroundTaskManager.write_background_task_stdin(
          parsed.id,
          parsed.input,
          parsed.close,
          access,
        );
      },
    );
  }

  async readBackgroundTaskOutput(
    input: ReadBackgroundTaskOutputInput,
    context: OperationContext = {},
  ): Promise<BackgroundTaskOutputResult> {
    return this.runValidatedAudited(
      "readBackgroundTaskOutput",
      "read",
      readBackgroundTaskOutputInputSchema,
      input,
      context,
      (parsed) => ({ query: parsed.id }),
      async (_workspace, parsed, activeContext) => {
        const access = backgroundTaskAccess(activeContext);
        const current = await this.backgroundTaskManager.get_background_task(
          parsed.id,
          access,
        );
        if (current?.workspaceId !== parsed.workspaceId) {
          return { task: null, stdout: null, stderr: null };
        }
        return this.backgroundTaskManager.read_background_task_output(
          parsed.id,
          {
            stdoutOffset: parsed.stdoutOffset,
            stderrOffset: parsed.stderrOffset,
            maxBytes: parsed.maxBytes,
          },
          access,
        );
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
        if (parsed.expectedHeadSha !== undefined) {
          metadata.expectedSha = parsed.expectedHeadSha;
        }
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

  async gitSyncBranch(
    input: GitSyncBranchInput,
    context: OperationContext = {},
  ): Promise<GitSyncBranchResult> {
    return this.runSourceControlValidatedAudited(
      "gitSyncBranch",
      gitSyncBranchInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const root = parsed.root ?? ".";
        const targetResource =
          `${localGitRepositoryTarget(workspace.id, root)}:${parsed.remote}:refs/heads/${parsed.branch}`;
        metadata.sourceControlCapability = "git.merge.write";
        metadata.targetResource = targetResource;
        metadata.expectedSha = parsed.expectedRemoteSha;
        return this.executeSourceControlMutation({
          workspace,
          operation: "git_sync_branch",
          capability: "git.merge.write",
          targetResource,
          input: parsed,
          context: activeContext,
          metadata,
          beforeReceipt: () => {
            assertTypedGitBranchMutationAllowed({
              operation: "git_sync_branch",
              branch: parsed.branch,
            });
          },
          resultSchema: gitSyncBranchResultSchema,
          backend: async () =>
            (await this.getGitRepositoryExecutor()).syncBranch(
              parsed,
              activeContext,
            ),
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
        const confirmableOperation = sourceControlConfirmationOperation(
          workspace,
          "git_push_branch",
          parsed.branch,
        );
        return this.executeSourceControlMutation({
          workspace,
          operation: "git_push_branch",
          ...(confirmableOperation === undefined ? {} : { confirmableOperation }),
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

  async githubGetCommitChecks(
    input: GitHubGetCommitChecksInput,
    context: OperationContext = {},
  ): Promise<GitHubCommitChecksResult> {
    return this.runSourceControlValidatedAudited(
      "githubGetCommitChecks",
      githubGetCommitChecksInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const repository = `${parsed.owner}/${parsed.repository}`;
        metadata.sourceControlCapability = "github.repository.read";
        metadata.targetResource =
          `github:${repository}:commit/${parsed.commitSha}:checks`;
        await this.assertGitHubRepositoryCapability(
          workspace,
          "github.repository.read",
          repository,
          parsed.root ?? ".",
          false,
          activeContext.signal,
        );
        return githubCommitChecksResultSchema.parse(
          await (await this.getGitHubExecutor()).getCommitChecks(
            parsed,
            activeContext,
          ),
        );
      },
    );
  }

  async githubStartCommitChecksWatch(
    input: GitHubStartCommitChecksWatchInput,
    context: OperationContext = {},
  ): Promise<GitHubStartCommitChecksWatchResult> {
    return this.runSourceControlValidatedAudited(
      "githubStartCommitChecksWatch",
      githubStartCommitChecksWatchInputSchema,
      input,
      context,
      async (workspace, parsed, activeContext, metadata) => {
        const repository = `${parsed.owner}/${parsed.repository}`;
        metadata.sourceControlCapability = "github.repository.read";
        metadata.targetResource =
          `github:${repository}:commit/${parsed.commitSha}:checks-watch`;
        await this.assertGitHubRepositoryCapability(
          workspace,
          "github.repository.read",
          repository,
          parsed.root ?? ".",
          false,
          activeContext.signal,
        );
        return githubStartCommitChecksWatchResultSchema.parse(
          await this.githubChecksWatchManager.start(parsed, activeContext),
        );
      },
    );
  }

  async githubGetCommitChecksWatches(
    input: GitHubGetCommitChecksWatchesInput,
    context: OperationContext = {},
  ): Promise<GitHubGetCommitChecksWatchesResult> {
    return this.runSourceControlValidatedAudited(
      "githubGetCommitChecksWatches",
      githubGetCommitChecksWatchesInputSchema,
      input,
      context,
      async (_workspace, parsed, activeContext, metadata) => {
        metadata.sourceControlCapability = "github.repository.read";
        metadata.targetResource = "github:commit-check-watches";
        return githubGetCommitChecksWatchesResultSchema.parse(
          await this.githubChecksWatchManager.get(
            parsed,
            backgroundTaskAccess(activeContext),
          ),
        );
      },
    );
  }

  async githubWaitCommitChecksWatch(
    input: GitHubWaitCommitChecksWatchInput,
    context: OperationContext = {},
  ): Promise<GitHubWaitCommitChecksWatchResult> {
    return this.runSourceControlValidatedAudited(
      "githubWaitCommitChecksWatch",
      githubWaitCommitChecksWatchInputSchema,
      input,
      context,
      async (_workspace, parsed, activeContext, metadata) => {
        metadata.sourceControlCapability = "github.repository.read";
        metadata.targetResource = `github:commit-check-watch/${parsed.id}`;
        return githubWaitCommitChecksWatchResultSchema.parse(
          await this.githubChecksWatchManager.wait(
            parsed,
            backgroundTaskAccess(activeContext),
          ),
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
        const confirmableOperation = sourceControlConfirmationOperation(
          workspace,
          "github_create_pull_request",
          parsed.head,
        );
        return this.executeSourceControlMutation({
          workspace,
          operation: "github_create_pull_request",
          ...(confirmableOperation === undefined ? {} : { confirmableOperation }),
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
          ...(appError.lifecycle === undefined
            ? {}
            : { lifecycle: appError.lifecycle }),
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
          ...(appError.lifecycle === undefined
            ? {}
            : { lifecycle: appError.lifecycle }),
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

type ConfirmableSourceControlOperation =
  | "git_push_branch"
  | "github_create_repository"
  | "github_create_pull_request"
  | "github_merge_pull_request";

function sourceControlConfirmationOperation(
  workspace: ResolvedWorkspace,
  operation: ConfirmableSourceControlOperation,
  sourceBranch?: string,
): ConfirmableSourceControlOperation | undefined {
  const trusted =
    workspace.confirmationMode === "trusted-workspace" &&
    workspace.permissionProfile === "full-repo-write";
  const trustedFeatureFlow =
    operation === "git_push_branch" || operation === "github_create_pull_request";
  const sourceIsProtectedMain = sourceBranch?.toLocaleLowerCase("en-US") === "main";

  if (trusted && trustedFeatureFlow && sourceBranch && !sourceIsProtectedMain) {
    return undefined;
  }
  return operation;
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
  lifecycle?: AuditEntry["lifecycle"];
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
    ...(input.lifecycle === undefined ? {} : { lifecycle: input.lifecycle }),
  };
}
