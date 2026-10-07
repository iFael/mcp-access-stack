import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { z } from "zod";
import {
  abortSignalError,
  AppError,
  createOperationDeadline,
  createOperationLifecycle,
  prepareReleaseResultSchema,
  redactSensitiveText,
  remainingOperationTimeMs,
  promoteReleaseResultSchema,
  runCommandInputSchema,
  startBackgroundTaskInputSchema,
  windowsExecutionNodeStateSchema,
  type DirectRunCommandInput,
  type GetReleaseStateResult,
  type OperationContext,
  type RunCommandResult,
  type PrepareReleaseInput,
  type PrepareReleaseResult,
  type PromoteReleaseInput,
  type PromoteReleaseResult,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../internal-types.js";
import { PathSecurity } from "../path-security.js";
import type { ShellService } from "../shell/service.js";
import type { BackgroundTaskManager } from "../tasks/background-task-manager.js";

interface ReleaseShellService {
  authorizeBackgroundCommand: ShellService["authorizeBackgroundCommand"];
  runAuthorizedCommandToFiles: ShellService["runAuthorizedCommandToFiles"];
  runCommand: ShellService["runCommand"];
}

interface ReleaseBackgroundTaskManager {
  start_background_task: BackgroundTaskManager["start_background_task"];
}

const PREPARE_TIMEOUT_MS = 30 * 60 * 1_000;
const PROMOTE_TIMEOUT_MS = 60_000;

const edgeRecoveryConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskName: z.string().min(1),
    projectRoot: z.string().min(1),
    runtimeRoot: z.string().min(1),
    edgeBaseUrl: z.string().url().refine((value) => value.startsWith("https://"), {
      message: "edgeBaseUrl must use HTTPS.",
    }),
    connectorTokenFile: z.string().min(1),
    // Accepted only when reading recovery state written by an older release.
    ownerTokenFile: z.string().min(1).optional(),
    policyPath: z.string().min(1),
    allowedOrigins: z.string().min(1),
    ownerOAuthScopes: z.string().min(1).optional(),
    mcpSessionMode: z.literal("stateless").optional(),
    maxConcurrentRequests: z.number().int().positive(),
    delaySeconds: z.number().int().nonnegative(),
    browserEnabled: z.boolean(),
    browserWorkerUrl: z.string().nullable(),
    browserWorkerTokenFile: z.string().nullable(),
    updatedAt: z.string().min(1),
  })
  .strict();

const handoverResultSchema = z
  .object({
    status: z.literal("started"),
    detached: z.literal(true),
    requestId: z.uuid(),
    releaseId: z.string().min(1),
    brokerTaskName: z.string().min(1),
    requestPath: z.string().min(1),
    resultPath: z.string().min(1),
  })
  .strict();

const localUpdateHandoffSchema = z
  .object({
    status: z.literal("accepted"),
    operationId: z.string().regex(/^[a-f0-9]{32}$/iu),
    tag: z.string().nullable(),
    taskName: z.string().min(1),
    resultPath: z.string().min(1),
    activeReleaseId: z.string().min(1),
  })
  .strict();

export class ReleaseLifecycleService {
  constructor(
    private readonly shellService: ReleaseShellService,
    private readonly backgroundTaskManager: ReleaseBackgroundTaskManager,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async getState(workspace: ResolvedWorkspace): Promise<GetReleaseStateResult> {
    assertReleaseStateWorkspace(workspace, this.platform);
    const installationRoot = resolveInstallationRoot();
    const state = await readLifecycleState(installationRoot);
    const activeReleaseId = state.active?.releaseId;
    const bootstrap = resolveLifecycleBootstrap(
      this.platform,
      isLocalReleaseRuntime(this.platform),
    );
    const updateScriptPresent = activeReleaseId
      ? await fileExists(activeBootstrapPath(installationRoot, activeReleaseId, bootstrap.directory, bootstrap.updateScript))
      : false;
    const cutoverScriptPresent = activeReleaseId
      ? await fileExists(activeBootstrapPath(installationRoot, activeReleaseId, bootstrap.directory, bootstrap.cutoverScript))
      : false;

    return {
      workspaceId: workspace.id,
      installationRoot,
      state,
      activeBootstrap: {
        updateScriptPresent,
        cutoverScriptPresent,
      },
    };
  }

  async prepare(
    workspace: ResolvedWorkspace,
    repository: string,
    input: PrepareReleaseInput,
    context: OperationContext = {},
  ): Promise<PrepareReleaseResult> {
    assertReleaseWorkspace(workspace, this.platform);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Release preparation requires a canonical GitHub repository origin.",
      );
    }

