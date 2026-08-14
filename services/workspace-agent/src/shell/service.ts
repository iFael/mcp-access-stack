import { spawn } from "node:child_process";
import {
  abortSignalError,
  AppError,
  createOperationDeadline,
  createOperationLifecycle,
  MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
  remainingOperationTimeMs,
  type OperationContext,
  type CommandPlan,
  type DirectRunCommandInput,
  type RunCommandResult,
  type RunPowerShellInput,
  type RunPowerShellResult,
  type ShellName,
} from "@vs-code-gpt/shared";
import { CommandConfirmationRegistry } from "./confirmation.js";
import {
  classifyCommandRisk,
  classifyGitPushIntent,
  protectedGitPushReason,
} from "./command-risk.js";
import { decideCommandAuthorization } from "./confirmation-policy.js";
import type { ResolvedWorkspace } from "../internal-types.js";
import {
  commandPlanExecutionToRiskCommand,
  commandPlanExecutionToShellCommand,
} from "./qualified/plan-execution.js";
import { normalizeRelativePath, PathSecurity } from "../path-security.js";
import {
  runShellCommand,
  runShellCommandToFiles,
  type ShellFileExecutionOptions,
} from "./process-runner.js";

interface PreparedCommand {
  logicalCwd: string;
  absoluteCwd: string;
}

export interface PreparedQualifiedCommand extends PreparedCommand {
  command: string;
  planFingerprint: string;
}

export class ShellService {
  private readonly confirmations = new CommandConfirmationRegistry();

  async runCommand(
    workspace: ResolvedWorkspace,
    input: DirectRunCommandInput,
    context: OperationContext = {},
  ): Promise<RunCommandResult> {
    const deadline = synchronousCommandDeadline(input.timeoutMs, context);
    const prepared = await this.prepareCommand(workspace, input, context.signal);
    if ("status" in prepared) return prepared;
    return runShellCommand(
      input.shell,
      input.command,
      prepared.absoluteCwd,
      prepared.logicalCwd,
      remainingOperationTimeMs(deadline),
      context.signal,
      deadline,
    );
  }

  async runCommandToFiles(
    workspace: ResolvedWorkspace,
    input: DirectRunCommandInput,
    output: ShellFileExecutionOptions,
    signal?: AbortSignal,
  ): Promise<RunCommandResult> {
    const prepared = await this.prepareCommand(workspace, input, signal);
    if ("status" in prepared) return prepared;
    return runShellCommandToFiles(
      input.shell,
      input.command,
      prepared.absoluteCwd,
      prepared.logicalCwd,
      input.timeoutMs,
      output,
      signal,
    );
  }

