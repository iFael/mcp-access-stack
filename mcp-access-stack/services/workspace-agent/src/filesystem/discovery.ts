import type { Dirent } from "node:fs";
import { lstat, opendir } from "node:fs/promises";
import path from "node:path";
import {
  abortSignalError,
  AppError,
  type ListFilesInput,
} from "@vs-code-gpt/shared";
import { minimatch } from "minimatch";
import type {
  ResolvedAllowedRoot,
  ResolvedWorkspace,
} from "../internal-types.js";
import { PathSecurity } from "../path-security.js";

export interface FileCandidate {
  logicalPath: string;
  absolutePath: string;
}

const MAX_DISCOVERY_DIRECTORIES = 4096;
const MAX_DISCOVERY_ENTRIES = 50000;
const MAX_DISCOVERY_DURATION_MS = 15000;

const IMPLICIT_OPERATIONAL_DIRECTORIES = new Set([
  ".runtime-tools",
  "releases",
  "runtime",
]);

export interface CollectedFiles {
  files: FileCandidate[];
  truncated: boolean;
}

export interface ListedWorkspaceRoots {
  roots: string[];
  truncated: boolean;
}

interface DiscoveryBudget {
  directoriesVisited: number;
  entriesScanned: number;
  deadlineAt: number;
  exhausted: boolean;
}

export async function collectAuthorizedFiles(
  workspace: ResolvedWorkspace,
  security: PathSecurity,
  input: Pick<ListFilesInput, "root" | "glob">,
  signal?: AbortSignal,
): Promise<CollectedFiles> {
  throwIfAborted(signal);
  const files = new Map<string, FileCandidate>();
  let truncated = false;
  const requestedRoot = normalizeRequestedRoot(input.root);

  if (workspace.workspaceKind === "aggregate" && requestedRoot === undefined) {
    throw new AppError(
      "INVALID_ARGUMENT",
      `Workspace "${workspace.id}" is aggregate. Recursive discovery requires a concrete root returned by list_workspace_roots.`,
    );
  }

  const budget = createDiscoveryBudget(workspace);
  const scanRoots = requestedRoot
    ? [await resolveRequestedScanRoot(security, requestedRoot)]
    : workspace.allowedRoots;
  throwIfAborted(signal);

  const addFile = (candidate: FileCandidate): boolean => {
    if (!matchesGlob(candidate.logicalPath, input.glob)) {
      return true;
    }
    if (files.has(candidate.logicalPath)) {
      return true;
    }
    if (files.size >= workspace.limits.maxListedFiles) {
      truncated = true;
      return false;
    }
    files.set(candidate.logicalPath, candidate);
    return true;
  };

  for (const scanRoot of scanRoots) {
    throwIfAborted(signal);
    if (discoveryDeadlineReached(budget)) {
      truncated = true;
      break;
    }
    if (scanRoot.kind === "file") {
      if (!security.isBlocked(scanRoot.logicalPath)) {
        addFile({
          logicalPath: scanRoot.logicalPath,
          absolutePath: scanRoot.canonicalPath,
        });
      }
      continue;
    }

    const rootStat = await lstat(scanRoot.absolutePath);
    throwIfAborted(signal);
    if (rootStat.isSymbolicLink()) {
      continue;
    }

    const shouldContinue = await walkDirectory(
      workspace,
      security,
      scanRoot.absolutePath,
      scanRoot.logicalPath,
      addFile,
      requestedRoot === undefined,
      budget,
      signal,
    );
    if (!shouldContinue) {
      truncated = true;
      break;
    }
  }

  throwIfAborted(signal);
  return {
    files: [...files.values()].sort((left, right) =>
      left.logicalPath.localeCompare(right.logicalPath),
    ),
    truncated: truncated || budget.exhausted,
  };
}