    const installationRoot = resolveInstallationRoot();
    const state = await readLifecycleState(installationRoot);
    if (!state.active) {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Release preparation requires an active execution-node release.",
      );
    }
    const bootstrap = resolveLifecycleBootstrap(
      this.platform,
      isLocalReleaseRuntime(this.platform),
    );
    const updater = activeBootstrapPath(
      installationRoot,
      state.active.releaseId,
      bootstrap.directory,
      bootstrap.updateScript,
    );
    await assertBootstrapPresent(updater, bootstrap.updateScript);

    const command = buildPrepareCommand(
      this.platform,
      updater,
      repository,
      installationRoot,
      input.tag,
    );

    const lifecycleShell = resolveLifecycleShell(this.platform);
    const parsed = startBackgroundTaskInputSchema.parse({
      workspaceId: workspace.id,
      operation: "prepare_release",
      command,
      shell: lifecycleShell,
      cwd: ".",
      timeoutMs: PREPARE_TIMEOUT_MS,
      ...(input.confirmationId === undefined
        ? {}
        : { confirmationId: input.confirmationId }),
    });
    let authorizedCwd = ".";
    if (input.confirmationId !== undefined || !releaseAutonomyEnabled(workspace)) {
      const authorization = await this.shellService.authorizeBackgroundCommand(
        workspace,
        parsed,
        context.signal,
      );
      if ("status" in authorization) {
        return prepareReleaseResultSchema.parse({
          status: "confirmation_required",
          tag: input.tag,
          confirmationId: authorization.confirmationId,
          expiresAt: authorization.expiresAt,
          reasons: authorization.reasons?.length
            ? authorization.reasons
            : ["release preparation requires confirmation"],
        });
      }
      authorizedCwd = authorization.logicalCwd;
    } else {
      await assertReleaseShellAllowed(workspace, lifecycleShell);
    }

    const task = await this.backgroundTaskManager.start_background_task(
      {
        workspaceId: workspace.id,
        operation: "prepare_release",
        command,
        shell: lifecycleShell,
        cwd: authorizedCwd,
        timeoutMs: PREPARE_TIMEOUT_MS,
      },
      context.ownerScope === undefined ? {} : { ownerScope: context.ownerScope },
    );
    return prepareReleaseResultSchema.parse({
      status: "background_task_started",
      tag: input.tag,
      task,
    });
  }

  async promote(
    workspace: ResolvedWorkspace,
    input: PromoteReleaseInput,
    context: OperationContext = {},
  ): Promise<PromoteReleaseResult> {
    const projectRoot = assertReleaseWorkspace(workspace, this.platform);
    const installationRoot = resolveInstallationRoot();
    const state = await readLifecycleState(installationRoot);
    if (!state.active || !state.candidate) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Release promotion requires active and candidate execution-node releases.",
      );
    }
    if (state.candidate.releaseId !== input.releaseId) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        `Release promotion candidate mismatch. Expected ${input.releaseId}, got ${state.candidate.releaseId}.`,
      );
    }

    const bootstrap = resolveLifecycleBootstrap(
      this.platform,
      isLocalReleaseRuntime(this.platform),
    );
    const cutover = activeBootstrapPath(
      installationRoot,
      state.active.releaseId,
      bootstrap.directory,
      bootstrap.cutoverScript,
    );
    await assertBootstrapPresent(cutover, bootstrap.cutoverScript);
    if (isLocalReleaseRuntime(this.platform)) {
      const stateRoot = resolveLocalStateRoot(installationRoot);
      const command = buildLocalPromoteCommand(
        cutover,
        installationRoot,
        stateRoot,
        input.releaseId,
      );
      const commandInput = runCommandInputSchema.parse({
        workspaceId: workspace.id,
        shell: resolveLifecycleShell(this.platform),
        cwd: ".",
        command,
        timeoutMs: PROMOTE_TIMEOUT_MS,
        ...(input.confirmationId === undefined
          ? {}
          : { confirmationId: input.confirmationId }),
      });
      const execution =
        input.confirmationId === undefined && releaseAutonomyEnabled(workspace)
          ? await runAuthorizedReleaseCommand(
              this.shellService,
              workspace,
              commandInput,
              context,
            )
          : await this.shellService.runCommand(workspace, commandInput, context);
      if (execution.status === "confirmation_required") {
        return promoteReleaseResultSchema.parse({
          status: "confirmation_required",
          releaseId: input.releaseId,
          confirmationId: execution.confirmationId,
          expiresAt: execution.expiresAt,
          reasons: execution.reasons?.length
            ? execution.reasons
            : ["release promotion requires confirmation"],
        });
      }
      if (execution.status === "executed" && execution.timedOut) {
        throw new AppError(
          "EXECUTION_OUTCOME_UNKNOWN",
          "Local release handoff timed out; reconcile the existing handoff before retrying.",
          execution.lifecycle === undefined
            ? undefined
            : { lifecycle: execution.lifecycle },
        );
      }
      if (execution.status !== "executed" || execution.exitCode !== 0) {
        throw new AppError(
          "SHELL_FAILED",
          "Local release handoff bootstrap did not complete successfully.",
        );
      }
      const handoff = parseLastJsonObject(
        execution.stdout,
        localUpdateHandoffSchema,
      );
      if (handoff.tag !== `v${input.releaseId}`) {
        throw new AppError(
          "EXECUTION_OUTCOME_UNKNOWN",
          "Local release handoff returned a different release identity.",
        );
      }
      return promoteReleaseResultSchema.parse({
        status: "handover_started",
        releaseId: input.releaseId,
        requestId: operationIdToUuid(handoff.operationId),
        brokerTaskName: handoff.taskName,
        resultPath: handoff.resultPath,
        installationRoot,
        projectRoot,
      });
    }

    const config = await readEdgeRecoveryConfig(installationRoot);
    const persistedProjectRoot = path.resolve(config.projectRoot);
    const samePersistedProjectRoot =
      this.platform === "win32"
        ? persistedProjectRoot.toLocaleLowerCase("en-US") ===
          projectRoot.toLocaleLowerCase("en-US")
        : persistedProjectRoot === projectRoot;
    if (!samePersistedProjectRoot) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Edge Connector recovery configuration projectRoot does not match the canonical workspace.",
      );
    }
    if (config.browserEnabled) {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Typed release promotion does not yet support an enabled browser worker.",
      );
    }

    const command = buildPromoteCommand(
      this.platform,
      cutover,
      installationRoot,
      projectRoot,
      input.releaseId,
      config,
    );

    const commandInput = runCommandInputSchema.parse({
      workspaceId: workspace.id,
      shell: "pwsh",
      cwd: ".",
      command,
      timeoutMs: PROMOTE_TIMEOUT_MS,
      ...(input.confirmationId === undefined
        ? {}
        : { confirmationId: input.confirmationId }),
    });
    const execution =
      input.confirmationId === undefined && releaseAutonomyEnabled(workspace)
        ? await runAuthorizedReleaseCommand(
            this.shellService,
            workspace,
            commandInput,
            context,
          )
        : await this.shellService.runCommand(workspace, commandInput, context);

    if (execution.status === "confirmation_required") {
      return promoteReleaseResultSchema.parse({
        status: "confirmation_required",
        releaseId: input.releaseId,
        confirmationId: execution.confirmationId,
        expiresAt: execution.expiresAt,
        reasons: execution.reasons?.length
          ? execution.reasons
          : ["release promotion requires confirmation"],
      });
    }
    if (execution.status === "executed" && execution.timedOut) {
      throw new AppError(
        "EXECUTION_OUTCOME_UNKNOWN",
        "Release cutover timed out; reconcile the existing handover before retrying.",
        execution.lifecycle === undefined
          ? undefined
          : { lifecycle: execution.lifecycle },
      );
    }
    if (execution.status !== "executed" || execution.exitCode !== 0) {
      throw new AppError(
        "SHELL_FAILED",
        "Release cutover bootstrap did not complete successfully.",
      );
    }

    const handover = parseLastJsonObject(execution.stdout, handoverResultSchema);
    if (handover.releaseId !== input.releaseId) {
      throw new AppError(
        "EXECUTION_OUTCOME_UNKNOWN",
        "Release cutover returned a different release identity.",
      );
    }

    return promoteReleaseResultSchema.parse({
      status: "handover_started",
      releaseId: input.releaseId,
      requestId: handover.requestId,
      brokerTaskName: handover.brokerTaskName,
      resultPath: handover.resultPath,
      installationRoot,
      projectRoot,
    });
  }
}

