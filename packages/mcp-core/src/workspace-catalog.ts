import type { PolicyFile } from "./policy.js";
import type { WorkspaceCatalogEntryMeta } from "./policy-merge.js";

export interface WorkspaceCatalogSnapshot {
  version: number;
  policy: PolicyFile;
  catalog: WorkspaceCatalogEntryMeta[];
  degraded: boolean;
  updatedAt: string;
  errorMessage?: string;
}

export interface WorkspaceCatalog {
  getSnapshot(): WorkspaceCatalogSnapshot | undefined;
  getLastKnownGood(): WorkspaceCatalogSnapshot | undefined;
  isDegraded(): boolean;
}

export function createEmptyCatalogState(): {
  current: WorkspaceCatalogSnapshot | undefined;
  lastKnownGood: WorkspaceCatalogSnapshot | undefined;
} {
  return {
    current: undefined,
    lastKnownGood: undefined,
  };
}

export function applyCatalogSnapshot(
  state: {
    current: WorkspaceCatalogSnapshot | undefined;
    lastKnownGood: WorkspaceCatalogSnapshot | undefined;
  },
  snapshot: WorkspaceCatalogSnapshot,
): void {
  state.current = snapshot;
  if (!snapshot.degraded) {
    state.lastKnownGood = snapshot;
  }
}

export function markCatalogDegraded(
  state: {
    current: WorkspaceCatalogSnapshot | undefined;
    lastKnownGood: WorkspaceCatalogSnapshot | undefined;
  },
  errorMessage: string,
): void {
  const fallback = state.lastKnownGood ?? state.current;
  if (!fallback) {
    state.current = {
      version: 0,
      policy: { version: 1, workspaces: [] },
      catalog: [],
      degraded: true,
      updatedAt: new Date().toISOString(),
      errorMessage,
    };
    return;
  }

  state.current = {
    ...fallback,
    degraded: true,
    updatedAt: new Date().toISOString(),
    errorMessage,
  };
}
