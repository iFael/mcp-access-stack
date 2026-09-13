import {
  abortSignalError,
  AppError,
  createOperationDeadline,
  createOperationLifecycle,
  MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
  remainingOperationTimeMs,
  type OperationContext,
  type CommandConfirmationRequiredResult,
  type DirectRunCommandInput,
  type ParsedStartBackgroundTaskInput,
  type RunCommandResult,
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
import { normalizeRelativePath, PathSecurity } from "../path-security.js";
import {
  runShellCommand,
  runShellCommandToFiles,
  type ShellFileExecutionOptions,
} from "./process-runner.js";

export interface AuthorizedCommandExecution {
  logicalCwd: string;
  absoluteCwd: string;
}

interface CommandAuthorizationScope {
  executionContext: "foreground" | "background";
  operation: string;
}

export class ShellService {
  private readonly confirmations = new CommandConfirmationRegistry();

  async runCommand(
    workspace: ResolvedWorkspace,
    input: DirectRunCommandInput,
    context: OperationContext = {},
  ): Promise<RunCommandResult> {
    const deadline = synchronousCommandDeadline(input.timeoutMs, context);
    const prepared = await this.prepareCommand(
      workspace,
      input,
      context.signal,
      { executionContext: "foreground", operation: "run_command" },
    );
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

  async runAuthorizedCommandToFiles(
    workspace: ResolvedWorkspace,
    input: DirectRunCommandInput,
    output: ShellFileExecutionOptions,
    signal?: AbortSignal,
  ): Promise<RunCommandResult> {
    await assertShellAllowed(workspace, input.shell);
    if (signal?.aborted) {
      throw abortSignalError(signal, "Command operation was cancelled.");
    }
    const cwd = await resolveShellCwd(workspace, input.cwd);
    enforceGitPushPolicy(input.shell, input.command);
    return runShellCommandToFiles(
      input.shell,
      input.command,
      cwd.absolutePath,
      cwd.logicalPath,
      input.timeoutMs,
      output,
      signal,
    );
  }

  async authorizeBackgroundCommand(
    workspace: ResolvedWorkspace,
    input: ParsedStartBackgroundTaskInput,
    signal?: AbortSignal,
  ): Promise<AuthorizedCommandExecution | CommandConfirmationRequiredResult> {
    return this.prepareCommand(
      workspace,
      input,
      signal,
      { executionContext: "background", operation: input.operation },
    );
  }

  private async prepareCommand(
    workspace: ResolvedWorkspace,
    input: DirectRunCommandInput,
    signal: AbortSignal | undefined,
    scope: CommandAuthorizationScope,
  ): Promise<AuthorizedCommandExecution | CommandConfirmationRequiredResult> {
    await assertShellAllowed(workspace, input.shell);
    if (signal?.aborted) {
      throw abortSignalError(signal, "Command operation was cancelled.");
    }

    const cwd = await resolveShellCwd(workspace, input.cwd);
    enforceGitPushPolicy(input.shell, input.command);
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
      executionContext: scope.executionContext,
      operation: scope.operation,
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

function enforceGitPushPolicy(
  shell: ShellName,
  command: string,
): void {
  const intent = classifyGitPushIntent(shell, command);
  if (!intent.isPush) return;

  const blockedReason = protectedGitPushReason(intent);
  if (blockedReason) {
    throw new AppError("PERMISSION_DENIED", blockedReason);
  }
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