function releaseAutonomyEnabled(workspace: ResolvedWorkspace): boolean {
  return (
    workspace.confirmationMode === "trusted-workspace" &&
    workspace.permissionProfile === "full-repo-write"
  );
}

async function assertReleaseShellAllowed(
  workspace: ResolvedWorkspace,
  shell: "powershell" | "pwsh",
): Promise<void> {
  if (workspace.allowShell.length === 0) {
    throw new AppError(
      "SHELL_NOT_ALLOWED",
      "Workspace policy does not allow shell execution.",
    );
  }
  if (!workspace.allowedShells.includes(shell)) {
    throw new AppError(
      "SHELL_NOT_ALLOWED",
      `Workspace policy does not allow the ${shell} shell.`,
    );
  }
  if (!workspace.allowShell.includes(".")) {
    throw new AppError(
      "SHELL_NOT_ALLOWED",
      "Path is outside the workspace allowShell policy.",
    );
  }
  await new PathSecurity(workspace).authorizeExisting(
    ".",
    "directory",
    true,
    "prepare_release",
  );
}

async function runAuthorizedReleaseCommand(
  shellService: ReleaseShellService,
  workspace: ResolvedWorkspace,
  input: DirectRunCommandInput,
  context: OperationContext,
): Promise<RunCommandResult> {
  if (context.signal?.aborted) {
    throw abortSignalError(context.signal, "Release command operation was cancelled.");
  }

  const startedAt = Date.now();
  const deadline = createOperationDeadline(input.timeoutMs, context.deadline, startedAt);
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "mcp-release-lifecycle-"),
  );
  try {
    const timeoutMs = remainingOperationTimeMs(deadline);
    if (timeoutMs <= 0) {
      throw new AppError("AGENT_TIMEOUT", "Release command deadline has expired.", {
        lifecycle: createOperationLifecycle(deadline, startedAt, {
          layer: "executor",
          reason: "timeout",
          diagnostic: "The release command executor received an expired deadline.",
        }),
      });
    }
    return await shellService.runAuthorizedCommandToFiles(
      workspace,
      { ...input, timeoutMs },
      {
        stdoutPath: path.join(temporaryDirectory, "stdout.log"),
        stderrPath: path.join(temporaryDirectory, "stderr.log"),
        transformOutput: redactSensitiveText,
      },
      context.signal,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function assertReleaseStateWorkspace(
  workspace: ResolvedWorkspace,
  platform: NodeJS.Platform = process.platform,
): void {
  if (process.env.MCP_V3_RELEASE_ROOT?.trim()) return;
  assertReleaseWorkspace(workspace, platform);
}

function assertReleaseWorkspace(
  workspace: ResolvedWorkspace,
  platform: NodeJS.Platform = process.platform,
): string {
  const configuredRoot = process.env.VS_CODE_GPT_STACK_ROOT?.trim();
  if (!configuredRoot) {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Typed release lifecycle requires VS_CODE_GPT_STACK_ROOT from the installed MCP runtime.",
    );
  }
  const expected = path.resolve(configuredRoot);
  const actual = path.resolve(workspace.rootPath);
  const same =
    platform === "win32"
      ? expected.toLocaleLowerCase("en-US") === actual.toLocaleLowerCase("en-US")
      : expected === actual;
  if (!same) {
    throw new AppError(
      "PERMISSION_DENIED",
      "Typed release lifecycle is restricted to the canonical MCP Access Stack workspace.",
    );
  }
  return expected;
}

function resolveInstallationRoot(): string {
  const explicit = process.env.MCP_ACCESS_STACK_INSTALLATION_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  const localReleaseRoot = process.env.MCP_V3_RELEASE_ROOT?.trim();
  if (localReleaseRoot) {
    return path.dirname(path.dirname(path.resolve(localReleaseRoot)));
  }
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Release lifecycle requires MCP_ACCESS_STACK_INSTALLATION_ROOT, MCP_V3_RELEASE_ROOT, or LOCALAPPDATA.",
    );
  }
  return path.join(localAppData, "McpAccessStack");
}

