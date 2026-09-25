import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import { BrowserWorkerClient } from "../browser/client.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;

export interface LocalBrowserWorkerOptions {
  releaseRoot: string;
  stateRoot: string;
  credentialBrokerPath: string;
  browserChannel?: "chromium" | "chrome";
  headless?: boolean;
  startupTimeoutMs?: number;
  operationTimeoutMs?: number;
  maxPayloadBytes?: number;
  log?: (entry: Record<string, unknown>) => void;
  spawnProcess?: typeof spawn;
  fetchImpl?: typeof fetch;
}

export class LocalBrowserWorker {
  readonly client: BrowserWorkerClient;
  readonly url: URL;
  private stopped = false;

  private constructor(
    private readonly child: ChildProcess,
    url: URL,
    token: string,
    private readonly options: LocalBrowserWorkerOptions,
  ) {
    this.url = url;
    this.client = new BrowserWorkerClient({
      url,
      token,
      timeoutMs: options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    });
  }

  static async start(
    options: LocalBrowserWorkerOptions,
  ): Promise<LocalBrowserWorker> {
    const releaseRoot = path.resolve(options.releaseRoot);
    const launcherPath = path.join(
      releaseRoot,
      "compat",
      "McpNodeHostLauncher.exe",
    );
    const nodePath = path.join(
      releaseRoot,
      "runtime",
      "node",
      "node.exe",
    );
    const browserScript = path.join(
      releaseRoot,
      "services",
      "browser-worker",
      "dist",
      "server.js",
    );

    await Promise.all([
      assertRegularFile(launcherPath, "Browser native launcher"),
      assertRegularFile(nodePath, "Bundled Node.js"),
      assertRegularFile(browserScript, "Browser Worker server"),
      assertRegularFile(options.credentialBrokerPath, "Credential broker"),
    ]);

    const browserRoot = path.join(options.stateRoot, "browser");
    const privateDirectory = path.join(browserRoot, "private");
    const runtimeDirectory = path.join(browserRoot, "runtime");
    const userDataDirectory = path.join(privateDirectory, "profile");
    const logsDirectory = path.join(options.stateRoot, "logs");
    await Promise.all([
      mkdir(privateDirectory, { recursive: true }),
      mkdir(runtimeDirectory, { recursive: true }),
      mkdir(userDataDirectory, { recursive: true }),
      mkdir(logsDirectory, { recursive: true }),
    ]);

    const port = await reserveLoopbackPort();
    const url = new URL(`http://127.0.0.1:${port}/`);
    const token = randomBytes(32).toString("base64url");
    const spawnProcess = options.spawnProcess ?? spawn;
    const child = spawnProcess(
      launcherPath,
      [
        "--node", nodePath,
        "--stdout-log", path.join(logsDirectory, "browser-worker.stdout.log"),
        "--stderr-log", path.join(logsDirectory, "browser-worker.stderr.log"),
        "--runner-restart-count", "1",
        "--runner-restart-interval-seconds", "1",
        "--",
        browserScript,
      ],
      {
        cwd: releaseRoot,
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          BROWSER_WORKER_HOST: "127.0.0.1",
          BROWSER_WORKER_PORT: String(port),
          BROWSER_WORKER_TOKEN: token,
          BROWSER_WORKER_MODE: "interactive",
          BROWSER_WORKER_PROFILE_MODE: "persistent",
          BROWSER_WORKER_BROWSER_CHANNEL: options.browserChannel ?? "chromium",
          BROWSER_WORKER_HEADLESS: options.headless ? "true" : "false",
          BROWSER_WORKER_USER_DATA_DIR: userDataDirectory,
          BROWSER_WORKER_RUNTIME_DIR: runtimeDirectory,
          BROWSER_WORKER_PRIVATE_DIR: privateDirectory,
          BROWSER_WORKER_CREDENTIAL_BROKER_PATH: path.resolve(
            options.credentialBrokerPath,
          ),
        },
      },
    );

    const instance = new LocalBrowserWorker(child, url, token, options);
    try {
      await instance.waitUntilLive();
      options.log?.({
        event: "mcp_v3_local_browser_ready",
        origin: url.origin,
        channel: options.browserChannel ?? "chromium",
      });
      return instance;
    } catch (error) {
      await instance.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;

    this.options.log?.({ event: "mcp_v3_local_browser_stopping" });
    try {
      this.child.kill();
    } catch {
      return;
    }

    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch { /* already stopped */ }
        resolve();
      }, DEFAULT_STOP_TIMEOUT_MS);
      timer.unref();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async waitUntilLive(): Promise<void> {
    const timeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const liveUrl = new URL("/health/live", this.url);

    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new AppError(
          "AGENT_UNAVAILABLE",
          `Browser Worker launcher exited during startup (exit=${String(this.child.exitCode)}).`,
        );
      }
      try {
        const response = await fetchImpl(liveUrl, {
          signal: AbortSignal.timeout(
            Math.min(2_000, Math.max(1, deadline - Date.now())),
          ),
        });
        if (response.ok) return;
      } catch {
        // The launcher may need a few seconds to create the Worker.
      }
      await delay(100);
    }

    throw new AppError(
      "AGENT_UNAVAILABLE",
      "Browser Worker did not become live before the startup deadline.",
    );
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new AppError(
      "AGENT_UNAVAILABLE",
      "Unable to reserve a loopback port for the Browser Worker.",
    );
  }
  const port = address.port;
  await closeServer(server);
  return port;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 0) throw new Error("not a regular file");
  } catch (error) {
    throw new AppError(
      "CAPABILITY_UNSUPPORTED",
      `${label} is missing from the MCP V3 release.`,
      { cause: error },
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
