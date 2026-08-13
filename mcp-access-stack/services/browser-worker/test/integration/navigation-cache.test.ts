import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  cacheableUrl,
  NavigationCache,
  navigationCacheKey,
} from "../../domain/navigation-cache.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("NavigationCache", () => {
  it("persists safe navigation metadata and restores by exact purpose", async () => {
    const directory = await temporaryDirectory();
    const cache = await NavigationCache.load(directory, {
      maxEntries: 10,
      retentionMs: 60_000,
      now: () => Date.parse("2026-07-23T10:00:10.000Z"),
    });

    const recorded = cache.record({
      url: "https://example.com/dashboard",
      purpose: "customer-dashboard",
      title: "Dashboard",
    }, { closed: true, now: "2026-07-23T10:00:00.000Z" });
    expect(recorded).toMatchObject({
      url: "https://example.com/dashboard",
      purpose: "customer-dashboard",
      useCount: 1,
      lastClosedAt: "2026-07-23T10:00:00.000Z",
    });
    await cache.save();

    const restored = await NavigationCache.load(directory, {
      maxEntries: 10,
      retentionMs: 60_000,
      now: () => Date.parse("2026-07-23T10:00:10.000Z"),
    });
    expect(restored.resolve(
      "customer-dashboard",
      Date.parse("2026-07-23T10:00:10.000Z"),
    )).toMatchObject({
      ageMs: 10_000,
      entry: {
        url: "https://example.com/dashboard",
        purpose: "customer-dashboard",
        title: "Dashboard",
      },
    });

    const raw = await readFile(
      path.join(directory, "registry", "navigation-cache.json"),
      "utf8",
    );
    expect(raw).not.toContain("content");
    expect(raw).not.toContain("ref=");
  });

  it("records the logical requested URL instead of a redirect destination", async () => {
    const directory = await temporaryDirectory();
    const cache = await NavigationCache.load(directory, {
      maxEntries: 10,
      retentionMs: 60_000,
    });

    expect(cache.record({
      url: "https://example.com/final",
      requestedUrl: "https://example.com/start",
      purpose: "redirected-page",
    })).toMatchObject({
      url: "https://example.com/start",
      purpose: "redirected-page",
    });
  });

  it("rejects URLs that could persist credentials, queries or fragments", () => {
    expect(cacheableUrl("https://example.com/page")).toBe(
      "https://example.com/page",
    );
    expect(cacheableUrl("https://user:pass@example.com/page")).toBeUndefined();
    expect(cacheableUrl("https://example.com/page?token=secret")).toBeUndefined();
    expect(cacheableUrl("https://example.com/page#private")).toBeUndefined();
    expect(cacheableUrl("about:blank")).toBeUndefined();
  });

  it("enforces retention and LRU capacity", async () => {
    const directory = await temporaryDirectory();
    const cache = await NavigationCache.load(directory, {
      maxEntries: 2,
      retentionMs: 1_000,
      now: () => Date.parse("2026-07-23T10:00:04.000Z"),
    });
    cache.record({
      url: "https://example.com/old",
      purpose: "old",
    }, { now: "2026-07-23T10:00:00.000Z" });
    cache.record({
      url: "https://example.com/a",
      purpose: "a",
    }, { now: "2026-07-23T10:00:02.000Z" });
    cache.record({
      url: "https://example.com/b",
      purpose: "b",
    }, { now: "2026-07-23T10:00:03.000Z" });
    cache.record({
      url: "https://example.com/c",
      purpose: "c",
    }, { now: "2026-07-23T10:00:04.000Z" });

    expect(cache.resolve("old", Date.parse("2026-07-23T10:00:04.000Z")))
      .toBeUndefined();
    expect(cache.list().map((entry) => entry.purpose)).toEqual(["c", "b"]);
  });

  it("uses a stable opaque key without exposing URL text", () => {
    const key = navigationCacheKey(
      "https://example.com/dashboard",
      "customer-dashboard",
    );
    expect(key).toMatch(/^[a-f0-9]{64}$/u);
    expect(key).not.toContain("example");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "navigation-cache-"));
  temporaryDirectories.push(directory);
  return directory;
}
