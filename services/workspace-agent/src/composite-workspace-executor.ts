import {
  AppError,
  type GitHubChecksWatchExecutor,
  type GitHubExecutor,
  type GitRepositoryExecutor,
  type OperationContext,
  type WorkspaceExecutor,
  type WorkspaceSummary,
} from "@vs-code-gpt/shared";

export type RoutedWorkspaceExecutor =
  & WorkspaceExecutor
  & GitRepositoryExecutor
  & GitHubExecutor
  & GitHubChecksWatchExecutor;

/**
 * Routes workspace-scoped operations to the executor that owns the workspace id.
 * listWorkspaces is the only aggregate operation; every other operation remains
 * explicitly bound to its existing workspaceId.
 */
export class CompositeWorkspaceExecutor
implements WorkspaceExecutor, GitRepositoryExecutor, GitHubExecutor, GitHubChecksWatchExecutor {
  private constructor(
    private readonly routes: ReadonlyMap<string, RoutedWorkspaceExecutor>,
    private readonly executors: readonly RoutedWorkspaceExecutor[],
  ) {}

  static async create(
    executors: readonly RoutedWorkspaceExecutor[],
    context: OperationContext = {},
  ): Promise<CompositeWorkspaceExecutor> {
    if (executors.length === 0) {
      throw new AppError("POLICY_INVALID", "Composite workspace executor requires at least one executor.");
    }

    const routes = new Map<string, RoutedWorkspaceExecutor>();
    for (const executor of executors) {
      for (const workspace of await executor.listWorkspaces(context)) {
        if (routes.has(workspace.id)) {
          throw new AppError(
            "POLICY_INVALID",
            `Workspace id is owned by more than one executor: ${workspace.id}`,
          );
        }
        routes.set(workspace.id, executor);
      }
    }

    return new CompositeWorkspaceExecutor(routes, [...executors]);
  }

  async listWorkspaces(context: OperationContext = {}): Promise<WorkspaceSummary[]> {
    const listed = await Promise.all(
      this.executors.map((executor) => executor.listWorkspaces(context)),
    );
    return listed
      .flat()
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  listWorkspaceRoots(...args: Parameters<WorkspaceExecutor["listWorkspaceRoots"]>) {
    return this.workspace(args[0].workspaceId).listWorkspaceRoots(...args);
  }

  listFiles(...args: Parameters<WorkspaceExecutor["listFiles"]>) {
    return this.workspace(args[0].workspaceId).listFiles(...args);
  }

  readFile(...args: Parameters<WorkspaceExecutor["readFile"]>) {
    return this.workspace(args[0].workspaceId).readFile(...args);
  }

  readBinaryFile(...args: Parameters<WorkspaceExecutor["readBinaryFile"]>) {
    return this.workspace(args[0].workspaceId).readBinaryFile(...args);
  }

  writeFile(...args: Parameters<WorkspaceExecutor["writeFile"]>) {
    return this.workspace(args[0].workspaceId).writeFile(...args);
  }

  patchFile(...args: Parameters<WorkspaceExecutor["patchFile"]>) {
    return this.workspace(args[0].workspaceId).patchFile(...args);
  }

  getReleaseState(...args: Parameters<WorkspaceExecutor["getReleaseState"]>) {
    return this.workspace(args[0].workspaceId).getReleaseState(...args);
  }

  prepareRelease(...args: Parameters<WorkspaceExecutor["prepareRelease"]>) {
    return this.workspace(args[0].workspaceId).prepareRelease(...args);
  }

  promoteRelease(...args: Parameters<WorkspaceExecutor["promoteRelease"]>) {
    return this.workspace(args[0].workspaceId).promoteRelease(...args);
  }

  runValidation(...args: Parameters<WorkspaceExecutor["runValidation"]>) {
    return this.workspace(args[0].workspaceId).runValidation(...args);
  }

  runCommand(...args: Parameters<WorkspaceExecutor["runCommand"]>) {
    return this.workspace(args[0].workspaceId).runCommand(...args);
  }

  searchFiles(...args: Parameters<WorkspaceExecutor["searchFiles"]>) {
    return this.workspace(args[0].workspaceId).searchFiles(...args);
  }

  inspectGit(...args: Parameters<WorkspaceExecutor["inspectGit"]>) {
    return this.workspace(args[0].workspaceId).inspectGit(...args);
  }

  getWorkspaceContext(...args: Parameters<WorkspaceExecutor["getWorkspaceContext"]>) {
    return this.workspace(args[0].workspaceId).getWorkspaceContext(...args);
  }

  startBackgroundTask(...args: Parameters<WorkspaceExecutor["startBackgroundTask"]>) {
    return this.workspace(args[0].workspaceId).startBackgroundTask(...args);
  }

  getBackgroundTask(...args: Parameters<WorkspaceExecutor["getBackgroundTask"]>) {
    return this.workspace(args[0].workspaceId).getBackgroundTask(...args);
  }

  waitBackgroundTask(...args: Parameters<WorkspaceExecutor["waitBackgroundTask"]>) {
    return this.workspace(args[0].workspaceId).waitBackgroundTask(...args);
  }

  listBackgroundTasks(...args: Parameters<WorkspaceExecutor["listBackgroundTasks"]>) {
    return this.workspace(args[0].workspaceId).listBackgroundTasks(...args);
  }

  cancelBackgroundTask(...args: Parameters<WorkspaceExecutor["cancelBackgroundTask"]>) {
    return this.workspace(args[0].workspaceId).cancelBackgroundTask(...args);
  }

  readBackgroundTaskLogs(...args: Parameters<WorkspaceExecutor["readBackgroundTaskLogs"]>) {
    return this.workspace(args[0].workspaceId).readBackgroundTaskLogs(...args);
  }

  writeBackgroundTaskStdin(...args: Parameters<WorkspaceExecutor["writeBackgroundTaskStdin"]>) {
    return this.workspace(args[0].workspaceId).writeBackgroundTaskStdin(...args);
  }

  readBackgroundTaskOutput(...args: Parameters<WorkspaceExecutor["readBackgroundTaskOutput"]>) {
    return this.workspace(args[0].workspaceId).readBackgroundTaskOutput(...args);
  }

  createBranch(...args: Parameters<GitRepositoryExecutor["createBranch"]>) {
    return this.workspace(args[0].workspaceId).createBranch(...args);
  }

  stagePaths(...args: Parameters<GitRepositoryExecutor["stagePaths"]>) {
    return this.workspace(args[0].workspaceId).stagePaths(...args);
  }

  unstagePaths(...args: Parameters<GitRepositoryExecutor["unstagePaths"]>) {
    return this.workspace(args[0].workspaceId).unstagePaths(...args);
  }

  commit(...args: Parameters<GitRepositoryExecutor["commit"]>) {
    return this.workspace(args[0].workspaceId).commit(...args);
  }

  mergeBranch(...args: Parameters<GitRepositoryExecutor["mergeBranch"]>) {
    return this.workspace(args[0].workspaceId).mergeBranch(...args);
  }

  syncBranch(...args: Parameters<GitRepositoryExecutor["syncBranch"]>) {
    return this.workspace(args[0].workspaceId).syncBranch(...args);
  }

  pushBranch(...args: Parameters<GitRepositoryExecutor["pushBranch"]>) {
    return this.workspace(args[0].workspaceId).pushBranch(...args);
  }

  startCommitChecksWatch(...args: Parameters<GitHubChecksWatchExecutor["startCommitChecksWatch"]>) {
    return this.workspace(args[0].workspaceId).startCommitChecksWatch(...args);
  }

  getCommitChecksWatches(...args: Parameters<GitHubChecksWatchExecutor["getCommitChecksWatches"]>) {
    return this.workspace(args[0].workspaceId).getCommitChecksWatches(...args);
  }

  waitCommitChecksWatch(...args: Parameters<GitHubChecksWatchExecutor["waitCommitChecksWatch"]>) {
    return this.workspace(args[0].workspaceId).waitCommitChecksWatch(...args);
  }

  getRepository(...args: Parameters<GitHubExecutor["getRepository"]>) {
    return this.workspace(args[0].workspaceId).getRepository(...args);
  }

  getCommitChecks(...args: Parameters<GitHubExecutor["getCommitChecks"]>) {
    return this.workspace(args[0].workspaceId).getCommitChecks(...args);
  }

  createRepository(...args: Parameters<GitHubExecutor["createRepository"]>) {
    return this.workspace(args[0].workspaceId).createRepository(...args);
  }

  getPullRequest(...args: Parameters<GitHubExecutor["getPullRequest"]>) {
    return this.workspace(args[0].workspaceId).getPullRequest(...args);
  }

  createPullRequest(...args: Parameters<GitHubExecutor["createPullRequest"]>) {
    return this.workspace(args[0].workspaceId).createPullRequest(...args);
  }

  mergePullRequest(...args: Parameters<GitHubExecutor["mergePullRequest"]>) {
    return this.workspace(args[0].workspaceId).mergePullRequest(...args);
  }

  private workspace(workspaceId: string): RoutedWorkspaceExecutor {
    const executor = this.routes.get(workspaceId);
    if (!executor) {
      throw new AppError("WORKSPACE_NOT_FOUND", "Workspace was not found.");
    }
    return executor;
  }
}
