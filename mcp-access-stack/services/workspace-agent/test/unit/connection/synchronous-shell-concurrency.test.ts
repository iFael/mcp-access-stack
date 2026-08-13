import { describe, expect, test } from "@jest/globals";
import {
  DEFAULT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS,
  MAX_CONCURRENT_SYNCHRONOUS_SHELLS,
  SynchronousShellConcurrency,
} from "../../../src/connection/synchronous-shell-concurrency.js";

describe("synchronous shell concurrency", () => {
  test("uses a bounded default", () => {
    const concurrency = new SynchronousShellConcurrency();
    expect(concurrency.maxConcurrent).toBe(DEFAULT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS);
    expect(DEFAULT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS).toBeGreaterThan(1);
    expect(DEFAULT_MAX_CONCURRENT_SYNCHRONOUS_SHELLS).toBeLessThanOrEqual(
      MAX_CONCURRENT_SYNCHRONOUS_SHELLS,
    );
  });

  test("allows different workspace keys and rejects the same key", () => {
    const concurrency = new SynchronousShellConcurrency(2);
    const first = concurrency.acquire("root:a", "request-a");
    expect(concurrency.activeCount).toBe(1);
    expect(() => concurrency.acquire("root:a", "request-a-2")).toThrow(
      "Another synchronous shell operation is already active for this workspace.",
    );
    const second = concurrency.acquire("root:b", "request-b");
    expect(concurrency.activeCount).toBe(2);
    expect(() => concurrency.acquire("root:c", "request-c")).toThrow(
      "The Workspace Agent synchronous shell concurrency limit is reached.",
    );
    first.release();
    first.release();
    expect(concurrency.activeCount).toBe(1);
    second.release();
    expect(concurrency.activeCount).toBe(0);
  });

  test("rejects unsafe concurrency configuration", () => {
    for (const value of [0, -1, 1.5, MAX_CONCURRENT_SYNCHRONOUS_SHELLS + 1]) {
      expect(() => new SynchronousShellConcurrency(value)).toThrow(
        `Synchronous shell concurrency must be an integer between 1 and ${MAX_CONCURRENT_SYNCHRONOUS_SHELLS}.`,
      );
    }
  });
});
