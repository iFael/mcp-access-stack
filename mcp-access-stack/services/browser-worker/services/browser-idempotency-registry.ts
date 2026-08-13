import { AppError, type BrowserIdempotencyMetrics } from "@vs-code-gpt/shared";

interface IdempotencyEntry<T> {
  fingerprint: string;
  expiresAt: number;
  settled: boolean;
  value: Promise<T>;
}

export type BrowserIdempotencyDisposition =
  | "hit"
  | "miss"
  | "conflict"
  | "capacity"
  | "expiration";

export interface BrowserIdempotencyRegistryOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
  onDisposition?: (disposition: BrowserIdempotencyDisposition) => void;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 4_096;

export class BrowserIdempotencyRegistry {
  private readonly entries = new Map<string, IdempotencyEntry<unknown>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly onDisposition: ((disposition: BrowserIdempotencyDisposition) => void) | undefined;
  private hits = 0;
  private misses = 0;
  private conflicts = 0;
  private evictions = 0;
  private expirations = 0;

  constructor(options: BrowserIdempotencyRegistryOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    this.onDisposition = options.onDisposition;
  }

  run<T>(
    key: string | undefined,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!key) return operation();

    this.prune();
    const existing = this.entries.get(key) as IdempotencyEntry<T> | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.conflicts += 1;
        this.observe("conflict");
        throw new AppError(
          "IDEMPOTENCY_KEY_CONFLICT",
          "The idempotency key is already associated with a different browser operation fingerprint.",
        );
      }
      this.hits += 1;
      this.observe("hit");
      return existing.value;
    }

    this.ensureCapacity();
    this.misses += 1;
    this.observe("miss");
    const entry: IdempotencyEntry<T> = {
      fingerprint,
      expiresAt: Number.POSITIVE_INFINITY,
      settled: false,
      value: Promise.resolve(undefined as T),
    };
    entry.value = Promise.resolve()
      .then(operation)
      .then(
        (result) => {
          entry.settled = true;
          entry.expiresAt = this.now() + this.ttlMs;
          return result;
        },
        (error: unknown) => {
          entry.settled = true;
          entry.expiresAt = this.now() + this.ttlMs;
          throw error;
        },
      );
    this.entries.set(key, entry as IdempotencyEntry<unknown>);
    return entry.value;
  }

  snapshot(): BrowserIdempotencyMetrics {
    this.prune();
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      conflicts: this.conflicts,
      evictions: this.evictions,
      expirations: this.expirations,
    };
  }

  get size(): number {
    return this.snapshot().entries;
  }

  private ensureCapacity(): void {
    if (this.entries.size < this.maxEntries) return;
    this.observe("capacity");
    throw new AppError(
      "LIMIT_EXCEEDED",
      "The browser idempotency registry is at capacity with unexpired operations.",
    );
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.settled && entry.expiresAt <= now) {
        this.entries.delete(key);
        this.expirations += 1;
        this.observe("expiration");
      }
    }
  }

  private observe(disposition: BrowserIdempotencyDisposition): void {
    try {
      this.onDisposition?.(disposition);
    } catch {}
  }
}