  async prepareQualifiedCommand(
    workspace: ResolvedWorkspace,
    plan: CommandPlan,
    confirmationId?: string,
    signal?: AbortSignal,
  ): Promise<
    | PreparedQualifiedCommand
    | Extract<RunCommandResult, { status: "confirmation_required" }>
  > {
    await assertShellAllowed(workspace, plan.shell);
    if (signal?.aborted) {
      throw abortSignalError(signal, "Qualified command operation was cancelled.");
    }

    const cwd = await resolveShellCwd(workspace, plan.cwd);
    const command = commandPlanExecutionToShellCommand(plan.shell, plan.execution);
    const riskCommand = commandPlanExecutionToRiskCommand(plan.execution);
    await enforceGitPushPolicy(plan.shell, riskCommand, cwd.absolutePath);
    if (plan.riskClass === "forbidden") {
      throw new AppError(
        "PERMISSION_DENIED",
        "Qualified command plan is permanently forbidden by policy.",
      );
    }

    const directRisk = classifyCommandRisk(plan.shell, riskCommand);
    if (plan.riskClass === "safe" && directRisk.destructive) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Qualified command risk classification diverged from the execution policy.",
      );
    }
    const fallbackReasons =
      directRisk.reasons.length > 0
        ? directRisk.reasons
        : ["qualified command plan requires explicit confirmation"];
    const authorization = await decideCommandAuthorization({
      workspace,
      shell: plan.shell,
      command: riskCommand,
      logicalCwd: cwd.logicalPath,
      absoluteCwd: cwd.absolutePath,
      directRisk,
      currentRequiresConfirmation:
        plan.riskClass === "confirmation_required" || directRisk.destructive,
      fallbackReasons,
    });
    if (authorization.disposition === "blocked") {
      throw new AppError(authorization.code, authorization.reason);
    }
    const binding = {
      workspaceId: workspace.id,
      shell: plan.shell,
      cwd: cwd.logicalPath,
      command: `qualified:${plan.fingerprint}`,
    };
    if (authorization.disposition === "confirmation_required") {
      if (!confirmationId) {
        const confirmation = this.confirmations.create(binding);
        return {
          status: "confirmation_required",
          shell: plan.shell,
          cwd: cwd.logicalPath,
          confirmationId: confirmation.confirmationId,
          expiresAt: confirmation.expiresAt,
          reasons: authorization.reasons,
        };
      }
      this.confirmations.consume(confirmationId, binding);
    }

    return {
      logicalCwd: cwd.logicalPath,
      absoluteCwd: cwd.absolutePath,
      command,
      planFingerprint: plan.fingerprint,
    };
  }

  async executeQualifiedCommand(
    plan: CommandPlan,
    prepared: PreparedQualifiedCommand,
    context: OperationContext = {},
  ): Promise<Extract<RunCommandResult, { status: "executed" }>> {
    if (prepared.planFingerprint !== plan.fingerprint) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Prepared command does not match the qualified plan fingerprint.",
      );
    }
    const now = Date.now();
    const deadlineAt = Date.parse(plan.absoluteDeadline);
    const upstreamDeadline = {
      requestedTimeoutMs: plan.timeoutMs,
      effectiveTimeoutMs: Math.max(0, deadlineAt - now),
      deadlineAt: plan.absoluteDeadline,
    };
    const deadline = createOperationDeadline(
      plan.timeoutMs,
      context.deadline ?? upstreamDeadline,
      now,
    );
    const remaining = remainingOperationTimeMs(deadline, now);
    if (remaining <= 0) {
      throw new AppError("AGENT_TIMEOUT", "Qualified command deadline has expired.", {
        lifecycle: createOperationLifecycle(deadline, now, {
          layer: "executor",
          reason: "timeout",
          diagnostic: "The qualified executor received an expired deadline.",
        }),
      });
    }
    const result = await runShellCommand(
      plan.shell,
      prepared.command,
      prepared.absoluteCwd,
      prepared.logicalCwd,
      remaining,
      context.signal,
      deadline,
    );
    if (result.status !== "executed") {
      throw new AppError(
        "INTERNAL_ERROR",
        "Qualified command execution returned an unexpected interactive result.",
      );
    }
    return result;
  }

  async assertBackgroundCommandAllowed(
    workspace: ResolvedWorkspace,
    input: DirectRunCommandInput,
  ): Promise<void> {
    await assertShellAllowed(workspace, input.shell);
    const cwd = await resolveShellCwd(workspace, input.cwd);
    await enforceGitPushPolicy(input.shell, input.command, cwd.absolutePath);
    const risk = classifyCommandRisk(input.shell, input.command);
    if (risk.destructive) {
      throw new AppError(
        "PERMISSION_DENIED",
        "Potentially destructive commands cannot be started as background tasks.",
      );
    }
  }

  async runPowerShell(
    workspace: ResolvedWorkspace,
    input: RunPowerShellInput,
    context: OperationContext = {},
  ): Promise<RunPowerShellResult> {
    return this.runCommand(workspace, { ...input, shell: "powershell" }, context);
  }

  private async prepareCommand(
    workspace: ResolvedWorkspace,
    input: DirectRunCommandInput,
    signal?: AbortSignal,
  ): Promise<PreparedCommand | RunCommandResult> {
    await assertShellAllowed(workspace, input.shell);
    if (signal?.aborted) {
      throw abortSignalError(signal, "Command operation was cancelled.");
    }

    const cwd = await resolveShellCwd(workspace, input.cwd);
    await enforceGitPushPolicy(input.shell, input.command, cwd.absolutePath);
    const risk = classifyCommandRisk(input.shell, input.command);
    const authorization = await decideCommandAuthorization({
      workspace,
      shell: input.shell,
      command: input.command,
      logicalCwd: cwd.logicalPath,
      absoluteCwd: cwd.absolutePath,
      directRisk: risk,
      currentRequiresConfirmation: risk.destructive,
      fallbackReasons: risk.reasons,
    });
    if (authorization.disposition === "blocked") {
      throw new AppError(authorization.code, authorization.reason);
    }
    const binding = {
      workspaceId: workspace.id,
      shell: input.shell,
      cwd: cwd.logicalPath,
      command: input.command,
    };

    if (authorization.disposition === "confirmation_required") {
      if (!input.confirmationId) {
        const confirmation = this.confirmations.create(binding);
        return {
          status: "confirmation_required",
          shell: input.shell,
          cwd: cwd.logicalPath,
          confirmationId: confirmation.confirmationId,
          expiresAt: confirmation.expiresAt,
          reasons: authorization.reasons,
        };
      }
      this.confirmations.consume(input.confirmationId, binding);
    }

    return {
      logicalCwd: cwd.logicalPath,
      absoluteCwd: cwd.absolutePath,
    };
  }
}

