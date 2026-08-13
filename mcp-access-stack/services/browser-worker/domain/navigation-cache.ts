import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserTab } from "@vs-code-gpt/shared";
import { z } from "zod";

const navigationCacheEntrySchema = z
  .object({
    cacheKey: z.string().regex(/^[a-f0-9]{64}$/),
    url: z.url(),
    purpose: z.string().min(1).max(200),
    title: z.string().max(500).optional(),
    firstUsedAt: z.string().datetime(),
    lastUsedAt: z.string().datetime(),
    lastClosedAt: z.string().datetime().optional(),
    useCount: z.number().int().positive(),
  })
  .strict();

export type NavigationCacheEntry = z.infer<typeof navigationCacheEntrySchema>;

const navigationCacheFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    updatedAt: z.string().datetime(),
    entries: z.array(navigationCacheEntrySchema).max(1_000),
  })
  .strict();

export interface NavigationCacheOptions {
  maxEntries: number;
  retentionMs: number;
  now?: () => number;
}

export interface NavigationCacheLookup {
  entry: NavigationCacheEntry;
  ageMs: number;
}

export class NavigationCache {
  private readonly entries = new Map<string, NavigationCacheEntry>();

  private constructor(
    readonly filePath: string,
    private readonly options: NavigationCacheOptions,
  ) {}

  static async load(
    runtimeDirectory: string,
    options: NavigationCacheOptions,
  ): Promise<NavigationCache> {
    const cache = new NavigationCache(
      path.join(runtimeDirectory, "registry", "navigation-cache.json"),
      options,
    );
    try {
      const raw = await readFile(cache.filePath, "utf8");
      const parsed = navigationCacheFileSchema.parse(
        JSON.parse(raw.replace(/^\uFEFF/u, "")),
      );
      for (const entry of parsed.entries) cache.entries.set(entry.cacheKey, entry);
      cache.prune(cache.now());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return cache;
  }

  resolve(purpose: string, now?: number): NavigationCacheLookup | undefined {
    const currentTime = now ?? this.now();
    this.prune(currentTime);
    const entry = [...this.entries.values()]
      .filter((candidate) => candidate.purpose === purpose)
      .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))[0];
    if (!entry) return undefined;
    return {
      entry,
      ageMs: Math.max(0, currentTime - Date.parse(entry.lastUsedAt)),
    };
  }

  record(
    input: Pick<BrowserTab, "url" | "requestedUrl" | "purpose" | "title">,
    options: { closed?: boolean; now?: string } = {},
  ): NavigationCacheEntry | undefined {
    const url = cacheableUrl(input.requestedUrl ?? input.url);
    if (!url) return undefined;
    const now = options.now ?? new Date(this.now()).toISOString();
    const cacheKey = navigationCacheKey(url, input.purpose);
    const current = this.entries.get(cacheKey);
    const entry: NavigationCacheEntry = {
      cacheKey,
      url,
      purpose: input.purpose,
      ...(input.title === undefined ? {} : { title: input.title }),
      firstUsedAt: current?.firstUsedAt ?? now,
      lastUsedAt: now,
      ...(options.closed ? { lastClosedAt: now } : current?.lastClosedAt === undefined
        ? {}
        : { lastClosedAt: current.lastClosedAt }),
      useCount: (current?.useCount ?? 0) + 1,
    };
    this.entries.set(cacheKey, entry);
    this.prune(Date.parse(now));
    return entry;
  }

  list(now?: number): NavigationCacheEntry[] {
    this.prune(now ?? this.now());
    return [...this.entries.values()].sort((left, right) =>
      right.lastUsedAt.localeCompare(left.lastUsedAt),
    );
  }

  async save(): Promise<void> {
    const now = this.now();
    this.prune(now);
    const data = navigationCacheFileSchema.parse({
      schemaVersion: 1,
      updatedAt: new Date(now).toISOString(),
      entries: this.list(now),
    });
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${now}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");
    await rename(temporaryPath, this.filePath);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private prune(now: number): void {
    const threshold = now - this.options.retentionMs;
    for (const [key, entry] of this.entries) {
      if (Date.parse(entry.lastUsedAt) < threshold) this.entries.delete(key);
    }
    const sorted = [...this.entries.values()].sort((left, right) =>
      right.lastUsedAt.localeCompare(left.lastUsedAt),
    );
    for (const entry of sorted.slice(this.options.maxEntries)) {
      this.entries.delete(entry.cacheKey);
    }
  }
}

export function cacheableUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (!/^https?:$/u.test(url.protocol)) return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  return url.href;
}

export function navigationCacheKey(url: string, purpose: string): string {
  return createHash("sha256").update(`${purpose}\n${url}`, "utf8").digest("hex");
}
