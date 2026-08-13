import type {
  BackgroundTaskListResult,
  BackgroundTaskLogsLookupResult,
  BackgroundTaskResult,
  CancelBackgroundTaskInput,
  GetBackgroundTaskInput,
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
  WorkspaceSummary,
} from "@vs-code-gpt/shared";
import type { LocalAgent } from "./local-agent.js";

/** Delegates workspace operations to a LocalAgent running in the same process. */
export class InProcessWorkspaceExecutor implements WorkspaceExecutor {
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
}
