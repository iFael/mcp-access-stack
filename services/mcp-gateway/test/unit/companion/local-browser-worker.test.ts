import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
      credentialBrokerPath: brokerPath,
      browserChannel: "chrome",
      startupTimeoutMs: 1_000,
      spawnProcess: ((file, args, options) => {
        capturedFile = String(file);
        capturedArgs = (args ?? []).map(String);
        capturedOptions = options;
        return child as never;
      }) as typeof import("node:child_process").spawn,
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
