import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { BrowserExecutor, BrowserTab } from "@vs-code-gpt/shared";
import { BrowserWorkerClient } from "../../../services/mcp-gateway/src/browser/client.js";
import { McpBrowserSmokeClient } from "./mcp-browser-smoke-client.js";

const WORKER_START_TIMEOUT_MS = 45_000;
const WORKER_OPERATION_TIMEOUT_MS = 150_000;
const WORKER_STOP_TIMEOUT_MS = 15_000;
const MAX_CAPTURED_LOG_BYTES = 64 * 1024;

interface WorkerReadiness {
  status: "ready" | "disconnected";
  ready: boolean;
  mode: string;
  driver: string;
  advancedCapabilitiesAvailable: boolean;
  capabilities: {
    console: boolean;
    network: boolean;
    trace: boolean;
    video: boolean;
    pdf: boolean;
    diagnostics: boolean;
  };
  ffmpegAvailable: boolean;
  activeTraces: number;
  activeVideos: number;
  artifactStorageBytes: number;
  artifactCount: number;
}

interface SmokeResult {
  target: "worker-advanced" | "mcp-public-advanced";
  live: boolean;
  ready: boolean;
  mode: string;
  driver: string;
  ffmpegAvailable: boolean;
  advancedCapabilitiesAvailable: boolean;
  baselineOwnedTabs: number;
  openedOwnedTabs: number;
  finalOwnedTabs: number;
  allObservedTabsMcpOwned: boolean;
  snapshotHasHeading: boolean;
  extractedHasHeading: boolean;
  screenshotExists: boolean;
  screenshotBytes: number;
  consoleHasMessage: boolean;
  networkHasFixtureRequest: boolean;
  networkInspectBytes: number;
  traceFiles: number;
  traceBytes: number;
  traceFilesExist: boolean;
  traceMetricActive: boolean;
  videoPathMatches: boolean;
  videoBytes: number;
  videoMetricActive: boolean;
  pdfBytes: number;
  diagnosticsConsoleBytes: number;
  diagnosticsNetworkBytes: number;
  diagnosticsInactiveAfterStop: boolean;
  artifactCount: number;
  artifactStorageBytes: number;
  allArtifactsPrivate: boolean;
  cleanupPreservedOwnedRegistry: boolean;
  publicAdvancedTools: number;
  gatewayExited: boolean;
  gatewayPortReleased: boolean;
  workerExited: boolean;
  portReleased: boolean;
}

const viaMcp = process.argv.includes("--via=mcp");
const result = await runAdvancedWorkerSmoke(viaMcp);
process.stdout.write(`${JSON.stringify(result)}\n`);

