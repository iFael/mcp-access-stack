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
    return {
      disposition: "confirmation_required",
      reasons: [criticalReason],
    };
  }

  if (!input.currentRequiresConfirmation) {
    return { disposition: "execute", authorization: "standard" };
  }

  return authorizeTrustedWorkspaceCommand({
    workspace: input.workspace,
    shell: input.shell,
    command: input.command,
    logicalCwd: input.logicalCwd,
    absoluteCwd: input.absoluteCwd,
    fallbackReasons: input.fallbackReasons,
  });
}
