import { afterEach, describe, expect, it } from "@jest/globals";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { EDGE_PROTOCOL_VERSION } from "@mcp-access-stack/edge-protocol";
import { EdgeConnector, type EdgeConnectorLog } from "../../../src/edge/connector.js";

const INTERNAL_ASSERTION = "a".repeat(43);
const servers: Array<{ close(): Promise<void> }> = [];
const RUNTIME_IDENTITY = {
  version: 1 as const,
  connectorInstanceId: "8b08f94c-46d4-4f3d-a11d-06d5ab23392f",
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

function waitForLog(
  logs: EdgeConnectorLog[],
  event: string,
  predicate: (entry: EdgeConnectorLog) => boolean = () => true,
  timeoutMs = 2_000,
): Promise<EdgeConnectorLog> {
  const existing = logs.find((entry) => entry.event === event && predicate(entry));
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const found = logs.find((entry) => entry.event === event && predicate(entry));
      if (found) {
        clearInterval(timer);
        resolve(found);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${event}`));
      }
    }, 5);
  });
}

function connectorOptions(edgePort: number, log: (entry: EdgeConnectorLog) => void) {
  return {
    edgeUrl: `ws://127.0.0.1:${edgePort}/connector`,
    localBaseUrl: "http://127.0.0.1:9/",
    token: "t".repeat(48),
    internalAssertion: INTERNAL_ASSERTION,
    reconnectMinMs: 10,
    reconnectMaxMs: 40,
    heartbeatIntervalMs: 5_000,
    runtimeIdentity: RUNTIME_IDENTITY,
    random: () => 0.5,
    log,
  };
}

afterEach(async () => {
  while (servers.length > 0) await servers.pop()!.close();
});

describe("EdgeConnector resilience observability", () => {
  it("classifies a terminated healthy WebSocket as abnormal 1006 with connection lifecycle metrics", async () => {
    const logs: EdgeConnectorLog[] = [];
    let now = 1_000;
    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/connector" });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    edgeWss.once("connection", (socket) => {
      now = 1_100;
      socket.send(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION }));
      socket.once("message", () => {
        now = 1_350;
        socket.terminate();
      });
    });

    const controller = new AbortController();
    const connector = new EdgeConnector({
      ...connectorOptions(edgePort, (entry) => logs.push(entry)),
      now: () => now,
    });
    const runPromise = connector.run(controller.signal);
    try {
      const ready = await waitForLog(logs, "edge_connector_ready", (entry) => entry.generation === 1);
      expect(ready).toMatchObject({
        generation: 1,
        connectorInstanceId: RUNTIME_IDENTITY.connectorInstanceId,
        processStartedAt: RUNTIME_IDENTITY.processStartedAt,
        catalogContractRevision: RUNTIME_IDENTITY.catalogContractRevision,
        toolSetRevision: RUNTIME_IDENTITY.toolSetRevision,
        toolCount: RUNTIME_IDENTITY.toolCount,
        serverVersion: RUNTIME_IDENTITY.serverVersion,
      });
      expect(JSON.stringify(ready)).not.toContain("nodePid");
      expect(JSON.stringify(ready)).not.toContain("hostPid");

      const disconnected = await waitForLog(logs, "edge_connector_disconnected", (entry) => entry.generation === 1);
      expect(disconnected).toMatchObject({
        generation: 1,
        status: 1006,
        closeClassification: "abnormal",
        connectionStartedAtMs: 1_000,
        readyAtMs: 1_100,
        endedAtMs: 1_350,
        durationMs: 350,
        pingCount: 0,
        pongCount: 0,
        activeRequests: 0,
      });
    } finally {
      controller.abort();
      await runPromise;
    }
  });

  it("records heartbeat timeout with deterministic ping and pong counters", async () => {
    const logs: EdgeConnectorLog[] = [];
    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/connector", autoPong: false });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    edgeWss.once("connection", (socket) => {
      socket.send(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION }));
    });

    const controller = new AbortController();
    const connector = new EdgeConnector({
      ...connectorOptions(edgePort, (entry) => logs.push(entry)),
      heartbeatIntervalMs: 20,
    });
    const runPromise = connector.run(controller.signal);
    try {
      const timeout = await waitForLog(logs, "edge_connector_heartbeat_timeout");
      expect(timeout).toMatchObject({
        generation: 1,
        pingCount: 1,
        pongCount: 0,
        activeRequests: 0,
      });
      const disconnected = await waitForLog(logs, "edge_connector_disconnected", (entry) => entry.generation === 1);
      expect(disconnected.status).toBe(1006);
    } finally {
      controller.abort();
      await runPromise;
    }
  });

  it("backs off consecutive pre-ready failures and resets after a healthy protocol handshake", async () => {
    const logs: EdgeConnectorLog[] = [];
    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/connector" });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    let connectionCount = 0;
    edgeWss.on("connection", (socket) => {
      connectionCount += 1;
      if (connectionCount <= 2) {
        socket.terminate();
        return;
      }
      if (connectionCount === 3) {
        socket.send(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION }));
        socket.once("message", () => socket.terminate());
      }
    });

    const controller = new AbortController();
    const connector = new EdgeConnector(connectorOptions(edgePort, (entry) => logs.push(entry)));
    const runPromise = connector.run(controller.signal);
    try {
      await waitForLog(logs, "edge_connector_reconnecting", (entry) => entry.generation === 3, 4_000);
      const reconnects = logs.filter((entry) => entry.event === "edge_connector_reconnecting").slice(0, 3);
      expect(reconnects.map((entry) => entry.reconnectInMs)).toEqual([20, 40, 10]);
      expect(reconnects.map((entry) => entry.consecutiveFailures)).toEqual([1, 2, 0]);
      expect(reconnects.map((entry) => entry.connectionFailures)).toEqual([1, 2, 2]);
    } finally {
      controller.abort();
      await runPromise;
    }
  });

  it("classifies service restarts and sanitizes close reasons", async () => {
    const logs: EdgeConnectorLog[] = [];
    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/connector" });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    edgeWss.once("connection", (socket) => {
      socket.send(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION }));
      socket.once("message", () => socket.close(1012, "Bearer super-secret authorization=hidden token=hidden"));
    });

    const controller = new AbortController();
    const connector = new EdgeConnector(connectorOptions(edgePort, (entry) => logs.push(entry)));
    const runPromise = connector.run(controller.signal);
    try {
      const disconnected = await waitForLog(logs, "edge_connector_disconnected", (entry) => entry.generation === 1);
      expect(disconnected.closeClassification).toBe("service_restart");
      expect(disconnected.closeReason).not.toContain("super-secret");
      expect(disconnected.closeReason).not.toContain("hidden");
      expect(disconnected.closeReason).toContain("[REDACTED]");
    } finally {
      controller.abort();
      await runPromise;
    }
  });

  it("records connection failures as bounded structured diagnostics", async () => {
    const logs: EdgeConnectorLog[] = [];
    const reserved = createServer();
    const port = await listen(reserved);
    await new Promise<void>((resolve) => reserved.close(() => resolve()));

    const controller = new AbortController();
    const connector = new EdgeConnector({
      ...connectorOptions(port, (entry) => logs.push(entry)),
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
    });
    const runPromise = connector.run(controller.signal);
    try {
      const failed = await waitForLog(logs, "edge_connector_connection_error");
      expect(failed.error).toMatchObject({
        name: "Error",
        code: "ECONNREFUSED",
      });
      expect(typeof failed.error?.message).toBe("string");
      expect((failed.error?.message ?? "").length).toBeLessThanOrEqual(256);
    } finally {
      controller.abort();
      await runPromise;
    }
  });
  it("measures offline duration across failed attempts until the next ready generation", async () => {
    const logs: EdgeConnectorLog[] = [];
    let now = 5_000;
    const edgeHttp = createServer();
    const edgeWss = new WebSocketServer({ server: edgeHttp, path: "/connector" });
    const edgePort = await listen(edgeHttp);
    servers.push({ close: () => stopWebSocketServer(edgeWss, edgeHttp) });

    let connectionCount = 0;
    edgeWss.on("connection", (socket) => {
      connectionCount += 1;
      if (connectionCount === 1) {
        now = 5_200;
        socket.terminate();
        return;
      }
      now = 5_700;
      socket.send(JSON.stringify({ type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION }));
    });

    const controller = new AbortController();
    const connector = new EdgeConnector({
      ...connectorOptions(edgePort, (entry) => logs.push(entry)),
      now: () => now,
    });
    const runPromise = connector.run(controller.signal);
    try {
      const ready = await waitForLog(logs, "edge_connector_ready", (entry) => entry.generation === 2, 4_000);
      expect(ready).toMatchObject({
        generation: 2,
        readyAtMs: 5_700,
        offlineDurationMs: 700,
        consecutiveFailures: 0,
        connectionFailures: 1,
      });
    } finally {
      controller.abort();
      await runPromise;
    }
  });
});
