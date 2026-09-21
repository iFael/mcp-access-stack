import type {
  BackgroundTaskListResult,
  BackgroundTaskLogsLookupResult,
  BackgroundTaskOutputResult,
  BackgroundTaskResult,
  BackgroundTaskStdinResult,
  BackgroundTaskWaitResult,
  CancelBackgroundTaskInput,
  GetBackgroundTaskInput,
  ListBackgroundTasksInput,
  ReadBackgroundTaskLogsInput,
  ReadBackgroundTaskOutputInput,
  StartBackgroundTaskInput,
  StartBackgroundTaskResult,
  WaitBackgroundTaskInput,
  WriteBackgroundTaskStdinInput,
} from "./background-task-contracts.js";
import type {
  GetReleaseStateInput,
  GetReleaseStateResult,
  PrepareReleaseInput,
  PrepareReleaseResult,
  PromoteReleaseInput,
  PromoteReleaseResult,
} from "./release-lifecycle-contracts.js";
import type {
  GetWorkspaceContextInput,
  GetWorkspaceContextResult,
  InspectGitInput,
  InspectGitResult,
  ListFilesInput,
  ListFilesResult,
  ListWorkspaceRootsInput,
  ListWorkspaceRootsResult,
  OperationContext,
  PatchFileInput,
  PatchFileResult,
  ReadFileInput,
  ReadBinaryFileInput,
  ReadBinaryFileResult,
  RunWorkspaceValidationInput,
  RunWorkspaceValidationResult,
  ReadFileResult,
  RunCommandInput,
  RunCommandResult,
  SearchFilesInput,
  SearchFilesResult,
  WriteFileInput,
  WriteFileResult,
  WorkspaceSummary,
} from "./contracts.js";

/** Operations that may move to a worker/subprocess if the extension host is impacted. */
export const HEAVY_WORKSPACE_OPERATIONS = [
  "searchFiles",
  "listFiles",
  "inspectGit",
] as const;

export type HeavyWorkspaceOperation = (typeof HEAVY_WORKSPACE_OPERATIONS)[number];

/**
 * Port between MCP tool handlers and workspace data access.
 * Implementations: in-process LocalAgent, relay WSS, or future subprocess worker.
 */
export interface WorkspaceExecutor {
  listWorkspaces(context?: OperationContext): Promise<WorkspaceSummary[]>;
  listWorkspaceRoots(
    input: ListWorkspaceRootsInput,
    context?: OperationContext,
  ): Promise<ListWorkspaceRootsResult>;
  listFiles(input: ListFilesInput, context?: OperationContext): Promise<ListFilesResult>;
  readFile(input: ReadFileInput, context?: OperationContext): Promise<ReadFileResult>;
  readBinaryFile(
    input: ReadBinaryFileInput,
    context?: OperationContext,
  ): Promise<ReadBinaryFileResult>;
  writeFile(input: WriteFileInput, context?: OperationContext): Promise<WriteFileResult>;
  patchFile(input: PatchFileInput, context?: OperationContext): Promise<PatchFileResult>;
  getReleaseState(
    input: GetReleaseStateInput,
    context?: OperationContext,
  ): Promise<GetReleaseStateResult>;
  prepareRelease(
    input: PrepareReleaseInput,
    context?: OperationContext,
  ): Promise<PrepareReleaseResult>;
  promoteRelease(
    input: PromoteReleaseInput,
    context?: OperationContext,
  ): Promise<PromoteReleaseResult>;
  runValidation(
    input: RunWorkspaceValidationInput,
    context?: OperationContext,
  ): Promise<RunWorkspaceValidationResult>;
  runCommand(input: RunCommandInput, context?: OperationContext): Promise<RunCommandResult>;
  searchFiles(input: SearchFilesInput, context?: OperationContext): Promise<SearchFilesResult>;
  inspectGit(input: InspectGitInput, context?: OperationContext): Promise<InspectGitResult>;
  getWorkspaceContext(
    input: GetWorkspaceContextInput,
    context?: OperationContext,
  ): Promise<GetWorkspaceContextResult>;
  startBackgroundTask(
    input: StartBackgroundTaskInput,
    context?: OperationContext,
  ): Promise<StartBackgroundTaskResult>;
  getBackgroundTask(
    input: GetBackgroundTaskInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskResult>;
  waitBackgroundTask(
    input: WaitBackgroundTaskInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskWaitResult>;
  listBackgroundTasks(
    input: ListBackgroundTasksInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskListResult>;
  cancelBackgroundTask(
    input: CancelBackgroundTaskInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskResult>;
  readBackgroundTaskLogs(
    input: ReadBackgroundTaskLogsInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskLogsLookupResult>;
  writeBackgroundTaskStdin(
    input: WriteBackgroundTaskStdinInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskStdinResult>;
  readBackgroundTaskOutput(
    input: ReadBackgroundTaskOutputInput,
    context?: OperationContext,
  ): Promise<BackgroundTaskOutputResult>;
}
