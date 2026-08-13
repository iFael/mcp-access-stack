import type {
  CommandDiagnosis,
  CommandPlan,
  QualifiedRunCommandInput,
  ShellName,
} from "@vs-code-gpt/shared";
import type { ProviderRepairProposal } from "./command-provider.js";
import type { LimitedCommandContext } from "./types.js";

const RETRY_DELAY_MS = 100;
const EXECUTABLE_ALIASES = new Map<string, string>([
  ["git.exe", "git"],
  ["node.exe", "node"],
  ["npm.cmd", "npm"],
  ["npx.cmd", "npx"],
  ["pnpm.cmd", "pnpm"],
  ["yarn.cmd", "yarn"],
]);

export type DeterministicRepairEvidence =
  | "none"
  | "git-root"
  | "package-root";

export interface DeterministicRepairProposal {
  ruleId: string;
  confidence: number;
  reason: string;
  correctedInput: QualifiedRunCommandInput;
  bindingChanged: boolean;
  waitBeforeRetryMs: number;
  requiredEvidence: DeterministicRepairEvidence;
}

export function proposeDeterministicRepair(
  input: QualifiedRunCommandInput,
  plan: CommandPlan,
  diagnosis: CommandDiagnosis,
  context: LimitedCommandContext,
): DeterministicRepairProposal | null {
  if (
    diagnosis.category === "resource_locked" &&
    (plan.effectClass === "pure_read" ||
      plan.effectClass === "repeatable_local")
  ) {
    return retryProposal(
      input,
      "retry.resource-lock",
      0.98,
      "Retry the same qualified operation after a deterministically classified resource lock.",
    );
  }

  if (
    diagnosis.category === "transient_failure" &&
    plan.effectClass === "pure_read"
  ) {
    return retryProposal(
      input,
      "retry.transient-read",
      0.95,
      "Retry the same read-only operation after a deterministically classified transient failure.",
    );
  }

  if (
    diagnosis.category === "executable_unavailable" &&
    plan.execution.kind === "argv"
  ) {
    const correctedExecutable = equivalentExecutable(
      plan.execution.executable,
      context,
    );
    if (correctedExecutable) {
      const correctedCommand = renderArgvCommand(
        plan.shell,
        correctedExecutable,
        plan.execution.argv,
      );
      if (correctedCommand) {
        return {
          ruleId: "executable.equivalent-windows-alias",
          confidence: 0.99,
          reason:
            "Replace a Windows executable suffix alias with the available equivalent executable.",
          correctedInput: correctedInput(input, {
            command: correctedCommand,
            shell: plan.shell,
            cwd: plan.cwd,
          }),
          bindingChanged: true,
          waitBeforeRetryMs: 0,
          requiredEvidence: "none",
        };
      }
    }
  }

  if (
    diagnosis.category === "wrong_working_directory" &&
    plan.cwd !== "." &&
    plan.execution.kind === "argv"
  ) {
    const evidence = rootEvidenceForExecutable(plan.execution.executable);
    if (evidence !== "none") {
      const correctedCommand =
        input.command ??
        renderArgvCommand(
          plan.shell,
          plan.execution.executable,
          plan.execution.argv,
        );
      if (!correctedCommand) return null;
      return {
        ruleId: `cwd.authorized-${evidence}`,
        confidence: 0.96,
        reason:
          "Retry from the authorized workspace root after the command reported an incompatible working directory.",
        correctedInput: correctedInput(input, {
          command: correctedCommand,
          shell: plan.shell,
          cwd: ".",
        }),
        bindingChanged: true,
        waitBeforeRetryMs: 0,
        requiredEvidence: evidence,
      };
    }
  }

  return null;
}

