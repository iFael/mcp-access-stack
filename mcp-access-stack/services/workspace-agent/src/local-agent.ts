import { createHash } from "node:crypto";
import path from "node:path";
import {
  AppError,
  disabledQualifiedCommandFeatureFlags,
  asAppError,
  cancelBackgroundTaskInputSchema,
  getBackgroundTaskInputSchema,
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
  type CancelBackgroundTaskInput,
  type DirectRunCommandInput,
  type GetBackgroundTaskInput,
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

interface AuditMetadata {
  path?: string;
  query?: string;
}

export interface LocalAgentOptions {
  qualifiedCommandFeatures?: QualifiedCommandFeatureFlags;
  qualifiedInvocationStateDirectory?: string;
  qualifiedCommandProvider?: QualifiedCommandProvider;
  qualifiedCommandWorkspaceAllowlist?: readonly string[];
  qualifiedCommandTelemetry?: (event: QualifiedCommandTelemetryEvent) => void;
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

  private constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly audit: AuditLogger,
    options: LocalAgentOptions = {},
  ) {
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
