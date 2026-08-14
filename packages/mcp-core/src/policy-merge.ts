import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type PolicyFile,
  type WorkspaceLimits,
  type WorkspacePolicy,
  workspaceLimitsSchema,
} from "./policy.js";
import { withAutoWriteAccess } from "./project-write-policy.js";

export const discoveredWorkspaceCandidateSchema = z
  .object({
    name: z.string().trim().min(1),
    rootPath: z.string().trim().min(1),
    canonicalRootPath: z.string().trim().min(1),
    trusted: z.boolean(),
  })
  .strict();

export type DiscoveredWorkspaceCandidate = z.infer<
  typeof discoveredWorkspaceCandidateSchema
>;

export interface ExplicitPolicyInput {
  workspace: WorkspacePolicy;
  canonicalRootPath: string;
}

export interface MergePolicyBase {
  version: 1;
  entries: ExplicitPolicyInput[];
}

export type WorkspaceCatalogSource = "explicit" | "discovered" | "deny-index";

export interface WorkspaceCatalogEntryMeta {
  source: WorkspaceCatalogSource;
  id: string;
  name: string;
  rootPath: string;
  canonicalRootPath: string;
  trusted: boolean;
  enabled: boolean;
}

/** Hard-coded ceiling for discovered workspaces; settings may only reduce these values. */
export const DISCOVERED_WORKSPACE_LIMIT_CEILINGS: WorkspaceLimits = {
  maxFileBytes: 64_000,
  maxSearchResults: 100,
  maxSearchSnippetBytes: 20_000,
  maxDiffBytes: 500_000,
  maxListedFiles: 500,
};

const IMPLICIT_TECHNICAL_WORKSPACE_NAMES = new Set([
  "build",
  "coverage",
  "dist",
  "docker",
  "node_modules",
  "releases",
  "runtime",
  "test",
  "tests",
  "temp",
  "tmp",
]);

export interface MergeWorkspacePoliciesOptions {
  includeOpenWorkspaces?: boolean;
  alwaysExposeExplicit?: boolean;
  requireTrustedWorkspace?: boolean;
  discoveredLimitsOverride?: Partial<WorkspaceLimits>;
  enableProjectWrites?: boolean;
  projectRootPath?: string;
  enableDevelopmentWrites?: boolean;
  developmentRootPath?: string;
}

export interface MergeWorkspacePoliciesResult {
  policy: PolicyFile;
  catalog: WorkspaceCatalogEntryMeta[];
}

const LIMIT_KEYS = [
  "maxFileBytes",
  "maxSearchResults",
  "maxSearchSnippetBytes",
  "maxDiffBytes",
  "maxListedFiles",
] as const satisfies ReadonlyArray<keyof WorkspaceLimits>;

