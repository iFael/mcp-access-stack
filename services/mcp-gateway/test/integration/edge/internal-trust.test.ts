import { afterEach, describe, expect, it } from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { EDGE_PROTOCOL_VERSION } from "@mcp-access-stack/edge-protocol";
import { createGatewayApplication } from "../../../src/app.js";
import type { AgentRelay } from "../../../src/relay/service.js";
import { RelayWorkspaceExecutor } from "../../../src/relay/workspace-executor.js";
import { EdgeConnector } from "../../../src/edge/connector.js";
import { listen as listenGateway, makeGatewayConfig, silentLogger } from "../../support/helpers.js";

const INTERNAL_ASSERTION = "a".repeat(43);
const PRINCIPAL = {
  subject: "owner:test",
  scopes: ["mcp:tools"],
  ownerScope: "owner",
};

const servers: Array<{ close(): Promise<void> }> = [];

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

function waitForConnection(wss: WebSocketServer): Promise<WebSocket> {
  return new Promise((resolve) => wss.once("connection", resolve));
}

function waitForMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("close", () => reject(new Error("socket closed before message")));
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
  while (servers.length > 0) await servers.pop()!.close();
});

describe("Edge Connector internal trust boundary", () => {
  it("drops caller credentials and injects only connector-owned trust headers", async () => {
    let observedAuthorization: string | undefined;
    let observedAssertion: string | undefined;
    let observedPrincipal: string | undefined;
    const localServer = createServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      observedAssertion = request.headers["x-mcp-edge-internal-assertion"] as string | undefined;
      observedPrincipal = request.headers["x-mcp-edge-principal"] as string | undefined;
      response.statusCode = 200;
      response.end("ok");
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
      internalAssertion: INTERNAL_ASSERTION,
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
      requestId: "request-1",
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: "Bearer caller-controlled",
        "content-type": "application/json",
        "x-mcp-edge-internal-assertion": "caller-controlled",
        "x-mcp-edge-principal": "caller-controlled",
      },
      body: "{}",
      principal: PRINCIPAL,
    }));

    await waitForMessage(edgeSocket);
    expect(observedAuthorization).toBeUndefined();
    expect(observedAssertion).toBe(INTERNAL_ASSERTION);
    expect(observedPrincipal).toBe(Buffer.from(JSON.stringify(PRINCIPAL), "utf8").toString("base64url"));

    controller.abort();
    await runPromise;
  });
});

describe("embedded Gateway edge-trusted mode", () => {
  it("rejects missing or wrong internal assertions before MCP handling", async () => {
    const config = {
      ...makeGatewayConfig({ authMode: "none", workspaceBackend: { kind: "in-process" } }),
      authMode: "edge-trusted" as const,
    };
    const gateway = createGatewayApplication(config, {
      logger: silentLogger(),
      workspaceExecutor: new RelayWorkspaceExecutor({} as AgentRelay),
      workspaceReady: () => true,
      edgeTrust: { internalAssertion: INTERNAL_ASSERTION },
    });
    const http = await listenGateway(gateway.app);
    try {
      for (const assertion of [undefined, "wrong"]) {
        const response = await fetch(new URL("/mcp", http.url), {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            "x-mcp-edge-principal": Buffer.from(JSON.stringify(PRINCIPAL), "utf8").toString("base64url"),
            ...(assertion === undefined ? {} : { "x-mcp-edge-internal-assertion": assertion }),
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        });
        expect(response.status).toBe(401);
      }
    } finally {
      await http.close();
    }
  });

  it("accepts a sanitized principal only with the connector-owned assertion", async () => {
    const config = {
      ...makeGatewayConfig({ authMode: "none", workspaceBackend: { kind: "in-process" } }),
      authMode: "edge-trusted" as const,
    };
    const gateway = createGatewayApplication(config, {
      logger: silentLogger(),
      workspaceExecutor: new RelayWorkspaceExecutor({} as AgentRelay),
      workspaceReady: () => true,
      edgeTrust: { internalAssertion: INTERNAL_ASSERTION },
    });
    const http = await listenGateway(gateway.app);
    try {
      const response = await fetch(new URL("/mcp", http.url), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer caller-controlled",
          "content-type": "application/json",
          "x-mcp-edge-internal-assertion": INTERNAL_ASSERTION,
          "x-mcp-edge-principal": Buffer.from(JSON.stringify(PRINCIPAL), "utf8").toString("base64url"),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(response.status).toBe(200);
    } finally {
      await http.close();
    }
  });
});
