import type {
  BackgroundTaskListResult,
  BackgroundTaskLogsLookupResult,
  BackgroundTaskResult,
  BackgroundTaskWaitResult,
  CancelBackgroundTaskInput,
  GetBackgroundTaskInput,
  WaitBackgroundTaskInput,
  GetWorkspaceContextInput,
  GetWorkspaceContextResult,
  InspectGitInput,
  InspectGitResult,
  ListBackgroundTasksInput,
  ListFilesInput,
  ListFilesResult,
  ListWorkspaceRootsInput,
  ListWorkspaceRootsResult,
  OperationContext,
  PatchFileInput,
  PatchFileResult,
  ReadBackgroundTaskLogsInput,
  ReadFileInput,
  ReadFileResult,
  ReadBinaryFileInput,
  ReadBinaryFileResult,
  RunWorkspaceValidationInput,
  RunWorkspaceValidationResult,
  SearchFilesInput,
  SearchFilesResult,
  StartBackgroundTaskInput,
  WriteFileInput,
  WriteFileResult,
  RunCommandInput,
  RunCommandResult,
  RunPowerShellInput,
  RunPowerShellResult,
  WorkspaceExecutor,
  GitRepositoryExecutor,
  GitHubExecutor,
  WorkspaceSummary,
} from "@vs-code-gpt/shared";
import type { LocalAgent } from "./local-agent.js";

/** Delegates workspace operations to a LocalAgent running in the same process. */
export class InProcessWorkspaceExecutor implements WorkspaceExecutor, GitRepositoryExecutor, GitHubExecutor {
  constructor(private readonly agent: LocalAgent) {}

  listWorkspaces(context?: OperationContext): Promise<WorkspaceSummary[]> {
    return this.agent.listWorkspaces(context);
  }

  listWorkspaceRoots(
    input: ListWorkspaceRootsInput,
    context?: OperationContext,
  ): Promise<ListWorkspaceRootsResult> {
    return this.agent.listWorkspaceRoots(input, context);
  }

  listFiles(input: ListFilesInput, context?: OperationContext): Promise<ListFilesResult> {
    return this.agent.listFiles(input, context);
  }

  readFile(input: ReadFileInput, context?: OperationContext): Promise<ReadFileResult> {
    return this.agent.readFile(input, context);
  }

  readBinaryFile(
    input: ReadBinaryFileInput,
    context?: OperationContext,
  ): Promise<ReadBinaryFileResult> {
    return this.agent.readBinaryFile(input, context);
  }

  writeFile(input: WriteFileInput, context?: OperationContext): Promise<WriteFileResult> {
    return this.agent.writeFile(input, context);
  }

  patchFile(input: PatchFileInput, context?: OperationContext): Promise<PatchFileResult> {
    return this.agent.patchFile(input, context);
  }

  runValidation(
    input: RunWorkspaceValidationInput,
    context?: OperationContext,
  ): Promise<RunWorkspaceValidationResult> {
    return this.agent.runValidation(input, context);
  }

  runCommand(input: RunCommandInput, context?: OperationContext): Promise<RunCommandResult> {
    return this.agent.runCommand(input, context);
  }

  runPowerShell(input: RunPowerShellInput, context?: OperationContext): Promise<RunPowerShellResult> {
    return this.agent.runPowerShell(input, context);
  }

  searchFiles(input: SearchFilesInput, context?: OperationContext): Promise<SearchFilesResult> {
    return this.agent.searchFiles(input, context);
  }

  inspectGit(input: InspectGitInput, context?: OperationContext): Promise<InspectGitResult> {
    return this.agent.inspectGit(input, context);
  }

  getWorkspaceContext(
    input: GetWorkspaceContextInput,
    context?: OperationContext,
  ): Promise<GetWorkspaceContextResult> {
    return this.agent.getWorkspaceContext(input, context);
  }

  startBackgroundTask(
    input: StartBackgroundTaskInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskResult> {
    return this.agent.startBackgroundTask(input, context);
  }

  getBackgroundTask(
    input: GetBackgroundTaskInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskResult> {
    return this.agent.getBackgroundTask(input, context);
  }

  waitBackgroundTask(
    input: WaitBackgroundTaskInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskWaitResult> {
    return this.agent.waitBackgroundTask(input, context);
  }
  listBackgroundTasks(
    input: ListBackgroundTasksInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskListResult> {
    return this.agent.listBackgroundTasks(input, context);
  }

  cancelBackgroundTask(
    input: CancelBackgroundTaskInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskResult> {
    return this.agent.cancelBackgroundTask(input, context);
  }

  readBackgroundTaskLogs(
    input: ReadBackgroundTaskLogsInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskLogsLookupResult> {
    return this.agent.readBackgroundTaskLogs(input, context);
  }
  createBranch(...args: Parameters<GitRepositoryExecutor["createBranch"]>) {
    return this.agent.gitCreateBranch(...args);
  }
  stagePaths(...args: Parameters<GitRepositoryExecutor["stagePaths"]>) {
    return this.agent.gitStagePaths(...args);
  }
  unstagePaths(...args: Parameters<GitRepositoryExecutor["unstagePaths"]>) {
    return this.agent.gitUnstagePaths(...args);
  }
  commit(...args: Parameters<GitRepositoryExecutor["commit"]>) {
    return this.agent.gitCommit(...args);
  }
  mergeBranch(...args: Parameters<GitRepositoryExecutor["mergeBranch"]>) {
    return this.agent.gitMergeBranch(...args);
  }
  pushBranch(...args: Parameters<GitRepositoryExecutor["pushBranch"]>) {
    return this.agent.gitPushBranch(...args);
  }
  getRepository(...args: Parameters<GitHubExecutor["getRepository"]>) {
    return this.agent.githubGetRepository(...args);
  }
  createRepository(...args: Parameters<GitHubExecutor["createRepository"]>) {
    return this.agent.githubCreateRepository(...args);
  }
  getPullRequest(...args: Parameters<GitHubExecutor["getPullRequest"]>) {
    return this.agent.githubGetPullRequest(...args);
  }
  createPullRequest(...args: Parameters<GitHubExecutor["createPullRequest"]>) {
    return this.agent.githubCreatePullRequest(...args);
  }
  mergePullRequest(...args: Parameters<GitHubExecutor["mergePullRequest"]>) {
    return this.agent.githubMergePullRequest(...args);
  }
}
