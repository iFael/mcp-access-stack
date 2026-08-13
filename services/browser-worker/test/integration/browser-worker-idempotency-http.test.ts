import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";
import { BrowserWorkerApplication } from "../../controllers/browser-worker-application.js";
import type { BrowserRuntime } from "../../services/browser-runtime.js";

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve) => server.close(() => resolve())),
  ));
  await Promise.all(directories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe("Browser Worker HTTP idempotency boundaries", () => {
  it("scopes identical call ids by owner so different principals never share an execution", async () => {
    let clicks = 0;
    const runtime = {
      click: async (input: { tabId: string }) => {
        clicks += 1;
        return { tabId: input.tabId, completed: true };
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);

    const first = await callMutation(baseUrl, token, "owner-a", "shared-call", "e1");
    const second = await callMutation(baseUrl, token, "owner-b", "shared-call", "e1");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(clicks).toBe(2);
  });

  it("retains a failed mutation outcome so a response-loss retry cannot execute twice", async () => {
    let clicks = 0;
    const runtime = {
      click: async () => {
        clicks += 1;
        throw new AppError(
          "BROWSER_DISCONNECTED",
          "The mutation completed but its response became unavailable.",
        );
      },
    } as unknown as BrowserRuntime;
    const { baseUrl, token } = await startApplication(runtime);

    const first = await callMutation(baseUrl, token, "owner-a", "ambiguous-call", "e1");
    const retry = await callMutation(baseUrl, token, "owner-a", "ambiguous-call", "e1");

    expect(first.status).toBe(503);
    expect(retry.status).toBe(503);
    await expect(first.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "BROWSER_DISCONNECTED" },
    });
    await expect(retry.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "BROWSER_DISCONNECTED" },
    });
    expect(clicks).toBe(1);
  });
});

async function callMutation(
  baseUrl: URL,
  token: string,
  ownerScope: string,
  callId: string,
  ref: string,
): Promise<Response> {
  return fetch(new URL("/operations", baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-mcp-owner-scope": ownerScope,
      "x-mcp-call-id": callId,
    },
    body: JSON.stringify({
      operation: "click",
      input: { tabId: "tab-1", ref },
    }),
  });
}

async function startApplication(
  runtime: BrowserRuntime,
): Promise<{ baseUrl: URL; token: string }> {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "browser-idempotency-http-"));
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
