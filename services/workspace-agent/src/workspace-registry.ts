import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  mandatoryBlockedGlobs,
  policyFileSchema,
  type PolicyFile,
  type WorkspaceSummary,
} from "@vs-code-gpt/shared";
import { normalizeRelativePath, resolveAllowedRoot } from "./path-security.js";
import type { ResolvedWorkspace } from "./internal-types.js";

export class WorkspaceRegistry {
  private constructor(private readonly workspaces: Map<string, ResolvedWorkspace>) {}

  static async load(policyPath: string): Promise<WorkspaceRegistry> {
    if (!path.isAbsolute(policyPath)) {
      throw new AppError("POLICY_INVALID", "Policy path must be absolute.");
    }

    let rawPolicy: string;
    try {
      rawPolicy = await readFile(policyPath, "utf8");
    } catch (error) {
      throw new AppError("POLICY_INVALID", "Unable to read policy file.", {
        cause: error,
      });
    }

    let json: unknown;
    try {
      json = JSON.parse(rawPolicy);
    } catch (error) {
      throw new AppError("POLICY_INVALID", "Policy file contains invalid JSON.", {
        cause: error,
      });
    }

    const parsed = policyFileSchema.safeParse(json);
    if (!parsed.success) {
      throw new AppError("POLICY_INVALID", "Policy file does not match schema.", {
        cause: parsed.error,
      });
    }

    return WorkspaceRegistry.fromPolicy(parsed.data);
  }

  static async fromPolicy(policy: PolicyFile): Promise<WorkspaceRegistry> {
    const parsed = policyFileSchema.safeParse(policy);
    if (!parsed.success) {
      throw new AppError("POLICY_INVALID", "Policy object does not match schema.", {
        cause: parsed.error,
      });
    }
    return new WorkspaceRegistry(await resolveWorkspaces(parsed.data));
  }

  listEnabled(): WorkspaceSummary[] {
    return [...this.workspaces.values()]
      .filter((workspace) => workspace.enabled)
      .map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        workspaceKind: workspace.workspaceKind ?? "repository",
        enabled: true as const,
        permissionProfile: workspace.permissionProfile,
        confirmationMode: workspace.confirmationMode ?? "standard",
        writesEnabled:
          workspace.permissionProfile === "full-repo-write" && workspace.allowWrites.length > 0,
        shellsEnabled:
          workspace.permissionProfile === "full-repo-write" && workspace.allowShell.length > 0,
        allowedShells: workspace.allowedShells,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  get(workspaceId: string): ResolvedWorkspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new AppError("WORKSPACE_NOT_FOUND", "Workspace was not found.");
    }
    if (!workspace.enabled) {
      throw new AppError("WORKSPACE_DISABLED", "Workspace is disabled.");
    }
    return workspace;
  }

  all(): ResolvedWorkspace[] {
    return [...this.workspaces.values()];
  }
}

async function resolveWorkspaces(
  policy: PolicyFile,
): Promise<Map<string, ResolvedWorkspace>> {
  const resolved = new Map<string, ResolvedWorkspace>();

  for (const workspace of policy.workspaces) {
    if (!path.isAbsolute(workspace.rootPath)) {
      throw new AppError("POLICY_INVALID", "Workspace rootPath must be absolute.");
    }

    let canonicalRootPath: string;
    try {
      canonicalRootPath = await realpath(workspace.rootPath);
      if (!(await stat(canonicalRootPath)).isDirectory()) {
        throw new Error("Not a directory");
      }
    } catch (error) {
      throw new AppError("POLICY_INVALID", "Workspace rootPath is not a directory.", {
        cause: error,
      });
    }

    const allowedRoots = await Promise.all(
      workspace.allowedRoots.map((allowedRoot) =>
        resolveAllowedRoot(canonicalRootPath, workspace.rootPath, allowedRoot),
      ),
    );

    if (
      workspace.permissionProfile === "full-repo-readonly" &&
      (allowedRoots.length !== 1 || allowedRoots[0]?.logicalPath !== ".")
    ) {
      throw new AppError(
        "POLICY_INVALID",
        "full-repo-readonly requires allowedRoots to contain only '.'.",
      );
    }

    if (
      workspace.permissionProfile === "full-repo-write" &&
      (allowedRoots.length !== 1 ||
        allowedRoots[0]?.logicalPath !== "." ||
        workspace.allowWrites.length === 0)
    ) {
      throw new AppError(
        "POLICY_INVALID",
        "full-repo-write requires allowedRoots ['.'] and a non-empty allowWrites list.",
      );
    }

    const allowWrites = workspace.allowWrites.map((writePath) =>
      normalizeRelativePath(writePath, { allowDot: true }),
    );
    const allowShell = (workspace.allowShell ?? []).map((shellPath) =>
      normalizeRelativePath(shellPath, { allowDot: true }),
    );
    const allowedShells = workspace.allowedShells;
    const blockedGlobs = [
      ...new Set([...mandatoryBlockedGlobs, ...workspace.blockedGlobs]),
    ];

    resolved.set(workspace.id, {
      id: workspace.id,
      name: workspace.name,
      rootPath: workspace.rootPath,
      workspaceKind: workspace.workspaceKind ?? "repository",
      canonicalRootPath,
      enabled: workspace.enabled,
      permissionProfile: workspace.permissionProfile,
      confirmationMode: workspace.confirmationMode,
      allowedRoots,
      blockedGlobs,
      limits: workspace.limits,
      allowWrites,
      allowShell,
      allowedShells,
      ...(workspace.sourceControl === undefined ? {} : { sourceControl: workspace.sourceControl }),
    });
  }

  return resolved;
}
