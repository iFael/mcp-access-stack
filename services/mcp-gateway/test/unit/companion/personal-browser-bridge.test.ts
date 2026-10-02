import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import { afterEach, describe, expect, it } from "@jest/globals";
import WebSocket from "ws";
import { PersonalBrowserBridge } from "../../../src/companion/personal-browser-bridge.js";
import {
  PERSONAL_BROWSER_CAPABILITIES,
  PERSONAL_BROWSER_EXTENSION_VERSION,
  PERSONAL_BROWSER_PROTOCOL_VERSION,
} from "../../../src/companion/personal-browser-extension-assets.js";

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
      "debugger",
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

    const extension = await connectExtension(port, token!);
    expect(bridge.isConnected()).toBe(true);
    expect(bridge.connectionInfo()).toMatchObject({
      connected: true,
      browser: "chrome",
      profile: "personal",
      protocolVersion: PERSONAL_BROWSER_PROTOCOL_VERSION,
      extensionVersion: PERSONAL_BROWSER_EXTENSION_VERSION,
      capabilities: [...PERSONAL_BROWSER_CAPABILITIES],
    });

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

  it("materializes configured private-site origins into the personal denylist", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-personal-browser-"));
    temporaryRoots.push(root);
    const privateDirectory = path.join(root, "browser", "private");
    await mkdir(privateDirectory, { recursive: true });
    await writeFile(
      path.join(privateDirectory, "site-policies.json"),
      JSON.stringify([{
        siteId: "private-test",
        entryUrl: "https://private.example.test/app",
        allowedOrigins: [
          "https://private.example.test",
          "https://api.private.example.test",
        ],
      }]),
      "utf8",
    );
    const port = await reservePort();
    const bridge = await PersonalBrowserBridge.start({ stateRoot: root, port });
    const workerSource = await readFile(
      path.join(root, "browser", "personal-extension", "service-worker.js"),
      "utf8",
    );

    expect(workerSource).toContain(
      'const BLOCKED_PRIVATE_ORIGINS = new Set(["https://api.private.example.test","https://private.example.test"]);',
    );
    await bridge.close();
  });

  it("persists personal screenshot bytes returned by the extension", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    try {
      extension.on("message", (data) => {
        const message = JSON.parse(data.toString()) as WireMessage;
        if (message.type !== "request" || message.operation !== "screenshot" || !message.id) return;
        extension.send(JSON.stringify({
          type: "response",
          id: message.id,
          ok: true,
          result: {
            tabId: "personal:7",
            path: "personal://screenshot/test.jpg",
            sizeBytes: 3,
            mimeType: "image/jpeg",
            contentBase64: "YWJj",
          },
        }));
      });

      const result = await bridge.screenshot({ tabId: "personal:7" });
      expect(result.path).toMatch(/personal-artifacts[\\/]screenshots/u);
      expect(result.sizeBytes).toBe(3);
      await expect(readFile(result.path)).resolves.toEqual(Buffer.from("abc"));
      expect(result).toMatchObject({
        mimeType: "image/jpeg",
        contentBase64: "YWJj",
      });
    } finally {
      await close();
    }
  });

  it("requires a compatible hello before activating an authenticated socket", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-personal-browser-"));
    temporaryRoots.push(root);
    const port = await reservePort();
    const bridge = await PersonalBrowserBridge.start({ stateRoot: root, port });
    const workerSource = await readFile(
      path.join(root, "browser", "personal-extension", "service-worker.js"),
      "utf8",
    );
    const token = /const BRIDGE_TOKEN = "([^"]+)";/u.exec(workerSource)?.[1];
    if (!token) throw new Error("Personal browser token was not materialized.");

    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    expect(bridge.isConnected()).toBe(false);

    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(JSON.stringify({
      type: "hello",
      protocolVersion: 999,
      extensionVersion: PERSONAL_BROWSER_EXTENSION_VERSION,
      browser: "chrome",
      profile: "personal",
      capabilities: [...PERSONAL_BROWSER_CAPABILITIES],
    }));

    await expect(closed).resolves.toBe(1008);
    expect(bridge.isConnected()).toBe(false);
    await bridge.close();
  });

  it("sends cooperative cancel and distinguishes read cancellation from unknown mutation outcome", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    try {
      const readController = new AbortController();
      const readRequestPromise = nextWireMessage(
        extension,
        (message) => message.type === "request" && message.operation === "wait",
      );
      const read = bridge.wait(
        { tabId: "personal:1", timeoutMs: 30_000 },
        { signal: readController.signal },
      );
      const readRequest = await readRequestPromise;
      const readCancelPromise = nextWireMessage(
        extension,
        (message) => message.type === "cancel" && message.id === readRequest.id,
      );
      readController.abort();

      await expect(read).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
      await expect(readCancelPromise).resolves.toMatchObject({
        type: "cancel",
        id: readRequest.id,
      });

      const mutationController = new AbortController();
      const mutationRequestPromise = nextWireMessage(
        extension,
        (message) => message.type === "request" && message.operation === "click",
      );
      const mutation = bridge.click(
        { tabId: "personal:1", ref: "p-generation-1" },
        { signal: mutationController.signal },
      );
      const mutationRequest = await mutationRequestPromise;
      const mutationCancelPromise = nextWireMessage(
        extension,
        (message) => message.type === "cancel" && message.id === mutationRequest.id,
      );
      mutationController.abort();

      await expect(mutation).rejects.toMatchObject({
        code: "EXECUTION_OUTCOME_UNKNOWN",
      });
      await expect(mutationCancelPromise).resolves.toMatchObject({
        type: "cancel",
        id: mutationRequest.id,
      });
    } finally {
      await close();
    }
  });

  it("bounds calls by the upstream deadline and propagates the effective deadline", async () => {
    const { bridge, extension, close } = await startAuthenticatedBridge();
    try {
      const deadlineAt = new Date(Date.now() + 500).toISOString();
      const requestPromise = nextWireMessage(
        extension,
        (message) => message.type === "request" && message.operation === "tabs",
      );
      const call = bridge.tabs(
        {},
        {
          deadline: {
            requestedTimeoutMs: 500,
            effectiveTimeoutMs: 500,
            deadlineAt,
          },
        },
      );
      const request = await requestPromise;

      expect(typeof request.deadlineAt).toBe("string");
      expect(Date.parse(String(request.deadlineAt))).toBeLessThanOrEqual(
        Date.parse(deadlineAt),
      );
      await expect(call).rejects.toMatchObject({ code: "BROWSER_WORKER_TIMEOUT" });
    } finally {
      await close();
    }
  });

  it("isolates pending calls by connection generation", async () => {
    const { bridge, extension: first, token, port, close } =
      await startAuthenticatedBridge();
    let second: WebSocket | undefined;
    try {
      const oldRequestPromise = nextWireMessage(
        first,
        (message) => message.type === "request" && message.operation === "tabs",
      );
      const oldCall = bridge.tabs({});
      await oldRequestPromise;

      second = await connectExtension(port, token);
      await expect(oldCall).rejects.toMatchObject({ code: "BROWSER_DISCONNECTED" });

      second.on("message", (data) => {
        const message = JSON.parse(data.toString()) as WireMessage;
        if (message.type !== "request" || message.operation !== "tabs" || !message.id) return;
        second?.send(JSON.stringify({
          type: "response",
          id: message.id,
          ok: true,
          result: { tabs: [] },
        }));
      });

      await expect(bridge.tabs({})).resolves.toEqual({ tabs: [] });
    } finally {
      second?.close();
      await close();
    }
  });
});

