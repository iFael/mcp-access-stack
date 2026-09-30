import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { AppError } from "@vs-code-gpt/shared";
import { BrowserWorkerClient } from "../browser/client.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_STOP_TIMEOUT_MS = 8_000;

export type BrowserLiveFramePayload = {
  seq: number;
  data: string;
  width: number;
  height: number;
  capturedAt: number;
};

export interface LocalBrowserWorkerOptions {
  releaseRoot: string;
  stateRoot: string;
  credentialBrokerPath?: string;
  credentialsPath?: string;
  nodePath?: string;
  platform?: NodeJS.Platform;
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
    private readonly token: string,
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
    const platform = options.platform ?? process.platform;
    const browserScript = path.join(
      releaseRoot,
      "services",
      "browser-worker",
      "dist",
      "server.js",
    );
    await assertRegularFile(browserScript, "Browser Worker server");

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

    let executable: string;
    let args: string[];
    let credentialEnvironment: Record<string, string>;
    const headless = options.headless ?? platform !== "win32";
    if (platform === "win32") {
      const launcherPath = path.join(
        releaseRoot,
        "compat",
        "McpNodeHostLauncher.exe",
      );
      const nodePath = path.resolve(
        options.nodePath ?? path.join(releaseRoot, "runtime", "node", "node.exe"),
      );
      const credentialBrokerPath = options.credentialBrokerPath === undefined
        ? ""
        : path.resolve(options.credentialBrokerPath);
      if (!credentialBrokerPath) {
        throw new AppError(
          "CAPABILITY_UNSUPPORTED",
          "Credential broker is required for the Windows Browser Worker.",
        );
      }
      await Promise.all([
        assertRegularFile(launcherPath, "Browser native launcher"),
        assertRegularFile(nodePath, "Bundled Node.js"),
        assertRegularFile(credentialBrokerPath, "Credential broker"),
      ]);
      executable = launcherPath;
      args = [
        "--node", nodePath,
        "--stdout-log", path.join(logsDirectory, "browser-worker.stdout.log"),
        "--stderr-log", path.join(logsDirectory, "browser-worker.stderr.log"),
        "--runner-restart-count", "1",
        "--runner-restart-interval-seconds", "1",
        "--",
        browserScript,
      ];
      credentialEnvironment = {
        BROWSER_WORKER_CREDENTIAL_BROKER_PATH: credentialBrokerPath,
      };
    } else {
      const nodePath = path.resolve(options.nodePath ?? process.execPath);
      await assertRegularFile(nodePath, "Node.js runtime");
      const credentialsPath = path.resolve(
        options.credentialsPath ?? path.join(privateDirectory, "credentials.json"),
      );
      if (options.credentialsPath === undefined) {
        await ensureEmptyCredentialFile(credentialsPath);
      } else {
        await assertRegularFile(credentialsPath, "Browser credential file");
      }
      executable = nodePath;
      args = [browserScript];
      credentialEnvironment = {
        BROWSER_WORKER_CREDENTIALS_PATH: credentialsPath,
      };
    }

    const port = await reserveLoopbackPort();
    const url = new URL(`http://127.0.0.1:${port}/`);
    const token = randomBytes(32).toString("base64url");
    const spawnProcess = options.spawnProcess ?? spawn;
    const child = spawnProcess(
      executable,
      args,
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
          BROWSER_WORKER_HEADLESS: headless ? "true" : "false",
          BROWSER_WORKER_USER_DATA_DIR: userDataDirectory,
          BROWSER_WORKER_RUNTIME_DIR: runtimeDirectory,
          BROWSER_WORKER_PRIVATE_DIR: privateDirectory,
          ...credentialEnvironment,
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

  async readLiveFrame(input: {
    taskId: string;
    tabId: string;
    afterSeq: number;
    ownerScope?: string;
    signal?: AbortSignal;
  }): Promise<BrowserLiveFramePayload | null> {
    const target = new URL("/live/frame", this.url);
    target.search = new URLSearchParams({
      taskId: input.taskId,
      tabId: input.tabId,
      afterSeq: String(input.afterSeq),
    }).toString();
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(target, {
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(input.ownerScope === undefined
            ? {}
            : { "x-mcp-owner-scope": input.ownerScope }),
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw new AppError(
        "BROWSER_WORKER_UNAVAILABLE",
        "Browser live view is unavailable.",
        { cause: error },
      );
    }
    if (response.status === 204) return null;
    if (response.status === 404) {
      throw new AppError("TASK_NOT_FOUND", "Browser live view is unavailable.");
    }
    if (!response.ok) {
      throw new AppError(
        "BROWSER_WORKER_UNAVAILABLE",
        `Browser live view request failed with HTTP ${response.status}.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new AppError(
        "RELAY_PROTOCOL_ERROR",
        "Browser live view returned invalid JSON.",
        { cause: error },
      );
    }
    if (!isBrowserLiveFramePayload(parsed)) {
      throw new AppError(
        "RELAY_PROTOCOL_ERROR",
        "Browser live view returned an invalid frame payload.",
      );
    }
    return parsed;
  }

  async supportsLiveView(): Promise<boolean> {
    if (this.stopped) return false;
    const target = new URL("/live/capability", this.url);
    try {
      const response = await (this.options.fetchImpl ?? fetch)(target, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.status !== 200) return false;
      const payload: unknown = await response.json();
      return typeof payload === "object" && payload !== null &&
        (payload as { version?: unknown }).version === 1;
    } catch {
      return false;
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

async function ensureEmptyCredentialFile(filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a regular file");
    await chmod(filePath, 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Browser credential file could not be prepared.",
        { cause: error },
      );
    }
  }
  await writeFile(
    filePath,
    JSON.stringify({ version: 1, credentials: [] }) + "\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
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

function isBrowserLiveFramePayload(value: unknown): value is BrowserLiveFramePayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as Record<string, unknown>;
  return Number.isSafeInteger(frame.seq) && Number(frame.seq) > 0 &&
    typeof frame.data === "string" && frame.data.length <= 512 * 1024 &&
    Number.isSafeInteger(frame.width) && Number(frame.width) > 0 && Number(frame.width) <= 4096 &&
    Number.isSafeInteger(frame.height) && Number(frame.height) > 0 && Number(frame.height) <= 4096 &&
    Number.isSafeInteger(frame.capturedAt) && Number(frame.capturedAt) >= 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
