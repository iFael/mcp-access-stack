import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  AppError,
  type BrowserArtifact,
  type BrowserArtifactCollection,
} from "@vs-code-gpt/shared";
import { afterEach, describe, expect, it } from "@jest/globals";
import { BrowserWorkerClient } from "../../../mcp-gateway/src/browser/client.js";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";
import { BrowserWorkerApplication } from "../../controllers/browser-worker-application.js";
import type {
  BrowserAdvancedDriver,
  BrowserConsoleOptions,
  BrowserDiagnosticTextResult,
  BrowserDiagnosticsOptions,
  BrowserDiagnosticsResult,
  BrowserNetworkDetail,
  BrowserNetworkOptions,
  BrowserPdfOptions,
  BrowserVideoOptions,
} from "../../drivers/browser-advanced-driver.js";
import type { BrowserAdvancedReadinessSnapshot } from "../../services/browser-readiness.js";
import { BrowserRuntime } from "../../services/browser-runtime.js";
import { FakeDirectDriver } from "../support/fake-direct-driver.js";

const servers: Server[] = [];
const runtimes: BrowserRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.shutdown()));
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Browser Worker advanced HTTP integration", () => {
  it("keeps readiness healthy while advertising unavailable video without FFmpeg", async () => {
    const harness = await startHarness({ ffmpegAvailable: false });
    await connectAndGetTab(harness.client);

    const response = await fetch(new URL("/health/ready", harness.baseUrl));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "ready",
      ready: true,
      mode: "diagnostic",
      driver: "direct",
      advancedCapabilitiesAvailable: true,
      capabilities: {
        console: true,
        network: true,
        trace: true,
        video: false,
        pdf: true,
        diagnostics: true,
      },
      ffmpegAvailable: false,
    });
  });

  it("executes the advanced public HTTP surface and stores artifacts privately", async () => {
    const harness = await startHarness();
    const tabId = await connectAndGetTab(harness.client);

    await expect(
      harness.client.console({ tabId, level: "debug", clear: true }),
    ).resolves.toMatchObject({ tabId, text: "console output" });
    await expect(
      harness.client.networkList({ tabId, includeStatic: true, filter: "/api" }),
    ).resolves.toMatchObject({ tabId, text: "network output" });
    await expect(
      harness.client.networkInspect({
        tabId,
        index: 2,
        detail: "response-headers",
      }),
    ).resolves.toMatchObject({ tabId, text: "request 2 response-headers" });

    await expect(harness.client.traceStart({ tabId })).resolves.toMatchObject({
      tabId,
      active: true,
    });
    await expect(harness.client.traceStop({ tabId })).resolves.toMatchObject({
      tabId,
      kind: "trace",
      totalBytes: 5,
    });
    await expect(
      harness.client.videoStart({
        tabId,
        filename: "flow.webm",
        width: 800,
        height: 600,
      }),
    ).resolves.toMatchObject({ tabId, active: true });
    await expect(harness.client.videoStop({ tabId })).resolves.toMatchObject({
      tabId,
      kind: "video",
      sizeBytes: 7,
    });
    await expect(
      harness.client.pdf({ tabId, filename: "page.pdf" }),
    ).resolves.toMatchObject({ tabId, kind: "pdf", sizeBytes: 3 });
    await expect(
      harness.client.diagnostics({
        tabId,
        consoleLevel: "warning",
        includeStaticRequests: true,
      }),
    ).resolves.toMatchObject({
      tabId,
      console: { text: "console output" },
      network: { text: "network output" },
    });

    expect(harness.driver.callsLog).toEqual([
      "console:debug:true",
      "network:true:/api:false",
      "network-inspect:2:response-headers",
      "trace-start",
      "trace-stop",
      "video-start:flow.webm:800x600",
      "video-stop",
      "pdf:page.pdf",
      "diagnostics:warning:true",
    ]);
    expect(harness.driver.artifactPaths.every((value) =>
      value.startsWith(harness.config.privateDirectory),
    )).toBe(true);
  });

  it("redacts secrets at the runtime boundary", async () => {
    const harness = await startHarness();
    const tabId = await connectAndGetTab(harness.client);
    harness.driver.consoleText = [
      "authorization: Bearer raw-secret",
      "set-cookie: session=private",
      "https://example.com/?access_token=hidden",
      '{"password":"unsafe"}',
    ].join("\n");

    const result = await harness.client.console({ tabId, level: "debug" });

    expect(result.text).not.toContain("raw-secret");
    expect(result.text).not.toContain("session=private");
    expect(result.text).not.toContain("hidden");
    expect(result.text).not.toContain("unsafe");
    expect(result.text).toContain("[redacted]");
  });

  it("serializes concurrent diagnostics for the same page", async () => {
    const harness = await startHarness({ diagnosticDelayMs: 40 });
    const tabId = await connectAndGetTab(harness.client);

    const [consoleResult, networkResult] = await Promise.all([
      harness.client.console({ tabId, level: "info" }),
      harness.client.networkList({ tabId, filter: "example" }),
    ]);

    expect(consoleResult.text).toBe("console output");
    expect(networkResult.text).toBe("network output");
    expect(harness.driver.maxConcurrentDiagnostics).toBe(1);
  });

  it("returns the worker diagnostic timeout before the client deadline", async () => {
    const harness = await startHarness({
      diagnosticDelayMs: 120,
      diagnosticTimeoutMs: 25,
    });
    const tabId = await connectAndGetTab(harness.client);

    await expect(harness.client.console({ tabId })).rejects.toMatchObject({
      code: "BROWSER_WORKER_TIMEOUT",
      message: expect.stringContaining("configured timeout"),
    });
    await delay(140);
  });

  it("cleans active trace and video state during runtime shutdown", async () => {
    const harness = await startHarness();
    const tabId = await connectAndGetTab(harness.client);
    await harness.client.traceStart({ tabId });
    await harness.client.videoStart({ tabId, filename: "cleanup.webm" });

    await harness.runtime.shutdown();
    runtimes.splice(runtimes.indexOf(harness.runtime), 1);

    expect(harness.driver.closed).toBe(true);
    expect(harness.driver.traceActive).toBe(false);
    expect(harness.driver.videoActive).toBe(false);
    expect(harness.driver.cleanupCount).toBe(2);
  });
});