async function readLifecycleState(installationRoot: string) {
  const statePath = path.join(installationRoot, "state", "lifecycle-state.v1.json");
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch {
    throw new AppError(
      "FILE_NOT_FOUND",
      "Execution-node lifecycle state is not available.",
    );
  }
  try {
    return windowsExecutionNodeStateSchema.parse(JSON.parse(raw));
  } catch {
    throw new AppError(
      "EXECUTION_STATE_INVALID",
      "Execution-node lifecycle state is invalid.",
    );
  }
}

async function readEdgeRecoveryConfig(installationRoot: string) {
  const configPath = path.join(installationRoot, "state", "edge-task-config.v1.json");
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new AppError(
      "FILE_NOT_FOUND",
      "Edge Connector recovery configuration is not available.",
    );
  }
  try {
    return edgeRecoveryConfigSchema.parse(JSON.parse(raw));
  } catch {
    throw new AppError(
      "EXECUTION_STATE_INVALID",
      "Edge Connector recovery configuration is invalid.",
    );
  }
}

function activeBootstrapPath(
  installationRoot: string,
  activeReleaseId: string,
  directory: "windows" | "linux",
  fileName: string,
): string {
  return path.join(
    installationRoot,
    "releases",
    activeReleaseId,
    "deploy",
    directory,
    fileName,
  );
}

