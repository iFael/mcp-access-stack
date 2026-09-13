import type { ShellName } from "@vs-code-gpt/shared";
import {
  analyzeSimplePowerShellCommand,
  analyzeSimpleShellCommand,
} from "./command-analysis.js";

export interface CommandRisk {
  destructive: boolean;
  reasons: string[];
}

export interface GitPushIntent {
  isPush: boolean;
  targetsMain: boolean;
  usesGitC: boolean;
  usesMirror: boolean;
}

interface RiskPattern {
  reason: string;
  pattern: RegExp;
}

const DISK_BOOT_VOLUME_REASON = "disk, boot or volume operation";
const EXTERNAL_PACKAGE_EXECUTION_REASON = "external package execution";
const EXTERNAL_DEPLOYMENT_REASON = "external deployment operation";
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
const NULL_DEVICE_REDIRECTION_PATTERN =
  /(?:^|\s)\d?>{1,2}\s*(?:\$null|nul|\/dev\/null)(?=\s|$|[;&|])/giu;
const GIT_PUSH_SEGMENT_PATTERN =
  /(?:^|(?:&&|\|\||[;|])\s*)(?:&\s*)?git(?:\.exe)?\b[^;&|\r\n]{0,1000}?\bpush\b[^;&|\r\n]*/i;
const MAIN_REF_PATTERN = /(?:^|[\s:+])(?:refs\/heads\/)?main(?=$|[\s:])/i;

export function classifyCommandRisk(shell: ShellName, command: string): CommandRisk {
  const normalized = normalizeForRisk(shell, command);
  const lexicalRiskText = normalizeForRisk(shell, maskPowerShellInertQuotedLiterals(shell, command));
  const executionAwareReasons = classifySimplePowerShellRisk(shell, command);
  const reasons =
    executionAwareReasons ??
    RISK_PATTERNS.filter((entry) => entry.pattern.test(lexicalRiskText)).map(
      (entry) => entry.reason,
    );

  reasons.push(...classifyExternalExecutionRisk(shell, command));

  if (containsDiskFormatCommand(shell, command, normalized)) {
    reasons.push(DISK_BOOT_VOLUME_REASON);
  }

  if (containsFileRedirection(lexicalRiskText)) {
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
    return { isPush: false, targetsMain: false, usesGitC: false, usesMirror: false };
  }

  const segment = match[0];
  const pushIndex = segment.search(/\bpush\b/i);
  const beforePush = segment.slice(0, pushIndex);
  const pushArgs = segment.slice(pushIndex + "push".length);

  return {
    isPush: true,
    targetsMain:
      /(?:^|\s)--all(?=$|\s)/i.test(pushArgs) ||
      MAIN_REF_PATTERN.test(pushArgs),
    usesGitC: /(?:^|\s)-C(?:=|\s)/.test(beforePush),
    usesMirror: /(?:^|\s)--mirror(?=$|\s)/i.test(pushArgs),
  };
}