interface HarnessOptions {
  diagnosticDelayMs?: number;
  ffmpegAvailable?: boolean;
  maxPayloadBytes?: number;
  diagnosticTimeoutMs?: number;
}

async function startHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-advanced-http-"));
  directories.push(root);
  const config = makeConfig(root, options.maxPayloadBytes ?? 1024 * 1024);
  config.diagnosticTimeoutMs = options.diagnosticTimeoutMs ?? config.diagnosticTimeoutMs;
  const driver = new IntegrationAdvancedDriver(config.privateDirectory, options);
  const runtime = await BrowserRuntime.create(config, () => driver);
  runtimes.push(runtime);
  const application = new BrowserWorkerApplication(config, runtime);
  const server = createServer((request, response) => {
    void application.handle(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected browser worker server address.");
  }
  const baseUrl = new URL(`http://127.0.0.1:${address.port}`);
  const client = new BrowserWorkerClient({
    url: baseUrl,
    token: config.token,
    timeoutMs: 2_000,
    maxPayloadBytes: 4 * 1024 * 1024,
  });
  return { baseUrl, client, config, driver, runtime };
}

async function connectAndGetTab(client: BrowserWorkerClient): Promise<string> {
  await client.connect({});
  const [tab] = (await client.tabs({})).tabs;
  if (!tab) throw new Error("Expected a browser worker owned tab.");
  return tab.tabId;
}

class IntegrationAdvancedDriver extends FakeDirectDriver implements BrowserAdvancedDriver {
  readonly callsLog: string[] = [];
  readonly artifactPaths: string[] = [];
  maxConcurrentDiagnostics = 0;
  consoleText = "console output";
  traceActive = false;
  videoActive = false;
  closed = false;
  cleanupCount = 0;

  private activeDiagnostics = 0;
  private readonly diagnosticDelayMs: number;
  private readonly ffmpegAvailable: boolean;

  constructor(
    private readonly privateDirectory: string,
    options: HarnessOptions,
  ) {
    super();
    this.diagnosticDelayMs = options.diagnosticDelayMs ?? 0;
    this.ffmpegAvailable = options.ffmpegAvailable ?? true;
  }

  override async connect(): Promise<void> {
    await super.connect();
    this.closed = false;
  }

  override async close(): Promise<void> {
    if (this.traceActive) this.cleanupCount += 1;
    if (this.videoActive) this.cleanupCount += 1;
    this.traceActive = false;
    this.videoActive = false;
    await super.close();
    this.closed = true;
  }

  async getAdvancedReadiness(): Promise<BrowserAdvancedReadinessSnapshot> {
    let artifactStorageBytes = 0;
    let artifactCount = 0;
    for (const value of new Set(this.artifactPaths)) {
      const metadata = await stat(value).catch(() => undefined);
      if (!metadata?.isFile()) continue;
      artifactStorageBytes += metadata.size;
      artifactCount += 1;
    }
    return {
      ffmpegAvailable: this.ffmpegAvailable,
      activeTraces: this.traceActive ? 1 : 0,
      activeVideos: this.videoActive ? 1 : 0,
      artifactStorageBytes,
      artifactCount,
    };
  }

  async readConsole(
    options: BrowserConsoleOptions = {},
  ): Promise<BrowserDiagnosticTextResult> {
    this.callsLog.push(`console:${options.level ?? "info"}:${options.clear ?? false}`);
    return this.withDiagnosticDelay(() => diagnosticText(this.consoleText));
  }

  async listNetwork(
    options: BrowserNetworkOptions = {},
  ): Promise<BrowserDiagnosticTextResult> {
    this.callsLog.push(
      `network:${options.includeStatic ?? false}:${options.filter ?? ""}:${options.clear ?? false}`,
    );
    return this.withDiagnosticDelay(() => diagnosticText("network output"));
  }

  async inspectNetworkRequest(
    index: number,
    detail: BrowserNetworkDetail = "request",
  ): Promise<BrowserDiagnosticTextResult> {
    this.callsLog.push(`network-inspect:${index}:${detail}`);
    return diagnosticText(`request ${index} ${detail}`);
  }

  async startTrace(): Promise<void> {
    if (this.traceActive) {
      throw new AppError("INVALID_ARGUMENT", "Trace is already active.");
    }
    this.callsLog.push("trace-start");
    this.traceActive = true;
  }

  async stopTrace(): Promise<BrowserArtifactCollection> {
    if (!this.traceActive) {
      throw new AppError("INVALID_ARGUMENT", "Trace is not active.");
    }
    this.callsLog.push("trace-stop");
    this.traceActive = false;
    const artifact = await this.writeArtifact("trace", "trace.zip", "trace");
    return {
      kind: "trace",
      files: [artifact],
      totalBytes: artifact.sizeBytes,
      createdAt: artifact.createdAt,
    };
  }

  async startVideo(options: BrowserVideoOptions = {}): Promise<{ path: string }> {
    if (!this.ffmpegAvailable) {
      throw new AppError(
        "BROWSER_WORKER_UNAVAILABLE",
        "Dynamic Playwright video recording requires FFmpeg.",
      );
    }
    this.callsLog.push(
      `video-start:${options.filename ?? "video.webm"}:${options.width ?? ""}x${options.height ?? ""}`,
    );
    this.videoActive = true;
    const value = path.join(this.privateDirectory, options.filename ?? "video.webm");
    this.artifactPaths.push(value);
    return { path: value };
  }

  async stopVideo(): Promise<BrowserArtifact> {
    if (!this.videoActive) {
      throw new AppError("INVALID_ARGUMENT", "Video is not active.");
    }
    this.callsLog.push("video-stop");
    this.videoActive = false;
    return this.writeArtifact("video", "flow.webm", "video-1");
  }

  async savePdf(options: BrowserPdfOptions = {}): Promise<BrowserArtifact> {
    this.callsLog.push(`pdf:${options.filename ?? "page.pdf"}`);
    return this.writeArtifact("pdf", options.filename ?? "page.pdf", "pdf");
  }

  async collectDiagnostics(
    options: BrowserDiagnosticsOptions = {},
  ): Promise<BrowserDiagnosticsResult> {
    this.callsLog.push(
      `diagnostics:${options.consoleLevel ?? "info"}:${options.includeStaticRequests ?? false}`,
    );
    const collectedAt = new Date().toISOString();
    return {
      console: diagnosticText("console output", collectedAt),
      network: diagnosticText("network output", collectedAt),
      traceActive: this.traceActive,
      videoActive: this.videoActive,
      collectedAt,
    };
  }

  private async withDiagnosticDelay<T>(task: () => T): Promise<T> {
    this.activeDiagnostics += 1;
    this.maxConcurrentDiagnostics = Math.max(
      this.maxConcurrentDiagnostics,
      this.activeDiagnostics,
    );
    try {
      if (this.diagnosticDelayMs > 0) await delay(this.diagnosticDelayMs);
      return task();
    } finally {
      this.activeDiagnostics -= 1;
    }
  }

  private async writeArtifact(
    kind: BrowserArtifact["kind"],
    filename: string,
    contents: string,
  ): Promise<BrowserArtifact> {
    const value = path.join(this.privateDirectory, filename);
    await mkdir(path.dirname(value), { recursive: true });
    await writeFile(value, contents, "utf8");
    this.artifactPaths.push(value);
    return {
      kind,
      path: value,
      sizeBytes: Buffer.byteLength(contents),
      createdAt: new Date().toISOString(),
    };
  }
}

function diagnosticText(
  text: string,
  collectedAt = new Date().toISOString(),
): BrowserDiagnosticTextResult {
  return { text, truncated: false, collectedAt };
}

function makeConfig(root: string, maxPayloadBytes: number): BrowserWorkerConfig {
  return {
    host: "127.0.0.1",
    port: 3350,
    token: "t".repeat(32),
    mode: "diagnostic",
    maxPayloadBytes,
    runtimeDirectory: path.join(root, "runtime"),
    privateDirectory: path.join(root, "private"),
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
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
