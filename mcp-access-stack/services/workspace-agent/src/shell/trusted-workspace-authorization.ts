import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  type ErrorCode,
  type ShellName,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../internal-types.js";
import {
  isContained,
  normalizeRelativePath,
  PathSecurity,
} from "../path-security.js";
import { QualifiedShellAdapterRegistry } from "./qualified/shell-adapters.js";
import { analyzeSimplePowerShellCommand } from "./qualified/powershell-lexical.js";
import type { ShellCommandAnalysis } from "./qualified/types.js";

export type TrustedWorkspaceAuthorizationDecision =
  | { disposition: "execute"; authorization: "trusted-workspace" }
  | { disposition: "confirmation_required"; reasons: string[] }
  | { disposition: "blocked"; code: ErrorCode; reason: string };

interface TrustedWorkspaceAuthorizationInput {
  workspace: ResolvedWorkspace;
  shell: ShellName;
  command: string;
  logicalCwd: string;
  absoluteCwd: string;
  fallbackReasons: string[];
}

interface MutablePath {
  logicalPath: string;
  kind?: "file" | "directory";
  canonicalPath?: string;
}

const shellAdapters = new QualifiedShellAdapterRegistry();
const MAX_GIT_PREFLIGHT_BYTES = 1_000_000;
const GIT_PREFLIGHT_TIMEOUT_MS = 10_000;
const TRUSTED_FALLBACK_REASON =
  "trusted-workspace could not prove that every command effect is local and authorized";
const TRUSTED_CRITICAL_CANDIDATE_PATTERN =
  /\b(?:schtasks|scheduledtask|runas|sudo|start-process|cmdkey|vaultcmd|certutil|certreq|import-pfxcertificate|winget|choco|scoop|msiexec|start-service|restart-service|stop-service|set-service|powershell|pwsh|cmd|wsl|bash|sh|node|python3?|perl|ruby|docker)\b|\.(?:ps1|cmd|bat|sh|py|rb|pl)(?:\s|$)/iu;

async function analyzeTrustedCommand(
  shell: ShellName,
  command: string,
  absoluteCwd: string,
): Promise<ShellCommandAnalysis | undefined> {
  if (shell === "powershell" || shell === "pwsh") {
    return analyzeSimplePowerShellCommand(shell, command);
  }
  return shellAdapters.analyze(shell, command, absoluteCwd);
}
export async function trustedWorkspaceCriticalReason(
  shell: ShellName,
  command: string,
  absoluteCwd: string,
): Promise<string | undefined> {
  if (!TRUSTED_CRITICAL_CANDIDATE_PATTERN.test(command)) return undefined;

  let analysis: ShellCommandAnalysis | undefined;
  try {
    analysis = await analyzeTrustedCommand(shell, command, absoluteCwd);
  } catch {
    return criticalReasonFromCommandText(command);
  }
  if (!analysis || !analysis.valid || analysis.usesShellFeatures || analysis.execution?.kind !== "argv") {
    return criticalReasonFromCommandText(command);
  }

  const rawExecutable = analysis.execution.executable;
  const executable = normalizeExecutable(rawExecutable);
  const argv = analysis.execution.argv.map((value) => value.toLowerCase());
  const first = argv[0] ?? "";

  if (/\.(?:ps1|cmd|bat|sh|py|rb|pl)$/iu.test(rawExecutable)) {
    return "script execution cannot inherit trusted-workspace authorization";
  }
  if (
    executable === "schtasks" &&
    argv.some((value) => /^\/(?:create|delete|change|run|end)$/iu.test(value))
  ) {
    return "Scheduled Task mutation requires explicit confirmation";
  }
  if (
    [
      "register-scheduledtask",
      "unregister-scheduledtask",
      "set-scheduledtask",
      "start-scheduledtask",
      "stop-scheduledtask",
      "enable-scheduledtask",
      "disable-scheduledtask",
    ].includes(executable)
  ) {
    return "Scheduled Task mutation requires explicit confirmation";
  }
  if (
    executable === "runas" ||
    executable === "sudo" ||
    (executable === "start-process" &&
      argv.some((value, index) => value === "-verb" && argv[index + 1] === "runas"))
  ) {
    return "elevation or UAC operation requires explicit confirmation";
  }
  if (
    executable === "cmdkey" ||
    executable === "vaultcmd" ||
    executable === "certutil" ||
    executable === "certreq" ||
    executable === "import-pfxcertificate"
  ) {
    return "credential or certificate operation requires explicit confirmation";
  }
  if (
    (executable === "winget" && ["install", "uninstall", "upgrade"].includes(first)) ||
    (executable === "choco" && ["install", "uninstall", "upgrade"].includes(first)) ||
    (executable === "scoop" && ["install", "uninstall", "update"].includes(first)) ||
    (executable === "msiexec" && argv.some((value) => /^\/(?:i|x|package|uninstall)$/iu.test(value)))
  ) {
    return "machine-wide install or uninstall operation requires explicit confirmation";
  }
  if (
    ["start-service", "restart-service", "stop-service", "set-service"].includes(executable)
  ) {
    return "Windows service mutation requires explicit confirmation";
  }
  if (executable === "docker" && isDockerMutation(argv)) {
    return "Docker mutation is outside trusted-workspace authorization";
  }
  if (
    ["powershell", "pwsh", "cmd", "wsl", "bash", "sh"].includes(executable) &&
    argv.some((value) => ["-command", "-c", "/c", "--exec"].includes(value))
  ) {
    return "nested shell execution cannot inherit trusted-workspace authorization";
  }
  if (
    ["node", "python", "python3", "perl", "ruby"].includes(executable) &&
    argv.some((value) => ["-e", "--eval", "-c"].includes(value))
  ) {
    return "inline interpreter execution cannot inherit trusted-workspace authorization";
  }

  return undefined;
}

