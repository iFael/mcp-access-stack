import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AppError,
  type RunWorkspaceValidationResult,
  type WorkspaceValidationFinding,
  type WorkspaceValidationScope,
} from "@vs-code-gpt/shared";
import { isContained } from "../path-security.js";
import {
  executeProcess,
  isExecutableNotFound,
  readToolVersion,
  sanitizeToolError,
  throwIfAborted,
} from "./process-runner.js";
import {
  decodeForInspection,
  detectTextFormat,
} from "./text-format.js";

const GITLEAKS_VERSION = "8.30.1";
const LEGACY_STATUS_LABEL_FALSE_POSITIVE = {
  ruleId: "generic-api-key",
  path: "Financeiro/FIN_conc_fila.js",
  linePattern:
    /^\s*if\s*\(\s*Key\s*==\s*"CANDIDATO"\s*\|\|\s*Key\s*==\s*"D1_COMPATIVEL"\s*\)\s*\{\s*return\s*"Localizado sem confirmação";\s*\}\s*$/,
} as const;

export interface SecretScanFile {
  relativePath: string;
  canonicalPath: string;
}

export interface SecretScanTool {
  command: string;
  version?: string;
}

export interface SecretScanValidationInput {
  tool: SecretScanTool;
  files: SecretScanFile[];
  scope: WorkspaceValidationScope;
  maxFindings: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface SecretScanValidationPayload {
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

export interface GitleaksFinding {
  Description?: unknown;
  StartLine?: unknown;
  StartColumn?: unknown;
  File?: unknown;
  RuleID?: unknown;
  Fingerprint?: unknown;
}

export async function resolveSecretScanTool(
  projectRoot: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<SecretScanTool | undefined> {
  const localBinary = path.join(
    projectRoot,
    ".runtime-tools",
    "gitleaks",
    GITLEAKS_VERSION,
    process.platform === "win32" ? "gitleaks.exe" : "gitleaks",
  );
  const explicit = process.env.GITLEAKS_PATH?.trim();
  const candidates = explicit
    ? [explicit]
    : [localBinary, process.platform === "win32" ? "gitleaks.exe" : "gitleaks"];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && !(await isFile(candidate))) continue;
    try {
      const version = await readToolVersion(candidate, ["version"], cwd, signal);
      return {
        command: candidate,
        ...(version === undefined ? {} : { version }),
      };
    } catch (error) {
      if (isExecutableNotFound(error)) continue;
    }
  }
  return undefined;
}

export async function runSecretScanValidation(
  input: SecretScanValidationInput,
): Promise<SecretScanValidationPayload> {
  if (input.files.length === 0) {
    return {
      executed: true,
      passed: true,
      tool: makeTool(input.tool.version),
      filesScanned: 0,
      findings: [],
      findingsCount: 0,
      truncated: false,
      issues: [],
      warnings: [],
    };
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-gitleaks-"));
  const sourceDirectory = path.join(temporaryDirectory, "source");
  const reportPath = path.join(temporaryDirectory, "report.json");
  const findings: WorkspaceValidationFinding[] = [];
  const issues: string[] = [];
  let outputTruncated = false;
  let suppressedFindings = 0;

  try {
    await stageAuthorizedFiles(input.files, sourceDirectory, input.signal);
    const result = await executeProcess(
      input.tool.command,
      [
        "dir",
        "--no-banner",
        "--no-color",
        "--redact=100",
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        "--exit-code",
        "1",
        ".",
      ],
      sourceDirectory,
      input.timeoutMs,
      input.signal,
    );

    if (result.timedOut) {
      throw new AppError("AGENT_TIMEOUT", "Gitleaks validation timed out.");
    }
    outputTruncated = result.outputTruncated;

    if (![0, 1].includes(result.exitCode ?? -1)) {
      issues.push(sanitizeToolError(result.stderr, "Gitleaks validation failed."));
    } else if (await isFile(reportPath)) {
      const report = await readGitleaksReport(reportPath, issues);
      if (report) {
        const filtered = await filterKnownGitleaksFalsePositives(
          report,
          sourceDirectory,
        );
        suppressedFindings = filtered.suppressedCount;
        findings.push(
          ...filtered.findings.map((finding) =>
            mapGitleaksFinding(finding, sourceDirectory),
          ),
        );
      }
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  const deduplicated = deduplicateFindings(findings);
  const limited = limitFindings(deduplicated, input.maxFindings);
  return {
    executed: true,
    passed: deduplicated.length === 0 && issues.length === 0,
    tool: makeTool(input.tool.version),
    filesScanned: input.files.length,
    findings: limited.findings,
    findingsCount: deduplicated.length,
    truncated: limited.truncated,
    issues,
    warnings: [
      ...(outputTruncated
        ? ["Gitleaks output reached the configured process output limit."]
        : []),
      ...repositoryScopeWarnings(input.scope),
      ...(suppressedFindings > 0
        ? [
            `Suppressed ${suppressedFindings} known LegacySite status-label false positive(s).`,
          ]
        : []),
    ],
  };
}

export async function filterKnownGitleaksFalsePositives(
  findings: GitleaksFinding[],
  scanRoot: string,
): Promise<{ findings: GitleaksFinding[]; suppressedCount: number }> {
  const retained: GitleaksFinding[] = [];
  const lineCache = new Map<string, string[]>();
  let suppressedCount = 0;

  for (const finding of findings) {
    const ruleId = stringOrFallback(finding.RuleID, "");
    const rawPath = stringOrFallback(finding.File, ".");
    const normalizedPath = path.isAbsolute(rawPath)
      ? toPortableRelative(scanRoot, rawPath)
      : normalizeOutputPath(rawPath);
    const lineNumber = numberOrUndefined(finding.StartLine);

    if (
      ruleId !== LEGACY_STATUS_LABEL_FALSE_POSITIVE.ruleId ||
      normalizedPath.toLocaleLowerCase("en-US") !==
        LEGACY_STATUS_LABEL_FALSE_POSITIVE.path.toLocaleLowerCase("en-US") ||
      lineNumber === undefined ||
      lineNumber <= 0
    ) {
      retained.push(finding);
      continue;
    }

    const absolutePath = path.resolve(
      scanRoot,
      ...normalizedPath.split("/").filter(Boolean),
    );
    if (!isContained(scanRoot, absolutePath)) {
      retained.push(finding);
      continue;
    }

    let lines = lineCache.get(absolutePath);
    if (!lines) {
      try {
        const buffer = await readFile(absolutePath);
        const format = detectTextFormat(buffer);
        const text = decodeForInspection(
          buffer,
          format.encoding,
          format.bomBytes,
        );
        lines = text.split(/\r\n|\n|\r/);
        lineCache.set(absolutePath, lines);
      } catch {
        retained.push(finding);
        continue;
      }
    }

    const sourceLine = lines[lineNumber - 1];
    if (
      sourceLine !== undefined &&
      LEGACY_STATUS_LABEL_FALSE_POSITIVE.linePattern.test(sourceLine)
    ) {
      suppressedCount += 1;
      continue;
    }
    retained.push(finding);
  }

  return { findings: retained, suppressedCount };
}

export function mapGitleaksFinding(
  finding: GitleaksFinding,
  scanRoot: string,
): WorkspaceValidationFinding {
  const rawPath = stringOrFallback(finding.File, ".");
  const normalizedPath = path.isAbsolute(rawPath)
    ? toPortableRelative(scanRoot, rawPath)
    : normalizeOutputPath(rawPath);
  const line = numberOrUndefined(finding.StartLine);
  const column = numberOrUndefined(finding.StartColumn);
  const fingerprint =
    typeof finding.Fingerprint === "string" && finding.Fingerprint.trim()
      ? `sha256:${createHash("sha256")
          .update(finding.Fingerprint.trim())
          .digest("hex")}`
      : undefined;

  return {
    ruleId: stringOrFallback(finding.RuleID, "gitleaks-secret"),
    severity: "error",
    message: stringOrFallback(finding.Description, "Potential secret detected."),
    path: normalizedPath,
    ...(line === undefined || line <= 0 ? {} : { line }),
    ...(column === undefined || column <= 0 ? {} : { column }),
    source: "gitleaks",
    ...(fingerprint === undefined ? {} : { fingerprint }),
  };
}

export function deduplicateFindings(
  findings: WorkspaceValidationFinding[],
): WorkspaceValidationFinding[] {
  const unique = new Map<string, WorkspaceValidationFinding>();
  for (const finding of findings) {
    const key = [
      finding.ruleId,
      finding.path,
      finding.line ?? "",
      finding.column ?? "",
      finding.fingerprint ?? "",
    ].join("|");
    unique.set(key, finding);
  }
  return [...unique.values()];
}

async function readGitleaksReport(
  reportPath: string,
  issues: string[],
): Promise<GitleaksFinding[] | undefined> {
  try {
    const report = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
    if (!Array.isArray(report)) throw new Error("Report must be an array");
    return report as GitleaksFinding[];
  } catch {
    issues.push("Gitleaks returned an invalid JSON report.");
    return undefined;
  }
}

async function stageAuthorizedFiles(
  files: SecretScanFile[],
  targetRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const file of files) {
    throwIfAborted(signal);
    const destination = path.join(targetRoot, ...file.relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(file.canonicalPath, destination);
  }
}

function repositoryScopeWarnings(scope: WorkspaceValidationScope): string[] {
  return scope === "repository"
    ? ["Repository scope scans current authorized files and does not inspect Git history."]
    : [];
}

function makeTool(version?: string): RunWorkspaceValidationResult["tool"] {
  return {
    name: "gitleaks",
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

function stringOrFallback(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim().slice(0, 1_000)
    : fallback;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toPortableRelative(rootPath: string, targetPath: string): string {
  const relative = path.relative(rootPath, targetPath).split(path.sep).join("/");
  return relative || ".";
}

function normalizeOutputPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "") || ".";
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