async function assertShellAllowed(
  workspace: ResolvedWorkspace,
  shell: ShellName,
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
}

async function enforceGitPushPolicy(
  shell: ShellName,
  command: string,
  cwd: string,
): Promise<void> {
  const intent = classifyGitPushIntent(shell, command);
  if (!intent.isPush) return;

  const currentBranch = intent.usesGitC ? undefined : await readCurrentGitBranch(cwd);
  const blockedReason = protectedGitPushReason(intent, currentBranch);
  if (blockedReason) {
    throw new AppError("PERMISSION_DENIED", blockedReason);
  }
}

async function readCurrentGitBranch(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("git", ["branch", "--show-current"], {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    let settled = false;

    const finish = (branch: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(branch);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish(undefined));
    child.once("close", (exitCode) => {
      finish(exitCode === 0 ? output.trim() || undefined : undefined);
    });
  });
}

async function resolveShellCwd(
  workspace: ResolvedWorkspace,
  inputCwd: string | undefined,
): Promise<{ logicalPath: string; absolutePath: string }> {
  const logicalPath = normalizeRelativePath(inputCwd ?? ".", { allowDot: true });
  if (!isAllowedShellPath(workspace, logicalPath)) {
    throw new AppError(
      "SHELL_NOT_ALLOWED",
      "Path is outside the workspace allowShell policy.",
    );
  }
  const security = new PathSecurity(workspace);
  const authorized = await security.authorizeExisting(logicalPath, "directory", true);
  return { logicalPath: authorized.logicalPath, absolutePath: authorized.canonicalPath };
}

function isAllowedShellPath(workspace: ResolvedWorkspace, logicalPath: string): boolean {
  return workspace.allowShell.some((shellRoot) => logicalContains(shellRoot, logicalPath));
}

function logicalContains(basePath: string, targetPath: string): boolean {
  if (basePath === ".") {
    return true;
  }
  const base = comparisonValue(basePath);
  const target = comparisonValue(targetPath);
  return target === base || target.startsWith(`${base}/`);
}

function comparisonValue(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function synchronousCommandDeadline(
  requestedTimeoutMs: number,
  context: OperationContext,
) {
  if (requestedTimeoutMs > MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Commands above 300 seconds must run through the BackgroundTaskManager.",
    );
  }
  const startedAt = Date.now();
  const deadline = createOperationDeadline(requestedTimeoutMs, context.deadline, startedAt);
  if (remainingOperationTimeMs(deadline, startedAt) <= 0) {
    throw new AppError("AGENT_TIMEOUT", "Command deadline has expired.", {
      lifecycle: createOperationLifecycle(deadline, startedAt, {
        layer: "executor",
        reason: "timeout",
        diagnostic: "The command executor received an expired deadline.",
      }),
    });
  }
  return deadline;
}
