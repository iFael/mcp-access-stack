import {
  AppError,
  type RunWorkspaceValidationResult,
  type WorkspaceValidationFinding,
  type WorkspaceValidationScope,
} from "@vs-code-gpt/shared";
import {
  executeProcess,
  readToolVersion,
  sanitizeToolError,
} from "./process-runner.js";

export interface ValidationDiffCheckGitContext {
  repositoryRoot: string;
  rootPrefix: string;
}

export interface ValidationDiffCheckTarget {
  relativePath: string;
}

export interface ValidationDiffCheckOptions {
  context: ValidationDiffCheckGitContext;
  scope: WorkspaceValidationScope;
  targets: ValidationDiffCheckTarget[];
  maxFindings: number;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

export interface ValidationDiffCheckPayload {
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

export async function runDiffCheckValidation(
  options: ValidationDiffCheckOptions,
): Promise<ValidationDiffCheckPayload> {
  const pathspecs = options.scope === "paths"
    ? options.targets.map((target) =>
        toValidationRepositoryPath(
          options.context.rootPrefix,
          target.relativePath,
        ),
      )
    : [options.context.rootPrefix];
  const relativeArg = options.context.rootPrefix === "."
    ? "--relative"
    : `--relative=${options.context.rootPrefix}`;

  const [unstaged, staged, version] = await Promise.all([
    executeProcess(
      "git",
      ["diff", relativeArg, "--check", "--", ...pathspecs],
      options.context.repositoryRoot,
      options.timeoutMs,
      options.signal,
    ),
    executeProcess(
      "git",
      ["diff", relativeArg, "--cached", "--check", "--", ...pathspecs],
      options.context.repositoryRoot,
      options.timeoutMs,
      options.signal,
    ),
    readToolVersion(
      "git",
      ["--version"],
      options.context.repositoryRoot,
      options.signal,
    ),
  ]);

  if (unstaged.timedOut || staged.timedOut) {
    throw new AppError("AGENT_TIMEOUT", "git diff --check timed out.");
  }

  const findings = [
    ...parseDiffCheckFindings(unstaged.stdout, "unstaged"),
    ...parseDiffCheckFindings(staged.stdout, "staged"),
  ];
  const issues: string[] = [];
  if (unstaged.exitCode !== 0 && unstaged.stdout.trim().length === 0) {
    issues.push(
      sanitizeToolError(
        unstaged.stderr,
        "Unstaged Git whitespace check failed.",
      ),
    );
  }
  if (staged.exitCode !== 0 && staged.stdout.trim().length === 0) {
    issues.push(
      sanitizeToolError(staged.stderr, "Staged Git whitespace check failed."),
    );
  }

  const limited = limitFindings(findings, options.maxFindings);
  return {
    executed: true,
    passed: findings.length === 0 && issues.length === 0,
    tool: makeTool("git", true, version),
    filesScanned: options.targets.length,
    findings: limited.findings,
    findingsCount: findings.length,
    truncated: limited.truncated,
    issues,
    warnings: [
      ...(unstaged.outputTruncated || staged.outputTruncated
        ? ["Git validation output reached the configured process output limit."]
        : []),
      ...(options.scope === "changes"
        ? ["git diff --check does not inspect untracked file contents."]
        : []),
    ],
  };
}

function toValidationRepositoryPath(
  rootPrefix: string,
  relativePath: string,
): string {
  if (relativePath === ".") return rootPrefix;
  return rootPrefix === "." ? relativePath : `${rootPrefix}/${relativePath}`;
}

function parseDiffCheckFindings(
  output: string,
  stage: "staged" | "unstaged",
): WorkspaceValidationFinding[] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^(.+?):(\d+):\s*(.+)$/.exec(line);
      return {
        ruleId: `git-diff-check-${stage}`,
        severity: "error" as const,
        message: match?.[3] ?? line,
        path: match?.[1] ?? ".",
        ...(match?.[2] === undefined
          ? {}
          : { line: Number.parseInt(match[2], 10) }),
        source: "git" as const,
      };
    });
}

function makeTool(
  name: string,
  available: boolean,
  version?: string,
): RunWorkspaceValidationResult["tool"] {
  return {
    name,
    available,
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
