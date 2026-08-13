import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { BrowserWorkerApplication } from "../../controllers/browser-worker-application.js";
import { BrowserRuntime } from "../../services/browser-runtime.js";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("BrowserWorkerApplication", () => {
  it("treats auto-connect idle as ready while exposing connection state and requiring authentication", async () => {
    const { baseUrl, token } = await startApplication();

    const live = await fetch(new URL("/health/live", baseUrl));
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "live" });

    const ready = await fetch(new URL("/health/ready", baseUrl));
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({
      status: "idle",
      ready: true,
      connected: false,
      mode: "interactive",
      driver: "direct",
      advancedCapabilitiesAvailable: false,
      capabilities: {
        console: false,
        network: false,
        trace: false,
        video: false,
        pdf: false,
        diagnostics: false,
      },
      ffmpegAvailable: expect.any(Boolean),
      activeTraces: 0,
      activeVideos: 0,
      artifactStorageBytes: 0,
      artifactCount: 0,
    });

    const unauthorized = await fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "status", input: {} }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "status", input: {} }),
    });
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      ok: true,
      result: { state: "disconnected", ready: false, browser: "chrome" },
    });
  });
  it("dispatches private-site authorization with owner scope", async () => {
    const openAuthorizedSite = jest.fn(async (
      input: { siteId: string; purpose: string },
      context: { ownerScope?: string },
    ) => ({
      status: "confirmation_required" as const,
      taskId: "task-private",
      siteId: input.siteId,
      confirmationId: "site-confirm-private",
      expiresAt: "2026-08-02T20:00:00.000Z",
      reasons: [input.purpose],
    }));
    const runtime = {
      isReady: () => true,
      openAuthorizedSite,
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);

    const response = await fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        "x-mcp-owner-scope": "principal:opaque",
      },
      body: JSON.stringify({
        operation: "openAuthorizedSite",
        input: { siteId: "private-site", purpose: "read-report" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        status: "confirmation_required",
        taskId: "task-private",
        siteId: "private-site",
        confirmationId: "site-confirm-private",
      },
    });
    expect(openAuthorizedSite).toHaveBeenCalledWith(
      { siteId: "private-site", purpose: "read-report" },
      expect.objectContaining({ ownerScope: "principal:opaque" }),
    );
  });

  it("maps permanently blocked production origins to forbidden", async () => {
    const runtime = {
      isReady: () => true,
      open: async () => {
        throw new AppError(
          "SITE_PRODUCTION_BLOCKED",
          "Production origin is blocked.",
        );
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);
    const response = await fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: "open",
        input: { url: "https://private.example.test/app" },
      }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "SITE_PRODUCTION_BLOCKED" },
    });
  });

  it("dispatches advanced operations through the authenticated public API", async () => {
    const collectedAt = "2026-07-02T14:30:00.000Z";
    const runtime = {
      isReady: () => true,
      console: async (input: { tabId: string }) => ({
        tabId: input.tabId,
        text: "sanitized console",
        truncated: false,
        collectedAt,
      }),
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);

    const response = await fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: "console",
        input: { tabId: "tab-1", level: "debug" },
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      result: {
        tabId: "tab-1",
        text: "sanitized console",
        truncated: false,
        collectedAt,
      },
    });

    const invalid = await fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "console", input: {} }),
    });
    expect(invalid.status).toBe(400);
  });

  it("propagates operation deadline and cancellation context to read operations", async () => {
    const contexts: Array<{ hasDeadline: boolean; hasSignal: boolean }> = [];
    const captureContext = (context: { deadline?: unknown; signal?: AbortSignal } | undefined) => {
      contexts.push({
        hasDeadline: context?.deadline !== undefined,
        hasSignal: context?.signal instanceof AbortSignal,
      });
    };
    const runtime = {
      isReady: () => true,
      snapshot: async (input: { tabId: string }, context?: { deadline?: unknown; signal?: AbortSignal }) => {
        captureContext(context);
        return { tabId: input.tabId, url: "https://example.com/", content: "", refs: [] };
      },
      extract: async (input: { tabId: string }, context?: { deadline?: unknown; signal?: AbortSignal }) => {
        captureContext(context);
        return { tabId: input.tabId, format: "text", value: "stable" };
      },
      frameExtract: async (input: { tabId: string; frame: string }, context?: { deadline?: unknown; signal?: AbortSignal }) => {
        captureContext(context);
        return { tabId: input.tabId, frame: input.frame, format: "text", value: "stable-frame" };
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);
    for (const body of [
      { operation: "snapshot", input: { tabId: "tab-1" } },
      { operation: "extract", input: { tabId: "tab-1" } },
      { operation: "frameExtract", input: { tabId: "tab-1", frame: "content" } },
    ]) {
      const response = await fetch(new URL("/operations", baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }
    expect(contexts).toEqual([
      { hasDeadline: true, hasSignal: true },
      { hasDeadline: true, hasSignal: true },
      { hasDeadline: true, hasSignal: true },
    ]);
  });

  it("serializes concurrent operations that share the current browser tab", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const runtime = {
      isReady: () => true,
      snapshot: async (input: { tabId: string }) => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        try {
          if (calls === 1) {
            firstEntered?.();
            await firstGate;
          }
          return {
            tabId: input.tabId,
            url: "https://example.com/",
            title: "Serialized",
            content: "",
            refs: [],
          };
        } finally {
          active -= 1;
        }
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);
    const request = () => fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "snapshot", input: { tabId: "tab-1" } }),
    });

    const first = request();
    await entered;
    const second = request();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(1);

    releaseFirst?.();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("keeps a timed-out operation serialized until the underlying browser action settles", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let calls = 0;
    const runtime = {
      isReady: () => true,
      snapshot: async (input: { tabId: string }) => {
        calls += 1;
        if (calls === 1) {
          firstEntered?.();
          await firstGate;
        }
        return {
          tabId: input.tabId,
          url: "https://example.com/",
          content: "",
          refs: [],
        };
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime, {
      operationTimeoutMs: 30,
    });
    const request = () => fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "snapshot", input: { tabId: "tab-1" } }),
    });

    const first = request();
    await entered;
    const second = request();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([504, 504]);
    expect(calls).toBe(1);

    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(1);
  });

  it("deduplicates mutating retries by MCP call id", async () => {
    let clicks = 0;
    const runtime = {
      isReady: () => true,
      click: async (input: { tabId: string }) => {
        clicks += 1;
        return { tabId: input.tabId, completed: true };
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);
    const request = () => fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-mcp-call-id": "call-retry-123",
      },
      body: JSON.stringify({
        operation: "click",
        input: { tabId: "tab-1", ref: "e1" },
      }),
    });

    const [first, retry] = await Promise.all([request(), request()]);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      ok: true,
      result: { tabId: "tab-1", completed: true },
    });
    await expect(retry.json()).resolves.toEqual({
      ok: true,
      result: { tabId: "tab-1", completed: true },
    });
    expect(clicks).toBe(1);
  });

  it("returns a specific conflict when a call id is reused for another mutation", async () => {
    let clicks = 0;
    const runtime = {
      isReady: () => true,
      click: async (input: { tabId: string }) => {
        clicks += 1;
        return { tabId: input.tabId, completed: true };
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);
    const request = (ref: string) => fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "x-mcp-call-id": "call-conflict-123",
      },
      body: JSON.stringify({
        operation: "click",
        input: { tabId: "tab-1", ref },
      }),
    });

    expect((await request("e1")).status).toBe(200);
    const conflict = await request("e2");

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "IDEMPOTENCY_KEY_CONFLICT",
        message: "The idempotency key is already associated with a different browser operation fingerprint.",
      },
    });
    expect(clicks).toBe(1);
  });

  it("exposes sanitized idempotency metrics on connect and status results", async () => {
    const status = {
      state: "connected",
      ready: true,
      browser: "chrome",
      profile: "dedicated-persistent",
      autoLaunch: true,
      tabGroup: "MCP",
      edgeFallback: "technical-necessity-only",
      tabCount: 0,
    } as const;
    const runtime = {
      isReady: () => true,
      connect: async () => status,
      status: async () => status,
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);
    const call = (operation: "connect" | "status", callId?: string) => fetch(
      new URL("/operations", baseUrl),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          ...(callId === undefined ? {} : { "x-mcp-call-id": callId }),
        },
        body: JSON.stringify({ operation, input: {} }),
      },
    );

    const first = await call("connect", "connect-metrics-1");
    const retry = await call("connect", "connect-metrics-1");
    const read = await call("status");

    await expect(first.json()).resolves.toMatchObject({
      ok: true,
      result: {
        idempotency: {
          entries: 1,
          hits: 0,
          misses: 1,
          conflicts: 0,
          evictions: 0,
          expirations: 0,
        },
      },
    });
    await expect(retry.json()).resolves.toMatchObject({
      ok: true,
      result: { idempotency: { entries: 1, hits: 1, misses: 1 } },
    });
    await expect(read.json()).resolves.toMatchObject({
      ok: true,
      result: { idempotency: { entries: 1, hits: 1, misses: 1 } },
    });
  });

  it("maps context recovery failure to a structured service-unavailable response", async () => {
    const runtime = {
      isReady: () => false,
      tabs: async () => {
        throw new AppError(
          "BROWSER_CONTEXT_RECOVERY_FAILED",
          "The Browser Worker could not restore a usable browser context.",
        );
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);

    const response = await fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operation: "tabs", input: {} }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "BROWSER_CONTEXT_RECOVERY_FAILED",
        message: "The Browser Worker could not restore a usable browser context.",
      },
    });
  });

  it("returns stable policy errors for advanced operations outside diagnostic mode", async () => {
    const runtime = {
      isReady: () => true,
      console: async () => {
        throw new AppError(
          "BROWSER_OPERATION_MODE_UNSUPPORTED",
          "Browser operation console requires diagnostic mode.",
        );
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);

    const response = await fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: "console",
        input: { tabId: "tab-1" },
      }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "BROWSER_OPERATION_MODE_UNSUPPORTED",
        message: "Browser operation console requires diagnostic mode.",
      },
    });
  });
});

