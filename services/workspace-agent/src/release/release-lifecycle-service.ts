import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { z } from "zod";
import {
  AppError,
  prepareReleaseResultSchema,
  promoteReleaseResultSchema,
  runCommandInputSchema,
  startBackgroundTaskInputSchema,
  windowsExecutionNodeStateSchema,
  type GetReleaseStateResult,
  type OperationContext,
  type PrepareReleaseInput,
  type PrepareReleaseResult,
  type PromoteReleaseInput,
  type PromoteReleaseResult,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../internal-types.js";
import type { ShellService } from "../shell/service.js";
import type { BackgroundTaskManager } from "../tasks/background-task-manager.js";

interface ReleaseShellService {
  authorizeBackgroundCommand: ShellService["authorizeBackgroundCommand"];
  runCommand: ShellService["runCommand"];
}

interface ReleaseBackgroundTaskManager {
  start_background_task: BackgroundTaskManager["start_background_task"];
}

const PREPARE_TIMEOUT_MS = 15 * 60 * 1_000;
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
    ownerTokenFile: z.string().min(1),
    policyPath: z.string().min(1),
    allowedOrigins: z.string().min(1),
    ownerOAuthScopes: z.string().min(1),
    mcpSessionMode: z.enum(["stateless", "stateful-experiment"]),
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

export class ReleaseLifecycleService {
  constructor(
    private readonly shellService: ReleaseShellService,
    private readonly backgroundTaskManager: ReleaseBackgroundTaskManager,
  ) {}

  async getState(workspace: ResolvedWorkspace): Promise<GetReleaseStateResult> {
    assertReleaseWorkspace(workspace);
    const installationRoot = resolveInstallationRoot();
    const state = await readLifecycleState(installationRoot);
    const activeReleaseId = state.active?.releaseId;
    const updateScriptPresent = activeReleaseId
      ? await fileExists(activeBootstrapPath(installationRoot, activeReleaseId, "Update-McpAccessStack.ps1"))
      : false;
    const cutoverScriptPresent = activeReleaseId
      ? await fileExists(activeBootstrapPath(installationRoot, activeReleaseId, "Start-McpAccessStackCutover.ps1"))
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
    assertReleaseWorkspace(workspace);
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
    const updater = activeBootstrapPath(
      installationRoot,
      state.active.releaseId,
      "Update-McpAccessStack.ps1",
    );
    await assertBootstrapPresent(updater, "Update-McpAccessStack.ps1");

    const command = [
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
      quotePowerShell(input.tag),
      "-Execute",
    ].join(" ");

    const parsed = startBackgroundTaskInputSchema.parse({
      workspaceId: workspace.id,
      operation: "prepare_release",
      command,
      shell: "pwsh",
      cwd: ".",
      timeoutMs: PREPARE_TIMEOUT_MS,
      ...(input.confirmationId === undefined
        ? {}
        : { confirmationId: input.confirmationId }),
    });
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

    const task = await this.backgroundTaskManager.start_background_task(
      {
        workspaceId: workspace.id,
        operation: "prepare_release",
        command,
        shell: "pwsh",
        cwd: authorization.logicalCwd,
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
    const projectRoot = assertReleaseWorkspace(workspace);
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

    const cutover = activeBootstrapPath(
      installationRoot,
      state.active.releaseId,
      "Start-McpAccessStackCutover.ps1",
    );
    await assertBootstrapPresent(cutover, "Start-McpAccessStackCutover.ps1");
    const config = await readEdgeRecoveryConfig(installationRoot);
    const persistedProjectRoot = path.resolve(config.projectRoot);
    const samePersistedProjectRoot =
      process.platform === "win32"
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

    const command = [
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
      quotePowerShell(input.releaseId),
      "-EdgeRuntimeRoot",
      quotePowerShell(config.runtimeRoot),
      "-EdgeBaseUrl",
      quotePowerShell(config.edgeBaseUrl),
      "-ConnectorTokenFile",
      quotePowerShell(config.connectorTokenFile),
      "-OwnerTokenFile",
      quotePowerShell(config.ownerTokenFile),
      "-PolicyPath",
      quotePowerShell(config.policyPath),
      "-AllowedOrigins",
      quotePowerShell(config.allowedOrigins),
      "-OwnerOAuthScopes",
      quotePowerShell(config.ownerOAuthScopes),
      "-McpSessionMode",
      quotePowerShell(config.mcpSessionMode),
      "-EdgeTaskName",
      quotePowerShell(config.taskName),
      "-Execute",
    ].join(" ");

    const execution = await this.shellService.runCommand(
      workspace,
      runCommandInputSchema.parse({
        workspaceId: workspace.id,
        shell: "pwsh",
        cwd: ".",
        command,
        timeoutMs: PROMOTE_TIMEOUT_MS,
        ...(input.confirmationId === undefined
          ? {}
          : { confirmationId: input.confirmationId }),
      }),
      context,
    );

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
    if (execution.status !== "executed" || execution.exitCode !== 0) {
      throw new AppError(
        "SHELL_FAILED",
        "Signed release cutover bootstrap did not complete successfully.",
      );
    }

    const handover = parseLastJsonObject(execution.stdout, handoverResultSchema);
    if (handover.releaseId !== input.releaseId) {
      throw new AppError(
        "EXECUTION_OUTCOME_UNKNOWN",
        "Signed release cutover returned a different release identity.",
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

function assertReleaseWorkspace(workspace: ResolvedWorkspace): string {
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
    process.platform === "win32"
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
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      "Release lifecycle requires MCP_ACCESS_STACK_INSTALLATION_ROOT or LOCALAPPDATA.",
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
  fileName: string,
): string {
  return path.join(
    installationRoot,
    "releases",
    activeReleaseId,
    "deploy",
    "windows",
    fileName,
  );
}

async function assertBootstrapPresent(filePath: string, name: string): Promise<void> {
  if (await fileExists(filePath)) return;
  throw new AppError(
    "CAPABILITY_UNSUPPORTED",
    `Active release does not contain the signed ${name} bootstrap. One legacy promotion is required before typed release lifecycle can take over.`,
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
    "Signed release cutover did not return a parseable handover result.",
  );
}
