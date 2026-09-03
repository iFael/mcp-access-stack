import { afterEach, describe, expect, it } from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import {
  EDGE_PROTOCOL_VERSION,
  parseConnectorToEdgeMessage,
} from "@mcp-access-stack/edge-protocol";
import { EdgeConnector } from "../../../src/edge/connector.js";

const INTERNAL_ASSERTION = "a".repeat(43);
const servers: Array<{ close(): Promise<void> }> = [];
const runtimeIdentity = {
  version: 1 as const,
  connectorInstanceId: "2fc94e69-439f-4f9f-a76b-71da6141b17f",
  processStartedAt: "2026-09-02T12:00:00.000Z",
  catalogContractRevision: "a".repeat(64),
  toolSetRevision: "b".repeat(64),
  toolCount: 61,
  serverVersion: "1.1.0-beta.24-catalog.test",
  nodePid: 1234,
  hostPid: 4321,
};

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

async function stopWebSocketServer(wss: WebSocketServer, http: Server): Promise<void> {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
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
      reject(new Error("socket closed before connector-ready"));
    };
    const cleanup = () => {
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

describe("connector runtime identity protocol", () => {
  it("keeps legacy connector-ready parseable and preserves a strict v1 runtime identity", () => {
    const legacy = {
      type: "connector-ready",
      protocolVersion: EDGE_PROTOCOL_VERSION,
    };
    expect(parseConnectorToEdgeMessage(JSON.stringify(legacy))).toEqual(legacy);

    const current = {
      ...legacy,
      runtime: {
        ...runtimeIdentity,
        connectionGeneration: 3,
      },
    };
    expect(parseConnectorToEdgeMessage(JSON.stringify(current))).toEqual(current);
  });

  it.each([
    { connectionGeneration: 0 },
    { toolCount: 0 },
    { nodePid: 0 },
    { hostPid: 0 },
    { processStartedAt: "not-an-iso-timestamp" },
    { catalogContractRevision: "not-a-sha256" },
    { toolSetRevision: "not-a-sha256" },
    { connectorInstanceId: "not-a-uuid" },
  ])("rejects malformed runtime identity instead of partially trusting it: %o", (override) => {
    const message = {
      type: "connector-ready",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      runtime: {
        ...runtimeIdentity,
        connectionGeneration: 1,
        ...override,
      },
    };
    expect(parseConnectorToEdgeMessage(JSON.stringify(message))).toBeNull();
  });

  it("rejects unexpected runtime identity fields", () => {
    const message = {
      type: "connector-ready",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      runtime: {
        ...runtimeIdentity,
        connectionGeneration: 1,
        authorization: "must-never-be-accepted",
      },
    };
    expect(parseConnectorToEdgeMessage(JSON.stringify(message))).toBeNull();
  });

  it("keeps connectorInstanceId stable and increments connectionGeneration across reconnect", async () => {
    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/connector" });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    const readyMessages: Array<Record<string, unknown>> = [];
    const logs: Array<Record<string, unknown>> = [];
    let connectionCount = 0;
    const receivedTwoReady = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("timed out waiting for reconnect runtime identity")), 4_000);
      edgeWss.on("connection", (socket) => {
        connectionCount += 1;
        socket.send(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION }));
        void waitForMessage(socket).then((message) => {
          readyMessages.push(message);
          if (connectionCount === 1) {
            socket.terminate();
            return;
          }
          clearTimeout(timeout);
          resolve();
        }).catch(reject);
      });
    });

    const controller = new AbortController();
    const options = {
      edgeUrl: `ws://127.0.0.1:${edgePort}/connector`,
      localBaseUrl: "http://127.0.0.1:9/",
      token: "t".repeat(48),
      internalAssertion: INTERNAL_ASSERTION,
      reconnectMinMs: 10,
      reconnectMaxMs: 10,
      heartbeatIntervalMs: 5_000,
      runtimeIdentity,
      log: (entry: object) => logs.push(entry as Record<string, unknown>),
    };
    const connector = new EdgeConnector(options as ConstructorParameters<typeof EdgeConnector>[0]);
    const runPromise = connector.run(controller.signal);
    try {
      await receivedTwoReady;
      expect(readyMessages).toHaveLength(2);
      expect(readyMessages[0]).toMatchObject({
        type: "connector-ready",
        protocolVersion: EDGE_PROTOCOL_VERSION,
        runtime: {
          ...runtimeIdentity,
          connectionGeneration: 1,
        },
      });
      expect(readyMessages[1]).toMatchObject({
        type: "connector-ready",
        protocolVersion: EDGE_PROTOCOL_VERSION,
        runtime: {
          ...runtimeIdentity,
          connectionGeneration: 2,
        },
      });

      const readyLogs = logs.filter((entry) => entry.event === "edge_connector_ready");
      expect(readyLogs).toHaveLength(2);
      expect(readyLogs[0]).toMatchObject({
        generation: 1,
        connectorInstanceId: runtimeIdentity.connectorInstanceId,
        processStartedAt: runtimeIdentity.processStartedAt,
        catalogContractRevision: runtimeIdentity.catalogContractRevision,
        toolSetRevision: runtimeIdentity.toolSetRevision,
        toolCount: runtimeIdentity.toolCount,
        serverVersion: runtimeIdentity.serverVersion,
      });
      expect(readyLogs[1]).toMatchObject({ generation: 2 });
      expect(readyLogs[0]).not.toHaveProperty("nodePid");
      expect(readyLogs[0]).not.toHaveProperty("hostPid");
    } finally {
      controller.abort();
      await runPromise;
    }
  });
});