export function protectedGitPushReason(intent: GitPushIntent): string | undefined {
  if (!intent.isPush) return undefined;
  if (intent.usesGitC) {
    return "git push with -C is blocked; use the command cwd so protected-branch policy can be enforced.";
  }
  if (intent.usesMirror) {
    return "git push --mirror is blocked because it can mutate multiple remote refs outside the explicit branch contract.";
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


interface ExternalCommandInvocation {
  executable: string;
  argv: string[];
}

interface PackageRunnerAnalysis {
  hasPackageTarget: boolean;
  invocation?: ExternalCommandInvocation;
}

const PACKAGE_RUNNER_OPTIONS_WITH_VALUE = new Set([
  "--cache",
  "--call",
  "--node-options",
  "--registry",
  "--shell",
  "--userconfig",
  "-c",
]);

function classifyExternalExecutionRisk(shell: ShellName, command: string): string[] {
  const analysis = analyzeSimpleShellCommand(shell, command);
  if (analysis?.valid && analysis.execution?.kind === "argv") {
    return classifyExternalExecutionArgv(
      analysis.execution.executable,
      analysis.execution.argv,
    );
  }

  const reasons: string[] = [];
  for (const segment of splitCommandSegments(shell, command)) {
    const segmentAnalysis = analyzeSimpleShellCommand(shell, segment);
    if (segmentAnalysis?.valid && segmentAnalysis.execution?.kind === "argv") {
      reasons.push(
        ...classifyExternalExecutionArgv(
          segmentAnalysis.execution.executable,
          segmentAnalysis.execution.argv,
        ),
      );
      continue;
    }

    const tokens = segment.trim().split(/\s+/u).filter(Boolean);
    const [executable, ...argv] = tokens;
    if (executable !== undefined) {
      reasons.push(...classifyExternalExecutionArgv(executable, argv));
    }
  }
  return reasons;
}

function classifyExternalExecutionArgv(
  rawExecutable: string,
  argv: string[],
): string[] {
  if (NESTED_SHELL_EXECUTABLES.has(normalizeRiskExecutable(rawExecutable))) {
    return [];
  }

  const executable = normalizeExternalExecutable(rawExecutable);
  const reasons: string[] = [];
  const runner = analyzePackageRunner(executable, argv);
  if (runner !== undefined) {
    if (runner.hasPackageTarget) {
      reasons.push(EXTERNAL_PACKAGE_EXECUTION_REASON);
    }
    if (
      runner.invocation !== undefined &&
      isExternalDeploymentMutation(runner.invocation.executable, runner.invocation.argv)
    ) {
      reasons.push(EXTERNAL_DEPLOYMENT_REASON);
    }
    return reasons;
  }

  if (isExternalDeploymentMutation(executable, argv)) {
    reasons.push(EXTERNAL_DEPLOYMENT_REASON);
  }
  return reasons;
}

function analyzePackageRunner(
  executable: string,
  argv: string[],
): PackageRunnerAnalysis | undefined {
  if (["npx", "pnpx", "bunx"].includes(executable)) {
    return analyzePackageRunnerTail(argv);
  }

  if (executable === "npm") {
    const execIndex = findRunnerVerb(argv, "exec");
    return execIndex < 0 ? undefined : analyzePackageRunnerTail(argv.slice(execIndex + 1));
  }

  if (executable === "pnpm" || executable === "yarn") {
    const dlxIndex = findRunnerVerb(argv, "dlx");
    return dlxIndex < 0 ? undefined : analyzePackageRunnerTail(argv.slice(dlxIndex + 1));
  }

  return undefined;
}

function findRunnerVerb(argv: string[], verb: string): number {
  return argv.findIndex(
    (value) => value.toLocaleLowerCase("en-US") === verb,
  );
}

function analyzePackageRunnerTail(argv: string[]): PackageRunnerAnalysis {
  let hasExplicitPackageTarget = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const lower = token.toLocaleLowerCase("en-US");

    if (token === "--") continue;

    if (lower === "--package" || lower === "-p") {
      if (index + 1 < argv.length) {
        hasExplicitPackageTarget = true;
        index += 1;
      }
      continue;
    }
    if (lower.startsWith("--package=") || lower.startsWith("-p=")) {
      hasExplicitPackageTarget = true;
      continue;
    }
    if (PACKAGE_RUNNER_OPTIONS_WITH_VALUE.has(lower)) {
      if (index + 1 < argv.length) index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;

    return {
      hasPackageTarget: true,
      invocation: {
        executable: token,
        argv: stripArgumentSeparator(argv.slice(index + 1)),
      },
    };
  }

  return { hasPackageTarget: hasExplicitPackageTarget };
}

function stripArgumentSeparator(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function isExternalDeploymentMutation(
  rawExecutable: string,
  argv: string[],
): boolean {
  const executable = normalizeExternalExecutable(rawExecutable);
  const lowerArgs = argv.map((value) => value.toLocaleLowerCase("en-US"));
  const positionals = lowerArgs.filter(
    (value) => value !== "--" && !value.startsWith("-"),
  );

  if (executable === "vercel") {
    return (
      argv.length === 0 ||
      lowerArgs.includes("--prod") ||
      positionals.includes("deploy")
    );
  }
  if (executable === "wrangler") {
    return positionals.includes("deploy") || positionals.includes("publish");
  }
  if (["netlify", "firebase", "fly"].includes(executable)) {
    return positionals.includes("deploy");
  }
  if (executable === "railway") {
    return positionals.includes("up") || positionals.includes("deploy");
  }
  if (executable === "supabase") {
    const functionsIndex = positionals.indexOf("functions");
    const deployIndex = positionals.indexOf("deploy");
    return functionsIndex >= 0 && deployIndex > functionsIndex;
  }
  return false;
}

function normalizeExternalExecutable(value: string): string {
  return normalizeRiskExecutable(value).replace(/\.(?:cmd|bat|exe)$/iu, "");
}

function splitCommandSegments(shell: ShellName, command: string): string[] {
  const segments: string[] = [];
  let segment = "";
  let quote: "single" | "double" | undefined;
  let escaped = false;

  const flush = (): void => {
    const value = segment.trim();
    if (value.length > 0) segments.push(value);
    segment = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;
    const next = command[index + 1];

    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }

    const escapeCharacter =
      shell === "powershell" || shell === "pwsh"
        ? String.fromCharCode(96)
        : shell === "cmd"
          ? "^"
          : "\\";
    if (character === escapeCharacter && quote !== "single") {
      segment += character;
      escaped = true;
      continue;
    }

    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? undefined : "double";
      segment += character;
      continue;
    }
    if (character === "'" && shell !== "cmd" && quote !== "double") {
      quote = quote === "single" ? undefined : "single";
      segment += character;
      continue;
    }

    if (quote === undefined) {
      if (character === "\r" || character === "\n") {
        flush();
        continue;
      }
      if ((character === "&" || character === "|") && next === character) {
        flush();
        index += 1;
        continue;
      }
      if (character === "|" || character === "&") {
        flush();
        continue;
      }
      if (character === ";" && shell !== "cmd") {
        flush();
        continue;
      }
    }

    segment += character;
  }

  flush();
  return segments;
}

function maskPowerShellInertQuotedLiterals(shell: ShellName, value: string): string {
  if (shell !== "powershell" && shell !== "pwsh") return value;

  let masked = "";
  for (let index = 0; index < value.length;) {
    const character = value[index]!;

    if (character === "'") {
      const start = index;
      index += 1;
      let closed = false;
      while (index < value.length) {
        if (value[index] !== "'") {
          index += 1;
          continue;
        }
        if (value[index + 1] === "'") {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      const literal = value.slice(start, index);
      masked += closed ? " ".repeat(literal.length) : literal;
      continue;
    }

    if (character === '"') {
      const start = index;
      index += 1;
      let closed = false;
      let inert = true;
      while (index < value.length) {
        const current = value[index]!;
        if (current === "`") {
          inert = false;
          index = Math.min(index + 2, value.length);
          continue;
        }
        if (current === "$") {
          inert = false;
          index += 1;
          continue;
        }
        if (current === '"') {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      const literal = value.slice(start, index);
      masked += closed && inert ? " ".repeat(literal.length) : literal;
      continue;
    }

    masked += character;
    index += 1;
  }

  return masked;
}

function containsFileRedirection(normalized: string): boolean {
  const candidate = normalized.replace(NULL_DEVICE_REDIRECTION_PATTERN, " ");
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
