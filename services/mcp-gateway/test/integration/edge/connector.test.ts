import { afterEach, describe, expect, it } from "@jest/globals";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { EDGE_PROTOCOL_VERSION, isAllowedEdgeRequest, parseConnectorToEdgeMessage } from "@mcp-access-stack/edge-protocol";
import { EdgeConnector } from "../../../src/edge/connector.js";

const servers: Array<{ close(): Promise<void> }> = [];
const TEST_PRINCIPAL = { subject: "owner:test", scopes: ["mcp:tools"], ownerScope: "owner" };
const TEST_INTERNAL_ASSERTION = "a".repeat(43);

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return address.port;
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

function waitForConnection(wss: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => wss.once("connection", resolve));
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
  while (servers.length > 0) {
    await servers.pop()!.close();
  }
});

describe("edge protocol route allowlist", () => {
  it("preserves only the MCP and Owner OAuth methods required by the embedded Gateway", () => {
    expect(isAllowedEdgeRequest("POST", "/mcp")).toBe(true);
    expect(isAllowedEdgeRequest("GET", "/authorize?client_id=test")).toBe(true);
    expect(isAllowedEdgeRequest("POST", "/authorize")).toBe(true);
    expect(isAllowedEdgeRequest("POST", "/token")).toBe(true);
    expect(isAllowedEdgeRequest("GET", "/.well-known/oauth-authorization-server")).toBe(true);
    expect(isAllowedEdgeRequest("GET", "/.well-known/oauth-protected-resource/mcp")).toBe(true);
    expect(isAllowedEdgeRequest("POST", "/.well-known/oauth-authorization-server")).toBe(false);
    expect(isAllowedEdgeRequest("GET", "/.well-known/oauth-protected-resource/other")).toBe(false);
    expect(isAllowedEdgeRequest("GET", "/arbitrary")).toBe(false);
  });
});
describe("EdgeConnector", () => {
  it("qualifies the outbound connection as protocol v3 for cutover routing", async () => {
    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/connector" });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    let observedUrl = "";
    const connectionPromise = new Promise<WebSocket>((resolve) => {
      edgeWss.once("connection", (socket, request) => {
        observedUrl = request.url ?? "";
        resolve(socket);
      });
    });
    const controller = new AbortController();
    const connector = new EdgeConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/connector`,
      localBaseUrl: "http://127.0.0.1:39999/",
      token: "v".repeat(48),
      internalAssertion: TEST_INTERNAL_ASSERTION,
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    });
    const runPromise = connector.run(controller.signal);
    const edgeSocket = await connectionPromise;
    expect(observedUrl).toBe(`/connector?protocol=${EDGE_PROTOCOL_VERSION}`);

    controller.abort();
    edgeSocket.terminate();
    await runPromise;
  });

  it("authenticates outbound, completes protocol handshake and relays allowlisted HTTP", async () => {
    let observedAuthorization: string | undefined;
    let observedSecretHeader: string | undefined;
    let observedOrigin: string | undefined;
    const localServer = createServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      observedSecretHeader = request.headers["x-edge-secret"] as string | undefined;
      observedOrigin = request.headers.origin;
      response.statusCode = 201;
      response.setHeader("content-type", "application/json");
      response.setHeader("www-authenticate", "Bearer test");
      response.setHeader("x-local-secret", "must-not-leak");
      response.end(JSON.stringify({ ok: true }));
    });
    const localPort = await listen(localServer);
    servers.push({ close: () => stopHttpServer(localServer) });

    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/connector" });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    const connectionPromise = waitForConnection(edgeWss);
    const controller = new AbortController();
    const connector = new EdgeConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/connector`,
      localBaseUrl: `http://127.0.0.1:${localPort}/`,
      token: "t".repeat(48),
      internalAssertion: TEST_INTERNAL_ASSERTION,
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
      heartbeatIntervalMs: 5_000,
    });
    const runPromise = connector.run(controller.signal);
    const edgeSocket = await connectionPromise;

    edgeSocket.send(JSON.stringify({
      type: "edge-hello",
      protocolVersion: EDGE_PROTOCOL_VERSION,
    }));
    expect(await waitForMessage(edgeSocket)).toEqual({
      type: "connector-ready",
      protocolVersion: EDGE_PROTOCOL_VERSION,
    });

    edgeSocket.send(JSON.stringify({
      type: "http-request",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      requestId: "request-1",
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: "Bearer mcp-token",
        "content-type": "application/json",
        "x-edge-secret": "must-not-forward",
        origin: "https://chatgpt.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      principal: TEST_PRINCIPAL,
    }));

    const response = await waitForMessage(edgeSocket);
    expect(response).toMatchObject({
      type: "http-response",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      requestId: "request-1",
      status: 201,
      body: JSON.stringify({ ok: true }),
    });
    expect(response.headers).toMatchObject({
      "content-type": "application/json",
      "www-authenticate": "Bearer test",
    });
    expect((response.headers as Record<string, string>)["x-local-secret"]).toBeUndefined();
    expect(observedAuthorization).toBeUndefined();
    expect(observedSecretHeader).toBeUndefined();
    expect(observedOrigin).toBe("https://chatgpt.com");

    controller.abort();
    await runPromise;
  });

  it("propagates edge cancellation to the loopback Gateway request", async () => {
    let requestClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => { requestClosed = resolve; });
    const localServer = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.once("close", requestClosed);
      const timer = setTimeout(() => response.end("late"), 10_000);
      request.once("close", () => clearTimeout(timer));
    });
    const localPort = await listen(localServer);
    servers.push({ close: () => stopHttpServer(localServer) });

    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/connector" });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    const connectionPromise = waitForConnection(edgeWss);
    const controller = new AbortController();
    const connector = new EdgeConnector({
      edgeUrl: `ws://127.0.0.1:${edgePort}/connector`,
      localBaseUrl: `http://127.0.0.1:${localPort}/`,
      token: "c".repeat(48),
      internalAssertion: TEST_INTERNAL_ASSERTION,
      reconnectMinMs: 10,
      reconnectMaxMs: 20,
    });
    const runPromise = connector.run(controller.signal);
    const edgeSocket = await connectionPromise;

    edgeSocket.send(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION }));
    await waitForMessage(edgeSocket);
    edgeSocket.send(JSON.stringify({
      type: "http-request",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      requestId: "cancel-1",
      method: "POST",
      path: "/mcp",
      headers: { "content-type": "application/json" },
      body: "{}",
      principal: TEST_PRINCIPAL,
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    edgeSocket.send(JSON.stringify({
      type: "http-cancel",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      requestId: "cancel-1",
      reason: "client_disconnected",
    }));

    await closedPromise;
    controller.abort();
    await runPromise;
  });
});

