import type { ShellName } from "@vs-code-gpt/shared";
import { analyzeSimplePowerShellCommand } from "./qualified/powershell-lexical.js";

export interface CommandRisk {
  destructive: boolean;
  reasons: string[];
}

export interface GitPushIntent {
  isPush: boolean;
  targetsMain: boolean;
  usesGitC: boolean;
}

interface RiskPattern {
  reason: string;
  pattern: RegExp;
}

const DISK_BOOT_VOLUME_REASON = "disk, boot or volume operation";
const FORMAT_COMMAND_TEXT_PATTERN = /\bformat-volume\b|\bformat(?:\.com|\.exe)?(?=\s|$)/iu;
const POWERSHELL_FORMAT_SEGMENT_PATTERN =
  /(?:^|[\r\n]|(?:&&|\|\||[;|])\s*)(?:&\s*)?(?:format-volume|format(?:\.com|\.exe)?)(?=\s|$)/iu;
const POWERSHELL_AMBIGUOUS_SYNTAX_PATTERN = /[{}()]/u;
const FORMAT_EXECUTABLES = new Set([
  "format",
  "format.com",
  "format.exe",
  "format-volume",
]);
const DELETE_EXECUTABLES = new Set([
  "remove-item",
  "ri",
  "rm",
  "del",
  "erase",
  "rd",
  "rmdir",
  "unlink",
  "shred",
]);
const WRITE_EXECUTABLES = new Set([
  "move-item",
  "mi",
  "move",
  "mv",
  "set-content",
  "sc",
  "out-file",
  "new-item",
  "ni",
  "copy-item",
  "copy",
  "cp",
  "cpi",
  "tee",
  "truncate",
]);
const REGISTRY_EXECUTABLES = new Set([
  "reg",
  "regedit",
  "set-itemproperty",
  "sp",
  "new-itemproperty",
  "remove-itemproperty",
  "rp",
]);
const SERVICE_EXECUTABLES = new Set([
  "stop-service",
  "spsv",
  "restart-service",
  "rsv",
  "set-service",
  "stop-process",
  "spps",
  "kill",
  "taskkill",
]);
const PERMISSION_EXECUTABLES = new Set([
  "chmod",
  "chown",
  "icacls",
  "takeown",
  "set-acl",
]);
const NESTED_SHELL_EXECUTABLES = new Set([
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "cmd",
  "cmd.exe",
  "wsl",
  "wsl.exe",
  "bash",
  "sh",
]);

