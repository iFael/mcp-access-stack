import { existsSync } from "node:fs";
import path from "node:path";
import {
  AppError,
  type RunWorkspaceValidationResult,
  type WorkspaceValidationFinding,
} from "@vs-code-gpt/shared";
import {
  executeProcess,
  readToolVersion,
  sanitizeToolError,
  throwIfAborted,
} from "./process-runner.js";

const AST_GREP_BATCH_SIZE = 100;

export interface LegacyCompatFile {
  relativePath: string;
}

export interface LegacyCompatTool {
  command: string;
  configPath: string;
}

export interface LegacyCompatValidationInput {
  tool: LegacyCompatTool;
  files: LegacyCompatFile[];
  cwd: string;
  maxFindings: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface LegacyCompatValidationPayload {
  executed: boolean;
  passed: boolean;
  tool: RunWorkspaceValidationResult["tool"];
  filesScanned: number;
  findings: WorkspaceValidationFinding[];
  findingsCount: number;
  truncated: boolean;
  issues: string[];
  warnings: string[];
}

interface AstGrepMatch {
  file?: unknown;
  ruleId?: unknown;
  severity?: unknown;
  message?: unknown;
  range?: {
    start?: {
      line?: unknown;
      column?: unknown;
    };
  };
}

export function isLegacyCompatCandidate(relativePath: string): boolean {
  return relativePath.toLocaleLowerCase("en-US").endsWith(".js");
}

export function resolveLegacyCompatTool(
  projectRoot: string,
): LegacyCompatTool | undefined {
  const configPath = path.join(
    projectRoot,
    "config",
    "validation",
    "ast-grep",
    "sgconfig.yml",
  );
  const command = resolveAstGrepBinary(projectRoot);
  if (!existsSync(command) || !existsSync(configPath)) return undefined;
  return { command, configPath };
}

export async function runLegacyCompatValidation(
  input: LegacyCompatValidationInput,
): Promise<LegacyCompatValidationPayload> {
  const versionPromise = readToolVersion(
    input.tool.command,
    ["--version"],
    input.cwd,
    input.signal,
  );

  if (input.files.length === 0) {
    return {
      executed: true,
      passed: true,
      tool: makeTool(await versionPromise),
      filesScanned: 0,
      findings: [],
      findingsCount: 0,
      truncated: false,
      issues: [],
      warnings: [],
    };
  }

  const findings: WorkspaceValidationFinding[] = [];
  const issues: string[] = [];
  let outputTruncated = false;

  for (let offset = 0; offset < input.files.length; offset += AST_GREP_BATCH_SIZE) {
    throwIfAborted(input.signal);
    const batch = input.files.slice(offset, offset + AST_GREP_BATCH_SIZE);
    const result = await executeProcess(
      input.tool.command,
      [
        "scan",
        "--config",
        input.tool.configPath,
        "--json=compact",
        "--color",
        "never",
        ...batch.map((file) => file.relativePath),
      ],
      input.cwd,
      input.timeoutMs,
      input.signal,
    );

    if (result.timedOut) {
      throw new AppError("AGENT_TIMEOUT", "ast-grep validation timed out.");
    }

    outputTruncated ||= result.outputTruncated;
    if (![0, 1].includes(result.exitCode ?? -1)) {
      issues.push(sanitizeToolError(result.stderr, "ast-grep validation failed."));
      continue;
    }

    const parsed = parseAstGrepOutput(result.stdout);
    findings.push(...parsed.findings);
    issues.push(...parsed.issues);
  }

  const limited = limitFindings(findings, input.maxFindings);
  return {
    executed: true,
    passed: findings.length === 0 && issues.length === 0,
    tool: makeTool(await versionPromise),
    filesScanned: input.files.length,
    findings: limited.findings,
    findingsCount: findings.length,
    truncated: limited.truncated,
    issues,
    warnings: outputTruncated
      ? ["ast-grep output reached the configured process output limit."]
      : [],
  };
}

export function parseAstGrepOutput(
  output: string,
): { findings: WorkspaceValidationFinding[]; issues: string[] } {
  try {
    const matches = JSON.parse(output || "[]") as AstGrepMatch[];
    if (!Array.isArray(matches)) {
      return { findings: [], issues: ["ast-grep returned invalid JSON output."] };
    }
    return { findings: matches.map(mapAstGrepFinding), issues: [] };
  } catch {
    return { findings: [], issues: ["ast-grep returned invalid JSON output."] };
  }
}

export function mapAstGrepFinding(
  match: AstGrepMatch,
): WorkspaceValidationFinding {
  const line = numberOrUndefined(match.range?.start?.line);
  const column = numberOrUndefined(match.range?.start?.column);
  return {
    ruleId: stringOrFallback(match.ruleId, "legacy-compat-rule"),
    severity: normalizeSeverity(match.severity),
    message: stringOrFallback(match.message, "Legacy compatibility rule matched."),
    path: normalizeOutputPath(stringOrFallback(match.file, ".")),
    ...(line === undefined ? {} : { line: line + 1 }),
    ...(column === undefined ? {} : { column: column + 1 }),
    source: "ast-grep",
  };
}

function resolveAstGrepBinary(projectRoot: string): string {
  const executable = process.platform === "win32" ? "ast-grep.exe" : "ast-grep";
  const candidates = [
    path.join(projectRoot, "node_modules", "@ast-grep", "cli", executable),
    path.join(
      projectRoot,
      "node_modules",
      "@ast-grep",
      platformAstGrepPackage(),
      executable,
    ),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ??
    path.join(projectRoot, "node_modules", "@ast-grep", "cli", executable)
  );
}

function platformAstGrepPackage(): string {
  const key = `${process.platform}-${process.arch}`;
  const packages: Record<string, string> = {
    "win32-x64": "cli-win32-x64-msvc",
    "win32-arm64": "cli-win32-arm64-msvc",
    "linux-x64": "cli-linux-x64-gnu",
    "linux-arm64": "cli-linux-arm64-gnu",
    "darwin-x64": "cli-darwin-x64",
    "darwin-arm64": "cli-darwin-arm64",
  };
  return packages[key] ?? "cli";
}

function makeTool(version?: string): RunWorkspaceValidationResult["tool"] {
  return {
    name: "ast-grep",
    available: true,
    ...(version === undefined || version.length === 0 ? {} : { version }),
  };
}

function limitFindings(
  findings: WorkspaceValidationFinding[],
  maxFindings: number,
): { findings: WorkspaceValidationFinding[]; truncated: boolean } {
  return {
    findings: findings.slice(0, maxFindings),
    truncated: findings.length > maxFindings,
  };
}

function normalizeSeverity(
  value: unknown,
): WorkspaceValidationFinding["severity"] {
  return value === "warning" || value === "info" ? value : "error";
}

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 1_000)
    : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOutputPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "") || ".";
}
