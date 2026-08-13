import { describe, expect, it } from "@jest/globals";
import { BrowserIdempotencyRegistry } from "../../services/browser-idempotency-registry.js";

describe("BrowserIdempotencyRegistry", () => {
  it("shares one successful mutation for retries with the same fingerprint", async () => {
    const registry = new BrowserIdempotencyRegistry();
    let executions = 0;
    const operation = async () => {
      executions += 1;
      return { completed: true };
    };

    const [first, retry] = await Promise.all([
      registry.run("call-1", "same", operation),
      registry.run("call-1", "same", operation),
    ]);

    expect(first).toEqual({ completed: true });
    expect(retry).toEqual(first);
    expect(executions).toBe(1);
    expect(registry.snapshot()).toMatchObject({
      entries: 1,
      hits: 1,
      misses: 1,
      conflicts: 0,
    });
  });

  it("returns a specific conflict without executing the second operation", async () => {
    const registry = new BrowserIdempotencyRegistry();
    let conflictingExecutions = 0;
    await registry.run("call-1", "first", async () => true);

    expect(() =>
      registry.run("call-1", "different", async () => {
        conflictingExecutions += 1;
        return false;
      }),
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
    expect(conflictingExecutions).toBe(0);
    expect(registry.snapshot().conflicts).toBe(1);
  });

  it("retains failed outcomes so an ambiguous retry cannot execute the mutation again", async () => {
    const registry = new BrowserIdempotencyRegistry();
    let executions = 0;
    const operation = async () => {
      executions += 1;
      throw new Error("outcome unavailable");
    };

    await expect(registry.run("call-1", "same", operation)).rejects.toThrow(
      "outcome unavailable",
    );
    await expect(registry.run("call-1", "same", operation)).rejects.toThrow(
      "outcome unavailable",
    );

    expect(executions).toBe(1);
    expect(registry.snapshot()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
  });

  it("starts the retention TTL when an outcome settles", async () => {
    let now = 1_000;
    let release!: (value: number) => void;
    const pendingResult = new Promise<number>((resolve) => {
      release = resolve;
    });
    const registry = new BrowserIdempotencyRegistry({
      ttlMs: 100,
      now: () => now,
    });
    const pending = registry.run("call-1", "same", () => pendingResult);

    now += 1_000;
    expect(registry.snapshot()).toMatchObject({ entries: 1, expirations: 0 });
    release(1);
    await expect(pending).resolves.toBe(1);

    now += 99;
    expect(registry.snapshot()).toMatchObject({ entries: 1, expirations: 0 });
    now += 2;
    expect(registry.snapshot()).toMatchObject({ entries: 0, expirations: 1 });
  });

  it("expires retained failures after the configured idempotency window", async () => {
    let now = 1_000;
    const registry = new BrowserIdempotencyRegistry({
      ttlMs: 100,
      now: () => now,
    });
    let executions = 0;
    const operation = async () => {
      executions += 1;
      throw new Error(`failure-${executions}`);
    };

    await expect(registry.run("call-1", "same", operation)).rejects.toThrow("failure-1");
    now += 101;
    await expect(registry.run("call-1", "same", operation)).rejects.toThrow("failure-2");

    expect(executions).toBe(2);
    expect(registry.snapshot()).toMatchObject({ expirations: 1, misses: 2 });
  });

  it("expires old entries and reports the expiration", async () => {
    let now = 1_000;
    const registry = new BrowserIdempotencyRegistry({
      ttlMs: 100,
      now: () => now,
    });
    await registry.run("call-1", "same", async () => true);

    now += 101;

    expect(registry.snapshot()).toMatchObject({
      entries: 0,
      expirations: 1,
    });
  });

  it("never expires an active operation and protects it for a full TTL after settlement", async () => {
    let now = 1_000;
    let release!: (value: number) => void;
    const pendingResult = new Promise<number>((resolve) => {
      release = resolve;
    });
    const registry = new BrowserIdempotencyRegistry({
      ttlMs: 100,
      maxEntries: 1,
      now: () => now,
    });
    const pending = registry.run("call-active", "active", () => pendingResult);

    now += 1_000;

    expect(registry.snapshot()).toMatchObject({
      entries: 1,
      expirations: 0,
      evictions: 0,
    });
    expect(() =>
      registry.run("call-second", "second", async () => 2),
    ).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));

    release(1);
    await expect(pending).resolves.toBe(1);
    expect(() =>
      registry.run("call-second", "second", async () => 2),
    ).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));

    now += 101;
    await expect(
      registry.run("call-second", "second", async () => 2),
    ).resolves.toBe(2);
    expect(registry.snapshot()).toMatchObject({
      expirations: 1,
      evictions: 0,
    });
  });

  it("fails closed at capacity instead of evicting an unexpired mutation outcome", async () => {
    const registry = new BrowserIdempotencyRegistry({ maxEntries: 2 });
    let firstExecutions = 0;
    await registry.run("call-1", "one", async () => {
      firstExecutions += 1;
      return 1;
    });
    await registry.run("call-2", "two", async () => 2);

    expect(() =>
      registry.run("call-3", "three", async () => 3),
    ).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    await expect(
      registry.run("call-1", "one", async () => {
        firstExecutions += 1;
        return 10;
      }),
    ).resolves.toBe(1);

    expect(firstExecutions).toBe(1);
    expect(registry.snapshot()).toMatchObject({
      entries: 2,
      evictions: 0,
      hits: 1,
      misses: 2,
    });
  });
});
