import { AppError, type WorkspaceExecutor } from "@vs-code-gpt/shared";

/**
 * Future offload path for heavy operations (`searchFiles`, `listFiles`, `inspectGit`).
 * PoC keeps all work in-process via {@link InProcessWorkspaceExecutor}.
 */
export class SubprocessWorkspaceExecutor implements WorkspaceExecutor {
  constructor(private readonly fallback?: WorkspaceExecutor) {}

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

  runValidation(...args: Parameters<WorkspaceExecutor["runValidation"]>) {
    return this.fallback?.runValidation(...args) ??
      Promise.reject(this.notImplemented("runValidation"));
  }

  runCommand(...args: Parameters<WorkspaceExecutor["runCommand"]>) {
    return this.fallback?.runCommand(...args) ??
      Promise.reject(this.notImplemented("runCommand"));
  }

  runPowerShell(...args: Parameters<WorkspaceExecutor["runPowerShell"]>) {
    return this.fallback?.runPowerShell(...args) ??
      Promise.reject(this.notImplemented("runPowerShell"));
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
}
