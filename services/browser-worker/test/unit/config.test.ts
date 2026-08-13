import path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { loadBrowserWorkerConfig } from "../../config/browser-worker-config.js";

describe("loadBrowserWorkerConfig", () => {
  it("defaults to interactive mode and bounded diagnostic settings", () => {
    const config = loadBrowserWorkerConfig({
      BROWSER_WORKER_TOKEN: "x".repeat(32),
    });

    expect(config.mode).toBe("interactive");
    expect(config.profileMode).toBe("persistent");
    expect(config.userDataDirectory).toBe(
      path.join(config.privateDirectory, "chrome-profile"),
    );
    expect(config.browserChannel).toBe("chromium");
    expect(config.maxOwnedTabs).toBe(8);
    expect(config.maxConcurrentTabs).toBe(4);
    expect(config.navigationCacheMaxEntries).toBe(100);
    expect(config.navigationCacheRetentionMs).toBe(30 * 24 * 60 * 60 * 1_000);
    expect(config.idempotencyTtlMs).toBe(5 * 60 * 1_000);
    expect(config.idempotencyMaxEntries).toBe(4_096);
    expect(config.diagnosticTimeoutMs).toBe(120_000);
    expect(config.diagnosticRetentionMs).toBe(7 * 24 * 60 * 60 * 1_000);
    expect(config.diagnosticMaxArtifacts).toBe(500);
    expect(config.diagnosticMaxEntries).toBe(500);
    expect(config.extractionMaxScrolls).toBe(24);
    expect(config.extractionMaxPages).toBe(5);
    expect(config.extractionMaxBytes).toBe(8 * 1024 * 1024);
    expect(config.extractionTimeoutMs).toBe(20_000);
    expect(config.extractionNoProgressLimit).toBe(2);
  });

  it("accepts a dedicated persistent profile inside the private directory", () => {
    const privateDirectory = path.resolve("private-browser-test");
    const userDataDirectory = path.join(privateDirectory, "chrome-profile");
    const config = loadBrowserWorkerConfig({
      BROWSER_WORKER_TOKEN: "x".repeat(32),
      BROWSER_WORKER_PRIVATE_DIR: privateDirectory,
      BROWSER_WORKER_PROFILE_MODE: "persistent",
      BROWSER_WORKER_USER_DATA_DIR: userDataDirectory,
    });

    expect(config).toMatchObject({
      profileMode: "persistent",
      privateDirectory,
      userDataDirectory,
    });
  });

  it("rejects a persistent profile outside the private directory", () => {
    expect(() => loadBrowserWorkerConfig({
      BROWSER_WORKER_TOKEN: "x".repeat(32),
      BROWSER_WORKER_PRIVATE_DIR: path.resolve("private-browser-test"),
      BROWSER_WORKER_PROFILE_MODE: "persistent",
      BROWSER_WORKER_USER_DATA_DIR: path.resolve("personal-chrome-profile"),
    })).toThrow(/must stay inside/u);
  });

  it("accepts each supported operation mode", () => {
    for (const mode of ["auto", "interactive", "efficient", "diagnostic"] as const) {
      const config = loadBrowserWorkerConfig({
        BROWSER_WORKER_TOKEN: "x".repeat(32),
        BROWSER_WORKER_MODE: mode,
      });

      expect(config.mode).toBe(mode);
    }
  });

  it("accepts explicit direct-engine concurrency and diagnostic limits", () => {
    const config = loadBrowserWorkerConfig({
      BROWSER_WORKER_TOKEN: "x".repeat(32),
      BROWSER_WORKER_MAX_OWNED_TABS: "12",
      BROWSER_WORKER_MAX_CONCURRENT_TABS: "6",
      BROWSER_WORKER_NAVIGATION_CACHE_MAX_ENTRIES: "25",
      BROWSER_WORKER_NAVIGATION_CACHE_RETENTION_MS: "7200000",
      BROWSER_WORKER_IDEMPOTENCY_TTL_MS: "60000",
      BROWSER_WORKER_IDEMPOTENCY_MAX_ENTRIES: "256",
      BROWSER_WORKER_DIAGNOSTIC_TIMEOUT_MS: "45000",
      BROWSER_WORKER_DIAGNOSTIC_RETENTION_MS: "3600000",
      BROWSER_WORKER_DIAGNOSTIC_MAX_ARTIFACTS: "25",
      BROWSER_WORKER_DIAGNOSTIC_MAX_ENTRIES: "100",
      BROWSER_WORKER_EXTRACTION_MAX_SCROLLS: "40",
      BROWSER_WORKER_EXTRACTION_MAX_PAGES: "7",
      BROWSER_WORKER_EXTRACTION_MAX_BYTES: "2097152",
      BROWSER_WORKER_EXTRACTION_TIMEOUT_MS: "15000",
      BROWSER_WORKER_EXTRACTION_NO_PROGRESS_LIMIT: "3",
      BROWSER_WORKER_CREDENTIAL_BROKER_PATH: "tools/McpCredentialBroker.exe",
      BROWSER_WORKER_CREDENTIAL_BROKER_TIMEOUT_MS: "9000",
      BROWSER_WORKER_LOGIN_TIMEOUT_MS: "25000",
      BROWSER_WORKER_LOGIN_INVALID_BACKOFF_MS: "120000",
    });

    expect(config).toMatchObject({
      maxOwnedTabs: 12,
      maxConcurrentTabs: 6,
      navigationCacheMaxEntries: 25,
      navigationCacheRetentionMs: 7_200_000,
      idempotencyTtlMs: 60_000,
      idempotencyMaxEntries: 256,
      diagnosticTimeoutMs: 45_000,
      diagnosticRetentionMs: 3_600_000,
      diagnosticMaxArtifacts: 25,
      diagnosticMaxEntries: 100,
      extractionMaxScrolls: 40,
      extractionMaxPages: 7,
      extractionMaxBytes: 2_097_152,
      extractionTimeoutMs: 15_000,
      extractionNoProgressLimit: 3,
      credentialBrokerPath: path.resolve("tools/McpCredentialBroker.exe"),
      credentialBrokerTimeoutMs: 9_000,
      loginTimeoutMs: 25_000,
      loginInvalidBackoffMs: 120_000,
    });
  });

  it("rejects unknown modes, extension profiles and invalid limits", () => {
    expect(() =>
      loadBrowserWorkerConfig({
        BROWSER_WORKER_TOKEN: "x".repeat(32),
        BROWSER_WORKER_MODE: "unsafe",
      }),
    ).toThrow();
    expect(() =>
      loadBrowserWorkerConfig({
        BROWSER_WORKER_TOKEN: "x".repeat(32),
        BROWSER_WORKER_PROFILE_MODE: "extension",
      }),
    ).toThrow();
    expect(() =>
      loadBrowserWorkerConfig({
        BROWSER_WORKER_TOKEN: "x".repeat(32),
        BROWSER_WORKER_DIAGNOSTIC_MAX_ARTIFACTS: "5001",
      }),
    ).toThrow();
    expect(() =>
      loadBrowserWorkerConfig({
        BROWSER_WORKER_TOKEN: "x".repeat(32),
        BROWSER_WORKER_DIAGNOSTIC_RETENTION_MS: "0",
      }),
    ).toThrow();
    expect(() =>
      loadBrowserWorkerConfig({
        BROWSER_WORKER_TOKEN: "x".repeat(32),
        BROWSER_WORKER_MAX_OWNED_TABS: "0",
      }),
    ).toThrow();
    expect(() =>
      loadBrowserWorkerConfig({
        BROWSER_WORKER_TOKEN: "x".repeat(32),
        BROWSER_WORKER_IDEMPOTENCY_TTL_MS: "0",
      }),
    ).toThrow();
    expect(() =>
      loadBrowserWorkerConfig({
        BROWSER_WORKER_TOKEN: "x".repeat(32),
        BROWSER_WORKER_IDEMPOTENCY_MAX_ENTRIES: "100001",
      }),
    ).toThrow();
  });
});
