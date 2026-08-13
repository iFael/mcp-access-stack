import { AppError, type CommandPlanExecution, type ShellName } from "@vs-code-gpt/shared";

export function commandPlanExecutionToRiskCommand(
  execution: CommandPlanExecution,
): string {
  if (execution.kind === "script") return execution.script;
  return [execution.executable, ...execution.argv]
    .map((value) => (/\s/u.test(value) ? JSON.stringify(value) : value))
    .join(" ");
}

export function commandPlanExecutionToShellCommand(
  shell: ShellName,
  execution: CommandPlanExecution,
): string {
  if (execution.kind === "script") return execution.script;
  if (execution.argv.length > 256) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Qualified command argv exceeds the supported argument count.",
    );
  }

  const values = [execution.executable, ...execution.argv];
  if (values.some((value) => value.includes("\0") || /[\r\n]/u.test(value))) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Qualified command argv contains an unsupported control character.",
    );
  }

  switch (shell) {
    case "powershell":
    case "pwsh":
      return `& ${values.map(quotePowerShellLiteral).join(" ")}`;
    case "cmd":
      return [
        quoteCmdExecutable(execution.executable),
        ...execution.argv.map(quoteCmdLiteral),
      ].join(" ");
    case "wsl":
    case "git-bash":
      return values.map(quotePosixLiteral).join(" ");
  }
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePosixLiteral(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function quoteCmdExecutable(value: string): string {
  if (/^[a-z0-9._:\\/-]+$/iu.test(value)) return value;
  return quoteCmdLiteral(value);
}

function quoteCmdLiteral(value: string): string {
  if (value.includes("%") || value.includes('"')) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Qualified cmd argv contains a value that cannot be serialized safely.",
    );
  }
  return `"${value.replace(/([\^&|<>()])/gu, "^$1")}"`;
}
