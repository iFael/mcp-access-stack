import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  normalizeBrowserDriverError,
  resolveBrowserPrivateOutputPath,
  type BrowserDriver,
} from "../../drivers/browser-driver.js";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";
import { DirectPlaywrightDriver } from "../../drivers/direct/direct-playwright-driver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 150,
      }),
    ),
  );
});

runBrowserDriverContract("DirectPlaywrightDriver", async () => {
  const directory = await makeTemporaryDirectory("browser-contract-direct-");
  return new DirectPlaywrightDriver(makeConfig(directory));
});

describe("browser driver private output contract", () => {
  it("resolves relative output paths inside private storage", async () => {
    const directory = await makeTemporaryDirectory("browser-output-contract-");
    const resolved = resolveBrowserPrivateOutputPath(
      directory,
      path.join("screenshots", "page.png"),
    );

    expect(resolved).toBe(path.join(directory, "screenshots", "page.png"));
    expect(() =>
      resolveBrowserPrivateOutputPath(directory, path.join("..", "outside.png")),
    ).toThrow(expect.objectContaining({ code: "BLOCKED_PATH" }));
  });
});

describe("browser driver error contract", () => {
  it("maps direct engine failures to stable browser error codes", () => {
    expect(
      normalizeBrowserDriverError("direct", "navigate", new Error("Request timed out")),
    ).toMatchObject({ code: "BROWSER_WORKER_TIMEOUT" });
    expect(
      normalizeBrowserDriverError("direct", "snapshot", new Error("browser not connected")),
    ).toMatchObject({ code: "BROWSER_DISCONNECTED" });
    expect(
      normalizeBrowserDriverError("direct", "evaluate", new Error("process failed")),
    ).toMatchObject({ code: "BROWSER_WORKER_UNAVAILABLE" });
  });

  it("redacts secrets from unexpected direct engine errors", () => {
    const error = normalizeBrowserDriverError(
      "direct",
      "connect",
      new Error("Authorization: Bearer secret Cookie: session=private"),
    );

    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("session=private");
    expect(error.message).toContain("[redacted]");
  });
});

function runBrowserDriverContract(
  label: string,
  createDriver: () => Promise<BrowserDriver>,
): void {
  describe(`${label} direct contract`, () => {
    it("exposes the typed direct engine surface", async () => {
      const driver = await createDriver();

      expect(driver.kind).toBe("direct");
      for (const method of [
        "navigate",
        "goBack",
        "goForward",
        "snapshot",
        "click",
        "fill",
        "press",
        "wait",
        "evaluate",
        "takeScreenshot",
      ] as const) {
        expect(typeof driver[method]).toBe("function");
      }
    });

    it("returns stable errors for disconnected operations", async () => {
      const driver = await createDriver();
      await expect(driver.snapshot()).rejects.toMatchObject({
        code: "BROWSER_DISCONNECTED",
      });
    });

    it("provides an idempotent connect and close lifecycle", async () => {
      const driver = await createDriver();
      try {
        await driver.connect();
        await driver.connect();
        expect(driver.isConnected()).toBe(true);
      } finally {
        await driver.close();
        await driver.close();
      }
      expect(driver.isConnected()).toBe(false);
    });
  });
}

function makeConfig(directory: string): BrowserWorkerConfig {
  return {
    host: "127.0.0.1",
    port: 3350,
    token: "x".repeat(32),
    mode: "interactive",
    headless: true,
    maxPayloadBytes: 1024 * 1024,
    runtimeDirectory: directory,
    privateDirectory: path.join(directory, "private"),
    primaryPrivateSiteUrl: new URL("https://dev-private.example.test/app"),
    connectTimeoutMs: 10_000,
    operationTimeoutMs: 10_000,
    actionTimeoutMs: 1_000,
    navigationTimeoutMs: 5_000,
    outputMaxBytes: 16 * 1024 * 1024,
    diagnosticTimeoutMs: 10_000,
    diagnosticRetentionMs: 7 * 24 * 60 * 60 * 1_000,
    diagnosticMaxArtifacts: 500,
    diagnosticMaxEntries: 500,
  };
}

async function makeTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