export async function listAuthorizedWorkspaceRoots(
  workspace: ResolvedWorkspace,
  security: PathSecurity,
  signal?: AbortSignal,
): Promise<ListedWorkspaceRoots> {
  throwIfAborted(signal);
  const budget = createDiscoveryBudget(workspace);
  const entries = await readDirectoryEntriesBounded(
    workspace,
    workspace.canonicalRootPath,
    budget,
    signal,
  );
  const roots: string[] = [];
  let truncated = budget.exhausted;

  for (const entry of entries) {
    throwIfAborted(signal);
    if (discoveryDeadlineReached(budget)) {
      truncated = true;
      break;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    if (IMPLICIT_OPERATIONAL_DIRECTORIES.has(normalizeDirectoryName(entry.name))) {
      continue;
    }
    if (security.isBlocked(entry.name) || security.isSubtreeBlocked(entry.name)) {
      continue;
    }
    try {
      security.authorizeLogical(entry.name);
    } catch (error) {
      if (
        error instanceof AppError &&
        ["BLOCKED_PATH", "PATH_OUTSIDE_ALLOWED_ROOTS"].includes(error.code)
      ) {
        continue;
      }
      throw error;
    }
    if (roots.length >= workspace.limits.maxListedFiles) {
      truncated = true;
      break;
    }
    roots.push(entry.name);
  }

  roots.sort((left, right) => left.localeCompare(right));
  return { roots, truncated };
}

async function resolveRequestedScanRoot(
  security: PathSecurity,
  requestedRoot: string,
): Promise<ResolvedAllowedRoot> {
  const authorized = await security.authorizeExisting(requestedRoot, undefined, true);
  return {
    logicalPath: authorized.logicalPath,
    absolutePath: authorized.absolutePath,
    canonicalPath: authorized.canonicalPath,
    kind: authorized.kind,
  };
}

async function walkDirectory(
  workspace: ResolvedWorkspace,
  security: PathSecurity,
  absoluteDirectory: string,
  logicalDirectory: string,
  addFile: (candidate: FileCandidate) => boolean,
  skipImplicitOperationalDirectories: boolean,
  budget: DiscoveryBudget,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal);
  if (discoveryDeadlineReached(budget)) {
    return false;
  }
  if (budget.directoriesVisited >= (workspace.limits.maxDiscoveryDirectories ?? MAX_DISCOVERY_DIRECTORIES)) {
    budget.exhausted = true;
    return false;
  }
  budget.directoriesVisited += 1;

  const entries = await readDirectoryEntriesBounded(
    workspace,
    absoluteDirectory,
    budget,
    signal,
  );

  for (const entry of entries) {
    throwIfAborted(signal);
    if (discoveryDeadlineReached(budget)) {
      return false;
    }
    const logicalPath =
      logicalDirectory === "."
        ? entry.name
        : `${logicalDirectory}/${entry.name}`;

    if (
      skipImplicitOperationalDirectories &&
      logicalDirectory === "." &&
      entry.isDirectory() &&
      IMPLICIT_OPERATIONAL_DIRECTORIES.has(normalizeDirectoryName(entry.name))
    ) {
      continue;
    }

    if (security.isBlocked(logicalPath)) {
      continue;
    }
    if (entry.isDirectory() && security.isSubtreeBlocked(logicalPath)) {
      continue;
    }

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

    if (entry.isSymbolicLink()) {
      continue;
    }

    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      if (budget.exhausted) {
        continue;
      }
      const shouldContinue = await walkDirectory(
        workspace,
        security,
        absolutePath,
        logicalPath,
        addFile,
        skipImplicitOperationalDirectories,
        budget,
        signal,
      );
      if (!shouldContinue) {
        return false;
      }
      continue;
    }

    if (entry.isFile() && !addFile({ logicalPath, absolutePath })) {
      return false;
    }
  }
  return !budget.exhausted;
}

async function readDirectoryEntriesBounded(
  workspace: ResolvedWorkspace,
  absoluteDirectory: string,
  budget: DiscoveryBudget,
  signal?: AbortSignal,
): Promise<Dirent[]> {
  throwIfAborted(signal);
  const directory = await opendir(absoluteDirectory);
  const entries: Dirent[] = [];
  try {
    while (true) {
      throwIfAborted(signal);
      if (discoveryDeadlineReached(budget)) {
        break;
      }
      if (budget.entriesScanned >= (workspace.limits.maxDiscoveryEntries ?? MAX_DISCOVERY_ENTRIES)) {
        budget.exhausted = true;
        break;
      }
      const entry = await directory.read();
      throwIfAborted(signal);
      if (entry === null) {
        break;
      }
      budget.entriesScanned += 1;
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return entries;
}

function createDiscoveryBudget(workspace: ResolvedWorkspace): DiscoveryBudget {
  return {
    directoriesVisited: 0,
    entriesScanned: 0,
    deadlineAt: Date.now() + (workspace.limits.maxDiscoveryDurationMs ?? MAX_DISCOVERY_DURATION_MS),
    exhausted: false,
  };
}

function discoveryDeadlineReached(budget: DiscoveryBudget): boolean {
  if (Date.now() < budget.deadlineAt) {
    return false;
  }
  budget.exhausted = true;
  return true;
}

function normalizeRequestedRoot(root: string | undefined): string | undefined {
  if (root === undefined) {
    return undefined;
  }
  const normalized = path.posix.normalize(root.replace(/\\/g, "/"));
  return normalized === "." ? undefined : root;
}

function matchesGlob(relativePath: string, glob: string | undefined): boolean {
  return (
    glob === undefined ||
    minimatch(relativePath, glob, {
      dot: true,
      nocase: process.platform === "win32",
      matchBase: false,
    })
  );
}

function normalizeDirectoryName(name: string): string {
  return process.platform === "win32" ? name.toLocaleLowerCase("en-US") : name;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortSignalError(signal, "File discovery was cancelled.");
  }
}
