import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  QUICK_OPERATION_TIMEOUT_MS,
  type RunWorkspaceValidationInput,
  type RunWorkspaceValidationResult,
  type WorkspaceValidationFinding,
  type WorkspaceValidationName,
  type WorkspaceValidationScope,
} from "@vs-code-gpt/shared";
import type { ResolvedWorkspace } from "../internal-types.js";
import {
  isContained,
  normalizeRelativePath,
  PathSecurity,
} from "../path-security.js";
import { runDiffCheckValidation } from "./diff-check.js";
import {
  isLegacyFormatCandidate,
  runLegacyFormatValidation,
} from "./legacy-format.js";
import {
  isLegacyCompatCandidate,
  resolveLegacyCompatTool,
  runLegacyCompatValidation,
} from "./legacy-compat.js";
import {
  resolveSecretScanTool,
  runSecretScanValidation,
} from "./secret-scan.js";
import {
  executeProcess,
  throwIfAborted,
} from "./process-runner.js";

const PROJECT_ROOT = resolveProjectRoot();
const MAX_VALIDATION_FILES = 2_000;
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".runtime-private",
  ".runtime-tools",
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "releases",
  "runtime",
  "vendor",
]);

function resolveProjectRoot(): string {
  const executablePath = process.argv[1]?.trim();
  const candidates = [
    process.env.VS_CODE_GPT_STACK_ROOT?.trim(),
    process.cwd(),
    executablePath
      ? path.resolve(path.dirname(executablePath), "../../..")
      : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (
      existsSync(path.join(resolved, "package.json")) &&
      existsSync(path.join(resolved, "config", "validation", "ast-grep", "sgconfig.yml"))
    ) {
      return resolved;
    }
  }
  return path.resolve(candidates[0] ?? process.cwd());
}
interface NormalizedValidationInput {
  workspaceId: string;
  root: string;
  validation: WorkspaceValidationName;
  scope: WorkspaceValidationScope;
  paths: string[];
  maxFindings: number;
  timeoutMs: number;
}

interface AuthorizedRoot {
  logicalPath: string;
  canonicalPath: string;
}

interface ValidationGitContext {
  repositoryRoot: string;
  rootPrefix: string;
}

interface ValidationTarget {
  logicalPath: string;
  relativePath: string;
  canonicalPath: string;
  kind: "file" | "directory";
}

interface ValidationFile {
  logicalPath: string;
  relativePath: string;
  canonicalPath: string;
}

