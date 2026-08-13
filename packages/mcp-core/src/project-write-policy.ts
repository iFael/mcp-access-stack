import { canonicalPathKey } from "./policy-merge.js";
import { supportedShells, type WorkspacePolicy } from "./policy.js";

export function isUnderConfiguredRoot(
  canonicalRootPath: string,
  rootPath: string,
): boolean {
  const rootKey = canonicalPathKey(rootPath);
  const pathKey = canonicalPathKey(canonicalRootPath);
  return pathKey === rootKey || pathKey.startsWith(`${rootKey}/`);
}

export interface AutoWritePolicyOptions {
  enableProjectWrites?: boolean;
  projectRootPath?: string;
  enableDevelopmentWrites?: boolean;
  developmentRootPath?: string;
}

export function isAutoWriteEligible(
  canonicalRootPath: string,
  options: AutoWritePolicyOptions,
): boolean {
  if (
    options.enableProjectWrites &&
    options.projectRootPath &&
    isUnderConfiguredRoot(canonicalRootPath, options.projectRootPath)
  ) {
    return true;
  }
  if (
    options.enableDevelopmentWrites &&
    options.developmentRootPath &&
    isUnderConfiguredRoot(canonicalRootPath, options.developmentRootPath)
  ) {
    return true;
  }
  return false;
}

function isConfiguredProjectRoot(
  canonicalRootPath: string,
  options: AutoWritePolicyOptions,
): boolean {
  return Boolean(
    options.enableProjectWrites &&
      options.projectRootPath &&
      canonicalPathKey(canonicalRootPath) === canonicalPathKey(options.projectRootPath),
  );
}

export function withAutoWriteAccess(
  workspace: WorkspacePolicy,
  canonicalRootPath: string,
  options: AutoWritePolicyOptions,
): WorkspacePolicy {
  if (!isAutoWriteEligible(canonicalRootPath, options)) {
    return workspace;
  }
  return {
    ...workspace,
    ...(isConfiguredProjectRoot(canonicalRootPath, options)
      ? { workspaceKind: "aggregate" as const }
      : {}),
    permissionProfile: "full-repo-write",
    allowWrites: ["."],
    allowShell: ["."],
    allowedShells: [...supportedShells],
  };
}