interface WireMessage {
  type?: string;
  id?: string;
  operation?: string;
  deadlineAt?: string;
  [key: string]: unknown;
}

async function startAuthenticatedBridge(): Promise<{
  bridge: PersonalBrowserBridge;
  extension: WebSocket;
  token: string;
  port: number;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-personal-browser-"));
  temporaryRoots.push(root);
  const port = await reservePort();
  const bridge = await PersonalBrowserBridge.start({ stateRoot: root, port });
  const workerSource = await readFile(
    path.join(root, "browser", "personal-extension", "service-worker.js"),
    "utf8",
  );
  const token = /const BRIDGE_TOKEN = "([^"]+)";/u.exec(workerSource)?.[1];
  if (!token) throw new Error("Personal browser token was not materialized.");
  const extension = await connectExtension(port, token);
  return {
    bridge,
    extension,
    token,
    port,
    async close() {
      if (extension.readyState < WebSocket.CLOSING) extension.close();
      await bridge.close();
    },
  };
}

async function connectExtension(port: number, token: string): Promise<WebSocket> {
  const extension = new WebSocket(
    `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`,
  );
  await new Promise<void>((resolve, reject) => {
    extension.once("open", () => resolve());
    extension.once("error", reject);
  });
  const acknowledged = nextWireMessage(
    extension,
    (message) => message.type === "hello-ack",
  );
  extension.send(JSON.stringify({
    type: "hello",
    protocolVersion: PERSONAL_BROWSER_PROTOCOL_VERSION,
    extensionVersion: PERSONAL_BROWSER_EXTENSION_VERSION,
    browser: "chrome",
    profile: "personal",
    capabilities: [...PERSONAL_BROWSER_CAPABILITIES],
  }));
  await acknowledged;
  return extension;
}

function nextWireMessage(
  socket: WebSocket,
  predicate: (message: WireMessage) => boolean,
): Promise<WireMessage> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      try {
        const message = JSON.parse(data.toString()) as WireMessage;
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before the expected message."));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
  });
}

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
