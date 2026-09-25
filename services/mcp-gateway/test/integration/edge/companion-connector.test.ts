import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "@jest/globals";
import { COMPANION_PROTOCOL_VERSION } from "@mcp-access-stack/edge-protocol";
import WebSocket, { WebSocketServer } from "ws";
import { CompanionConnector } from "../../../src/companion/connector.js";
import {
  DesktopOAuthClient,
  type DesktopOAuthCredentialStore,
  type DesktopOAuthRefreshCredential,
} from "../../../src/companion/desktop-oauth.js";
import { LocalRepositoryManager } from "../../../src/companion/local-repository-manager.js";
import {
  EDGE_INTERNAL_ASSERTION_HEADER,
  EDGE_INTERNAL_PRINCIPAL_HEADER,
  decodeEdgeAuthenticatedPrincipal,
} from "../../../src/edge/internal-trust.js";

const execFileAsync = promisify(execFile);
const servers: Array<{ close(): Promise<void> }> = [];
const temporaryRoots: string[] = [];
const controllers: AbortController[] = [];
const INTERNAL_ASSERTION = "a".repeat(43);
const DEVICE_ID = "dev_11111111-1111-4111-8111-111111111111";
const USER_ID = "usr_22222222-2222-4222-8222-222222222222";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onMessage = (data: WebSocket.RawData) => {
      cleanup();
      try {
        resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before message"));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = 3_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for ${label}.`)),
      timeoutMs,
    );
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function stopWebSocketServer(wss: WebSocketServer, http: Server): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
}

async function stopHttpServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