function isDockerMutation(argv: string[]): boolean {
  const values = argv.map((value) => value.toLowerCase());
  const globalValueOptions = new Set([
    "--config",
    "--context",
    "-c",
    "--host",
    "-h",
    "--log-level",
    "-l",
    "--tlscacert",
    "--tlscert",
    "--tlskey",
  ]);
  const primary = nextDockerPositional(values, 0, globalValueOptions);
  if (!primary) return false;

  const directMutations = new Set([
    "build",
    "commit",
    "cp",
    "create",
    "exec",
    "export",
    "import",
    "kill",
    "load",
    "login",
    "logout",
    "pause",
    "pull",
    "push",
    "rename",
    "restart",
    "rm",
    "rmi",
    "run",
    "save",
    "start",
    "stop",
    "tag",
    "unpause",
    "update",
  ]);
  if (directMutations.has(primary.value)) return true;

  const namespaceMutations: Record<string, ReadonlySet<string>> = {
    system: new Set(["prune"]),
    volume: new Set(["create", "prune", "rm"]),
    network: new Set(["connect", "create", "disconnect", "prune", "rm"]),
    image: new Set(["build", "import", "load", "prune", "pull", "push", "rm", "tag"]),
    container: new Set([
      "attach",
      "commit",
      "cp",
      "create",
      "exec",
      "export",
      "kill",
      "pause",
      "prune",
      "rename",
      "restart",
      "rm",
      "run",
      "start",
      "stop",
      "unpause",
      "update",
    ]),
    compose: new Set([
      "build",
      "create",
      "down",
      "exec",
      "kill",
      "pause",
      "pull",
      "push",
      "restart",
      "rm",
      "run",
      "start",
      "stop",
      "unpause",
      "up",
    ]),
    context: new Set(["create", "import", "rm", "update", "use"]),
  };
  const mutations = namespaceMutations[primary.value];
  if (!mutations) return false;

  const namespaceValueOptions = primary.value === "compose"
    ? new Set([
        "-f",
        "--file",
        "-p",
        "--project-name",
        "--profile",
        "--env-file",
        "--project-directory",
        "--parallel",
      ])
    : new Set<string>();
  const secondary = nextDockerPositional(values, primary.index + 1, namespaceValueOptions);
  return secondary ? mutations.has(secondary.value) : false;
}