async function startApplication(
  runtimeOverride?: BrowserRuntime,
  configOverrides: Partial<BrowserWorkerConfig> = {},
): Promise<{ baseUrl: URL; token: string }> {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "browser-http-"));
  directories.push(runtimeDirectory);
  const token = "t".repeat(32);
  const config: BrowserWorkerConfig = {
    host: "127.0.0.1",
    port: 3350,
    token,
    mode: "interactive",
    maxPayloadBytes: 1024 * 1024,
    runtimeDirectory,
    privateDirectory: path.join(runtimeDirectory, "private"),
    primaryPrivateSiteUrl: new URL("https://dev-private.example.test/app"),
    connectTimeoutMs: 5_000,
    operationTimeoutMs: 5_000,
    actionTimeoutMs: 1_000,
    navigationTimeoutMs: 5_000,
    outputMaxBytes: 16 * 1024 * 1024,
    diagnosticTimeoutMs: 10_000,
    diagnosticRetentionMs: 7 * 24 * 60 * 60 * 1_000,
    diagnosticMaxArtifacts: 500,
    diagnosticMaxEntries: 500,
    ...configOverrides,
  };
  const runtime = runtimeOverride ?? await BrowserRuntime.create(config);
  const application = new BrowserWorkerApplication(config, runtime);
  const server = createServer((request, response) => void application.handle(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected server address.");
  return { baseUrl: new URL(`http://127.0.0.1:${address.port}`), token };
}