async function runAdvancedWorkerSmoke(viaMcp: boolean): Promise<SmokeResult> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "browser-worker-advanced-smoke-"),
  );
  const privateDirectory = path.join(root, ".runtime-private", "browser");
  const runtimeDirectory = path.join(root, "runtime");
  const workerPort = await findAvailablePort();
  const gatewayPort = viaMcp ? await findAvailablePort() : undefined;
  const mcpPath = `/mcp-browser-canary-${randomBytes(6).toString("hex")}`;
  const token = randomBytes(32).toString("hex");
  const fixture = await startFixtureServer();
  const worker = startBrowserWorker({
    port: workerPort,
    token,
    privateDirectory,
    runtimeDirectory,
  });
  const workerLogs = captureWorkerLogs(worker);
  const baseUrl = new URL(`http://127.0.0.1:${workerPort}/`);
  const directClient = new BrowserWorkerClient({
    url: baseUrl,
    token,
    timeoutMs: WORKER_OPERATION_TIMEOUT_MS,
    maxPayloadBytes: 16 * 1024 * 1024,
  });

  let client: BrowserExecutor = directClient;
  let gateway: ChildProcessWithoutNullStreams | undefined;
  let gatewayLogs: (() => string) | undefined;
  let publicAdvancedTools = 0;
  let smokeTab: BrowserTab | undefined;
  let gatewayExited = false;
  let gatewayPortReleased = false;
  let workerExited = false;
  let portReleased = false;

  try {
    await waitForLive(baseUrl, worker);
    if (viaMcp) {
      assert(gatewayPort !== undefined, "MCP canary gateway port is missing.");
      gateway = startGateway({
        port: gatewayPort,
        mcpPath,
        workerPort,
        workerToken: token,
      });
      gatewayLogs = captureWorkerLogs(gateway);
      const gatewayBaseUrl = new URL(`http://127.0.0.1:${gatewayPort}/`);
      await waitForLive(gatewayBaseUrl, gateway);
      const mcpClient = new McpBrowserSmokeClient(
        gatewayBaseUrl,
        mcpPath,
        WORKER_OPERATION_TIMEOUT_MS,
      );
      publicAdvancedTools = assertPublicAdvancedTools(await mcpClient.listTools());
      client = mcpClient;
    }
    const initialReadiness = await readReadiness(baseUrl);
    assert(initialReadiness.mode === "diagnostic", "Worker did not start in diagnostic mode.");
    assert(initialReadiness.driver === "direct", "Diagnostic mode did not select the direct driver.");

    const connected = await client.connect({});
    assert(connected.ready, "Browser Worker did not connect to Chrome.");

    const ready = await waitForReady(baseUrl, worker);
    assertReadyCapabilities(ready);
    assert(ready.ffmpegAvailable, "Playwright FFmpeg is unavailable.");

    const baselineTabs = (await client.tabs({})).tabs;
    assertAllTabsMcpOwned(baselineTabs);

    smokeTab = (
      await client.open({
        url: fixture.url.href,
        purpose: `worker-advanced-smoke-${randomUUID()}`,
        reusable: false,
      })
    ).tab;
    assert(smokeTab.ownership === "mcp", "Smoke tab was not registered as MCP-owned.");
    await client.wait({
      tabId: smokeTab.tabId,
      text: "API pong",
      timeoutMs: 15_000,
    });

    const openedTabs = (await client.tabs({})).tabs;
    assertAllTabsMcpOwned(openedTabs);
    assert(
      openedTabs.length === baselineTabs.length + 1,
      "Smoke did not create exactly one isolated MCP-owned tab.",
    );

    const expectedHeading = "Browser Worker Advanced Smoke";
    const snapshot = await client.snapshot({ tabId: smokeTab.tabId });
    const extracted = await client.extract({
      tabId: smokeTab.tabId,
      format: "text",
    });
    const screenshot = await client.screenshot({
      tabId: smokeTab.tabId,
      fullPage: false,
    });
    const snapshotHasHeading = snapshot.content.includes(expectedHeading);
    const extractedHasHeading = String(extracted.value).includes(expectedHeading);
    const screenshotExists = await filesExist([screenshot.path]);
    assert(snapshotHasHeading, "Snapshot did not contain the fixture heading.");
    assert(extractedHasHeading, "Text extraction did not contain the fixture heading.");
    assert(screenshotExists, "Screenshot artifact was not created.");
    assert(screenshot.sizeBytes > 0, "Screenshot artifact is empty.");

    const consoleResult = await client.console({
      tabId: smokeTab.tabId,
      level: "debug",
    });
    const networkResult = await client.networkList({
      tabId: smokeTab.tabId,
      includeStatic: true,
    });
    const networkInspect = await client.networkInspect({
      tabId: smokeTab.tabId,
      index: 1,
      detail: "response-headers",
    });
    assert(
      consoleResult.text.includes("browser-worker-advanced-smoke-console"),
      "Console diagnostics did not contain the fixture message.",
    );
    assert(
      networkResult.text.includes("/api/ping"),
      "Network diagnostics did not contain the fixture request.",
    );
    assert(
      Buffer.byteLength(networkInspect.text) > 0,
      "Network inspection returned an empty response.",
    );

    await client.traceStart({ tabId: smokeTab.tabId });
    const traceReadiness = await readReadiness(baseUrl);
    assert(traceReadiness.activeTraces === 1, "Readiness did not report the active trace.");
    await client.navigate({
      tabId: smokeTab.tabId,
      url: new URL(`/?trace=${randomUUID()}`, fixture.url).href,
    });
    await client.wait({
      tabId: smokeTab.tabId,
      text: "API pong",
      timeoutMs: 15_000,
    });
    const trace = await client.traceStop({ tabId: smokeTab.tabId });

    const videoStart = await client.videoStart({
      tabId: smokeTab.tabId,
      filename: "worker-advanced-smoke.webm",
      width: 800,
      height: 600,
    });
    const videoReadiness = await readReadiness(baseUrl);
    assert(videoReadiness.activeVideos === 1, "Readiness did not report the active video.");
    await client.navigate({
      tabId: smokeTab.tabId,
      url: new URL(`/?video=${randomUUID()}`, fixture.url).href,
    });
    await client.wait({
      tabId: smokeTab.tabId,
      text: "API pong",
      timeoutMs: 15_000,
    });
    await delay(1_000);
    const video = await client.videoStop({ tabId: smokeTab.tabId });
    assert(video.path === videoStart.path, "Video stop returned a different artifact path.");

    const pdf = await client.pdf({
      tabId: smokeTab.tabId,
      filename: "worker-advanced-smoke.pdf",
    });
    const diagnostics = await client.diagnostics({
      tabId: smokeTab.tabId,
      consoleLevel: "debug",
      includeStaticRequests: true,
    });
    assert(
      Buffer.byteLength(diagnostics.console.text) > 0,
      "Diagnostics console output is empty.",
    );
    assert(
      Buffer.byteLength(diagnostics.network.text) > 0,
      "Diagnostics network output is empty.",
    );
    assert(
      !diagnostics.traceActive && !diagnostics.videoActive,
      "Diagnostics reported an active trace or video after stop.",
    );

    const traceFilesExist = await filesExist(trace.files.map((file) => file.path));
    const artifacts = [...trace.files, screenshot, video, pdf];
    const allArtifactsPrivate = artifacts.every((artifact) =>
      isPathInside(privateDirectory, artifact.path),
    );
    assert(traceFilesExist, "Trace artifacts were not created.");
    assert(video.sizeBytes > 0, "Video artifact is empty.");
    assert(pdf.sizeBytes > 0, "PDF artifact is empty.");
    assert(allArtifactsPrivate, "An artifact escaped the private directory.");

    const finalReadiness = await readReadiness(baseUrl);
    assert(finalReadiness.activeTraces === 0, "Trace remained active after traceStop.");
    assert(finalReadiness.activeVideos === 0, "Video remained active after videoStop.");
    assert(finalReadiness.artifactCount >= artifacts.length, "Readiness artifact count is incomplete.");
    assert(finalReadiness.artifactStorageBytes > 0, "Readiness artifact storage metric is empty.");

    await client.closeTab({ tabId: smokeTab.tabId });
    smokeTab = undefined;
    const finalTabs = (await client.tabs({})).tabs;
    assertAllTabsMcpOwned(finalTabs);
    assert(
      finalTabs.length === baselineTabs.length,
      "Smoke cleanup changed the pre-existing MCP-owned tab registry.",
    );

    if (gateway) {
      await stopWorker(gateway);
      gatewayExited = true;
      assert(gatewayPort !== undefined, "MCP canary gateway port is missing.");
      await assertPortAvailable(gatewayPort);
      gatewayPortReleased = true;
    }
    await stopWorker(worker);
    workerExited = true;
    await assertPortAvailable(workerPort);
    portReleased = true;

    return {
      target: viaMcp ? "mcp-public-advanced" : "worker-advanced",
      live: true,
      ready: ready.ready,
      mode: ready.mode,
      driver: ready.driver,
      ffmpegAvailable: ready.ffmpegAvailable,
      advancedCapabilitiesAvailable: ready.advancedCapabilitiesAvailable,
      baselineOwnedTabs: baselineTabs.length,
      openedOwnedTabs: openedTabs.length,
      finalOwnedTabs: finalTabs.length,
      allObservedTabsMcpOwned: true,
      snapshotHasHeading,
      extractedHasHeading,
      screenshotExists,
      screenshotBytes: screenshot.sizeBytes,
      consoleHasMessage: consoleResult.text.includes(
        "browser-worker-advanced-smoke-console",
      ),
      networkHasFixtureRequest: networkResult.text.includes("/api/ping"),
      networkInspectBytes: Buffer.byteLength(networkInspect.text),
      traceFiles: trace.files.length,
      traceBytes: trace.totalBytes,
      traceFilesExist,
      traceMetricActive: traceReadiness.activeTraces === 1,
      videoPathMatches: video.path === videoStart.path,
      videoBytes: video.sizeBytes,
      videoMetricActive: videoReadiness.activeVideos === 1,
      pdfBytes: pdf.sizeBytes,
      diagnosticsConsoleBytes: Buffer.byteLength(diagnostics.console.text),
      diagnosticsNetworkBytes: Buffer.byteLength(diagnostics.network.text),
      diagnosticsInactiveAfterStop:
        !diagnostics.traceActive && !diagnostics.videoActive,
      artifactCount: finalReadiness.artifactCount,
      artifactStorageBytes: finalReadiness.artifactStorageBytes,
      allArtifactsPrivate,
      cleanupPreservedOwnedRegistry: true,
      publicAdvancedTools,
      gatewayExited: viaMcp ? gatewayExited : true,
      gatewayPortReleased: viaMcp ? gatewayPortReleased : true,
      workerExited,
      portReleased,
    };
  } catch (error) {
    throw addWorkerContext(error, () =>
      [gatewayLogs?.(), workerLogs()].filter(Boolean).join("\n"),
    );
  } finally {
    if (smokeTab && worker.exitCode === null) {
      await client.closeTab({ tabId: smokeTab.tabId }).catch(() => undefined);
    }
    if (gateway && !gatewayExited) {
      await stopWorker(gateway).catch(() => undefined);
    }
    if (!workerExited) {
      await stopWorker(worker).catch(() => undefined);
    }
    await fixture.close().catch(() => undefined);
    await removeSmokeRoot(root);
  }
}