function nextDockerPositional(
  values: string[],
  start: number,
  valueOptions: ReadonlySet<string>,
): { value: string; index: number } | undefined {
  for (let index = start; index < values.length; index += 1) {
    const value = values[index]!;
    if (valueOptions.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    return { value, index };
  }
  return undefined;
}
function criticalReasonFromCommandText(command: string): string | undefined {
  const normalized = command.replace(/`[\r\n]/gu, " ").replace(/\s+/gu, " ").trim();
  const boundary = String.raw`(?:^|[;&|]\s*)(?:&\s*)?`;

  if (new RegExp(`${boundary}(?:schtasks(?:\\.exe)?\\b[^;&|]{0,240}\\/(?:create|delete|change|run|end)\\b|(?:register|unregister|set|start|stop|enable|disable)-scheduledtask\\b)`, "iu").test(normalized)) {
    return "Scheduled Task mutation requires explicit confirmation";
  }
  if (new RegExp(`${boundary}(?:runas(?:\\.exe)?|sudo|start-process\\b[^;&|]{0,240}\\s-verb\\s+runas\\b)`, "iu").test(normalized)) {
    return "elevation or UAC operation requires explicit confirmation";
  }
  if (new RegExp(`${boundary}(?:cmdkey|vaultcmd|certutil|certreq|import-pfxcertificate)\\b`, "iu").test(normalized)) {
    return "credential or certificate operation requires explicit confirmation";
  }
  if (new RegExp(`${boundary}(?:(?:winget|choco)\\b[^;&|]{0,240}\\b(?:install|uninstall|upgrade)\\b|scoop\\b[^;&|]{0,240}\\b(?:install|uninstall|update)\\b|msiexec\\b[^;&|]{0,240}\/(?:i|x|package|uninstall)\\b)`, "iu").test(normalized)) {
    return "machine-wide install or uninstall operation requires explicit confirmation";
  }
  if (
    new RegExp(
      String.raw`${boundary}docker(?:\.exe)?\b[^;&|]{0,320}\b(?:build|commit|cp|create|exec|export|import|kill|load|login|logout|pause|pull|push|rename|restart|rm|rmi|run|save|start|stop|tag|unpause|update)\b`,
      "iu",
    ).test(normalized) ||
    new RegExp(
      String.raw`${boundary}docker(?:\.exe)?\b[^;&|]{0,320}\b(?:system\s+prune|volume\s+(?:create|prune|rm)|network\s+(?:connect|create|disconnect|prune|rm)|image\s+(?:build|import|load|prune|pull|push|rm|tag)|container\s+(?:attach|commit|cp|create|exec|export|kill|pause|prune|rename|restart|rm|run|start|stop|unpause|update)|compose\s+(?:build|create|down|exec|kill|pause|pull|push|restart|rm|run|start|stop|unpause|up)|context\s+(?:create|import|rm|update|use))\b`,
      "iu",
    ).test(normalized)
  ) {
    return "Docker mutation is outside trusted-workspace authorization";
  }  if (new RegExp(`${boundary}(?:start-service|restart-service|stop-service|set-service)\\b`, "iu").test(normalized)) {
    return "Windows service mutation requires explicit confirmation";
  }
  if (new RegExp(`${boundary}(?:powershell|pwsh|cmd|wsl|bash|sh)(?:\\.exe)?\\b[^;&|]{0,240}(?:-command|-c|/c|--exec)\\b`, "iu").test(normalized)) {
    return "nested shell execution cannot inherit trusted-workspace authorization";
  }
  if (new RegExp(`${boundary}[^\\s;&|]+\\.(?:ps1|cmd|bat|sh|py|rb|pl)\\b`, "iu").test(normalized)) {
    return "script execution cannot inherit trusted-workspace authorization";
  }
  if (new RegExp(`${boundary}(?:node|python3?|perl|ruby)(?:\\.exe)?\\b[^;&|]{0,240}(?:-e|--eval|-c)\\b`, "iu").test(normalized)) {
    return "inline interpreter execution cannot inherit trusted-workspace authorization";
  }
  return undefined;
}

export async function authorizeTrustedWorkspaceCommand(
  input: TrustedWorkspaceAuthorizationInput,
): Promise<TrustedWorkspaceAuthorizationDecision> {
  let analysis: ShellCommandAnalysis | undefined;
  try {
    analysis = await analyzeTrustedCommand(input.shell, input.command, input.absoluteCwd);
  } catch {
    return confirmation(input);
  }

  if (
    !analysis ||
    !analysis.valid ||
    analysis.usesShellFeatures ||
    analysis.execution?.kind !== "argv"
  ) {
    return confirmation(input);
  }

  const rawExecutable = analysis.execution.executable;
  const executable = normalizeExecutable(rawExecutable);
  const argv = analysis.execution.argv;

  try {
    if (executable === "git") {
      if (!isTrustedWindowsGitInvocation(input.shell, rawExecutable)) return confirmation(input);
      return await authorizeGitMutation(input, argv);
    }

    if (input.shell === "powershell" || input.shell === "pwsh") {
      return await authorizePowerShellMutation(input, rawExecutable, argv);
    }

    if (input.shell === "cmd") {
      return await authorizeCmdMutation(input, executable, argv);
    }

    if (input.shell === "wsl" || input.shell === "git-bash") {
      return await authorizePosixMutation(input, executable, argv);
    }
  } catch (error) {
    return decisionFromAuthorizationError(input, error);
  }

  return confirmation(input);
}

async function authorizePowerShellMutation(
  input: TrustedWorkspaceAuthorizationInput,
  rawExecutable: string,
  argv: string[],
): Promise<TrustedWorkspaceAuthorizationDecision> {
  const command = rawExecutable.toLowerCase();
  if (isPowerShellCommand(command, "remove-item", ["ri", "rm"])) {
    return authorizePowerShellRemove(input, argv);
  }
  if (isPowerShellCommand(command, "move-item", ["mi", "mv"])) {
    return authorizePowerShellMove(input, argv);
  }
  if (isPowerShellCommand(command, "copy-item", ["cpi", "cp"])) {
    return authorizePowerShellCopy(input, argv);
  }
  if (
    command === "set-content" ||
    (input.shell === "powershell" && command === "sc")
  ) {
    return authorizePowerShellSetContent(input, argv);
  }
  if (isPowerShellCommand(command, "new-item", ["ni"])) {
    return authorizePowerShellNewItem(input, argv);
  }
  return confirmation(input);
}

function isPowerShellCommand(
  rawExecutable: string,
  canonical: string,
  aliases: string[],
): boolean {
  return rawExecutable === canonical || aliases.includes(rawExecutable);
}

function isTrustedWindowsGitInvocation(shell: ShellName, rawExecutable: string): boolean {
  if (shell !== "powershell" && shell !== "pwsh" && shell !== "cmd") return false;
  const raw = rawExecutable.toLowerCase();
  return raw === "git" || raw === "git.exe";
}
async function authorizePowerShellRemove(
  input: TrustedWorkspaceAuthorizationInput,
  argv: string[],
): Promise<TrustedWorkspaceAuthorizationDecision> {
  let target: string | undefined;
  let recurse = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const lower = token.toLowerCase();
    if (lower === "-literalpath" || lower === "-path") {
      if (target !== undefined || index + 1 >= argv.length) return confirmation(input);
      target = argv[++index];
      continue;
    }
    if (lower === "-force") continue;
    if (lower === "-recurse") {
      recurse = true;
      continue;
    }
    if (token.startsWith("-")) return confirmation(input);
    if (target !== undefined) return confirmation(input);
    target = token;
  }
  if (!target) return confirmation(input);

  const security = new PathSecurity(input.workspace);
  const resolved = await authorizeExistingMutablePath(input, security, target);
  if (!resolved) return confirmation(input);
  if (resolved.kind === "directory") {
    if (security.isSubtreeBlocked(resolved.logicalPath)) {
      throw new AppError("BLOCKED_PATH", "Directory subtree is blocked by workspace policy.");
    }
    if (recurse) {
      const safeTree = await authorizeMutableTree(input.workspace, security, resolved);
      if (!safeTree) return confirmation(input);
    } else {
      const entries = await readdir(resolved.canonicalPath!);
      if (entries.length > 0) return confirmation(input);
    }
  }
  return trustedExecute();
}

async function authorizePowerShellMove(
  input: TrustedWorkspaceAuthorizationInput,
  argv: string[],
): Promise<TrustedWorkspaceAuthorizationDecision> {
  const parsed = parseSourceDestination(argv, new Set(["-force"]));
  if (!parsed) return confirmation(input);
  return authorizeMoveLike(input, parsed.source, parsed.destination, false);
}

async function authorizePowerShellCopy(
  input: TrustedWorkspaceAuthorizationInput,
  argv: string[],
): Promise<TrustedWorkspaceAuthorizationDecision> {
  const parsed = parseSourceDestination(argv, new Set(["-force"]));
  if (!parsed) return confirmation(input);
  return authorizeMoveLike(input, parsed.source, parsed.destination, true);
}

async function authorizeMoveLike(
  input: TrustedWorkspaceAuthorizationInput,
  sourceOperand: string,
  destinationOperand: string,
  copy: boolean,
): Promise<TrustedWorkspaceAuthorizationDecision> {
  const security = new PathSecurity(input.workspace);
  const source = await authorizeExistingMutablePath(input, security, sourceOperand);
  if (!source) return confirmation(input);
  if (source.kind === "directory") {
    if (security.isSubtreeBlocked(source.logicalPath)) {
      throw new AppError("BLOCKED_PATH", "Directory subtree is blocked by workspace policy.");
    }
    if (!(await authorizeMutableTree(input.workspace, security, source))) {
      return confirmation(input);
    }
  }

  const destination = await authorizeMutableTarget(input, security, destinationOperand);
  if (!destination) return confirmation(input);
  if (destination.kind === "directory") {
    return confirmation(input);
  }
  if (source.kind === "directory" && destination.kind === "file") {
    return confirmation(input);
  }

  if (!copy && source.logicalPath === destination.logicalPath) {
    return confirmation(input);
  }
  return trustedExecute();
}

async function authorizePowerShellSetContent(
  input: TrustedWorkspaceAuthorizationInput,
  argv: string[],
): Promise<TrustedWorkspaceAuthorizationDecision> {
  let target: string | undefined;
  let positionalTarget: string | undefined;
  let sawValue = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const lower = token.toLowerCase();
    if (lower === "-literalpath" || lower === "-path") {
      if (target !== undefined || index + 1 >= argv.length) return confirmation(input);
      target = argv[++index];
      continue;
    }
    if (lower === "-value" || lower === "-encoding") {
      if (index + 1 >= argv.length) return confirmation(input);
      index += 1;
      if (lower === "-value") sawValue = true;
      continue;
    }
    if (lower === "-force" || lower === "-nonewline") continue;
    if (token.startsWith("-")) return confirmation(input);
    if (!target && !positionalTarget) {
      positionalTarget = token;
      continue;
    }
    if (!sawValue) {
      sawValue = true;
      continue;
    }
  }
  target ??= positionalTarget;
  if (!target) return confirmation(input);

  const security = new PathSecurity(input.workspace);
  const destination = await authorizeMutableTarget(input, security, target);
  if (!destination || destination.kind === "directory") return confirmation(input);
  return trustedExecute();
}

async function authorizePowerShellNewItem(
  input: TrustedWorkspaceAuthorizationInput,
  argv: string[],
): Promise<TrustedWorkspaceAuthorizationDecision> {
  let target: string | undefined;
  let itemType: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const lower = token.toLowerCase();
    if (lower === "-literalpath" || lower === "-path") {
      if (target !== undefined || index + 1 >= argv.length) return confirmation(input);
      target = argv[++index];
      continue;
    }
    if (lower === "-itemtype") {
      if (index + 1 >= argv.length) return confirmation(input);
      itemType = argv[++index]?.toLowerCase();
      continue;
    }
    if (lower === "-value") {
      if (index + 1 >= argv.length) return confirmation(input);
      index += 1;
      continue;
    }
    if (lower === "-force") continue;
    if (token.startsWith("-")) return confirmation(input);
    if (target !== undefined) return confirmation(input);
    target = token;
  }
  if (!target || (itemType !== "file" && itemType !== "directory")) {
    return confirmation(input);
  }

  const security = new PathSecurity(input.workspace);
  const destination = await authorizeMutableTarget(input, security, target);
  if (!destination) return confirmation(input);
  if (itemType === "directory" && security.isSubtreeBlocked(destination.logicalPath)) {
    throw new AppError("BLOCKED_PATH", "Directory subtree is blocked by workspace policy.");
  }
  if (destination.kind && destination.kind !== itemType) return confirmation(input);
  return trustedExecute();
}

async function authorizeCmdMutation(
  input: TrustedWorkspaceAuthorizationInput,
  executable: string,
  argv: string[],
): Promise<TrustedWorkspaceAuthorizationDecision> {
  const security = new PathSecurity(input.workspace);
  if (executable === "del" || executable === "erase") {
    const args = argv.filter((value) => !/^\/q$/iu.test(value));
    if (args.length !== 1 || args[0]?.startsWith("/")) return confirmation(input);
    const target = await authorizeExistingMutablePath(input, security, args[0]!);
    return target?.kind === "file" ? trustedExecute() : confirmation(input);
  }
  if (executable === "move" || executable === "ren" || executable === "rename") {
    const args = argv.filter((value) => !/^\/y$/iu.test(value));
    if (args.length !== 2) return confirmation(input);
    return authorizeMoveLike(input, args[0]!, args[1]!, false);
  }
  if (executable === "copy") {
    const args = argv.filter((value) => !/^\/y$/iu.test(value));
    if (args.length !== 2) return confirmation(input);
    return authorizeMoveLike(input, args[0]!, args[1]!, true);
  }
  if (executable === "rd" || executable === "rmdir") {
    let recurse = false;
    const args = argv.filter((value) => {
      if (/^\/s$/iu.test(value)) {
        recurse = true;
        return false;
      }
      return !/^\/q$/iu.test(value);
    });
    if (args.length !== 1) return confirmation(input);
    const target = await authorizeExistingMutablePath(input, security, args[0]!);
    if (!target || target.kind !== "directory") return confirmation(input);
    if (recurse) {
      if (!(await authorizeMutableTree(input.workspace, security, target))) {
        return confirmation(input);
      }
    } else if ((await readdir(target.canonicalPath!)).length > 0) {
      return confirmation(input);
    }
    return trustedExecute();
  }
  return confirmation(input);
}

async function authorizePosixMutation(
  input: TrustedWorkspaceAuthorizationInput,
  executable: string,
  argv: string[],
): Promise<TrustedWorkspaceAuthorizationDecision> {
  const security = new PathSecurity(input.workspace);
  if (executable === "rm") {
    let recurse = false;
    const paths: string[] = [];
    for (const token of argv) {
      if (/^-[a-z]*r[a-z]*$/iu.test(token) || /^-[a-z]*R[a-z]*$/u.test(token)) {
        recurse = true;
        if (!/^-[fRr]+$/u.test(token)) return confirmation(input);
        continue;
      }
      if (/^-f$/u.test(token) || token === "--") continue;
      if (token.startsWith("-")) return confirmation(input);
      paths.push(token);
    }
    if (paths.length !== 1) return confirmation(input);
    const target = await authorizeExistingMutablePath(input, security, paths[0]!);
    if (!target) return confirmation(input);
    if (target.kind === "directory") {
      if (!recurse) return confirmation(input);
      if (!(await authorizeMutableTree(input.workspace, security, target))) {
        return confirmation(input);
      }
    }
    return trustedExecute();
  }
  if (executable === "rmdir") {
    if (argv.length !== 1) return confirmation(input);
    const target = await authorizeExistingMutablePath(input, security, argv[0]!);
    if (!target || target.kind !== "directory") return confirmation(input);
    if ((await readdir(target.canonicalPath!)).length > 0) return confirmation(input);
    return trustedExecute();
  }
  if (executable === "mv" || executable === "cp") {
    const args = argv.filter((value) => value !== "--" && value !== "-f");
    if (args.length !== 2 || args.some((value) => value.startsWith("-"))) {
      return confirmation(input);
    }
    return authorizeMoveLike(input, args[0]!, args[1]!, executable === "cp");
  }
  return confirmation(input);
}

async function authorizeGitMutation(
  input: TrustedWorkspaceAuthorizationInput,
  argv: string[],
): Promise<TrustedWorkspaceAuthorizationDecision> {
  if (argv.length === 0) return confirmation(input);
  if (argv[0]?.startsWith("-")) return confirmation(input);
  const subcommand = argv[0]!.toLowerCase();
  const args = argv.slice(1);

  const repo = await resolveGitRepository(input);
  if (!repo) return confirmation(input);
  const security = new PathSecurity(input.workspace);

  if (subcommand === "add") {
    const pathspecs = parseGitPathspecs(args, { allowDot: true, allowedOptions: [] });
    if (!pathspecs) return confirmation(input);
    const affected = await collectGitPaths(input.absoluteCwd, [
      ["diff", "--name-only", "-z", "--no-relative", "--", ...pathspecs],
      ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ...pathspecs],
    ]);
    if (!affected) return confirmation(input);
    await authorizeGitAffectedPaths(input, security, repo.logicalRoot, affected);
    return trustedExecute();
  }

  if (subcommand === "restore") {
    const staged = args.some((value) => value === "--staged");
    if (args.some((value) => value === "--worktree" || value.startsWith("--source"))) {
      return confirmation(input);
    }
    const filtered = args.filter((value) => value !== "--staged");
    const pathspecs = parseGitPathspecs(filtered, {
      allowDot: staged,
      allowedOptions: [],
    });
    if (!pathspecs) return confirmation(input);
    if (!staged && pathspecs.includes(".")) return confirmation(input);
    const affected = await collectGitPaths(input.absoluteCwd, [
      staged
        ? ["diff", "--cached", "--name-only", "-z", "--no-relative", "--", ...pathspecs]
        : ["diff", "--name-only", "-z", "--no-relative", "--", ...pathspecs],
    ]);
    if (!affected) return confirmation(input);
    await authorizeGitAffectedPaths(input, security, repo.logicalRoot, affected);
    if (!staged && !gitAffectedSetIsExplicit(pathspecs, affected)) {
      return confirmation(input);
    }
    return trustedExecute();
  }

  if (subcommand === "reset") {
    if (args.some((value) => /^(--hard|--soft|--merge|--keep)$/u.test(value))) {
      return confirmation(input);
    }
    const separator = args.indexOf("--");
    if (separator < 0) return confirmation(input);
    const prefix = args.slice(0, separator);
    if (
      prefix.some(
        (value) => value !== "HEAD" && value !== "--mixed" && value !== "-q",
      )
    ) {
      return confirmation(input);
    }
    const pathspecs = args.slice(separator + 1);
    if (!validateLiteralGitPathspecs(pathspecs, false)) return confirmation(input);
    const affected = await collectGitPaths(input.absoluteCwd, [
      ["diff", "--cached", "--name-only", "-z", "--no-relative", "--", ...pathspecs],
    ]);
    if (!affected) return confirmation(input);
    await authorizeGitAffectedPaths(input, security, repo.logicalRoot, affected);
    if (!gitAffectedSetIsExplicit(pathspecs, affected)) return confirmation(input);
    return trustedExecute();
  }

  if (subcommand === "clean") {
    const separator = args.indexOf("--");
    if (separator < 0) return confirmation(input);
    const flags = args.slice(0, separator);
    const pathspecs = args.slice(separator + 1);
    if (
      !flags.some((value) => value.includes("f")) ||
      flags.some((value) => /[xX]/u.test(value)) ||
      flags.some((value) => !/^-[fdn]+$/u.test(value)) ||
      !validateLiteralGitPathspecs(pathspecs, false)
    ) {
      return confirmation(input);
    }
    const affected = await collectGitPaths(input.absoluteCwd, [
      ["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ...pathspecs],
    ]);
    if (!affected) return confirmation(input);
    await authorizeGitAffectedPaths(input, security, repo.logicalRoot, affected, true);
    for (const pathspec of pathspecs) {
      const logical = resolveLiteralLogical(input.logicalCwd, pathspec, false);
      if (!logical) return confirmation(input);
      security.authorizeWriteLogical(logical);
      try {
        const existing = await security.authorizeExisting(logical);
        if (await security.isSymbolicLink(logical)) return confirmation(input);
        if (existing.kind === "directory") {
          if (!(await authorizeMutableTree(input.workspace, security, existing))) {
            return confirmation(input);
          }
        }
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "FILE_NOT_FOUND") throw error;
      }
    }
    return trustedExecute();
  }

  return confirmation(input);
}

async function resolveGitRepository(
  input: TrustedWorkspaceAuthorizationInput,
): Promise<{ logicalRoot: string } | undefined> {
  const output = await runGit(input.absoluteCwd, ["rev-parse", "--show-toplevel"]);
  if (output === undefined) return undefined;
  const canonicalTop = path.resolve(output.trim());
  if (!isContained(input.workspace.canonicalRootPath, canonicalTop)) {
    throw new AppError(
      "PATH_OUTSIDE_WORKSPACE",
      "Git repository root resolves outside the trusted workspace.",
    );
  }
  const relative = path
    .relative(input.workspace.canonicalRootPath, canonicalTop)
    .split(path.sep)
    .join("/");
  return { logicalRoot: relative || "." };
}

async function collectGitPaths(
  cwd: string,
  commands: string[][],
): Promise<string[] | undefined> {
  const values = new Set<string>();
  for (const args of commands) {
    const output = await runGit(cwd, args);
    if (output === undefined) return undefined;
    for (const value of output.split("\0")) {
      if (value.length > 0) values.add(value.replaceAll("\\", "/"));
    }
  }
  return [...values];
}

async function authorizeGitAffectedPaths(
  input: TrustedWorkspaceAuthorizationInput,
  security: PathSecurity,
  repoLogicalRoot: string,
  paths: string[],
  requireExisting = false,
): Promise<void> {
  for (const relative of paths) {
    const logical = resolveLiteralLogical(repoLogicalRoot, relative, false);
    if (!logical) {
      throw new AppError("INVALID_PATH", "Git preflight returned an ambiguous path.");
    }
    security.authorizeWriteLogical(logical);
    if (security.isSubtreeBlocked(logical)) {
      throw new AppError("BLOCKED_PATH", "Git target subtree is blocked by workspace policy.");
    }
    try {
      await security.authorizeExisting(logical);
      if (await security.isSymbolicLink(logical)) {
        throw new AppError("INVALID_PATH", "Git target is a symbolic link.");
      }
    } catch (error) {
      if (
        !requireExisting &&
        error instanceof AppError &&
        error.code === "FILE_NOT_FOUND"
      ) {
        continue;
      }
      throw error;
    }
  }
}

function parseGitPathspecs(
  args: string[],
  options: { allowDot: boolean; allowedOptions: string[] },
): string[] | undefined {
  const separator = args.indexOf("--");
  let pathspecs: string[];
  if (separator >= 0) {
    const flags = args.slice(0, separator);
    if (flags.some((value) => !options.allowedOptions.includes(value))) return undefined;
    pathspecs = args.slice(separator + 1);
  } else {
    if (args.some((value) => value.startsWith("-"))) return undefined;
    pathspecs = args;
  }
  return validateLiteralGitPathspecs(pathspecs, options.allowDot) ? pathspecs : undefined;
}

function validateLiteralGitPathspecs(pathspecs: string[], allowDot: boolean): boolean {
  return (
    pathspecs.length > 0 &&
    pathspecs.every((value) => {
      if (value === ".") return allowDot;
      return isLiteralRelativeOperand(value);
    })
  );
}

function gitAffectedSetIsExplicit(pathspecs: string[], affected: string[]): boolean {
  if (affected.length === 0) return true;
  const normalized = new Set(pathspecs.map((value) => value.replaceAll("\\", "/")));
  return affected.every((value) => normalized.has(value));
}

async function authorizeExistingMutablePath(
  input: TrustedWorkspaceAuthorizationInput,
  security: PathSecurity,
  operand: string,
): Promise<MutablePath | undefined> {
  const logicalPath = resolveLiteralLogical(input.logicalCwd, operand, false);
  if (!logicalPath) return undefined;
  security.authorizeWriteLogical(logicalPath);
  if (security.isSubtreeBlocked(logicalPath)) {
    throw new AppError("BLOCKED_PATH", "Target subtree is blocked by workspace policy.");
  }
  if (await security.isSymbolicLink(logicalPath)) return undefined;
  const authorized = await security.authorizeExisting(logicalPath);
  return {
    logicalPath,
    kind: authorized.kind,
    canonicalPath: authorized.canonicalPath,
  };
}

async function authorizeMutableTarget(
  input: TrustedWorkspaceAuthorizationInput,
  security: PathSecurity,
  operand: string,
): Promise<MutablePath | undefined> {
  const logicalPath = resolveLiteralLogical(input.logicalCwd, operand, false);
  if (!logicalPath) return undefined;
  security.authorizeWriteLogical(logicalPath);
  if (security.isSubtreeBlocked(logicalPath)) {
    throw new AppError("BLOCKED_PATH", "Target subtree is blocked by workspace policy.");
  }

  try {
    const existing = await security.authorizeExisting(logicalPath);
    if (await security.isSymbolicLink(logicalPath)) return undefined;
    return {
      logicalPath,
      kind: existing.kind,
      canonicalPath: existing.canonicalPath,
    };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "FILE_NOT_FOUND") throw error;
  }

  const parent = path.posix.dirname(logicalPath);
  await security.authorizeExisting(parent, "directory", true);
  return { logicalPath };
}

async function authorizeMutableTree(
  workspace: ResolvedWorkspace,
  security: PathSecurity,
  root: MutablePath,
): Promise<boolean> {
  if (root.kind !== "directory" || !root.canonicalPath) return false;
  const stack: MutablePath[] = [root];
  let count = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current.canonicalPath!, { withFileTypes: true });
    for (const entry of entries) {
      count += 1;
      if (count > workspace.limits.maxListedFiles) return false;
      const logicalPath = `${current.logicalPath}/${entry.name}`;
      security.authorizeWriteLogical(logicalPath);
      if (security.isSubtreeBlocked(logicalPath)) {
        throw new AppError("BLOCKED_PATH", "Directory subtree is blocked by workspace policy.");
      }
      if (entry.isSymbolicLink()) return false;
      const authorized = await security.authorizeExisting(logicalPath);
      if (authorized.kind === "directory") {
        stack.push({
          logicalPath,
          kind: "directory",
          canonicalPath: authorized.canonicalPath,
        });
      }
    }
  }
  return true;
}

function parseSourceDestination(
  argv: string[],
  allowedSwitches: Set<string>,
): { source: string; destination: string } | undefined {
  let source: string | undefined;
  let destination: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const lower = token.toLowerCase();
    if (lower === "-literalpath" || lower === "-path") {
      if (source !== undefined || index + 1 >= argv.length) return undefined;
      source = argv[++index];
      continue;
    }
    if (lower === "-destination") {
      if (destination !== undefined || index + 1 >= argv.length) return undefined;
      destination = argv[++index];
      continue;
    }
    if (allowedSwitches.has(lower)) continue;
    if (token.startsWith("-")) return undefined;
    positionals.push(token);
  }
  source ??= positionals.shift();
  destination ??= positionals.shift();
  if (!source || !destination || positionals.length > 0) return undefined;
  return { source, destination };
}

function resolveLiteralLogical(
  logicalCwd: string,
  operand: string,
  allowDot: boolean,
): string | undefined {
  if (!isLiteralRelativeOperand(operand) && !(allowDot && operand === ".")) {
    return undefined;
  }
  const portable = operand.replaceAll("\\", "/");
  const combined = logicalCwd === "." ? portable : `${logicalCwd}/${portable}`;
  try {
    return normalizeRelativePath(combined, { allowDot });
  } catch {
    return undefined;
  }
}

function isLiteralRelativeOperand(value: string): boolean {
  if (value.length === 0 || value.startsWith("~") || value.startsWith(":")) return false;
  if (
    path.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    path.posix.isAbsolute(value) ||
    value.startsWith("\\\\") ||
    /^[a-zA-Z]:/u.test(value)
  ) {
    return false;
  }
  const portable = value.replaceAll("\\", "/");
  if (portable.split("/").includes("..")) return false;
  return !/[?*\[\]]/u.test(portable);
}

function normalizeExecutable(value: string): string {
  return path.basename(value).replace(/\.(?:exe|cmd)$/iu, "").toLowerCase();
}

function trustedExecute(): TrustedWorkspaceAuthorizationDecision {
  return { disposition: "execute", authorization: "trusted-workspace" };
}

function confirmation(
  input: TrustedWorkspaceAuthorizationInput,
): TrustedWorkspaceAuthorizationDecision {
  return {
    disposition: "confirmation_required",
    reasons:
      input.fallbackReasons.length > 0
        ? input.fallbackReasons
        : [TRUSTED_FALLBACK_REASON],
  };
}

function decisionFromAuthorizationError(
  input: TrustedWorkspaceAuthorizationInput,
  error: unknown,
): TrustedWorkspaceAuthorizationDecision {
  if (error instanceof AppError) {
    if (
      error.code === "BLOCKED_PATH" ||
      error.code === "PATH_OUTSIDE_WORKSPACE" ||
      error.code === "PATH_OUTSIDE_ALLOWED_ROOTS" ||
      error.code === "WRITE_NOT_ALLOWED" ||
      error.code === "INVALID_PATH"
    ) {
      return { disposition: "blocked", code: error.code, reason: error.message };
    }
  }
  return confirmation(input);
}

async function runGit(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child;
    try {
      child = spawn("git", args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }

    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, GIT_PREFLIGHT_TIMEOUT_MS);
    timer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_GIT_PREFLIGHT_BYTES) {
        child.kill();
        finish(undefined);
      }
    });
    child.once("error", () => finish(undefined));
    child.once("close", (code) => finish(code === 0 ? stdout : undefined));
  });
}
