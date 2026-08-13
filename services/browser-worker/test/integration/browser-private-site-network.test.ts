import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";
import { authorizedSitePolicySchema, type AuthorizedSitePolicy } from "../../domain/authorized-site-policy.js";
import { DirectPlaywrightDriver } from "../../drivers/direct/direct-playwright-driver.js";

const directories: string[] = [];
const drivers: DirectPlaywrightDriver[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(drivers.splice(0).map((driver) => driver.close()));
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

describe("DirectPlaywrightDriver private-site network guard", () => {

  it("enforces an authenticated request allowlist and transient POST permits", async () => {
    const counts = new Map<string, number>();
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://local").pathname;
      const key = String(request.method) + " " + pathname;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      response.writeHead(200, {
        "content-type": "text/html",
        "access-control-allow-origin": "*",
      });
      response.end("<!doctype html><title>allowed</title><body>allowed</body>");
    });
    servers.push(server);
    const port = await listen(server);
    let externalRequests = 0;
    const externalServer = createServer((_request, response) => {
      externalRequests += 1;
      response.writeHead(200, { "access-control-allow-origin": "*" });
      response.end("external");
    });
    servers.push(externalServer);
    const externalPort = await listen(externalServer);
    const externalUrl = "http://127.0.0.1:" + externalPort + "/external";
    const privateUrl = new URL("http://127.0.0.1:" + port + "/entry");
    const deniedUrl = new URL("http://localhost:" + port + "/production");
    const policy = authorizedSitePolicySchema.parse({
      siteId: "private-test",
      entryUrl: privateUrl.href,
      allowedOrigins: [privateUrl.origin],
      deniedOrigins: [deniedUrl.origin],
      accessMode: "business-read-only",
      loginStrategy: "none",
      requestPolicy: {
        rules: [
          {
            methods: ["GET"],
            pathname: "/allowed",
            queryKeys: [],
            resourceTypes: ["document"],
            navigation: true,
            requiresSemanticPermit: false,
          },
          {
            methods: ["POST"],
            pathname: "/post",
            queryKeys: [],
            resourceTypes: ["fetch"],
            navigation: false,
            requiresSemanticPermit: true,
          },
        ],
        semanticActions: [],
      },
    });
    const driver = await createDriver(privateUrl, deniedUrl, policy);

    driver.enablePrivateOrigin(privateUrl.origin);
    await driver.newTabWithAllowedOrigins(privateUrl.href, [privateUrl.origin]);
    driver.setActivePageRequestPolicy(policy);

    await expect(driver.navigate({ url: new URL("/allowed", privateUrl).href })).resolves.toBeDefined();
    expect(counts.get("GET /allowed")).toBe(1);

    await expect(driver.navigate({ url: new URL("/blocked", privateUrl).href })).rejects.toBeDefined();
    expect(counts.get("GET /blocked") ?? 0).toBe(0);
    await expect(driver.navigate({ url: new URL("/allowed?extra=1", privateUrl).href })).rejects.toBeDefined();
    expect(counts.get("GET /allowed")).toBe(1);

    const page = driver.activePage();
    const postUrl = new URL("/post", privateUrl).href;
    await expect(page.evaluate(async (url) => {
      await fetch(url, { method: "POST" });
    }, postUrl)).rejects.toBeDefined();
    expect(counts.get("POST /post") ?? 0).toBe(0);

    const release = driver.acquireActivePageSemanticRequestPermit();
    try {
      await expect(page.evaluate(async (url) => {
        const response = await fetch(url, { method: "POST" });
        return response.status;
      }, postUrl)).resolves.toBe(200);
    } finally {
      release();
    }
    expect(counts.get("POST /post")).toBe(1);

    await expect(page.evaluate(async (url) => {
      await fetch(url, { method: "POST" });
    }, postUrl)).rejects.toBeDefined();
    expect(counts.get("POST /post")).toBe(1);

    await expect(page.evaluate(async (url) => {
      await fetch(url);
    }, externalUrl)).rejects.toBeDefined();
    expect(externalRequests).toBe(0);
  });

  it("sends zero private requests before a grant and always blocks a denied origin", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>private</title><body>private</body>");
    });
    servers.push(server);
    const port = await listen(server);
    const privateUrl = new URL(`http://127.0.0.1:${port}/private`);
    const deniedUrl = new URL(`http://localhost:${port}/production`);
    const driver = await createDriver(privateUrl, deniedUrl);

    await expect(driver.newTab(privateUrl.href)).rejects.toBeDefined();
    expect(requests).toBe(0);

    driver.enablePrivateOrigin(privateUrl.origin);
    const tabs = await driver.newTabWithAllowedOrigins(
      privateUrl.href,
      [privateUrl.origin],
    );
    expect(tabs.some((tab) => tab.url === privateUrl.href)).toBe(true);
    expect(requests).toBe(1);

    driver.setActivePageAllowedOrigins([]);
    await expect(driver.navigate({ url: privateUrl.href })).rejects.toBeDefined();
    expect(requests).toBe(1);

    driver.enablePrivateOrigin(deniedUrl.origin);
    driver.setActivePageAllowedOrigins([deniedUrl.origin]);
    await expect(driver.navigate({ url: deniedUrl.href })).rejects.toBeDefined();
    expect(requests).toBe(1);
  });
});

async function createDriver(
  privateUrl: URL,
  deniedUrl: URL,
  suppliedPolicy?: AuthorizedSitePolicy,
): Promise<DirectPlaywrightDriver> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "private-site-network-"));
  directories.push(directory);
  const config: BrowserWorkerConfig = {
    host: "127.0.0.1",
    port: 3350,
    token: "x".repeat(32),
    mode: "interactive",
    profileMode: "persistent",
    browserChannel: "chromium",
    headless: true,
    userDataDirectory: path.join(directory, "private", "chrome-profile"),
    maxPayloadBytes: 4 * 1024 * 1024,
    maxOwnedTabs: 8,
    maxConcurrentTabs: 4,
    runtimeDirectory: directory,
    privateDirectory: path.join(directory, "private"),
    primaryPrivateSiteUrl: privateUrl,
    privateSitePolicies: [suppliedPolicy ?? authorizedSitePolicySchema.parse({
      siteId: "private-test",
      entryUrl: privateUrl.href,
      allowedOrigins: [privateUrl.origin],
      deniedOrigins: [deniedUrl.origin],
      accessMode: "business-read-only",
      loginStrategy: "none",
    })],
    connectTimeoutMs: 30_000,
    operationTimeoutMs: 30_000,
    actionTimeoutMs: 5_000,
    navigationTimeoutMs: 10_000,
    outputMaxBytes: 64 * 1024 * 1024,
    diagnosticTimeoutMs: 30_000,
    diagnosticRetentionMs: 60_000,
    diagnosticMaxArtifacts: 20,
    diagnosticMaxEntries: 100,
  };
  const driver = new DirectPlaywrightDriver(config);
  drivers.push(driver);
  await driver.connect();
  return driver;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  return address.port;
}