const RISK_PATTERNS: RiskPattern[] = [
  {
    reason: "delete, remove or force-clean operation",
    pattern: /\b(remove-item|ri|rm|del|erase|rd|rmdir|unlink|shred)\b/i,
  },
  {
    reason: "move, overwrite or direct file write operation",
    pattern:
      /\b(move-item|mi|move|mv|set-content|sc|out-file|new-item|ni|copy-item|copy|cp|cpi|tee|truncate)\b/i,
  },
  {
    reason: "registry modification or system configuration",
    pattern:
      /\b(reg|regedit|set-itemproperty|sp|new-itemproperty|remove-itemproperty|rp)\b|\bhklm:|\bhkcu:/i,
  },
  {
    reason: DISK_BOOT_VOLUME_REASON,
    pattern: /\b(diskpart|bcdedit|mountvol|manage-bde|chkdsk\s+.*\/f|dd\s+if=)\b/i,
  },
  {
    reason: "service or process control",
    pattern:
      /\b(stop-service|spsv|restart-service|rsv|set-service|stop-process|spps|kill|taskkill|sc(?:\.exe)?\s+(delete|stop|config)|net\s+(stop|start))\b/i,
  },
  {
    reason: "destructive git operation",
    pattern:
      /\bgit(?:\.exe)?\b(?=[^;&|\r\n]{0,240}\b(reset|clean|checkout|restore|switch|rebase)\b)/i,
  },
  {
    reason: "git push requires explicit user confirmation",
    pattern:
      /(?:^|(?:&&|\|\||[;|])\s*)(?:&\s*)?git(?:\.exe)?\b(?=[^;&|\r\n]{0,240}\bpush\b)/i,
  },
  {
    reason: "docker cleanup or volume-removing operation",
    pattern:
      /\bdocker(?:\.exe)?\b(?=[^;&|\r\n]{0,240}\b(system\s+prune|volume\s+prune|image\s+prune|container\s+prune|rm|rmi|compose\s+down\b[^;&|\r\n]*\s-v)\b)/i,
  },
  {
    reason: "publish, install or migration operation",
    pattern:
      /\b(npm|pnpm|yarn)\b(?=[^;&|\r\n]{0,200}\b(install|i|add|remove|publish|audit\s+fix)\b)|\b(pip|pipx)\b(?=[^;&|\r\n]{0,160}\binstall\b)|\b(prisma|sequelize|typeorm)\b(?=[^;&|\r\n]{0,160}\bmigrate\b)|\bdotnet\b(?=[^;&|\r\n]{0,200}\bef\s+database\s+update\b)/i,
  },
  {
    reason: "remote download execution or encoded command",
    pattern:
      /\b(invoke-expression|iex|encodedcommand)\b|\b(curl|wget|invoke-webrequest|iwr)\b.*(\||;).*\b(sh|bash|powershell|pwsh|cmd)\b/i,
  },
  {
    reason: "permission or ownership change",
    pattern: /\b(chmod|chown|icacls|takeown|set-acl)\b/i,
  },
  {
    reason: "dynamic PowerShell call operator",
    pattern: /(?:^|[;|]\s*)&\s*(?:\$|['"]|\.?[\\/])/i,
  },
];

const FILE_REDIRECTION_PATTERN = /(?:^|\s)(?:\d?>{1,2})\s*(?!&\d)(?=\S)/i;
const POWERSHELL_NULL_REDIRECTION_PATTERN = /(?:^|\s)\d?>{1,2}\s*\$null(?=\s|$)/giu;
const GIT_PUSH_SEGMENT_PATTERN =
  /(?:^|(?:&&|\|\||[;|])\s*)(?:&\s*)?git(?:\.exe)?\b[^;&|\r\n]{0,1000}?\bpush\b[^;&|\r\n]*/i;
const MAIN_REF_PATTERN = /(?:^|[\s:+])(?:refs\/heads\/)?main(?=$|[\s:])/i;

export function classifyCommandRisk(shell: ShellName, command: string): CommandRisk {
  const normalized = normalizeForRisk(shell, command);
  const executionAwareReasons = classifySimplePowerShellRisk(shell, command);
  const reasons =
    executionAwareReasons ??
    RISK_PATTERNS.filter((entry) => entry.pattern.test(normalized)).map(
      (entry) => entry.reason,
    );

  if (containsDiskFormatCommand(shell, command, normalized)) {
    reasons.push(DISK_BOOT_VOLUME_REASON);
  }

  if (containsFileRedirection(shell, normalized)) {
    reasons.push("move, overwrite or direct file write operation");
  }

  return {
    destructive: reasons.length > 0,
    reasons: [...new Set(reasons)],
  };
}

export function classifyGitPushIntent(shell: ShellName, command: string): GitPushIntent {
  const normalized = normalizeForRisk(shell, command);
  const match = normalized.match(GIT_PUSH_SEGMENT_PATTERN);
  if (!match) {
    return { isPush: false, targetsMain: false, usesGitC: false };
  }

  const segment = match[0];
  const pushIndex = segment.search(/\bpush\b/i);
  const beforePush = segment.slice(0, pushIndex);
  const pushArgs = segment.slice(pushIndex + "push".length);

  return {
    isPush: true,
    targetsMain:
      /(?:^|\s)--(?:all|mirror)(?=$|\s)/i.test(pushArgs) ||
      MAIN_REF_PATTERN.test(pushArgs),
    usesGitC: /(?:^|\s)-C(?:=|\s)/.test(beforePush),
  };
}

export function protectedGitPushReason(
  intent: GitPushIntent,
  currentBranch: string | undefined,
): string | undefined {
  if (!intent.isPush) return undefined;
  if (intent.usesGitC) {
    return "git push with -C is blocked; use the command cwd so protected-branch policy can be enforced.";
  }
  if (intent.targetsMain || currentBranch?.toLocaleLowerCase("en-US") === "main") {
    return "Pushing to or from the main branch is permanently blocked.";
  }
  return undefined;
}

function classifySimplePowerShellRisk(
  shell: ShellName,
  command: string,
): string[] | undefined {
  if (shell !== "powershell" && shell !== "pwsh") return undefined;

  const analysis = analyzeSimplePowerShellCommand(shell, command);
  if (!analysis?.valid || analysis.execution?.kind !== "argv") return undefined;

  const executable = normalizeRiskExecutable(analysis.execution.executable);
  if (NESTED_SHELL_EXECUTABLES.has(executable)) return undefined;

  const args = analysis.execution.argv.join(" ");
  const reasons: string[] = [];

  if (DELETE_EXECUTABLES.has(executable)) {
    reasons.push("delete, remove or force-clean operation");
  }
  if (WRITE_EXECUTABLES.has(executable)) {
    reasons.push("move, overwrite or direct file write operation");
  }
  if (REGISTRY_EXECUTABLES.has(executable)) {
    reasons.push("registry modification or system configuration");
  }
  if (SERVICE_EXECUTABLES.has(executable)) {
    reasons.push("service or process control");
  }
  if (PERMISSION_EXECUTABLES.has(executable)) {
    reasons.push("permission or ownership change");
  }

  if (executable === "git" || executable === "git.exe") {
    if (/\b(reset|clean|checkout|restore|switch|rebase)\b/iu.test(args)) {
      reasons.push("destructive git operation");
    }
    if (/\bpush\b/iu.test(args)) {
      reasons.push("git push requires explicit user confirmation");
    }
  }

  if (
    (executable === "docker" || executable === "docker.exe") &&
    /\b(system\s+prune|volume\s+prune|image\s+prune|container\s+prune|rm|rmi|compose\s+down\b.*\s-v)\b/iu.test(
      args,
    )
  ) {
    reasons.push("docker cleanup or volume-removing operation");
  }

  if (
    ["npm", "pnpm", "yarn"].includes(executable) &&
    /\b(install|i|add|remove|publish|audit\s+fix)\b/iu.test(args)
  ) {
    reasons.push("publish, install or migration operation");
  }
  if (["pip", "pipx"].includes(executable) && /\binstall\b/iu.test(args)) {
    reasons.push("publish, install or migration operation");
  }
  if (
    ["prisma", "sequelize", "typeorm"].includes(executable) &&
    /\bmigrate\b/iu.test(args)
  ) {
    reasons.push("publish, install or migration operation");
  }
  if (executable === "dotnet" && /\bef\s+database\s+update\b/iu.test(args)) {
    reasons.push("publish, install or migration operation");
  }
  if (["invoke-expression", "iex", "encodedcommand"].includes(executable)) {
    reasons.push("remote download execution or encoded command");
  }

  return reasons;
}

function containsFileRedirection(shell: ShellName, normalized: string): boolean {
  const candidate =
    shell === "powershell" || shell === "pwsh"
      ? normalized.replace(POWERSHELL_NULL_REDIRECTION_PATTERN, " ")
      : normalized;
  return FILE_REDIRECTION_PATTERN.test(candidate);
}

function containsDiskFormatCommand(
  shell: ShellName,
  command: string,
  normalized: string,
): boolean {
  if (!FORMAT_COMMAND_TEXT_PATTERN.test(normalized)) return false;

  if (shell !== "powershell" && shell !== "pwsh") {
    return true;
  }

  const analysis = analyzeSimplePowerShellCommand(shell, command);
  if (analysis?.valid && analysis.execution?.kind === "argv") {
    return powerShellArgvExecutesDiskFormat(analysis.execution.executable, analysis.execution.argv);
  }

  if (POWERSHELL_FORMAT_SEGMENT_PATTERN.test(command)) {
    return true;
  }

  // Complex PowerShell control syntax stays fail-closed when format-like text is present.
  return POWERSHELL_AMBIGUOUS_SYNTAX_PATTERN.test(command);
}

function powerShellArgvExecutesDiskFormat(executable: string, argv: string[]): boolean {
  const normalizedExecutable = normalizeRiskExecutable(executable);
  if (FORMAT_EXECUTABLES.has(normalizedExecutable)) return true;

  if (normalizedExecutable === "powershell" || normalizedExecutable === "powershell.exe") {
    return nestedPowerShellFormatRisk("powershell", argv, ["-command", "-c"]);
  }
  if (normalizedExecutable === "pwsh" || normalizedExecutable === "pwsh.exe") {
    return nestedPowerShellFormatRisk("pwsh", argv, ["-command", "-c"]);
  }
  if (normalizedExecutable === "cmd" || normalizedExecutable === "cmd.exe") {
    return nestedOpaqueFormatRisk(argv, ["/c", "/k"]);
  }
  if (["bash", "sh", "wsl", "wsl.exe"].includes(normalizedExecutable)) {
    return argv.some((value) => FORMAT_COMMAND_TEXT_PATTERN.test(value));
  }

  return false;
}

function nestedPowerShellFormatRisk(
  shell: "powershell" | "pwsh",
  argv: string[],
  commandOptions: string[],
): boolean {
  const command = commandAfterOption(argv, commandOptions);
  return command ? containsDiskFormatCommand(shell, command, normalizeForRisk(shell, command)) : false;
}

function nestedOpaqueFormatRisk(argv: string[], commandOptions: string[]): boolean {
  const command = commandAfterOption(argv, commandOptions);
  return command ? FORMAT_COMMAND_TEXT_PATTERN.test(command) : false;
}

function commandAfterOption(argv: string[], options: string[]): string | undefined {
  const index = argv.findIndex((value) => options.includes(value.toLocaleLowerCase("en-US")));
  if (index < 0 || index + 1 >= argv.length) return undefined;
  return argv.slice(index + 1).join(" ");
}

function normalizeRiskExecutable(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLocaleLowerCase("en-US");
}

function normalizeForRisk(shell: ShellName, command: string): string {
  const normalized = command.replace(/`[\r\n]/g, " ").replace(/\s+/g, " ").trim();
  if (shell === "cmd") {
    return normalized.replace(/\^/g, "");
  }
  return normalized;
}