describe("connector-ready runtime identity protocol", () => {
  const runtime = {
    version: 1,
    connectorInstanceId: "11111111-1111-4111-8111-111111111111",
    connectionGeneration: 3,
    processStartedAt: "2026-09-02T12:00:00.000Z",
    catalogContractRevision: "a".repeat(64),
    toolSetRevision: "b".repeat(64),
    toolCount: 61,
    serverVersion: "1.1.0-beta.24-catalog.test",
    nodePid: 1234,
    hostPid: 5678,
  };

  it("accepts legacy connector-ready and preserves a strict runtime identity when present", () => {
    expect(parseConnectorToEdgeMessage(JSON.stringify({
      type: "connector-ready",
      protocolVersion: EDGE_PROTOCOL_VERSION,
    }))).toEqual({
      type: "connector-ready",
      protocolVersion: EDGE_PROTOCOL_VERSION,
    });

    expect(parseConnectorToEdgeMessage(JSON.stringify({
      type: "connector-ready",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      runtime,
    }))).toEqual({
      type: "connector-ready",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      runtime,
    });
  });

  it("rejects malformed runtime identity instead of partially trusting it", () => {
    const malformed = [
      { ...runtime, version: 2 },
      { ...runtime, connectorInstanceId: "" },
      { ...runtime, connectionGeneration: 0 },
      { ...runtime, processStartedAt: "not-a-timestamp" },
      { ...runtime, catalogContractRevision: "short" },
      { ...runtime, toolSetRevision: "short" },
      { ...runtime, toolCount: 0 },
      { ...runtime, serverVersion: "" },
      { ...runtime, nodePid: 0 },
      { ...runtime, hostPid: -1 },
      { ...runtime, extra: "not-allowed" },
    ];

    for (const candidate of malformed) {
      expect(parseConnectorToEdgeMessage(JSON.stringify({
        type: "connector-ready",
        protocolVersion: EDGE_PROTOCOL_VERSION,
        runtime: candidate,
      }))).toBeNull();
    }
  });
});