afterEach(async () => {
  while (controllers.length > 0) controllers.pop()!.abort();
  while (servers.length > 0) await servers.pop()!.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CompanionConnector end-to-end", () => {
  it("authenticates, announces repositories, persists device registration, relays MCP and cancels in-flight work", async () => {
    const temporaryRoot = await realpath(
      await mkdtemp(path.join(os.tmpdir(), "mcp-v3-companion-e2e-")),
    );
    temporaryRoots.push(temporaryRoot);
    const repository = path.join(temporaryRoot, "project");
    await mkdir(repository, { recursive: true });
    await execFileAsync("git", ["init", repository]);

    const repositories = await LocalRepositoryManager.create({
      stateDirectory: path.join(temporaryRoot, "state"),
      managedRoot: path.join(temporaryRoot, "managed"),
      homeDirectory: temporaryRoot,
    });
    await repositories.bindRepositories([{
      repositoryId: "repo_33333333-3333-4333-8333-333333333333",
      name: "project",
      path: repository,
      workspaceId: "project",
      remoteUrls: [],
      managed: false,
    }]);

    let storedCredential: DesktopOAuthRefreshCredential | null = {
      clientId: "client-1",
      scope: "workspaces:read",
      refreshToken: "refresh-token-old-value",
    };
    const credentialStore: DesktopOAuthCredentialStore = {
      read: async () => storedCredential ? { ...storedCredential } : null,
      write: async (value) => { storedCredential = { ...value }; },
      clear: async () => { storedCredential = null; },
    };
    const oauth = new DesktopOAuthClient({
      edgeBaseUrl: new URL("https://edge.example/"),
      credentialStore,
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        expect(url.pathname).toBe("/token");
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("refresh-token-old-value");
        return Response.json({
          access_token: "access-token-value",
          refresh_token: "refresh-token-new-value",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "workspaces:read",
        });
      },
      now: () => 1_000,
    });

    let relayAssertion: string | undefined;
    let relayPrincipal: ReturnType<typeof decodeEdgeAuthenticatedPrincipal> = null;
    let relayAuthorization: string | undefined;
    let cancelStarted!: () => void;
    let cancelClosed!: () => void;
    const cancelStartedPromise = new Promise<void>((resolve) => { cancelStarted = resolve; });
    const cancelClosedPromise = new Promise<void>((resolve) => { cancelClosed = resolve; });

    const localServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      if (request.headers["x-openai-session"] === "cancel-session") {
        request.once("close", cancelClosed);
        cancelStarted();
        return;
      }

      relayAssertion = request.headers[EDGE_INTERNAL_ASSERTION_HEADER] as string | undefined;
      const encodedPrincipal = request.headers[EDGE_INTERNAL_PRINCIPAL_HEADER];
      relayPrincipal = typeof encodedPrincipal === "string"
        ? decodeEdgeAuthenticatedPrincipal(encodedPrincipal)
        : null;
      relayAuthorization = request.headers.authorization;
      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.setHeader("www-authenticate", "Bearer local");
      response.setHeader("x-local-secret", "must-not-leak");
      response.end(JSON.stringify({ relayed: true }));
    });
    const localPort = await listen(localServer);
    servers.push({ close: () => stopHttpServer(localServer) });

    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/companion" });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    let handshakeAuthorization: string | undefined;
    const edgeConnection = new Promise<WebSocket>((resolve) => {
      edgeWss.once("connection", (socket, request) => {
        handshakeAuthorization = request.headers.authorization;
        resolve(socket);
      });
    });

    let registered!: () => void;
    const registeredPromise = new Promise<void>((resolve) => { registered = resolve; });
    let requestedEdgeUrl = "";
    const controller = new AbortController();
    controllers.push(controller);
    const connector = new CompanionConnector({
      edgeBaseUrl: new URL("https://edge.example/"),
      oauth,
      internalAssertion: INTERNAL_ASSERTION,
      localBaseUrl: new URL(`http://127.0.0.1:${localPort}/`),
      repositories,
      displayName: "Integration Device",
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
      webSocketFactory: (url, options) => {
        requestedEdgeUrl = url.href;
        return new WebSocket(`ws://127.0.0.1:${edgePort}/companion`, options);
      },
      log: (entry) => {
        if (entry.event === "local_runtime_registered") registered();
      },
    });
    const runPromise = connector.run(controller.signal);
    const edgeSocket = await withTimeout(edgeConnection, "companion WebSocket connection");

    expect(requestedEdgeUrl).toBe("wss://edge.example/companion");
    expect(handshakeAuthorization).toBe("Bearer access-token-value");
    expect(storedCredential?.refreshToken).toBe("refresh-token-new-value");

    const readyPromise = waitForMessage(edgeSocket);
    edgeSocket.send(JSON.stringify({
      type: "companion-hello",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
    }));
    const ready = await withTimeout(readyPromise, "companion-ready");
    expect(ready).toMatchObject({
      type: "companion-ready",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      registration: {
        displayName: "Integration Device",
      },
      workspaces: [
        expect.objectContaining({
          workspaceId: "project",
          name: "project",
        }),
      ],
      materializations: [
        expect.objectContaining({
          repositoryId: "repo_33333333-3333-4333-8333-333333333333",
          workspaceId: "project",
        }),
      ],
    });

    edgeSocket.send(JSON.stringify({
      type: "companion-registered",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      deviceId: DEVICE_ID,
    }));
    await withTimeout(registeredPromise, "companion registration");
    expect(repositories.getDeviceId()).toBe(DEVICE_ID);

    const principal = {
      subject: `user:${USER_ID}`,
      scopes: ["workspaces:read"],
      ownerScope: "owner",
      userId: USER_ID,
    };
    const relayedPromise = waitForMessage(edgeSocket);
    edgeSocket.send(JSON.stringify({
      type: "http-request",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      requestId: "relay-1",
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: "Bearer must-not-forward",
        "content-type": "application/json",
        "x-openai-session": "relay-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      principal,
    }));

    const relayed = await withTimeout(relayedPromise, "relayed MCP response");
    expect(relayed).toMatchObject({
      type: "http-response",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      requestId: "relay-1",
      status: 202,
      body: JSON.stringify({ relayed: true }),
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer local",
      },
    });
    expect((relayed.headers as Record<string, string>)["x-local-secret"]).toBeUndefined();
    expect(relayAssertion).toBe(INTERNAL_ASSERTION);
    expect(relayAuthorization).toBeUndefined();
    expect(relayPrincipal).toEqual(principal);

    edgeSocket.send(JSON.stringify({
      type: "http-request",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      requestId: "cancel-1",
      method: "POST",
      path: "/mcp",
      headers: {
        "content-type": "application/json",
        "x-openai-session": "cancel-session",
      },
      body: "{}",
      principal,
    }));
    await withTimeout(cancelStartedPromise, "local cancellable request start");
    edgeSocket.send(JSON.stringify({
      type: "http-cancel",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      requestId: "cancel-1",
      reason: "client_disconnected",
    }));
    await withTimeout(cancelClosedPromise, "local request cancellation");

    controller.abort();
    await withTimeout(runPromise, "connector shutdown");
  }, 20_000);
});