interface ValidationPayload {
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

export class ValidationService {
  async run(
    workspace: ResolvedWorkspace,
    input: RunWorkspaceValidationInput,
    signal?: AbortSignal,
  ): Promise<RunWorkspaceValidationResult> {
    const startedAt = performance.now();
    const normalized = normalizeInput(input);
    const security = new PathSecurity(workspace);
    const rootPath = await security.authorizeExisting(
      normalized.root,
      "directory",
      true,
    );
    const root: AuthorizedRoot = {
      logicalPath: rootPath.logicalPath,
      canonicalPath: rootPath.canonicalPath,
    };
    const warnings: string[] = [];
    const targets = await resolveTargets(
      security,
      root,
      normalized,
      signal,
      warnings,
    );

    let payload: ValidationPayload;
    switch (normalized.validation) {
      case "diff-check": {
        const context = await resolveValidationGitContext(
          root.canonicalPath,
          normalized.timeoutMs,
          signal,
        );
        payload = await runDiffCheckValidation({
          context,
          scope: normalized.scope,
          targets,
          maxFindings: normalized.maxFindings,
          timeoutMs: normalized.timeoutMs,
          signal,
        });
        break;
      }
      case "legacy-format":
        payload = await runLegacyFormat(
          workspace,
          security,
          root,
          normalized,
          targets,
          signal,
        );
        break;
      case "legacy-compat":
        payload = await runLegacyCompat(
          workspace,
          security,
          root,
          normalized,
          targets,
          signal,
        );
        break;
      case "secret-scan":
        payload = await runSecretScan(
          workspace,
          security,
          root,
          normalized,
          targets,
          signal,
        );
        break;
    }

    return {
      workspaceId: workspace.id,
      root: root.logicalPath,
      validation: normalized.validation,
      scope: normalized.scope,
      executed: payload.executed,
      passed: payload.passed,
      tool: payload.tool,
      filesScanned: payload.filesScanned,
      findings: payload.findings,
      findingsCount: payload.findingsCount,
      truncated: payload.truncated,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      issues: payload.issues,
      warnings: [...warnings, ...payload.warnings],
    };
  }
}

function normalizeInput(input: RunWorkspaceValidationInput): NormalizedValidationInput {
  return {
    workspaceId: input.workspaceId,
    root: input.root ?? ".",
    validation: input.validation,
    scope: input.scope ?? "changes",
    paths: input.paths ?? [],
    maxFindings: input.maxFindings ?? 100,
    timeoutMs: input.timeoutMs ?? QUICK_OPERATION_TIMEOUT_MS,
  };
}

async function resolveTargets(
  security: PathSecurity,
  root: AuthorizedRoot,
  input: NormalizedValidationInput,
  signal: AbortSignal | undefined,
  warnings: string[],
): Promise<ValidationTarget[]> {
  throwIfAborted(signal);
  if (input.scope === "repository") {
    return [
      {
        logicalPath: root.logicalPath,
        relativePath: ".",
        canonicalPath: root.canonicalPath,
        kind: "directory",
      },
    ];
  }

  const requestedPaths =
    input.scope === "changes"
      ? await readChangedPaths(root.canonicalPath, input.timeoutMs, signal)
      : input.paths;
  if (requestedPaths.length === 0) {
    return [];
  }

  const targets = new Map<string, ValidationTarget>();
  for (const requestedPath of requestedPaths) {
    throwIfAborted(signal);
    const relativePath = normalizeRelativePath(requestedPath, { allowDot: true });
    const logicalPath = joinLogicalPath(root.logicalPath, relativePath);
    try {
      const authorized = await security.authorizeExisting(
        logicalPath,
        undefined,
        true,
      );
      if (!isContained(root.canonicalPath, authorized.canonicalPath)) {
        throw new AppError(
          "PATH_OUTSIDE_ALLOWED_ROOTS",
          "Validation path is outside the selected validation root.",
        );
      }
      targets.set(authorized.canonicalPath, {
        logicalPath: authorized.logicalPath,
        relativePath: toPortableRelative(root.canonicalPath, authorized.canonicalPath),
        canonicalPath: authorized.canonicalPath,
        kind: authorized.kind,
      });
    } catch (error) {
      if (
        input.scope === "changes" &&
        error instanceof AppError &&
        error.code === "FILE_NOT_FOUND"
      ) {
        warnings.push(`Changed path no longer exists and was skipped: ${relativePath}`);
        continue;
      }
      throw error;
    }
  }
  return [...targets.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
}

async function resolveValidationGitContext(
  rootPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ValidationGitContext> {
  const topLevel = await executeProcess(
    "git",
    ["rev-parse", "--show-toplevel"],
    rootPath,
    timeoutMs,
    signal,
  );
  if (topLevel.timedOut) {
    throw new AppError("AGENT_TIMEOUT", "Git root discovery timed out during validation.");
  }
  if (topLevel.exitCode !== 0 || topLevel.stdout.trim().length === 0) {
    throw new AppError("NOT_GIT_REPOSITORY", "Validation root is not a Git repository.");
  }

  const repositoryRoot = path.resolve(topLevel.stdout.trim());
  if (!isContained(repositoryRoot, rootPath)) {
    throw new AppError(
      "NOT_GIT_REPOSITORY",
      "Validation root is outside the resolved Git worktree.",
    );
  }
  return {
    repositoryRoot,
    rootPrefix: toPortableRelative(repositoryRoot, rootPath),
  };
}

async function readChangedPaths(
  rootPath: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const context = await resolveValidationGitContext(rootPath, timeoutMs, signal);
  const result = await executeProcess(
    "git",
    [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      context.rootPrefix,
    ],
    context.repositoryRoot,
    timeoutMs,
    signal,
  );
  if (result.timedOut) {
    throw new AppError("AGENT_TIMEOUT", "Git status timed out during validation.");
  }
  if (result.exitCode !== 0) {
    throw new AppError("NOT_GIT_REPOSITORY", "Validation root is not a Git repository.");
  }

  const tokens = result.stdout.split(String.fromCharCode(0));
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const status = token.slice(0, 2);
    const repositoryPath = token.slice(3);
    const relativePath = relativizeChangedPath(repositoryPath, context.rootPrefix);
    if (relativePath) paths.push(relativePath);
    if (status.includes("R") || status.includes("C")) {
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function relativizeChangedPath(
  repositoryPath: string,
  rootPrefix: string,
): string | undefined {
  const normalizedPath = normalizeOutputPath(repositoryPath);
  if (rootPrefix === ".") return normalizedPath;
  const normalizedPrefix = normalizeOutputPath(rootPrefix);
  const prefix = `${normalizedPrefix}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : undefined;
}

async function runLegacyFormat(
  workspace: ResolvedWorkspace,
  security: PathSecurity,
  root: AuthorizedRoot,
  input: NormalizedValidationInput,
  targets: ValidationTarget[],
  signal?: AbortSignal,
): Promise<ValidationPayload> {
  const expansion = await expandValidationFiles(
    workspace,
    security,
    root,
    targets,
    isLegacyFormatCandidate,
    signal,
  );
  const warnings = [...expansion.warnings];
  const files = await filterFilesBySize(
    expansion.files,
    workspace.limits.maxFileBytes,
    warnings,
  );
  const payload = await runLegacyFormatValidation({
    files,
    maxFindings: input.maxFindings,
    ...(signal === undefined ? {} : { signal }),
  });

  return {
    ...payload,
    warnings: [...warnings, ...payload.warnings],
  };
}

async function runLegacyCompat(
  workspace: ResolvedWorkspace,
  security: PathSecurity,
  root: AuthorizedRoot,
  input: NormalizedValidationInput,
  targets: ValidationTarget[],
  signal?: AbortSignal,
): Promise<ValidationPayload> {
  const tool = resolveLegacyCompatTool(PROJECT_ROOT);
  if (!tool) {
    return unavailablePayload(
      "ast-grep",
      "ast-grep is not installed in the local-agent dependencies.",
    );
  }

  const expansion = await expandValidationFiles(
    workspace,
    security,
    root,
    targets,
    isLegacyCompatCandidate,
    signal,
  );
  const files = await filterFilesBySize(
    expansion.files,
    workspace.limits.maxFileBytes,
    expansion.warnings,
  );
  const payload = await runLegacyCompatValidation({
    tool,
    files,
    cwd: root.canonicalPath,
    maxFindings: input.maxFindings,
    timeoutMs: input.timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });

  return {
    ...payload,
    warnings: [...expansion.warnings, ...payload.warnings],
  };
}

async function runSecretScan(
  workspace: ResolvedWorkspace,
  security: PathSecurity,
  root: AuthorizedRoot,
  input: NormalizedValidationInput,
  targets: ValidationTarget[],
  signal?: AbortSignal,
): Promise<ValidationPayload> {
  const tool = await resolveSecretScanTool(
    PROJECT_ROOT,
    root.canonicalPath,
    signal,
  );
  if (!tool) {
    return unavailablePayload(
      "gitleaks",
      "Gitleaks is not installed. Run npm run validation:tools:init on the host.",
    );
  }

  const expansion = await expandValidationFiles(
    workspace,
    security,
    root,
    targets,
    () => true,
    signal,
  );
  const files = await filterFilesBySize(
    expansion.files,
    workspace.limits.maxFileBytes,
    expansion.warnings,
  );
  const payload = await runSecretScanValidation({
    tool,
    files,
    scope: input.scope,
    maxFindings: input.maxFindings,
    timeoutMs: input.timeoutMs,
    ...(signal === undefined ? {} : { signal }),
  });

  return {
    ...payload,
    warnings: [...expansion.warnings, ...payload.warnings],
  };
}

async function filterFilesBySize(
  files: ValidationFile[],
  maxFileBytes: number,
  warnings: string[],
): Promise<ValidationFile[]> {
  const accepted: ValidationFile[] = [];
  for (const file of files) {
    const fileStat = await stat(file.canonicalPath);
    if (fileStat.size > maxFileBytes) {
      warnings.push(
        `File exceeds the workspace read limit and was skipped: ${file.relativePath}`,
      );
      continue;
    }
    accepted.push(file);
  }
  return accepted;
}

async function expandValidationFiles(
  workspace: ResolvedWorkspace,
  security: PathSecurity,
  root: AuthorizedRoot,
  targets: ValidationTarget[],
  include: (relativePath: string) => boolean,
  signal?: AbortSignal,
): Promise<{ files: ValidationFile[]; warnings: string[] }> {
  const files = new Map<string, ValidationFile>();
  const warnings: string[] = [];

  const addFile = (logicalPath: string, canonicalPath: string): boolean => {
    const relativePath = toPortableRelative(root.canonicalPath, canonicalPath);
    if (!include(relativePath)) return true;
    if (files.has(canonicalPath)) return true;
    if (files.size >= Math.min(workspace.limits.maxListedFiles, MAX_VALIDATION_FILES)) {
      warnings.push("Validation file discovery reached its configured limit.");
      return false;
    }
    files.set(canonicalPath, { logicalPath, relativePath, canonicalPath });
    return true;
  };

  const walk = async (directory: ValidationTarget): Promise<boolean> => {
    throwIfAborted(signal);
    const entries = await readdir(directory.canonicalPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.isSymbolicLink()) continue;
      if (
        entry.isDirectory() &&
        SKIPPED_DIRECTORIES.has(entry.name.toLocaleLowerCase("en-US"))
      ) {
        continue;
      }
      const logicalPath = joinLogicalPath(directory.logicalPath, entry.name);
      try {
        security.authorizeLogical(logicalPath);
      } catch (error) {
        if (
          error instanceof AppError &&
          ["BLOCKED_PATH", "PATH_OUTSIDE_ALLOWED_ROOTS"].includes(error.code)
        ) {
          continue;
        }
        throw error;
      }
      const absolutePath = path.join(directory.canonicalPath, entry.name);
      if (!isContained(root.canonicalPath, absolutePath)) continue;
      if (entry.isDirectory()) {
        const shouldContinue = await walk({
          logicalPath,
          relativePath: toPortableRelative(root.canonicalPath, absolutePath),
          canonicalPath: absolutePath,
          kind: "directory",
        });
        if (!shouldContinue) return false;
      } else if (entry.isFile() && !addFile(logicalPath, absolutePath)) {
        return false;
      }
    }
    return true;
  };

  for (const target of targets) {
    throwIfAborted(signal);
    if (target.kind === "file") {
      if (!addFile(target.logicalPath, target.canonicalPath)) break;
    } else if (!(await walk(target))) {
      break;
    }
  }

  return {
    files: [...files.values()].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    ),
    warnings: [...new Set(warnings)],
  };
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

function unavailablePayload(name: string, issue: string): ValidationPayload {
  return {
    executed: false,
    passed: false,
    tool: makeTool(name, false),
    filesScanned: 0,
    findings: [],
    findingsCount: 0,
    truncated: false,
    issues: [issue],
    warnings: [],
  };
}

function joinLogicalPath(root: string, relativePath: string): string {
  if (relativePath === ".") return root;
  return root === "." ? relativePath : `${root.replace(/\/$/, "")}/${relativePath}`;
}

function toPortableRelative(rootPath: string, targetPath: string): string {
  const relative = path.relative(rootPath, targetPath).split(path.sep).join("/");
  return relative || ".";
}

function normalizeOutputPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "") || ".";
}
