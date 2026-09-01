import {
  backgroundTaskListResultSchema,
  backgroundTaskLogsLookupResultSchema,
  backgroundTaskResultSchema,
  backgroundTaskWaitResultSchema,
  getWorkspaceContextResultSchema,
  inspectGitResultSchema,
  listFilesResultSchema,
  listWorkspaceRootsResultSchema,
  listWorkspacesResultSchema,
  patchFileResultSchema,
  readFileResultSchema,
  readBinaryFileResultSchema,
  runWorkspaceValidationResultSchema,
  runCommandResultSchema,
  runPowerShellResultSchema,
  searchFilesResultSchema,
  writeFileResultSchema,
  type CancelBackgroundTaskInput,
  type GetBackgroundTaskInput,
  type WaitBackgroundTaskInput,
  type GetWorkspaceContextInput,
  type InspectGitInput,
  type ListBackgroundTasksInput,
  type ListFilesInput,
  type ListWorkspaceRootsInput,
  type OperationContext,
  type PatchFileInput,
  type ReadBackgroundTaskLogsInput,
  type ReadFileInput,
  type ReadBinaryFileInput,
  type RunWorkspaceValidationInput,
  type RunCommandInput,
  type SearchFilesInput,
  type RunPowerShellInput,
  type StartBackgroundTaskInput,
  type WriteFileInput,
  type WorkspaceExecutor,
} from "@vs-code-gpt/shared";
import {
  gitCommitResultSchema,
  gitCreateBranchResultSchema,
  gitMergeBranchResultSchema,
  gitPushBranchResultSchema,
  gitStagePathsResultSchema,
  gitUnstagePathsResultSchema,
  githubCreatePullRequestResultSchema,
  githubCreateRepositoryResultSchema,
  githubMergePullRequestResultSchema,
  githubPullRequestResultSchema,
  githubRepositoryResultSchema,
  type GitCommitInput,
  type GitHubExecutor,
  type GitRepositoryExecutor,
  type GitCreateBranchInput,
  type GitHubCreatePullRequestInput,
  type GitHubCreateRepositoryInput,
  type GitHubGetPullRequestInput,
  type GitHubGetRepositoryInput,
  type GitHubMergePullRequestInput,
  type GitMergeBranchInput,
  type GitPushBranchInput,
  type GitStagePathsInput,
  type GitUnstagePathsInput,
} from "@vs-code-gpt/shared";
import type { AgentRelay } from "./service.js";

/** Forwards workspace operations to the connected local agent through the WSS relay. */
export class RelayWorkspaceExecutor implements WorkspaceExecutor, GitRepositoryExecutor, GitHubExecutor {
  constructor(private readonly relay: AgentRelay) {}

  async listWorkspaces(context?: OperationContext) {
    return listWorkspacesResultSchema.parse(
      await this.relay.call("listWorkspaces", {}, context),
    );
  }

  async listWorkspaceRoots(input: ListWorkspaceRootsInput, context?: OperationContext) {
    return listWorkspaceRootsResultSchema.parse(
      await this.relay.call("listWorkspaceRoots", input, context),
    );
  }

  async listFiles(input: ListFilesInput, context?: OperationContext) {
    return listFilesResultSchema.parse(await this.relay.call("listFiles", input, context));
  }

  async readFile(input: ReadFileInput, context?: OperationContext) {
    return readFileResultSchema.parse(await this.relay.call("readFile", input, context));
  }

  async readBinaryFile(input: ReadBinaryFileInput, context?: OperationContext) {
    return readBinaryFileResultSchema.parse(
      await this.relay.call("readBinaryFile", input, context),
    );
  }

  async writeFile(input: WriteFileInput, context?: OperationContext) {
    return writeFileResultSchema.parse(await this.relay.call("writeFile", input, context));
  }

  async patchFile(input: PatchFileInput, context?: OperationContext) {
    return patchFileResultSchema.parse(await this.relay.call("patchFile", input, context));
  }

  async runValidation(
    input: RunWorkspaceValidationInput,
    context?: OperationContext,
  ) {
    return runWorkspaceValidationResultSchema.parse(
      await this.relay.call("runValidation", input, context),
    );
  }

  async runCommand(input: RunCommandInput, context?: OperationContext) {
    return runCommandResultSchema.parse(
      await this.relay.call("runCommand", input, context),
    );
  }

  async runPowerShell(input: RunPowerShellInput, context?: OperationContext) {
    return runPowerShellResultSchema.parse(
      await this.relay.call("runPowerShell", input, context),
    );
  }

