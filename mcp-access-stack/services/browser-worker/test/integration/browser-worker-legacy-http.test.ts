import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { abortSignalError, AppError, type OperationContext } from "@vs-code-gpt/shared";
import { afterEach, describe, expect, it } from "@jest/globals";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";
import { BrowserWorkerApplication } from "../../controllers/browser-worker-application.js";
import type { BrowserRuntime } from "../../services/browser-runtime.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })),
  );
});

describe("BrowserWorkerApplication legacy operations", () => {
  it("dispatches a read-only profile operation through the authenticated HTTP boundary", async () => {
    const runtime = {
      readiness: async () => ({ ready: true }),
      profilePage: async (input: { tabId: string }) => ({
        tabId: input.tabId,
        profile: "legacy-frames" as const,
        signals: {
          frames: 2,
          nestedFrames: 0,
          layoutTables: 1,
          inlineHandlers: 1,
          hashLinks: 1,
          targetedNavigation: 1,
          postForms: 0,
        },
        pageSignature: "page-1",
        frameGraphSignature: "frames-1",
        frames: [],
        telemetry: { totalMs: 2, retries: 0 },
      }),
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);

    const response = await operation(baseUrl, token, "profilePage", {
      tabId: "tab-1",
      maxDepth: 4,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: {
        tabId: "tab-1",
        profile: "legacy-frames",
        pageSignature: "page-1",
      },
    });
  });

  it("propagates an HTTP client abort to the running legacy operation", async () => {
    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    let operationSignal: AbortSignal | undefined;
    const runtime = {
      readiness: async () => ({ ready: true }),
      frameSequence: async (_input: unknown, context?: OperationContext) => {
        operationSignal = context?.signal;
        enteredResolve?.();
        await new Promise<never>((_resolve, reject) => {
          const signal = context?.signal;
          if (!signal) {
            reject(new Error("Missing operation signal."));
            return;
          }
          const onAbort = (): void => reject(abortSignalError(signal));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);
    const controller = new AbortController();

    const pending = fetch(new URL("/operations", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        operation: "frameSequence",
        input: { tabId: "tab-1", steps: [{ action: "index" }] },
      }),
      signal: controller.signal,
    });
    await entered;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitUntil(() => operationSignal?.aborted === true);
    expect(operationSignal?.reason).toMatchObject({ code: "OPERATION_CANCELLED" });
  });

  it("preserves a typed ambiguity error across the HTTP boundary", async () => {
    const runtime = {
      readiness: async () => ({ ready: true }),
      frameSequence: async () => {
        throw new AppError(
          "LOCATOR_AMBIGUOUS",
          "Legacy locator matched multiple equivalent candidates.",
        );
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);

    const response = await operation(baseUrl, token, "frameSequence", {
      tabId: "tab-1",
      steps: [{ action: "click", locator: { text: "Histórico" } }],
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "LOCATOR_AMBIGUOUS",
        message: "Legacy locator matched multiple equivalent candidates.",
      },
    });
  });
});

async function operation(
  baseUrl: URL,
  token: string,
  operationName: string,
  input: unknown,
): Promise<Response> {
  return fetch(new URL("/operations", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operation: operationName, input }),
  });
}

async function startApplication(runtime: BrowserRuntime): Promise<{ baseUrl: URL; token: string }> {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "browser-legacy-http-"));
  directories.push(runtimeDirectory);
  const token = "l".repeat(32);
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
  };
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
async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition was not reached before the test deadline.");
}
