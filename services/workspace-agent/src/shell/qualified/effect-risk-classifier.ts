import path from "node:path";
import type {
  CommandPlanExecution,
  CommandRiskClass,
  ShellName,
} from "@vs-code-gpt/shared";
import { classifyCommandRisk } from "../command-risk.js";
import type { CommandClassification } from "./types.js";

const FORBIDDEN_PATTERNS = [
  /\bwsl(?:\.exe)?\b[^\r\n;&|]{0,240}(?:^|\s)--unregister(?:\s|$)/iu,
  /\b(reset\s+to\s+factory\s+defaults?|factory\s+reset)\b/iu,
  /(?:^|[;&|]\s*)(?:&\s*)?(?:diskpart|bcdedit|format(?:\.com)?)\b/iu,
  /\bdocker(?:\.exe)?\b[^\r\n;&|]{0,240}\bsystem\s+prune\b/iu,
  /\brm\b[^\r\n;&|]{0,160}\s-rf\s+(?:\/|~)(?:\s|$)/iu,
  /\bremove-item\b(?=[^\r\n;&|]{0,240}\s-recurse(?:\s|$))(?=[^\r\n;&|]{0,240}\s-force(?:\s|$))[^\r\n;&|]{0,240}["']?(?:[a-z]:\\|\\\\|\/)["']?(?:\s|$)/iu,
];

const DESTRUCTIVE_PATTERNS = [
  /\b(remove-item|rm|del|erase|rd|rmdir|unlink|shred)\b/iu,
  /\bgit(?:\.exe)?\b[^\r\n;&|]{0,240}\b(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)\b/iu,
  /\bdocker(?:\.exe)?\b[^\r\n;&|]{0,240}\b(rm|rmi|volume\s+prune|image\s+prune|container\s+prune)\b/iu,
];

const EXTERNAL_MUTATION_PATTERNS = [
  /\bgit(?:\.exe)?\b[^\r\n;&|]{0,240}\bpush\b/iu,
  /\b(npm|pnpm|yarn|bun)\b[^\r\n;&|]{0,240}\bpublish\b/iu,
  /\b(docker|kubectl|helm|terraform)\b[^\r\n;&|]{0,240}\b(push|apply|deploy|destroy)\b/iu,
  /\b(curl|wget|invoke-webrequest|iwr)\b[^\r\n;&|]{0,240}(?:^|\s)(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/iu,
];

const LOCAL_MUTATION_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\b[^\r\n;&|]{0,240}\b(install|add|remove|update|audit\s+fix)\b/iu,
  /\b(git(?:\.exe)?)\b[^\r\n;&|]{0,240}\b(add|commit|checkout|switch|restore|rebase|merge|stash)\b/iu,
  /\b(copy-item|move-item|set-content|out-file|new-item|mkdir|md|copy|cp|move|mv|touch|tee|truncate)\b/iu,
  /\b(jest|vitest)\b[^\r\n;&|]{0,240}(?:^|\s)(?:--updatesnapshot|--update|-u)(?:\s|$)/iu,
  /\b(eslint|biome|prettier)\b[^\r\n;&|]{0,240}(?:^|\s)(?:--fix|--write)(?:\s|$)/iu,
  /(?:^|\s)(?:\d?>{1,2})\s*(?!&\d)(?=\S)/u,
];

const REPEATABLE_LOCAL_PATTERNS = [
  /\b(npm|pnpm|yarn|bun)\b[^\r\n;&|]{0,240}\b(run\s+)?(test(?::[\w.-]+)?|build(?::[\w.-]+)?|lint(?::[\w.-]+)?|typecheck(?::[\w.-]+)?|check(?::[\w.-]+)?)\b/iu,
  /\b(jest|vitest|mocha|ava|tap|cypress\s+run|playwright\s+test)\b/iu,
  /\b(eslint|biome)\b(?![^\r\n;&|]{0,160}(?:^|\s)(?:--fix|--write)(?:\s|$))/iu,
  /\bprettier\b[^\r\n;&|]{0,160}(?:^|\s)--check(?:\s|$)/iu,
  /\b(tsc|vue-tsc)\b/iu,
  /\b(vite\s+build|webpack|next\s+build|turbo\s+run|nx\s+(test|build|lint))\b/iu,
  /\bdotnet\b[^\r\n;&|]{0,240}\b(test|build)\b/iu,
  /\b(go\s+test|cargo\s+(test|check|build))\b/iu,
  /\bnode(?:\.exe)?\b[^\r\n;&|]{0,320}\b(jest|vitest|mocha|eslint|tsc)\b/iu,
];

const PURE_READ_EXECUTABLES = new Set([
  "cat",
  "echo",
  "find",
  "get-childitem",
  "get-content",
  "git",
  "grep",
  "head",
  "ls",
  "node",
  "npm",
  "pnpm",
  "pwd",
  "rg",
  "tail",
  "test-path",
  "type",
  "where",
  "which",
  "yarn",
]);

export function classifyCommandExecution(
  shell: ShellName,
  execution: CommandPlanExecution,
): CommandClassification {
  const command = executionToCommand(execution);
  const normalized = normalize(command);
  const reasons: string[] = [];

  if (matchesAny(normalized, FORBIDDEN_PATTERNS)) {
    return {
      effectClass: "destructive",
      riskClass: "forbidden",
      reasons: ["command matches a permanently forbidden destructive operation"],
    };
  }

  let effectClass: CommandClassification["effectClass"];
  if (matchesAny(normalized, DESTRUCTIVE_PATTERNS)) {
    effectClass = "destructive";
    reasons.push("command can remove or irreversibly discard local state");
  } else if (matchesAny(normalized, EXTERNAL_MUTATION_PATTERNS)) {
    effectClass = "external_mutation";
    reasons.push("command can mutate an external system or remote repository");
  } else if (matchesAny(normalized, LOCAL_MUTATION_PATTERNS)) {
    effectClass = "local_mutation";
    reasons.push("command can mutate workspace or machine-local state");
  } else if (matchesAny(normalized, REPEATABLE_LOCAL_PATTERNS)) {
    effectClass = "repeatable_local";
    reasons.push("command is a deterministic build, test, lint or typecheck operation");
  } else if (isPureRead(execution, normalized)) {
    effectClass = "pure_read";
    reasons.push("command is limited to read-only inspection");
  } else {
    effectClass = "unknown";
    reasons.push("command effect could not be classified deterministically");
  }

  const directRisk = classifyCommandRisk(shell, command);
  reasons.push(...directRisk.reasons);

  const riskClass = classifyRisk(effectClass, directRisk.destructive);
  return {
    effectClass,
    riskClass,
    reasons: [...new Set(reasons)],
  };
}

function classifyRisk(
  effectClass: CommandClassification["effectClass"],
  directRisk: boolean,
): CommandRiskClass {
  if (directRisk) return "confirmation_required";
  switch (effectClass) {
    case "pure_read":
    case "repeatable_local":
      return "safe";
    case "local_mutation":
    case "external_mutation":
    case "destructive":
      return "confirmation_required";
    case "unknown":
      return "unknown";
  }
}

function isPureRead(
  execution: CommandPlanExecution,
  normalized: string,
): boolean {
  const executable =
    execution.kind === "argv"
      ? path.basename(execution.executable).replace(/\.(?:exe|cmd)$/iu, "").toLowerCase()
      : firstExecutable(normalized);
  if (!PURE_READ_EXECUTABLES.has(executable)) return false;

  if (executable === "git") {
    return /\bgit(?:\.exe)?\b[^\r\n;&|]{0,240}\b(status|diff|log|show|rev-parse|branch\s+--show-current|remote\s+-v)\b/iu.test(
      normalized,
    );
  }
  if (executable === "npm" || executable === "pnpm" || executable === "yarn") {
    return /(?:^|\s)(?:--version|-v|view|list|ls|why|config\s+get)(?:\s|$)/iu.test(
      normalized,
    );
  }
  if (executable === "node") {
    return /(?:^|\s)(?:--version|-v|--help|-h)(?:\s|$)/iu.test(normalized);
  }
  return true;
}

function executionToCommand(execution: CommandPlanExecution): string {
  if (execution.kind === "script") return execution.script;
  return [execution.executable, ...execution.argv].map(quoteForClassification).join(" ");
}

function quoteForClassification(value: string): string {
  return /\s/u.test(value) ? JSON.stringify(value) : value;
}

function normalize(value: string): string {
  return value.replace(/`[\r\n]/gu, " ").replace(/\s+/gu, " ").trim();
}

function firstExecutable(value: string): string {
  const first = value.match(/^\s*(?:&\s*)?["']?([^\s"']+)/u)?.[1] ?? "";
  return path.basename(first).replace(/\.(?:exe|cmd)$/iu, "").toLowerCase();
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}