export function normalizePathKey(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function canonicalPathKey(filePath: string): string {
  return normalizePathKey(filePath);
}

export function clampDiscoveredLimits(
  override?: Partial<WorkspaceLimits>,
): WorkspaceLimits {
  const clamped: WorkspaceLimits = { ...DISCOVERED_WORKSPACE_LIMIT_CEILINGS };
  if (!override) {
    return clamped;
  }

  for (const key of LIMIT_KEYS) {
    const value = override[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      clamped[key] = Math.min(value, DISCOVERED_WORKSPACE_LIMIT_CEILINGS[key]);
    }
  }

  return workspaceLimitsSchema.parse(clamped);
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug.length > 0 ? slug : "workspace";
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

function buildDiscoveredId(candidate: DiscoveredWorkspaceCandidate): string {
  const base = `${slugify(candidate.name)}-${shortHash(candidate.canonicalRootPath)}`;
  return base.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function isImplicitTechnicalWorkspaceCandidate(
  candidate: DiscoveredWorkspaceCandidate,
): boolean {
  const names = [
    candidate.name,
    leafName(candidate.rootPath),
    leafName(candidate.canonicalRootPath),
  ].map((value) => value.trim().toLocaleLowerCase("en-US"));
  return names.some(
    (name) => name.startsWith(".") || IMPLICIT_TECHNICAL_WORKSPACE_NAMES.has(name),
  );
}

function leafName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/u, "");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function createDiscoveredWorkspace(
  candidate: DiscoveredWorkspaceCandidate,
  limits: WorkspaceLimits,
  usedIds: Set<string>,
): WorkspacePolicy {
  let id = buildDiscoveredId(candidate);
  if (usedIds.has(id)) {
    id = `${id}-${shortHash(`${candidate.canonicalRootPath}:collision`)}`;
  }
  usedIds.add(id);

  return {
    id,
    name: candidate.name,
    rootPath: candidate.rootPath,
    workspaceKind: "repository",
    enabled: true,
    permissionProfile: "planning-readonly",
    confirmationMode: "standard",
    allowedRoots: ["."],
    blockedGlobs: [],
    limits,
    allowWrites: [],
    allowShell: [],
    allowedShells: ["powershell"],
  };
}

/**
 * Pure merge of explicit policy JSON with VS Code discovered folder candidates.
 * Explicit entries win for the same canonical path, including deny (`enabled: false`).
 */
export function mergeWorkspacePolicies(
  base: MergePolicyBase,
  discovered: DiscoveredWorkspaceCandidate[],
  options: MergeWorkspacePoliciesOptions = {},
): MergeWorkspacePoliciesResult {
  const includeOpenWorkspaces = options.includeOpenWorkspaces ?? true;
  const alwaysExposeExplicit = options.alwaysExposeExplicit ?? false;
  const requireTrustedWorkspace = options.requireTrustedWorkspace ?? true;
  const discoveredLimits = clampDiscoveredLimits(options.discoveredLimitsOverride);

  const explicitByPath = new Map<string, WorkspacePolicy>();
  const explicitCanonicalByPath = new Map<string, string>();
  const denyPaths = new Set<string>();
  const catalog: WorkspaceCatalogEntryMeta[] = [];
  const usedIds = new Set<string>();

  for (const entry of base.entries) {
    const { workspace, canonicalRootPath } = entry;
    const key = canonicalPathKey(canonicalRootPath);
    explicitByPath.set(key, workspace);
    explicitCanonicalByPath.set(key, canonicalRootPath);
    usedIds.add(workspace.id);

    if (!workspace.enabled) {
      denyPaths.add(key);
      catalog.push({
        source: "deny-index",
        id: workspace.id,
        name: workspace.name,
        rootPath: workspace.rootPath,
        canonicalRootPath,
        trusted: true,
        enabled: false,
      });
    }
  }

  const merged = new Map<string, WorkspacePolicy>();

  if (includeOpenWorkspaces) {
    for (const candidate of discovered) {
      const key = canonicalPathKey(candidate.canonicalRootPath);

      if (requireTrustedWorkspace && !candidate.trusted) {
        continue;
      }
      if (denyPaths.has(key)) {
        continue;
      }

      const explicit = explicitByPath.get(key);
      if (explicit) {
        if (explicit.enabled) {
          merged.set(
            key,
            withAutoWriteAccess(explicit, candidate.canonicalRootPath, options),
          );
          catalog.push({
            source: "explicit",
            id: explicit.id,
            name: explicit.name,
            rootPath: explicit.rootPath,
            canonicalRootPath: candidate.canonicalRootPath,
            trusted: candidate.trusted,
            enabled: true,
          });
        }
        continue;
      }

      if (isImplicitTechnicalWorkspaceCandidate(candidate)) {
        continue;
      }

      const discoveredWorkspace = withAutoWriteAccess(
        createDiscoveredWorkspace(candidate, discoveredLimits, usedIds),
        candidate.canonicalRootPath,
        options,
      );
      merged.set(key, discoveredWorkspace);
      catalog.push({
        source: "discovered",
        id: discoveredWorkspace.id,
        name: discoveredWorkspace.name,
        rootPath: discoveredWorkspace.rootPath,
        canonicalRootPath: candidate.canonicalRootPath,
        trusted: candidate.trusted,
        enabled: true,
      });
    }
  }

  if (alwaysExposeExplicit) {
    for (const entry of base.entries) {
      const { workspace, canonicalRootPath } = entry;
      if (!workspace.enabled) {
        continue;
      }
      const key = canonicalPathKey(canonicalRootPath);
      if (merged.has(key)) {
        continue;
      }
      merged.set(
        key,
        withAutoWriteAccess(workspace, canonicalRootPath, options),
      );
      catalog.push({
        source: "explicit",
        id: workspace.id,
        name: workspace.name,
        rootPath: workspace.rootPath,
        canonicalRootPath,
        trusted: true,
        enabled: true,
      });
    }
  }

  const workspaces = [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );

  if (workspaces.length === 0) {
    throw new Error("MERGE_EMPTY_POLICY: no workspaces available after merge");
  }

  return {
    policy: {
      version: 1,
      workspaces,
    },
    catalog,
  };
}
