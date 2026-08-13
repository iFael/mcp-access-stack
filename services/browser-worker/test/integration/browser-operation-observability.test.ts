import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";
import { BrowserWorkerApplication } from "../../controllers/browser-worker-application.js";
import { BrowserOperationTelemetry } from "../../infrastructure/browser-operation-telemetry.js";
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

describe("Browser Worker operation observability", () => {
  it("correlates a successful operation without persisting owner, call id or payload values", async () => {
    const runtime = {
      click: async (input: { tabId: string }) => ({ tabId: input.tabId, completed: true }),
    } as unknown as BrowserRuntime;
    const fixture = await startApplication(runtime);
    const traceId = "a".repeat(32);

    const response = await callClick(fixture, {
      traceId,
      ownerScope: "owner-sensitive-value",
      callId: "call-sensitive-value",
      ref: "ref-sensitive-value",
    });
    expect(response.status).toBe(200);
    await fixture.telemetry.flush();

    const telemetry = await readFile(fixture.telemetry.filePath, "utf8");
    expect(telemetry).toContain(`"traceId":"${traceId}"`);
    expect(telemetry).toContain('"event":"browser_operation_started"');
    expect(telemetry).toContain('"event":"browser_operation_completed"');
    expect(telemetry).toContain('"idempotencyDisposition":"miss"');
    expect(telemetry).not.toContain("owner-sensitive-value");
    expect(telemetry).not.toContain("call-sensitive-value");
    expect(telemetry).not.toContain("ref-sensitive-value");
  });

  it("classifies policy and browser-context failures without logging private values", async () => {
    for (const [code, expectedLayer] of [
      ["TASK_OWNERSHIP_MISMATCH", "policy"],
      ["BROWSER_CONTEXT_RECOVERY_FAILED", "browser_context"],
    ] as const) {
      const runtime = {
        click: async () => {
          throw new AppError(code, "sanitized failure");
        },
      } as unknown as BrowserRuntime;
      const fixture = await startApplication(runtime);
      const response = await callClick(fixture, {
        traceId: code === "TASK_OWNERSHIP_MISMATCH" ? "b".repeat(32) : "c".repeat(32),
        ownerScope: "private-owner",
        callId: `private-call-${code}`,
        ref: "private-ref",
      });
      expect(response.status).toBe(code === "BROWSER_CONTEXT_RECOVERY_FAILED" ? 503 : 409);
      await fixture.telemetry.flush();
      const telemetry = await readFile(fixture.telemetry.filePath, "utf8");
      expect(telemetry).toContain(`"failureLayer":"${expectedLayer}"`);
      expect(telemetry).toContain(`"reason":"${code}"`);
      expect(telemetry).not.toContain("private-owner");
      expect(telemetry).not.toContain("private-ref");
    }
  });

  it("distinguishes executor timeout from a request that expires while queued", async () => {
    const runtime = {
      click: async () => new Promise<never>(() => undefined),
    } as unknown as BrowserRuntime;
    const fixture = await startApplication(runtime, {
      operationTimeoutMs: 40,
      maxConcurrentTabs: 1,
    });

    const first = callClick(fixture, {
      traceId: "d".repeat(32),
      ownerScope: "owner-a",
      callId: "call-a",
      ref: "e1",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = callClick(fixture, {
      traceId: "e".repeat(32),
      ownerScope: "owner-a",
      callId: "call-b",
      ref: "e2",
    });

    expect((await first).status).toBe(504);
    expect((await second).status).toBe(504);
    await fixture.telemetry.flush();
    const telemetry = await readFile(fixture.telemetry.filePath, "utf8");
    expect(telemetry).toContain('"failureLayer":"executor"');
    expect(telemetry).toContain('"failureLayer":"queue"');
  });
});

interface Fixture {
  baseUrl: URL;
  token: string;
  telemetry: BrowserOperationTelemetry;
}

async function callClick(
  fixture: Fixture,
  input: { traceId: string; ownerScope: string; callId: string; ref: string },
): Promise<Response> {
  return fetch(new URL("/operations", fixture.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.token}`,
      "content-type": "application/json",
      "x-mcp-operation-trace": input.traceId,
      "x-mcp-owner-scope": input.ownerScope,
      "x-mcp-call-id": input.callId,
    },
    body: JSON.stringify({
      operation: "click",
      input: { tabId: "tab-private-value", ref: input.ref },
    }),
  });
}

async function startApplication(
  runtime: BrowserRuntime,
  overrides: Partial<BrowserWorkerConfig> = {},
): Promise<Fixture> {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "browser-observability-http-"));
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
    ...overrides,
  };
  const telemetry = new BrowserOperationTelemetry(runtimeDirectory);
  const application = new BrowserWorkerApplication(config, runtime, telemetry);
  const server = createServer((request, response) => void application.handle(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected server address.");
  return { baseUrl: new URL(`http://127.0.0.1:${address.port}`), token, telemetry };
}
