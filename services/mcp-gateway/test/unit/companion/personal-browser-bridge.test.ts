import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "@jest/globals";
import WebSocket from "ws";
import { PersonalBrowserBridge } from "../../../src/companion/personal-browser-bridge.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("PersonalBrowserBridge", () => {
  it("materializes the extension, rejects an invalid token and accepts authenticated RPC", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-personal-browser-"));
    temporaryRoots.push(root);
    const port = await reservePort();
    const bridge = await PersonalBrowserBridge.start({
      stateRoot: root,
      port,
    });

    const manifestPath = path.join(
      root,
      "browser",
      "personal-extension",
      "manifest.json",
    );
    const workerPath = path.join(
      root,
      "browser",
      "personal-extension",
      "service-worker.js",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      manifest_version: number;
      permissions: string[];
    };
    const workerSource = await readFile(workerPath, "utf8");
    const token = /const BRIDGE_TOKEN = "([^"]+)";/u.exec(workerSource)?.[1];

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(expect.arrayContaining([
      "tabs",
      "scripting",
      "storage",
    ]));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(() => new Script(workerSource)).not.toThrow();

    const rejected = new WebSocket(
      `ws://127.0.0.1:${port}/?token=invalid`,
    );
    const rejectedCode = await new Promise<number>((resolve, reject) => {
      rejected.once("close", (code) => resolve(code));
      rejected.once("error", reject);
    });
    expect(rejectedCode).toBe(1008);
    expect(bridge.isConnected()).toBe(false);

    const extension = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token!)}`,
    );
    await new Promise<void>((resolve, reject) => {
      extension.once("open", () => resolve());
      extension.once("error", reject);
    });
    expect(bridge.isConnected()).toBe(true);

    extension.on("message", (data) => {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        id?: string;
        operation?: string;
      };
      if (message.type !== "request" || !message.id) return;
      if (message.operation !== "tabs") return;
      extension.send(JSON.stringify({
        type: "response",
        id: message.id,
        ok: true,
        result: { tabs: [] },
      }));
    });

    await expect(bridge.tabs({})).resolves.toEqual({ tabs: [] });

    extension.close();
    await new Promise<void>((resolve) => extension.once("close", () => resolve()));
    await bridge.close();
  });
});

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Failed to reserve a loopback port.");
  }
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