function startBrowserWorker(options: {
  port: number;
  token: string;
  privateDirectory: string;
  runtimeDirectory: string;
}): ChildProcessWithoutNullStreams {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BROWSER_WORKER_PORT: String(options.port),
    BROWSER_WORKER_TOKEN: options.token,
    BROWSER_WORKER_MODE: "diagnostic",
    BROWSER_WORKER_PROFILE_MODE: "persistent",
    BROWSER_WORKER_BROWSER_CHANNEL: "chromium",
    BROWSER_WORKER_USER_DATA_DIR: path.join(
      options.privateDirectory,
      "chrome-profile",
    ),
    BROWSER_WORKER_MAX_PAYLOAD_BYTES: String(16 * 1024 * 1024),
    BROWSER_WORKER_RUNTIME_DIR: options.runtimeDirectory,
    BROWSER_WORKER_PRIVATE_DIR: options.privateDirectory,
    BROWSER_WORKER_CONNECT_TIMEOUT_MS: "90000",
    BROWSER_WORKER_OPERATION_TIMEOUT_MS: "90000",
    BROWSER_WORKER_ACTION_TIMEOUT_MS: "10000",
    BROWSER_WORKER_NAVIGATION_TIMEOUT_MS: "90000",
    BROWSER_WORKER_OUTPUT_MAX_BYTES: String(64 * 1024 * 1024),
    BROWSER_WORKER_DIAGNOSTIC_TIMEOUT_MS: "120000",
    BROWSER_WORKER_DIAGNOSTIC_RETENTION_MS: String(60 * 60 * 1000),
    BROWSER_WORKER_DIAGNOSTIC_MAX_ARTIFACTS: "500",
    BROWSER_WORKER_DIAGNOSTIC_MAX_ENTRIES: "500",
  };
  const worker = spawn(
    process.execPath,
    [path.resolve("services/browser-worker/dist/server.js")],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  worker.stdin.end();
  return worker;
}

