import { AppError, type GitHubChecksWatchExecutor, type GitHubExecutor, type GitRepositoryExecutor, type WorkspaceExecutor } from "@vs-code-gpt/shared";

type SubprocessFallback = WorkspaceExecutor & Partial<GitRepositoryExecutor> & Partial<GitHubExecutor> & Partial<GitHubChecksWatchExecutor>;

/**
 * Future offload path for heavy operations (`searchFiles`, `listFiles`, `inspectGit`).
 * PoC keeps all work in-process via {@link InProcessWorkspaceExecutor}.
 */
export class SubprocessWorkspaceExecutor implements WorkspaceExecutor, GitRepositoryExecutor, GitHubExecutor, GitHubChecksWatchExecutor {
  constructor(private readonly fallback?: SubprocessFallback) {}

  private notImplemented(operation: string): never {
    throw new AppError(
      "INTERNAL_ERROR",
      `SubprocessWorkspaceExecutor is not implemented yet (${operation}). Use InProcessWorkspaceExecutor for the PoC.`,
    );
  }

  listWorkspaces(...args: Parameters<WorkspaceExecutor["listWorkspaces"]>) {
    return this.fallback?.listWorkspaces(...args) ??
      Promise.reject(this.notImplemented("listWorkspaces"));
  }

  listWorkspaceRoots(...args: Parameters<WorkspaceExecutor["listWorkspaceRoots"]>) {
    return this.fallback?.listWorkspaceRoots(...args) ??
      Promise.reject(this.notImplemented("listWorkspaceRoots"));
  }

  listFiles(...args: Parameters<WorkspaceExecutor["listFiles"]>) {
    return this.fallback?.listFiles(...args) ??
      Promise.reject(this.notImplemented("listFiles"));
  }

  readFile(...args: Parameters<WorkspaceExecutor["readFile"]>) {
    return this.fallback?.readFile(...args) ??
      Promise.reject(this.notImplemented("readFile"));
  }

  readBinaryFile(...args: Parameters<WorkspaceExecutor["readBinaryFile"]>) {
    return this.fallback?.readBinaryFile(...args) ??
      Promise.reject(this.notImplemented("readBinaryFile"));
  }

  writeFile(...args: Parameters<WorkspaceExecutor["writeFile"]>) {
    return this.fallback?.writeFile(...args) ??
      Promise.reject(this.notImplemented("writeFile"));
  }

  patchFile(...args: Parameters<WorkspaceExecutor["patchFile"]>) {
    return this.fallback?.patchFile(...args) ??
      Promise.reject(this.notImplemented("patchFile"));
  }

  getReleaseState(...args: Parameters<WorkspaceExecutor["getReleaseState"]>) {
    return this.fallback?.getReleaseState(...args) ??
      Promise.reject(this.notImplemented("getReleaseState"));
  }

  prepareRelease(...args: Parameters<WorkspaceExecutor["prepareRelease"]>) {
    return this.fallback?.prepareRelease(...args) ??
      Promise.reject(this.notImplemented("prepareRelease"));
  }

  promoteRelease(...args: Parameters<WorkspaceExecutor["promoteRelease"]>) {
    return this.fallback?.promoteRelease(...args) ??
      Promise.reject(this.notImplemented("promoteRelease"));
  }

  runValidation(...args: Parameters<WorkspaceExecutor["runValidation"]>) {
    return this.fallback?.runValidation(...args) ??
      Promise.reject(this.notImplemented("runValidation"));
  }

  runCommand(...args: Parameters<WorkspaceExecutor["runCommand"]>) {
    return this.fallback?.runCommand(...args) ??
      Promise.reject(this.notImplemented("runCommand"));
  }


  searchFiles(...args: Parameters<WorkspaceExecutor["searchFiles"]>) {
    return this.fallback?.searchFiles(...args) ??
      Promise.reject(this.notImplemented("searchFiles"));
  }

  inspectGit(...args: Parameters<WorkspaceExecutor["inspectGit"]>) {
    return this.fallback?.inspectGit(...args) ??
      Promise.reject(this.notImplemented("inspectGit"));
  }

  getWorkspaceContext(
    ...args: Parameters<WorkspaceExecutor["getWorkspaceContext"]>
  ) {
    return this.fallback?.getWorkspaceContext(...args) ??
      Promise.reject(this.notImplemented("getWorkspaceContext"));
  }

  startBackgroundTask(
    ...args: Parameters<WorkspaceExecutor["startBackgroundTask"]>
  ) {
    return this.fallback?.startBackgroundTask(...args) ??
      Promise.reject(this.notImplemented("startBackgroundTask"));
  }

  getBackgroundTask(
    ...args: Parameters<WorkspaceExecutor["getBackgroundTask"]>
  ) {
    return this.fallback?.getBackgroundTask(...args) ??
      Promise.reject(this.notImplemented("getBackgroundTask"));
  }

