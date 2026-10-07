import type { ErrorCode, ShellName } from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../internal-types.js";
import type { CommandRisk } from "./command-risk.js";
import {
  authorizeTrustedWorkspaceCommand,
  trustedWorkspaceCriticalReason,
} from "./trusted-workspace-authorization.js";

export type CommandAuthorizationDecision =
  | { disposition: "execute"; authorization: "standard" | "trusted-workspace" }
  | { disposition: "confirmation_required"; reasons: string[] }
  | { disposition: "blocked"; code: ErrorCode; reason: string };

export interface CommandAuthorizationInput {
  workspace: ResolvedWorkspace;
  shell: ShellName;
  command: string;
  confirmationId?: string;
  logicalCwd: string;
  absoluteCwd: string;
  directRisk: CommandRisk;
  currentRequiresConfirmation: boolean;
  fallbackReasons: string[];
}

export async function decideCommandAuthorization(
  input: CommandAuthorizationInput,
): Promise<CommandAuthorizationDecision> {
  const trusted =
    input.workspace.confirmationMode === "trusted-workspace" &&
    input.workspace.permissionProfile === "full-repo-write";

  if (!trusted) {
    return input.currentRequiresConfirmation
      ? {
          disposition: "confirmation_required",
          reasons: input.fallbackReasons,
        }
      : { disposition: "execute", authorization: "standard" };
  }

  const criticalReason = await trustedWorkspaceCriticalReason(
    input.shell,
    input.command,
    input.absoluteCwd,
  );
  if (criticalReason) {
    if (input.confirmationId !== undefined) {
      return {
        disposition: "confirmation_required",
        reasons: [criticalReason],
      };
    }
    return {
      disposition: "blocked",
      code: "PERMISSION_DENIED",
      reason:
        "Trusted-workspace automation requires a typed MCP capability for privileged, external, nested-shell or otherwise unbounded effects.",
    };
  }

  if (!input.currentRequiresConfirmation) {
    return { disposition: "execute", authorization: "standard" };
  }

  const delegated = await authorizeTrustedWorkspaceCommand({
    workspace: input.workspace,
    shell: input.shell,
    command: input.command,
    logicalCwd: input.logicalCwd,
    absoluteCwd: input.absoluteCwd,
    fallbackReasons: input.fallbackReasons,
  });
  if (delegated.disposition === "confirmation_required") {
    if (input.confirmationId !== undefined) return delegated;
    return {
      disposition: "blocked",
      code: "PERMISSION_DENIED",
      reason:
        "Trusted-workspace automation could not prove this shell mutation is bounded by the workspace policy. Use a typed MCP capability or a more explicit workspace-local command.",
    };
  }
  return delegated;
}