function startGateway(options: {
  port: number;
  mcpPath: string;
  workerPort: number;
  workerToken: string;
}): ChildProcessWithoutNullStreams {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(options.port),
    PUBLIC_BASE_URL: `http://127.0.0.1:${options.port}`,
    AUTH_MODE: "none",
    MCP_PATH: options.mcpPath,
    TRUST_PROXY: "0",
    ALLOWED_ORIGINS: "",
    AGENT_ID: "browser-mcp-advanced-smoke",
    AGENT_TOKEN_SHA256: "0".repeat(64),
    AGENT_REQUEST_TIMEOUT_MS: "300000",
    AGENT_HEARTBEAT_MS: "30000",
    AGENT_MAX_CONCURRENCY: "4",
    AGENT_MAX_PAYLOAD_BYTES: String(512 * 1024 * 1024),
    BROWSER_WORKER_ENABLED: "true",
    BROWSER_WORKER_URL: `http://127.0.0.1:${options.workerPort}`,
    BROWSER_WORKER_TOKEN: options.workerToken,
    BROWSER_WORKER_TIMEOUT_MS: String(WORKER_OPERATION_TIMEOUT_MS),
    BROWSER_WORKER_MAX_PAYLOAD_BYTES: String(16 * 1024 * 1024),
    RATE_LIMIT_WINDOW_MS: "60000",
    RATE_LIMIT_MAX: "500",
    LOG_LEVEL: "silent",
  };
  const gateway = spawn(
    process.execPath,
    [path.resolve("services/mcp-gateway/dist/server.js")],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  gateway.stdin.end();
  return gateway;
}