  waitBackgroundTask(
    ...args: Parameters<WorkspaceExecutor["waitBackgroundTask"]>
  ) {
    return this.fallback?.waitBackgroundTask(...args) ??
      Promise.reject(this.notImplemented("waitBackgroundTask"));
  }
  listBackgroundTasks(
    ...args: Parameters<WorkspaceExecutor["listBackgroundTasks"]>
  ) {
    return this.fallback?.listBackgroundTasks(...args) ??
      Promise.reject(this.notImplemented("listBackgroundTasks"));
  }

  cancelBackgroundTask(
    ...args: Parameters<WorkspaceExecutor["cancelBackgroundTask"]>
  ) {
    return this.fallback?.cancelBackgroundTask(...args) ??
      Promise.reject(this.notImplemented("cancelBackgroundTask"));
  }

  readBackgroundTaskLogs(
    ...args: Parameters<WorkspaceExecutor["readBackgroundTaskLogs"]>
  ) {
    return this.fallback?.readBackgroundTaskLogs(...args) ??
      Promise.reject(this.notImplemented("readBackgroundTaskLogs"));
  }

  writeBackgroundTaskStdin(
    ...args: Parameters<WorkspaceExecutor["writeBackgroundTaskStdin"]>
  ) {
    return this.fallback?.writeBackgroundTaskStdin(...args) ??
      Promise.reject(this.notImplemented("writeBackgroundTaskStdin"));
  }

  readBackgroundTaskOutput(
    ...args: Parameters<WorkspaceExecutor["readBackgroundTaskOutput"]>
  ) {
    return this.fallback?.readBackgroundTaskOutput(...args) ??
      Promise.reject(this.notImplemented("readBackgroundTaskOutput"));
  }
  createBranch(...args: Parameters<GitRepositoryExecutor["createBranch"]>) {
    return this.fallback?.createBranch?.(...args) ?? Promise.reject(this.notImplemented("createBranch"));
  }
  stagePaths(...args: Parameters<GitRepositoryExecutor["stagePaths"]>) {
    return this.fallback?.stagePaths?.(...args) ?? Promise.reject(this.notImplemented("stagePaths"));
  }
  unstagePaths(...args: Parameters<GitRepositoryExecutor["unstagePaths"]>) {
    return this.fallback?.unstagePaths?.(...args) ?? Promise.reject(this.notImplemented("unstagePaths"));
  }
  commit(...args: Parameters<GitRepositoryExecutor["commit"]>) {
    return this.fallback?.commit?.(...args) ?? Promise.reject(this.notImplemented("commit"));
  }
  mergeBranch(...args: Parameters<GitRepositoryExecutor["mergeBranch"]>) {
    return this.fallback?.mergeBranch?.(...args) ?? Promise.reject(this.notImplemented("mergeBranch"));
  }
  syncBranch(...args: Parameters<GitRepositoryExecutor["syncBranch"]>) {
    return this.fallback?.syncBranch?.(...args) ?? Promise.reject(this.notImplemented("syncBranch"));
  }
  pushBranch(...args: Parameters<GitRepositoryExecutor["pushBranch"]>) {
    return this.fallback?.pushBranch?.(...args) ?? Promise.reject(this.notImplemented("pushBranch"));
  }
  getRepository(...args: Parameters<GitHubExecutor["getRepository"]>) {
    return this.fallback?.getRepository?.(...args) ?? Promise.reject(this.notImplemented("getRepository"));
  }
  getCommitChecks(...args: Parameters<GitHubExecutor["getCommitChecks"]>) {
    return this.fallback?.getCommitChecks?.(...args) ?? Promise.reject(this.notImplemented("getCommitChecks"));
  }
  startCommitChecksWatch(...args: Parameters<GitHubChecksWatchExecutor["startCommitChecksWatch"]>) {
    return this.fallback?.startCommitChecksWatch?.(...args) ?? Promise.reject(this.notImplemented("startCommitChecksWatch"));
  }
  getCommitChecksWatches(...args: Parameters<GitHubChecksWatchExecutor["getCommitChecksWatches"]>) {
    return this.fallback?.getCommitChecksWatches?.(...args) ?? Promise.reject(this.notImplemented("getCommitChecksWatches"));
  }
  waitCommitChecksWatch(...args: Parameters<GitHubChecksWatchExecutor["waitCommitChecksWatch"]>) {
    return this.fallback?.waitCommitChecksWatch?.(...args) ?? Promise.reject(this.notImplemented("waitCommitChecksWatch"));
  }
  createRepository(...args: Parameters<GitHubExecutor["createRepository"]>) {
    return this.fallback?.createRepository?.(...args) ?? Promise.reject(this.notImplemented("createRepository"));
  }
  getPullRequest(...args: Parameters<GitHubExecutor["getPullRequest"]>) {
    return this.fallback?.getPullRequest?.(...args) ?? Promise.reject(this.notImplemented("getPullRequest"));
  }
  createPullRequest(...args: Parameters<GitHubExecutor["createPullRequest"]>) {
    return this.fallback?.createPullRequest?.(...args) ?? Promise.reject(this.notImplemented("createPullRequest"));
  }
  mergePullRequest(...args: Parameters<GitHubExecutor["mergePullRequest"]>) {
    return this.fallback?.mergePullRequest?.(...args) ?? Promise.reject(this.notImplemented("mergePullRequest"));
  }
}
