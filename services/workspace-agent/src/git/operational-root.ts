import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import type { AuthorizedPath, ResolvedWorkspace } from "../internal-types.js";
import {
  isContained,
  normalizeRelativePath,
  PathSecurity,
  toNativeAbsolute,
} from "../path-security.js";

export async function authorizeGitOperationalRoot(
  workspace: ResolvedWorkspace,
  security: PathSecurity,
  input: string,
): Promise<AuthorizedPath> {
  try {
    return await security.authorizeExisting(input, "directory", true);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "PATH_OUTSIDE_ALLOWED_ROOTS") {
      throw error;
    }
  }

  const logicalPath = normalizeRelativePath(input, { allowDot: true });
  if (security.isBlocked(logicalPath)) {
    throw new AppError("BLOCKED_PATH", "Path is blocked by workspace policy.");
  }
  const isAllowedAncestor = workspace.allowedRoots.some((allowedRoot) => {
    const allowed = normalizeForComparison(allowedRoot.logicalPath);
    const candidate = normalizeForComparison(logicalPath);
    return candidate === "." || allowed === candidate || allowed.startsWith(`${candidate}/`);
  });
  if (!isAllowedAncestor) {
    throw new AppError(
      "PATH_OUTSIDE_ALLOWED_ROOTS",
      "Git root must be an allowed path or an ancestor of an allowed root.",
    );
  }

  const absolutePath = toNativeAbsolute(workspace.rootPath, logicalPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    throw new AppError("FILE_NOT_FOUND", "Requested Git root does not exist.", {
      cause: error,
    });
  }
  if (!isContained(workspace.canonicalRootPath, canonicalPath)) {
    throw new AppError(
      "PATH_OUTSIDE_WORKSPACE",
      "Resolved Git root is outside the workspace.",
    );
  }
  const canonicalRelativePath =
    path.relative(workspace.canonicalRootPath, canonicalPath).split(path.sep).join("/") || ".";
  if (security.isBlocked(canonicalRelativePath)) {
    throw new AppError("BLOCKED_PATH", "Resolved Git root is blocked by workspace policy.");
  }
  if (!(await stat(canonicalPath)).isDirectory()) {
    throw new AppError("NOT_A_DIRECTORY", "Requested Git root is not a directory.");
  }
  return {
    logicalPath,
    absolutePath,
    canonicalPath,
    canonicalRelativePath,
    kind: "directory",
  };
}

export async function authorizeGitMutationPath(
  security: PathSecurity,
  rootLogicalPath: string,
  candidate: string,
): Promise<string> {
  const normalized = normalizeRelativePath(candidate);
  const workspacePath = rootLogicalPath === "." ? normalized : `${rootLogicalPath}/${normalized}`;
  security.authorizeLogical(workspacePath, true);
  try {
    await security.authorizeExisting(workspacePath, undefined, true);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "FILE_NOT_FOUND") {
      throw error;
    }
    const parent = path.posix.dirname(workspacePath);
    await security.authorizeExisting(parent === "" ? "." : parent, "directory", true);
  }
  return normalized;
}

function normalizeForComparison(value: string): string {
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}