async function assertBootstrapPresent(filePath: string, name: string): Promise<void> {
  if (await fileExists(filePath)) return;
  throw new AppError(
    "CAPABILITY_UNSUPPORTED",
    `Active release does not contain the required ${name} lifecycle bootstrap. One platform bootstrap is required before typed release lifecycle can take over.`,
  );
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

type LifecycleBootstrap = {
  directory: "windows" | "linux";
  updateScript: "Update-McpAccessStack.ps1" | "Update-McpAccessStack.sh";
  cutoverScript:
    | "Start-McpAccessStackCutover.ps1"
    | "Start-McpAccessStackCutover.sh"
    | "Start-McpV3LocalUpdate.ps1";
};

export function resolveLifecycleBootstrap(
  platform: NodeJS.Platform,
  localReleaseRuntime = false,
): LifecycleBootstrap {
  if (platform === "win32") {
    return {
      directory: "windows",
      updateScript: "Update-McpAccessStack.ps1",
      cutoverScript: localReleaseRuntime
        ? "Start-McpV3LocalUpdate.ps1"
        : "Start-McpAccessStackCutover.ps1",
    };
  }
  return {
    directory: "linux",
    updateScript: "Update-McpAccessStack.sh",
    cutoverScript: "Start-McpAccessStackCutover.sh",
  };
}

function buildPrepareCommand(
  platform: NodeJS.Platform,
  updater: string,
  repository: string,
  installationRoot: string,
  tag: string,
): string {
  if (platform === "win32") {
    return [
      "pwsh.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "AllSigned",
      "-File",
      quotePowerShell(updater),
      "-Repository",
      quotePowerShell(repository),
      "-InstallationRoot",
      quotePowerShell(installationRoot),
      "-Tag",
      quotePowerShell(tag),
      "-Execute",
    ].join(" ");
  }
  return [
    "bash",
    quotePowerShell(updater),
    "--repository",
    quotePowerShell(repository),
    "--installation-root",
    quotePowerShell(installationRoot),
    "--tag",
    quotePowerShell(tag),
    "--execute",
  ].join(" ");
}

function buildLocalPromoteCommand(
  handoff: string,
  installationRoot: string,
  stateRoot: string,
  releaseId: string,
): string {
  return [
    "pwsh.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "AllSigned",
    "-File",
    quotePowerShell(handoff),
    "-InstallationRoot",
    quotePowerShell(installationRoot),
    "-StateRoot",
    quotePowerShell(stateRoot),
    "-Tag",
    quotePowerShell(`v${releaseId}`),
    "-Execute",
  ].join(" ");
}

function buildPromoteCommand(
  platform: NodeJS.Platform,
  cutover: string,
  installationRoot: string,
  projectRoot: string,
  releaseId: string,
  config: z.infer<typeof edgeRecoveryConfigSchema>,
): string {
  if (platform === "win32") {
    return [
      "pwsh.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "AllSigned",
      "-File",
      quotePowerShell(cutover),
      "-InstallationRoot",
      quotePowerShell(installationRoot),
      "-ProjectRoot",
      quotePowerShell(projectRoot),
      "-ExpectedReleaseId",
      quotePowerShell(releaseId),
      "-EdgeRuntimeRoot",
      quotePowerShell(config.runtimeRoot),
      "-EdgeBaseUrl",
      quotePowerShell(config.edgeBaseUrl),
      "-ConnectorTokenFile",
      quotePowerShell(config.connectorTokenFile),
      "-PolicyPath",
      quotePowerShell(config.policyPath),
      "-AllowedOrigins",
      quotePowerShell(config.allowedOrigins),
      "-EdgeTaskName",
      quotePowerShell(config.taskName),
      "-Execute",
    ].join(" ");
  }
  return [
    "bash",
    quotePowerShell(cutover),
    "--installation-root",
    quotePowerShell(installationRoot),
    "--project-root",
    quotePowerShell(projectRoot),
    "--expected-release-id",
    quotePowerShell(releaseId),
    "--edge-runtime-root",
    quotePowerShell(config.runtimeRoot),
    "--edge-base-url",
    quotePowerShell(config.edgeBaseUrl),
    "--connector-token-file",
    quotePowerShell(config.connectorTokenFile),
    "--policy-path",
    quotePowerShell(config.policyPath),
    "--allowed-origins",
    quotePowerShell(config.allowedOrigins),
    "--edge-task-name",
    quotePowerShell(config.taskName),
    "--max-concurrent-requests",
    String(config.maxConcurrentRequests),
    "--handover-delay-seconds",
    String(config.delaySeconds),
    "--execute",
  ].join(" ");
}

function isLocalReleaseRuntime(platform: NodeJS.Platform): boolean {
  return platform === "win32" && Boolean(process.env.MCP_V3_RELEASE_ROOT?.trim());
}

function resolveLifecycleShell(platform: NodeJS.Platform): "powershell" | "pwsh" {
  return isLocalReleaseRuntime(platform) ? "powershell" : "pwsh";
}

function resolveLocalStateRoot(installationRoot: string): string {
  const configured = process.env.MCP_V3_STATE_ROOT?.trim();
  return path.resolve(configured || path.dirname(installationRoot));
}

function operationIdToUuid(operationId: string): string {
  return [
    operationId.slice(0, 8),
    operationId.slice(8, 12),
    operationId.slice(12, 16),
    operationId.slice(16, 20),
    operationId.slice(20),
  ].join("-");
}

function quotePowerShell(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function parseLastJsonObject<T>(
  stdout: string,
  schema: z.ZodType<T>,
): T {
  const lines = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return schema.parse(JSON.parse(lines[index]!));
    } catch {
      // Keep scanning because PowerShell may emit non-JSON informational output first.
    }
  }
  throw new AppError(
    "EXECUTION_OUTCOME_UNKNOWN",
    "Release cutover did not return a parseable handover result.",
  );
}
