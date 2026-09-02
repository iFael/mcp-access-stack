import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import { minimatch } from "minimatch";
import type {
  AuthorizedPath,
  AuthorizedWritePath,
  ResolvedAllowedRoot,
  ResolvedWorkspace,
} from "./internal-types.js";

const isWindows = process.platform === "win32";

function comparisonValue(value: string): string {
  return isWindows ? value.toLocaleLowerCase("en-US") : value;
}

export function isContained(basePath: string, targetPath: string): boolean {
  const relative = path.relative(basePath, targetPath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function logicalContains(basePath: string, targetPath: string): boolean {
  if (basePath === ".") {
    return true;
  }

  const base = comparisonValue(basePath);
  const target = comparisonValue(targetPath);
  return target === base || target.startsWith(`${base}/`);
}

export function normalizeRelativePath(
  input: string,
  options: { allowDot?: boolean } = {},
): string {
  if (input.length === 0 || input.includes("\0")) {
    throw new AppError("INVALID_PATH", "Path must be a non-empty relative path.");
  }

  if (
    path.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    path.posix.isAbsolute(input) ||
    input.startsWith("\\\\") ||
    /^[a-zA-Z]:/.test(input)
  ) {
    throw new AppError("INVALID_PATH", "Absolute paths are not allowed.");
  }

  const portable = input.replaceAll("\\", "/");
  if (portable.startsWith("//")) {
    throw new AppError("INVALID_PATH", "UNC paths are not allowed.");
  }

  const outputSegments: string[] = [];
  for (const segment of portable.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new AppError("INVALID_PATH", "Path traversal is not allowed.");
    }
    if (isWindows && (segment.includes(":") || /[. ]$/.test(segment))) {
      throw new AppError("INVALID_PATH", "Path contains an invalid Windows segment.");
    }
    outputSegments.push(segment);
  }

  if (outputSegments.length === 0) {
    if (options.allowDot) {
      return ".";
    }
    throw new AppError("INVALID_PATH", "Path must identify a file or directory.");
  }

  return outputSegments.join("/");
}

export function toNativeAbsolute(rootPath: string, relativePath: string): string {
  if (relativePath === ".") {
    return rootPath;
  }
  return path.resolve(rootPath, ...relativePath.split("/"));
}

function isRealEnvironmentFile(relativePath: string): boolean {
  const fileName = relativePath.split("/").at(-1) ?? "";
  const compared = comparisonValue(fileName);
  const templates = new Set(
    [".env.example", ".env.sample", ".env.template"].map(comparisonValue),
  );
  return (
    compared === comparisonValue(".env") ||
    (compared.startsWith(comparisonValue(".env.")) && !templates.has(compared))
  );
}
export class PathSecurity {
  constructor(private readonly workspace: ResolvedWorkspace) {}

  matchedBlockedPattern(relativePath: string): string | undefined {
    const candidate = relativePath === "." ? "" : relativePath;
    return this.workspace.blockedGlobs.find((pattern) =>
      minimatch(candidate, pattern, {
        dot: true,
        nocase: isWindows,
        matchBase: false,
      }),
    );
  }

  isBlocked(relativePath: string): boolean {
    return this.matchedBlockedPattern(relativePath) !== undefined;
  }

  isSubtreeBlocked(relativePath: string): boolean {
    const candidate = relativePath === "." ? "" : relativePath;
    return this.workspace.blockedGlobs.some((pattern) => {
      if (!pattern.endsWith("/**")) {
        return false;
      }
      const subtreeRootPattern = pattern.slice(0, -3);
      return minimatch(candidate, subtreeRootPattern, {
        dot: true,
        nocase: isWindows,
        matchBase: false,
      });
    });
  }
  authorizeLogical(input: string, allowDot = false, operation?: string): string {
    const logicalPath = normalizeRelativePath(input, { allowDot });
    const policyRule = this.matchedBlockedPattern(logicalPath);
    if (policyRule) {
      throw this.blockedPathError(logicalPath, policyRule, "Path is blocked by workspace policy.", operation);
    }
    if (!this.isWithinLogicalAllowedRoot(logicalPath)) {
      throw new AppError(
        "PATH_OUTSIDE_ALLOWED_ROOTS",
        "Path is outside the workspace allowed roots.",
      );
    }
    return logicalPath;
  }

  authorizeWriteLogical(input: string): string {
    const logicalPath = normalizeRelativePath(input);
    if (this.isBlocked(logicalPath)) {
      throw new AppError("BLOCKED_PATH", "Path is blocked by workspace policy.");
    }
    if (!this.isWithinLogicalAllowedRoot(logicalPath)) {
      throw new AppError(
        "PATH_OUTSIDE_ALLOWED_ROOTS",
        "Path is outside the workspace allowed roots.",
      );
    }
    if (!this.isAllowedWritePath(logicalPath)) {
      throw new AppError(
        "WRITE_NOT_ALLOWED",
        "Path is outside the workspace allowWrites policy.",
      );
    }
    return logicalPath;
  }

  async authorizeWriteTarget(input: string): Promise<AuthorizedWritePath> {
    const logicalPath = this.authorizeWriteLogical(input);
    const absolutePath = toNativeAbsolute(this.workspace.rootPath, logicalPath);

    let created = false;
    try {
      const existing = await stat(absolutePath);
      if (!existing.isFile()) {
        throw new AppError("NOT_A_FILE", "Requested path is not a file.");
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      created = true;
      this.assertCreatableAncestors(logicalPath);
    }

    const parentAbsolute = path.dirname(absolutePath);
    let parentCanonical: string;
    try {
      parentCanonical = await realpath(parentAbsolute);
    } catch (error) {
      if (!created) {
        throw new AppError("INVALID_PATH", "Unable to resolve parent directory.", {
          cause: error,
        });
      }
      return { logicalPath, absolutePath, created };
    }

    if (!isContained(this.workspace.canonicalRootPath, parentCanonical)) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Resolved parent path is outside the workspace.",
      );
    }

    if (!created) {
      const canonicalPath = await realpath(absolutePath);
      if (!isContained(this.workspace.canonicalRootPath, canonicalPath)) {
        throw new AppError(
          "PATH_OUTSIDE_WORKSPACE",
          "Resolved path is outside the workspace.",
        );
      }
    }

    return { logicalPath, absolutePath, created };
  }

  async authorizeExisting(
    input: string,
    expectedKind?: "file" | "directory",
    allowDot = false,
    operation?: string,
  ): Promise<AuthorizedPath> {
    return this.authorizeExistingInternal(input, expectedKind, allowDot, true, operation);
  }

  async authorizeExistingForSecretScan(
    input: string,
    expectedKind?: "file" | "directory",
    allowDot = false,
  ): Promise<AuthorizedPath> {
    return this.authorizeExistingInternal(input, expectedKind, allowDot, false);
  }

  private async authorizeExistingInternal(
    input: string,
    expectedKind: "file" | "directory" | undefined,
    allowDot: boolean,
    enforceBlockedPolicy: boolean,
    operation?: string,
  ): Promise<AuthorizedPath> {
    const logicalPath = enforceBlockedPolicy
      ? this.authorizeLogical(input, allowDot, operation)
      : normalizeRelativePath(input, { allowDot });
    if (!this.isWithinLogicalAllowedRoot(logicalPath)) {
      throw new AppError(
        "PATH_OUTSIDE_ALLOWED_ROOTS",
        "Path is outside the workspace allowed roots.",
      );
    }
    const absolutePath = toNativeAbsolute(this.workspace.rootPath, logicalPath);

    let canonicalPath: string;
    try {
      canonicalPath = await realpath(absolutePath);
    } catch (error) {
      throw new AppError("FILE_NOT_FOUND", "Requested path does not exist.", {
        cause: error,
      });
    }

    if (!isContained(this.workspace.canonicalRootPath, canonicalPath)) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "Resolved path is outside the workspace.",
      );
    }

    const allowedRoot = this.workspace.allowedRoots.find((root) =>
      isContained(root.canonicalPath, canonicalPath),
    );
    if (!allowedRoot) {
      throw new AppError(
        "PATH_OUTSIDE_ALLOWED_ROOTS",
        "Resolved path is outside the workspace allowed roots.",
      );
    }

    const canonicalRelativePath = path
      .relative(this.workspace.canonicalRootPath, canonicalPath)
      .split(path.sep)
      .join("/");
    const portableCanonicalPath = canonicalRelativePath || ".";
    const canonicalPolicyRule = enforceBlockedPolicy
      ? this.matchedBlockedPattern(portableCanonicalPath)
      : undefined;
    if (canonicalPolicyRule) {
      throw this.blockedPathError(
        logicalPath,
        canonicalPolicyRule,
        "Resolved path is blocked by workspace policy.",
        operation,
      );
    }

    const pathStat = await stat(canonicalPath);
    const kind = pathStat.isFile()
      ? "file"
      : pathStat.isDirectory()
        ? "directory"
        : undefined;
    if (!kind) {
      throw new AppError("INVALID_PATH", "Path type is not supported.");
    }
    if (expectedKind === "file" && kind !== "file") {
      throw new AppError("NOT_A_FILE", "Requested path is not a file.");
    }
    if (expectedKind === "directory" && kind !== "directory") {
      throw new AppError("NOT_A_DIRECTORY", "Requested path is not a directory.");
    }

    return {
      logicalPath,
      absolutePath,
      canonicalPath,
      canonicalRelativePath: portableCanonicalPath,
      kind,
    };
  }

  private blockedPathError(
    logicalPath: string,
    policyRule: string,
    message: string,
    operation?: string,
  ): AppError {
    const safeAlternative =
      operation === "read_file" && isRealEnvironmentFile(logicalPath)
        ? "run_workspace_validation(secret-scan)"
        : undefined;
    return new AppError("BLOCKED_PATH", message, {
      details: {
        path: logicalPath,
        policyRule,
        ...(operation === undefined ? {} : { operation }),
        reason: "blocked_by_workspace_policy",
        ...(safeAlternative === undefined ? {} : { safeAlternative }),
      },
    });
  }
  async isSymbolicLink(input: string): Promise<boolean> {
    const logicalPath = normalizeRelativePath(input, { allowDot: true });
    const absolutePath = toNativeAbsolute(this.workspace.rootPath, logicalPath);
    return (await lstat(absolutePath)).isSymbolicLink();
  }

  private isWithinLogicalAllowedRoot(logicalPath: string): boolean {
    return this.workspace.allowedRoots.some((root) => {
      if (root.kind === "file") {
        return comparisonValue(root.logicalPath) === comparisonValue(logicalPath);
      }
      return logicalContains(root.logicalPath, logicalPath);
    });
  }

  private isAllowedWritePath(logicalPath: string): boolean {
    if (this.workspace.allowWrites.length === 0) {
      return false;
    }
    return this.workspace.allowWrites.some((writeRoot) => {
      if (writeRoot === ".") {
        return true;
      }
      const root = comparisonValue(writeRoot);
      const candidate = comparisonValue(logicalPath);
      return (
        candidate === root ||
        candidate.startsWith(`${root}/`) ||
        root.startsWith(`${candidate}/`)
      );
    });
  }

  private assertCreatableAncestors(logicalPath: string): void {
    const segments = logicalPath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (this.isBlocked(ancestor)) {
        throw new AppError("BLOCKED_PATH", "Path is blocked by workspace policy.");
      }
      if (!this.isAllowedWritePath(ancestor)) {
        throw new AppError(
          "WRITE_NOT_ALLOWED",
          "Path is outside the workspace allowWrites policy.",
        );
      }
    }
  }
}

export async function resolveAllowedRoot(
  canonicalWorkspaceRoot: string,
  workspaceRoot: string,
  configuredPath: string,
): Promise<ResolvedAllowedRoot> {
  const logicalPath = normalizeRelativePath(configuredPath, { allowDot: true });
  const absolutePath = toNativeAbsolute(workspaceRoot, logicalPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    throw new AppError("POLICY_INVALID", "An allowed root does not exist.", {
      cause: error,
    });
  }

  if (!isContained(canonicalWorkspaceRoot, canonicalPath)) {
    throw new AppError(
      "POLICY_INVALID",
      "An allowed root resolves outside the workspace.",
    );
  }

  const rootStat = await stat(canonicalPath);
  if (!rootStat.isFile() && !rootStat.isDirectory()) {
    throw new AppError("POLICY_INVALID", "An allowed root has an unsupported type.");
  }

  return {
    logicalPath,
    absolutePath,
    canonicalPath,
    kind: rootStat.isFile() ? "file" : "directory",
  };
}
