import { createHash } from "node:crypto";
import type { QualifiedRunCommandInput, ShellName } from "@vs-code-gpt/shared";
import type {
  DeterministicCommandRecipe,
  LimitedCommandContext,
} from "./types.js";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 1_000;

export interface SanitizedRecipeCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => Date;
}

export interface SanitizedRecipeCacheLookupInput {
  workspaceId: string;
  logicalCwd: string;
  objective: string;
  shellPreference: ShellName | "auto";
  context: LimitedCommandContext;
}

export type SanitizedRecipeCacheLookupResult =
  | { status: "hit"; recipe: DeterministicCommandRecipe }
  | { status: "miss" }
  | { status: "stale" };

export interface SanitizedRecipeCacheMetrics {
  entries: number;
  hits: number;
  misses: number;
  stale: number;
  evictions: number;
  expirations: number;
  stores: number;
}

export interface SanitizedRecipeCacheEntryMetadata {
  keySha256: string;
  contextSha256: string;
  recipeId: string;
  createdAt: string;
  lastAccessedAt: string;
  expiresAt: string;
}

interface SanitizedRecipeCacheEntry {
  keySha256: string;
  contextSha256: string;
  recipe: DeterministicCommandRecipe;
  createdAtMs: number;
  lastAccessedAtMs: number;
  expiresAtMs: number;
}

export class SanitizedRecipeCache {
  private readonly entries = new Map<string, SanitizedRecipeCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private hits = 0;
  private misses = 0;
  private stale = 0;
  private evictions = 0;
  private expirations = 0;
  private stores = 0;

  constructor(options: SanitizedRecipeCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new Error("Sanitized recipe cache ttlMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new Error(
        "Sanitized recipe cache maxEntries must be a positive integer.",
      );
    }
  }

  lookup(
    input: SanitizedRecipeCacheLookupInput,
  ): SanitizedRecipeCacheLookupResult {
    const nowMs = this.timestamp();
    this.pruneExpired(nowMs);
    const keySha256 = cacheKey(input);
    const existing = this.entries.get(keySha256);
    if (!existing) {
      this.misses += 1;
      return { status: "miss" };
    }

    const contextSha256 = contextFingerprint(input.context);
    if (existing.contextSha256 !== contextSha256) {
      this.entries.delete(keySha256);
      this.stale += 1;
      this.misses += 1;
      return { status: "stale" };
    }

    const refreshed: SanitizedRecipeCacheEntry = {
      ...existing,
      lastAccessedAtMs: nowMs,
    };
    this.entries.delete(keySha256);
    this.entries.set(keySha256, refreshed);
    this.hits += 1;
    return { status: "hit", recipe: cloneRecipe(refreshed.recipe) };
  }

  store(
    input: SanitizedRecipeCacheLookupInput,
    recipe: DeterministicCommandRecipe,
  ): boolean {
    if (!isCacheableRecipe(recipe)) return false;
    const nowMs = this.timestamp();
    this.pruneExpired(nowMs);
    const keySha256 = cacheKey(input);
    const existing = this.entries.get(keySha256);
    const entry: SanitizedRecipeCacheEntry = {
      keySha256,
      contextSha256: contextFingerprint(input.context),
      recipe: cloneRecipe(recipe),
      createdAtMs: existing?.createdAtMs ?? nowMs,
      lastAccessedAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    };
    this.entries.delete(keySha256);
    this.entries.set(keySha256, entry);
    this.stores += 1;
    this.trimToCapacity();
    return true;
  }

  snapshot(): SanitizedRecipeCacheMetrics {
    this.pruneExpired(this.timestamp());
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      stale: this.stale,
      evictions: this.evictions,
      expirations: this.expirations,
      stores: this.stores,
    };
  }

  listMetadata(): SanitizedRecipeCacheEntryMetadata[] {
    this.pruneExpired(this.timestamp());
    return [...this.entries.values()].map((entry) => ({
      keySha256: entry.keySha256,
      contextSha256: entry.contextSha256,
      recipeId: entry.recipe.id,
      createdAt: new Date(entry.createdAtMs).toISOString(),
      lastAccessedAt: new Date(entry.lastAccessedAtMs).toISOString(),
      expiresAt: new Date(entry.expiresAtMs).toISOString(),
    }));
  }

  private pruneExpired(nowMs: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs > nowMs) continue;
      this.entries.delete(key);
      this.expirations += 1;
    }
  }

  private trimToCapacity(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) return;
      this.entries.delete(oldest);
      this.evictions += 1;
    }
  }

  private timestamp(): number {
    const value = this.now().getTime();
    if (!Number.isFinite(value)) {
      throw new Error("Sanitized recipe cache clock returned an invalid date.");
    }
    return value;
  }
}

export function createRecipeCacheLookupInput(
  input: QualifiedRunCommandInput,
  context: LimitedCommandContext,
): SanitizedRecipeCacheLookupInput | undefined {
  if (!input.objective) return undefined;
  const preferred = input.preferredShell;
  return {
    workspaceId: context.workspaceId,
    logicalCwd: context.logicalCwd,
    objective: input.objective,
    shellPreference:
      input.shell ?? (preferred === undefined ? "auto" : preferred),
    context,
  };
}

function isCacheableRecipe(recipe: DeterministicCommandRecipe): boolean {
  return (
    recipe.execution.kind === "argv" &&
    recipe.classification.riskClass === "safe" &&
    (recipe.classification.effectClass === "pure_read" ||
      recipe.classification.effectClass === "repeatable_local") &&
    Number.isSafeInteger(recipe.defaultPostconditionExitCode)
  );
}

function cacheKey(input: SanitizedRecipeCacheLookupInput): string {
  return hash({
    version: 1,
    workspaceId: input.workspaceId,
    logicalCwd: input.logicalCwd,
    objective: normalizeObjective(input.objective),
    shellPreference: input.shellPreference,
  });
}

function contextFingerprint(context: LimitedCommandContext): string {
  return hash({
    version: 1,
    platform: context.platform,
    architecture: context.architecture,
    allowedShells: [...context.allowedShells].sort(),
    markers: [...context.markers]
      .map((marker) => ({
        path: marker.path,
        kind: marker.kind,
        sizeBytes: marker.sizeBytes,
        sha256: marker.sha256,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    packageMetadata:
      context.packageMetadata === undefined
        ? undefined
        : {
            packageManager: context.packageMetadata.packageManager,
            scripts: [...context.packageMetadata.scripts]
              .map((script) => ({
                name: script.name,
                commandSha256: script.commandSha256,
                effectClass: script.effectClass,
                riskClass: script.riskClass,
              }))
              .sort((left, right) => left.name.localeCompare(right.name)),
          },
    gitRepository: context.git.repository,
    tools: [...context.tools]
      .map((tool) => ({
        name: tool.name,
        available: tool.available,
        version: tool.version,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}

function normalizeObjective(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function cloneRecipe(
  recipe: DeterministicCommandRecipe,
): DeterministicCommandRecipe {
  return {
    ...recipe,
    execution:
      recipe.execution.kind === "argv"
        ? {
            kind: "argv",
            executable: recipe.execution.executable,
            argv: [...recipe.execution.argv],
          }
        : { kind: "script", script: recipe.execution.script },
    requiredTools: [...recipe.requiredTools],
    requiredMarkers: [...recipe.requiredMarkers],
    classification: {
      ...recipe.classification,
      reasons: [...recipe.classification.reasons],
    },
  };
}
