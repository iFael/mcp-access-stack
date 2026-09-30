import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { LocalBrowserWorker } from "../../../src/companion/local-browser-worker.js";

const temporaryRoots: string[] = [];

describe("LocalBrowserWorker", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  it("starts the packaged Browser Worker through the native launcher without exposing its token in arguments", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-worker-"));
    temporaryRoots.push(root);

    const launcherPath = path.join(root, "compat", "McpNodeHostLauncher.exe");
    const nodePath = path.join(root, "runtime", "node", "node.exe");
    const browserPath = path.join(
      root,
      "services",
      "browser-worker",
      "dist",
      "server.js",
    );
    const brokerPath = path.join(root, "compat", "McpCredentialBroker.exe");
    for (const filePath of [launcherPath, nodePath, browserPath, brokerPath]) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "fixture", "utf8");
    }

    let capturedFile = "";
    let capturedArgs: readonly string[] = [];
    let capturedOptions: SpawnOptions | undefined;
    const child = fakeChild();

    const worker = await LocalBrowserWorker.start({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      platform: "win32",
      credentialBrokerPath: brokerPath,
      browserChannel: "chrome",
      startupTimeoutMs: 1_000,
      spawnProcess: ((
        file: string,
        args: readonly string[] | undefined,
        options: SpawnOptions | undefined,
      ) => {
        capturedFile = String(file);
        capturedArgs = (args ?? []).map(String);
        capturedOptions = options;
        return child as never;
      }) as unknown as typeof import("node:child_process").spawn,
      fetchImpl: jest.fn(async () =>
        new Response(JSON.stringify({ status: "live" }), { status: 200 }),
      ) as unknown as typeof fetch,
    });

    expect(capturedFile).toBe(launcherPath);
    expect(capturedArgs).toEqual(expect.arrayContaining([
      "--node",
      nodePath,
      "--",
      browserPath,
    ]));
    expect(capturedArgs.join(" ")).not.toContain("BROWSER_WORKER_TOKEN");
    expect(capturedOptions?.env?.BROWSER_WORKER_HOST).toBe("127.0.0.1");
    expect(capturedOptions?.env?.BROWSER_WORKER_BROWSER_CHANNEL).toBe("chrome");
    expect(capturedOptions?.env?.BROWSER_WORKER_TOKEN).toEqual(
      expect.stringMatching(/^[A-Za-z0-9_-]{40,}$/u),
    );
    expect(Number(capturedOptions?.env?.BROWSER_WORKER_PORT)).toBeGreaterThan(0);
    expect(worker.url.hostname).toBe("127.0.0.1");

    await worker.close();
    expect(child.kill).toHaveBeenCalled();
  });

  it("starts the same Browser Worker directly with Node on Linux and uses the file credential broker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-worker-linux-"));
    temporaryRoots.push(root);

    const nodePath = path.join(root, "runtime", "node");
    const browserPath = path.join(
      root,
      "services",
      "browser-worker",
      "dist",
      "server.js",
    );
    for (const filePath of [nodePath, browserPath]) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "fixture", "utf8");
    }

    let capturedFile = "";
    let capturedArgs: readonly string[] = [];
    let capturedOptions: SpawnOptions | undefined;
    const child = fakeChild();

    const worker = await LocalBrowserWorker.start({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      platform: "linux",
      nodePath,
      startupTimeoutMs: 1_000,
      spawnProcess: ((
        file: string,
        args: readonly string[] | undefined,
        options: SpawnOptions | undefined,
      ) => {
        capturedFile = String(file);
        capturedArgs = (args ?? []).map(String);
        capturedOptions = options;
        return child as never;
      }) as unknown as typeof import("node:child_process").spawn,
      fetchImpl: jest.fn(async () =>
        new Response(JSON.stringify({ status: "live" }), { status: 200 }),
      ) as unknown as typeof fetch,
    });

    expect(capturedFile).toBe(nodePath);
    expect(capturedArgs).toEqual([browserPath]);
    expect(capturedOptions?.env?.BROWSER_WORKER_HEADLESS).toBe("true");
    expect(capturedOptions?.env?.BROWSER_WORKER_CREDENTIAL_BROKER_PATH).toBeUndefined();
    const credentialsPath = String(capturedOptions?.env?.BROWSER_WORKER_CREDENTIALS_PATH);
    expect(credentialsPath).toBe(path.join(root, "state", "browser", "private", "credentials.json"));
    await expect(readFile(credentialsPath, "utf8")).resolves.toBe(
      JSON.stringify({ version: 1, credentials: [] }) + "\n",
    );
    if (process.platform !== "win32") {
      expect((await stat(credentialsPath)).mode & 0o077).toBe(0);
    }

    await worker.close();
    expect(child.kill).toHaveBeenCalled();
  });

  it("reads an authenticated live frame from the private loopback worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-worker-frame-"));
    temporaryRoots.push(root);
    const nodePath = path.join(root, "runtime", "node");
    const browserPath = path.join(
      root,
      "services",
      "browser-worker",
      "dist",
      "server.js",
    );
    for (const filePath of [nodePath, browserPath]) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, "fixture", "utf8");
    }

    const child = fakeChild();
    const requests: Array<{ url: string; authorization?: string; ownerScope?: string }> = [];
    const fetchImpl = jest.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/health/live") {
        return new Response(JSON.stringify({ status: "live" }), { status: 200 });
      }
      requests.push({
        url: url.href,
        ...(typeof init?.headers === "object" && init.headers !== null
          ? {
              authorization: (init.headers as Record<string, string>).authorization,
              ownerScope: (init.headers as Record<string, string>)["x-mcp-owner-scope"],
            }
          : {}),
      });
      return new Response(JSON.stringify({
        seq: 8,
        data: "/9j/",
        width: 640,
        height: 360,
        capturedAt: 123,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const worker = await LocalBrowserWorker.start({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      platform: "linux",
      nodePath,
      startupTimeoutMs: 1_000,
      spawnProcess: (() => child as never) as unknown as typeof import("node:child_process").spawn,
      fetchImpl,
    });

    await expect(worker.readLiveFrame({
      taskId: "task-1",
      tabId: "tab-1",
      afterSeq: 7,
      ownerScope: "user:one",
    })).resolves.toMatchObject({ seq: 8, width: 640, height: 360 });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/live/frame?taskId=task-1&tabId=tab-1&afterSeq=7");
    expect(requests[0]?.authorization).toMatch(/^Bearer [A-Za-z0-9_-]{40,}$/u);
    expect(requests[0]?.ownerScope).toBe("user:one");

    await worker.close();
  });
});

function fakeChild(): ChildProcess & EventEmitter & {
  kill: ReturnType<typeof jest.fn>;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
  const emitter = new EventEmitter() as ChildProcess & EventEmitter & {
    kill: ReturnType<typeof jest.fn>;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.kill = jest.fn(() => {
    emitter.signalCode = "SIGTERM";
    queueMicrotask(() => emitter.emit("exit", null, "SIGTERM"));
    return true;
  });
  return emitter;
}