async function startFixtureServer(): Promise<{
  url: URL;
  close(): Promise<void>;
}> {
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/ping") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.setHeader("x-browser-worker-smoke", "pong");
      response.end("API pong");
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Browser Worker Advanced Smoke</title></head>
  <body>
    <h1>Browser Worker Advanced Smoke</h1>
    <div id="status">Loading</div>
    <script>
      console.log("browser-worker-advanced-smoke-console");
      fetch("/api/ping")
        .then((response) => response.text())
        .then((text) => {
          document.getElementById("status").textContent = text;
          console.log("browser-worker-advanced-smoke-network-complete");
        });
    </script>
  </body>
</html>`);
  });

  const port = await listenOnEphemeralPort(server);
  return {
    url: new URL(`http://127.0.0.1:${port}/`),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function waitForLive(
  baseUrl: URL,
  worker: ChildProcessWithoutNullStreams,
): Promise<void> {
  const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    assertWorkerRunning(worker);
    try {
      const response = await fetch(new URL("/health/live", baseUrl), {
        signal: AbortSignal.timeout(2_000),
      });
      const payload = await response.json() as { status?: unknown };
      if (response.status === 200 && payload.status === "live") return;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Browser Worker live probe timed out: ${formatError(lastError)}`);
}

async function waitForReady(
  baseUrl: URL,
  worker: ChildProcessWithoutNullStreams,
): Promise<WorkerReadiness> {
  const deadline = Date.now() + WORKER_START_TIMEOUT_MS;
  let lastReadiness: WorkerReadiness | undefined;
  while (Date.now() < deadline) {
    assertWorkerRunning(worker);
    lastReadiness = await readReadiness(baseUrl);
    if (lastReadiness.ready) return lastReadiness;
    await delay(200);
  }
  throw new Error(
    `Browser Worker ready probe timed out: ${JSON.stringify(lastReadiness)}`,
  );
}

async function readReadiness(baseUrl: URL): Promise<WorkerReadiness> {
  const response = await fetch(new URL("/health/ready", baseUrl), {
    signal: AbortSignal.timeout(5_000),
  });
  assert(
    response.status === 200 || response.status === 503,
    `Unexpected readiness status: ${response.status}.`,
  );
  return parseReadiness(await response.json());
}

function parseReadiness(value: unknown): WorkerReadiness {
  const record = asRecord(value, "readiness");
  const capabilities = asRecord(record.capabilities, "readiness.capabilities");
  const status = requireString(record.status, "readiness.status");
  assert(status === "ready" || status === "disconnected", "Invalid readiness status.");
  return {
    status,
    ready: requireBoolean(record.ready, "readiness.ready"),
    mode: requireString(record.mode, "readiness.mode"),
    driver: requireString(record.driver, "readiness.driver"),
    advancedCapabilitiesAvailable: requireBoolean(
      record.advancedCapabilitiesAvailable,
      "readiness.advancedCapabilitiesAvailable",
    ),
    capabilities: {
      console: requireBoolean(capabilities.console, "capabilities.console"),
      network: requireBoolean(capabilities.network, "capabilities.network"),
      trace: requireBoolean(capabilities.trace, "capabilities.trace"),
      video: requireBoolean(capabilities.video, "capabilities.video"),
      pdf: requireBoolean(capabilities.pdf, "capabilities.pdf"),
      diagnostics: requireBoolean(
        capabilities.diagnostics,
        "capabilities.diagnostics",
      ),
    },
    ffmpegAvailable: requireBoolean(
      record.ffmpegAvailable,
      "readiness.ffmpegAvailable",
    ),
    activeTraces: requireNonnegativeInteger(
      record.activeTraces,
      "readiness.activeTraces",
    ),
    activeVideos: requireNonnegativeInteger(
      record.activeVideos,
      "readiness.activeVideos",
    ),
    artifactStorageBytes: requireNonnegativeInteger(
      record.artifactStorageBytes,
      "readiness.artifactStorageBytes",
    ),
    artifactCount: requireNonnegativeInteger(
      record.artifactCount,
      "readiness.artifactCount",
    ),
  };
}

function assertReadyCapabilities(readiness: WorkerReadiness): void {
  assert(readiness.status === "ready" && readiness.ready, "Worker is not ready.");
  assert(readiness.mode === "diagnostic", "Worker readiness mode is not diagnostic.");
  assert(readiness.driver === "direct", "Worker readiness driver is not direct.");
  assert(
    readiness.advancedCapabilitiesAvailable,
    "Advanced Browser Worker capabilities are unavailable.",
  );
  for (const [name, available] of Object.entries(readiness.capabilities)) {
    assert(available, `Browser Worker capability ${name} is unavailable.`);
  }
}

function assertPublicAdvancedTools(
  tools: readonly Record<string, unknown>[],
): number {
  const expected = [
    "browser_console",
    "browser_network",
    "browser_trace",
    "browser_video",
    "browser_pdf",
    "browser_diagnostics",
  ];
  const advanced = tools.filter((tool) =>
    expected.includes(String(tool.name)),
  );
  assert(
    advanced.map((tool) => tool.name).join(",") === expected.join(","),
    "MCP Gateway did not publish the complete advanced browser tool surface.",
  );
  for (const tool of advanced) {
    assert(
      asRecord(tool.inputSchema, "tool.inputSchema").type === "object",
      `${String(tool.name)} input schema is not an object.`,
    );
    assert(
      asRecord(tool.outputSchema, "tool.outputSchema").type === "object",
      `${String(tool.name)} output schema is not an object.`,
    );
    assert(
      isNoAuthSecurityScheme(tool.securitySchemes),
      `${String(tool.name)} root security scheme is invalid.`,
    );
    assert(
      isNoAuthSecurityScheme(asRecord(tool._meta, "tool._meta").securitySchemes),
      `${String(tool.name)} metadata security scheme is invalid.`,
    );
  }
  return advanced.length;
}

function isNoAuthSecurityScheme(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 1 &&
    asRecord(value[0], "security scheme").type === "noauth"
  );
}

function assertAllTabsMcpOwned(tabs: readonly BrowserTab[]): void {
  assert(
    tabs.every((tab) => tab.ownership === "mcp"),
    "Browser Worker exposed a tab that is not MCP-owned.",
  );
}

async function filesExist(files: readonly string[]): Promise<boolean> {
  if (files.length === 0) return false;
  const metadata = await Promise.all(files.map((file) => stat(file)));
  return metadata.every((value) => value.isFile() && value.size > 0);
}

function isPathInside(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function findAvailablePort(): Promise<number> {
  const server = createNetServer();
  const port = await listenOnEphemeralPort(server);
  await closeNetServer(server);
  return port;
}

async function assertPortAvailable(port: number): Promise<void> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  await closeNetServer(server);
}

async function listenOnEphemeralPort(
  server: HttpServer | ReturnType<typeof createNetServer>,
): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string", "Server did not expose a TCP address.");
  return (address as AddressInfo).port;
}

async function closeNetServer(
  server: ReturnType<typeof createNetServer>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopWorker(worker: ChildProcessWithoutNullStreams): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = waitForWorkerExit(worker);
  worker.kill("SIGTERM");
  const stopped = await Promise.race([
    exited.then(() => true),
    delay(WORKER_STOP_TIMEOUT_MS).then(() => false),
  ]);
  if (!stopped) {
    worker.kill("SIGKILL");
    await waitForWorkerExit(worker);
  }
}

async function removeSmokeRoot(root: string): Promise<void> {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(root);
  const relative = path.relative(temporaryRoot, resolved);
  assert(
    relative.startsWith("browser-worker-advanced-smoke-") &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative),
    "Refusing to remove a smoke directory outside the system temporary root.",
  );
  await rm(resolved, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 150,
  });
}

function waitForWorkerExit(
  worker: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => worker.once("exit", () => resolve()));
}

function assertWorkerRunning(worker: ChildProcessWithoutNullStreams): void {
  assert(
    worker.exitCode === null && worker.signalCode === null,
    `Browser Worker exited before the smoke completed (exit=${worker.exitCode}, signal=${worker.signalCode}).`,
  );
}

function captureWorkerLogs(worker: ChildProcessWithoutNullStreams): () => string {
  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (Buffer.byteLength(output) > MAX_CAPTURED_LOG_BYTES) {
      output = output.slice(-MAX_CAPTURED_LOG_BYTES);
    }
  };
  worker.stdout.on("data", append);
  worker.stderr.on("data", append);
  return () => output;
}

function addWorkerContext(error: unknown, logs: () => string): Error {
  const message = formatError(error);
  const workerOutput = logs().trim();
  return new Error(
    workerOutput.length > 0
      ? `${message}\nBrowser Worker output:\n${workerOutput}`
      : message,
    { cause: error },
  );
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object.`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  assert(typeof value === "string" && value.length > 0, `${name} must be a non-empty string.`);
  return value;
}

function requireBoolean(value: unknown, name: string): boolean {
  assert(typeof value === "boolean", `${name} must be a boolean.`);
  return value;
}

function requireNonnegativeInteger(value: unknown, name: string): number {
  assert(Number.isInteger(value) && Number(value) >= 0, `${name} must be a nonnegative integer.`);
  return Number(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