export function proposeProviderRepair(
  input: QualifiedRunCommandInput,
  plan: CommandPlan,
  proposal: ProviderRepairProposal,
  context: LimitedCommandContext,
): DeterministicRepairProposal | null {
  if (proposal.status !== "proposal" || plan.execution.kind !== "argv") {
    return null;
  }

  let shell = plan.shell;
  let cwd = plan.cwd;
  let executable = plan.execution.executable;
  let requiredEvidence: DeterministicRepairEvidence = "none";
  switch (proposal.action) {
    case "retry_same":
      break;
    case "change_shell":
      shell = proposal.shell;
      break;
    case "change_cwd_root":
      cwd = ".";
      requiredEvidence = rootEvidenceForExecutable(executable);
      if (requiredEvidence === "none") return null;
      break;
    case "replace_executable":
      if (
        !context.tools.some(
          (tool) =>
            tool.available &&
            tool.name.toLowerCase() === proposal.executable.toLowerCase(),
        )
      ) {
        return null;
      }
      executable = proposal.executable;
      break;
  }

  const command = renderArgvCommand(shell, executable, plan.execution.argv);
  if (!command) return null;
  return {
    ruleId: `provider.${proposal.action}`,
    confidence: proposal.confidence,
    reason:
      "Apply a provider-proposed structural repair only after complete local requalification.",
    correctedInput: correctedInput(input, { command, shell, cwd }),
    bindingChanged: proposal.action !== "retry_same",
    waitBeforeRetryMs:
      proposal.action === "retry_same" ? RETRY_DELAY_MS : 0,
    requiredEvidence,
  };
}

export function hasRequiredRepairEvidence(
  proposal: DeterministicRepairProposal,
  correctedContext: LimitedCommandContext,
): boolean {
  switch (proposal.requiredEvidence) {
    case "none":
      return true;
    case "git-root":
      return correctedContext.git.repository;
    case "package-root":
      return correctedContext.packageMetadata !== undefined;
  }
}

function retryProposal(
  input: QualifiedRunCommandInput,
  ruleId: string,
  confidence: number,
  reason: string,
): DeterministicRepairProposal {
  return {
    ruleId,
    confidence,
    reason,
    correctedInput: correctedInput(input),
    bindingChanged: false,
    waitBeforeRetryMs: RETRY_DELAY_MS,
    requiredEvidence: "none",
  };
}

function correctedInput(
  input: QualifiedRunCommandInput,
  patch: Partial<
    Pick<QualifiedRunCommandInput, "command" | "shell" | "cwd">
  > = {},
): QualifiedRunCommandInput {
  const { confirmationId: _confirmationId, ...base } = input;
  return {
    ...base,
    autoCorrection: "off",
    ...patch,
  };
}

function equivalentExecutable(
  executable: string,
  context: LimitedCommandContext,
): string | null {
  if (/[\\/]/u.test(executable)) return null;
  const replacement = EXECUTABLE_ALIASES.get(executable.toLowerCase());
  if (!replacement) return null;
  return context.tools.some(
    (tool) => tool.available && tool.name.toLowerCase() === replacement,
  )
    ? replacement
    : null;
}

function rootEvidenceForExecutable(
  executable: string,
): DeterministicRepairEvidence {
  const normalized = executable.toLowerCase().replace(/\.(?:exe|cmd)$/u, "");
  if (normalized === "git") return "git-root";
  if (["npm", "npx", "pnpm", "yarn", "bun"].includes(normalized)) {
    return "package-root";
  }
  return "none";
}

function renderArgvCommand(
  shell: ShellName,
  executable: string,
  argv: string[],
): string | null {
  if (
    !/^[a-z0-9._:+-]+$/iu.test(executable) ||
    [executable, ...argv].some(
      (value) => value.includes("\0") || /[\r\n]/u.test(value),
    )
  ) {
    return null;
  }

  switch (shell) {
    case "powershell":
    case "pwsh":
      return [executable, ...argv.map(quotePowerShell)].join(" ");
    case "cmd":
      if (argv.some((value) => value.includes("%") || value.includes('"'))) {
        return null;
      }
      return [executable, ...argv.map(quoteCmd)].join(" ");
    case "wsl":
    case "git-bash":
      return [executable, ...argv.map(quotePosix)].join(" ");
  }
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteCmd(value: string): string {
  return `"${value.replace(/([\^&|<>()])/gu, "^$1")}"`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