  async searchFiles(input: SearchFilesInput, context?: OperationContext) {
    return searchFilesResultSchema.parse(
      await this.relay.call("searchFiles", input, context),
    );
  }

  async inspectGit(input: InspectGitInput, context?: OperationContext) {
    return inspectGitResultSchema.parse(
      await this.relay.call("inspectGit", input, context),
    );
  }

  async getWorkspaceContext(
    input: GetWorkspaceContextInput,
    context?: OperationContext,
  ) {
    return getWorkspaceContextResultSchema.parse(
      await this.relay.call("getWorkspaceContext", input, context),
    );
  }

  async startBackgroundTask(
    input: StartBackgroundTaskInput,
    context?: OperationContext,
  ) {
    return backgroundTaskResultSchema.parse(
      await this.relay.call("startBackgroundTask", input, context),
    );
  }

  async getBackgroundTask(
    input: GetBackgroundTaskInput,
    context?: OperationContext,
  ) {
    return backgroundTaskResultSchema.parse(
      await this.relay.call("getBackgroundTask", input, context),
    );
  }

  async waitBackgroundTask(
    input: WaitBackgroundTaskInput,
    context?: OperationContext,
  ) {
    return backgroundTaskWaitResultSchema.parse(
      await this.relay.call("waitBackgroundTask", input, context),
    );
  }

  async listBackgroundTasks(
    input: ListBackgroundTasksInput,
    context?: OperationContext,
  ) {
    return backgroundTaskListResultSchema.parse(
      await this.relay.call("listBackgroundTasks", input, context),
    );
  }

  async cancelBackgroundTask(
    input: CancelBackgroundTaskInput,
    context?: OperationContext,
  ) {
    return backgroundTaskResultSchema.parse(
      await this.relay.call("cancelBackgroundTask", input, context),
    );
  }

  async readBackgroundTaskLogs(
    input: ReadBackgroundTaskLogsInput,
    context?: OperationContext,
  ) {
    return backgroundTaskLogsLookupResultSchema.parse(
      await this.relay.call("readBackgroundTaskLogs", input, context),
    );
  }
  async createBranch(input: GitCreateBranchInput, context?: OperationContext) {
    return gitCreateBranchResultSchema.parse(
      await this.relay.call("gitCreateBranch", input, context),
    );
  }

  async stagePaths(input: GitStagePathsInput, context?: OperationContext) {
    return gitStagePathsResultSchema.parse(
      await this.relay.call("gitStagePaths", input, context),
    );
  }

  async unstagePaths(input: GitUnstagePathsInput, context?: OperationContext) {
    return gitUnstagePathsResultSchema.parse(
      await this.relay.call("gitUnstagePaths", input, context),
    );
  }

  async commit(input: GitCommitInput, context?: OperationContext) {
    return gitCommitResultSchema.parse(
      await this.relay.call("gitCommit", input, context),
    );
  }

  async mergeBranch(input: GitMergeBranchInput, context?: OperationContext) {
    return gitMergeBranchResultSchema.parse(
      await this.relay.call("gitMergeBranch", input, context),
    );
  }

  async pushBranch(input: GitPushBranchInput, context?: OperationContext) {
    return gitPushBranchResultSchema.parse(
      await this.relay.call("gitPushBranch", input, context),
    );
  }

  async getRepository(input: GitHubGetRepositoryInput, context?: OperationContext) {
    return githubRepositoryResultSchema.parse(
      await this.relay.call("githubGetRepository", input, context),
    );
  }

  async createRepository(input: GitHubCreateRepositoryInput, context?: OperationContext) {
    return githubCreateRepositoryResultSchema.parse(
      await this.relay.call("githubCreateRepository", input, context),
    );
  }

  async getPullRequest(input: GitHubGetPullRequestInput, context?: OperationContext) {
    return githubPullRequestResultSchema.parse(
      await this.relay.call("githubGetPullRequest", input, context),
    );
  }

  async createPullRequest(input: GitHubCreatePullRequestInput, context?: OperationContext) {
    return githubCreatePullRequestResultSchema.parse(
      await this.relay.call("githubCreatePullRequest", input, context),
    );
  }

  async mergePullRequest(input: GitHubMergePullRequestInput, context?: OperationContext) {
    return githubMergePullRequestResultSchema.parse(
      await this.relay.call("githubMergePullRequest", input, context),
    );
  }
}
