import { describe, expect, it, jest } from "@jest/globals";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";
import type {
  UpdateControlEvent,
  UpdateControlRunSnapshot,
  UpdateGetRunResult,
  UpdateListRunsResult,
  UpdateWaitEventsResult,
} from "@mcp-access-stack/update-control-contract";
import {
  ORACLE_CHANNEL_CONNECT_PATH,
  ORACLE_CHANNEL_ORIGIN,
  ORACLE_CHANNEL_SCOPE,
  UpdateControlOracleChannel,
  type OracleChannelDurableState,
  type OracleChannelEnvironment,
} from "../../src/oracle-channel.js";
import { UpdateControlOracleChannelReadClient } from "../../src/oracle-channel-client.js";
import { createUpdateControlReadOnlyTools } from "../../src/tools.js";

const TOKEN = "oracle-channel-test-token-".padEnd(48, "x");
const principal: AuthenticatedEdgePrincipal = {
  subject: "owner:test",
  scopes: ["update:read"],
  ownerScope: "owner",
  userId: "usr_update_control_owner",
};
const runId = "6aa35d14-07fb-414c-9f91-f9b08c125303";
const run: UpdateControlRunSnapshot = {
  runId,
  blueprintId: "mcp-v3-public-release",
  blueprintVersion: 1,
  blueprintSha256: "a".repeat(64),
  targetRelease: "synthetic-beta80",
  sourceCommitSha: "b".repeat(40),
  status: "paused_outcome_unknown",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:01:00.000Z",
  lastSeq: 3,
  steps: [],
  gates: [],
};
const events: UpdateControlEvent[] = [
  {
    eventId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320000",
    runId,
    seq: 2,
    eventType: "step.started",
    payload: { stepId: "oracle-health" },
    occurredAt: "2026-10-01T00:00:30.000Z",
    redacted: true,
  },
  {
    eventId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320001",
    runId,
    seq: 3,
    eventType: "run.paused_outcome_unknown",
    payload: { stepId: "oracle-health" },
    occurredAt: "2026-10-01T00:01:00.000Z",
    redacted: true,
  },
];

type SocketMessage = string | ArrayBuffer;

class MemorySocket {
  readyState = 1;
  closeCode: number | undefined;
  receiver: ((message: SocketMessage) => void) | undefined;
  peer: MemorySocket | undefined;

  send(message: SocketMessage): void {
    if (this.readyState !== 1 || !this.peer || this.peer.readyState !== 1) {
      throw new Error("socket is not open");
    }
    this.peer.receiver?.(message);
  }

  close(code = 1000, _reason = ""): void {
    this.closeCode = code;
    this.readyState = 3;
    if (this.peer) this.peer.readyState = 3;
  }

  static pair(): { client: MemorySocket; server: MemorySocket } {
    const client = new MemorySocket();
    const server = new MemorySocket();
    client.peer = server;
    server.peer = client;
    return { client, server };
  }
}

class MemoryDurableState implements OracleChannelDurableState {
  readonly accepted: Array<{ socket: WebSocket; tags: string[] }> = [];
  readonly tasks: Promise<unknown>[] = [];
  readonly storage = {
    get: jest.fn(async () => { throw new Error("channel must not read durable storage"); }),
    put: jest.fn(async () => { throw new Error("channel must not write durable storage"); }),
    delete: jest.fn(async () => { throw new Error("channel must not delete durable storage"); }),
  };

  acceptWebSocket(socket: WebSocket, tags?: string[]): void {
    this.accepted.push({ socket, tags: [...(tags ?? [])] });
  }

  getWebSockets(tag?: string): WebSocket[] {
    return this.accepted
      .filter((entry) => tag === undefined || entry.tags.includes(tag))
      .map((entry) => entry.socket)
      .filter((socket) => socket.readyState === 1);
  }

  waitUntil(promise: Promise<unknown>): void {
    this.tasks.push(promise);
  }

  async flush(): Promise<void> {
    while (this.tasks.length > 0) await Promise.all(this.tasks.splice(0));
  }
}

function makeUpgradeResponse(client: WebSocket): Response {
  const response = new Response(null, { status: 200 });
  Object.defineProperty(response, "webSocket", { value: client });
  return response;
}

function createHarness() {
  const state = new MemoryDurableState();
  const pairs: Array<{ client: MemorySocket; server: MemorySocket }> = [];
  let channel = new UpdateControlOracleChannel(
    state,
    { UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: TOKEN } satisfies OracleChannelEnvironment,
    {
      webSocketPairFactory: () => {
        const pair = MemorySocket.pair();
        pairs.push(pair);
        return pair as unknown as { client: WebSocket; server: WebSocket };
      },
      upgradeResponseFactory: makeUpgradeResponse,
    },
  );
  const namespace = {
    idFromName: jest.fn((name: string) => name),
    get: jest.fn((id: unknown) => ({
      fetch: (request: Request) => channel.fetch(request),
      id,
    })),
  };
  const client = new UpdateControlOracleChannelReadClient(namespace);

  async function connect(headers: Record<string, string> = {}) {
    const response = await channel.fetch(new Request(
      "https://mcp-v3-update-control.workers.dev" + ORACLE_CHANNEL_CONNECT_PATH,
      {
        method: "GET",
        headers: {
          upgrade: "websocket",
          origin: ORACLE_CHANNEL_ORIGIN,
          authorization: "Bearer " + TOKEN,
          ...headers,
        },
      },
    ));
    return { response, oracle: pairs.at(-1)?.client, server: pairs.at(-1)?.server };
  }

  function reactivate(): void {
    channel = new UpdateControlOracleChannel(
      state,
      { UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN: TOKEN } satisfies OracleChannelEnvironment,
      {
        webSocketPairFactory: () => {
          const pair = MemorySocket.pair();
          pairs.push(pair);
          return pair as unknown as { client: WebSocket; server: WebSocket };
        },
        upgradeResponseFactory: makeUpgradeResponse,
      },
    );
  }

  return { state, pairs, channel: () => channel, client, namespace, connect, reactivate };
}

function rpcRequest(method: string, args: unknown): Request {
  return new Request("https://oracle-channel.internal/_internal/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, arguments: args }),
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 25; attempt += 1) await Promise.resolve();
}

function attachOraclePeer(
  channel: UpdateControlOracleChannel,
  state: MemoryDurableState,
  oracle: MemorySocket,
  server: MemorySocket,
  respond: (request: Record<string, unknown>) => unknown,
): void {
  server.receiver = (message) => channel.webSocketMessage(server as unknown as WebSocket, message);
  oracle.receiver = (message) => {
    if (typeof message !== "string") return;
    const request = JSON.parse(message) as Record<string, unknown>;
    const result = respond(request);
    oracle.send(JSON.stringify({
      version: 1,
      type: "response",
      requestId: request.requestId,
      outcome: "success",
      result,
    }));
    void state.flush();
  };
}

describe("Update Control reverse WSS channel", () => {
  it("routes the three existing read-only tools end to end without changing arguments or results", async () => {
    const h = createHarness();
    const connected = await h.connect();
    expect(connected.response.status).toBe(200);
    const oracle = connected.oracle!;
    const server = connected.server!;
    const seen: Array<{ method: string; arguments: unknown }> = [];
    attachOraclePeer(h.channel(), h.state, oracle, server, (frame) => {
      seen.push({ method: String(frame.method), arguments: frame.arguments });
      if (frame.method === "list_runs") {
        return { runs: [run], nextCursor: "cursor_next", hasMore: true } satisfies UpdateListRunsResult;
      }
      if (frame.method === "get_run") {
        return {
          run,
          evidence: [],
          nextEvidenceCursor: null,
          hasMoreEvidence: false,
        } satisfies UpdateGetRunResult;
      }
      return {
        outcome: "events",
        runId,
        afterSeq: 1,
        currentSeq: 3,
        events: events.slice(0, 1),
        hasMore: true,
      } satisfies UpdateWaitEventsResult;
    });

    const tools = createUpdateControlReadOnlyTools(h.client);
    const list = await tools.handle({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "update_list_runs", arguments: { limit: 1, cursor: "cursor_prior" } },
    }, principal);
    const get = await tools.handle({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "update_get_run", arguments: { runId, evidenceLimit: 10 } },
    }, principal);
    const wait = await tools.handle({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "update_wait_events", arguments: { runId, afterSeq: 1, timeoutSeconds: 15, limit: 1 } },
    }, principal);

    expect(seen).toEqual([
      { method: "list_runs", arguments: { limit: 1, cursor: "cursor_prior" } },
      { method: "get_run", arguments: { runId, evidenceLimit: 10 } },
      { method: "wait_events", arguments: { runId, afterSeq: 1, timeoutSeconds: 15, limit: 1 } },
    ]);
    expect((await list!.json() as { result: { structuredContent: UpdateListRunsResult } })
      .result.structuredContent.runs[0]?.status).toBe("paused_outcome_unknown");
    expect((await get!.json() as { result: { structuredContent: UpdateGetRunResult } })
      .result.structuredContent.run.runId).toBe(runId);
    const waitResult = (await wait!.json() as {
      result: { structuredContent: UpdateWaitEventsResult };
    }).result.structuredContent;
    expect(waitResult.events.map((event) => event.seq)).toEqual([2]);
    expect(waitResult.hasMore).toBe(true);
    expect(h.state.storage.get).not.toHaveBeenCalled();
    expect(h.state.storage.put).not.toHaveBeenCalled();
    expect(h.state.storage.delete).not.toHaveBeenCalled();
  });

  it("preserves a legitimate wait timeout response separately from transport timeout", async () => {
    const h = createHarness();
    const connected = await h.connect();
    attachOraclePeer(h.channel(), h.state, connected.oracle!, connected.server!, (frame) => ({
      outcome: "timeout",
      runId,
      afterSeq: (frame.arguments as { afterSeq: number }).afterSeq,
      currentSeq: 3,
      events: [],
    } satisfies UpdateWaitEventsResult));

    await expect(h.client.waitEvents({ runId, afterSeq: 3, timeoutSeconds: 15, limit: 100 }))
      .resolves.toEqual({
        outcome: "timeout",
        runId,
        afterSeq: 3,
        currentSeq: 3,
        events: [],
      });
  });

  it("reports a disconnected Oracle as transport unavailable and supports a clean reconnect", async () => {
    const h = createHarness();
    const connected = await h.connect();
    connected.oracle!.close(1006, "test disconnect");
    h.channel().webSocketClose(
      connected.server as unknown as WebSocket, 1006, "test disconnect", false,
    );

    await expect(h.client.listRuns({ limit: 1 })).rejects.toMatchObject({
      code: "UPDATE_ORCHESTRATOR_UNAVAILABLE",
    });
    const next = await h.connect();
    attachOraclePeer(h.channel(), h.state, next.oracle!, next.server!, () => ({
      runs: [run],
      nextCursor: null,
      hasMore: false,
    } satisfies UpdateListRunsResult));
    await expect(h.client.listRuns({ limit: 1 })).resolves.toMatchObject({ runs: [run] });
  });

  it("recovers the active socket after DO reactivation without persistent business storage", async () => {
    const h = createHarness();
    const connected = await h.connect();
    h.reactivate();
    attachOraclePeer(h.channel(), h.state, connected.oracle!, connected.server!, () => ({
      runs: [run],
      nextCursor: null,
      hasMore: false,
    } satisfies UpdateListRunsResult));
    await expect(h.client.listRuns({ limit: 1 })).resolves.toMatchObject({ runs: [run] });
    expect(h.state.storage.get).not.toHaveBeenCalled();
    expect(h.state.storage.put).not.toHaveBeenCalled();
    expect(h.state.storage.delete).not.toHaveBeenCalled();
  });

  it("replaces an authenticated connection while retaining one live socket per scope", async () => {
    const h = createHarness();
    const first = await h.connect();
    const second = await h.connect();
    expect(first.response.status).toBe(200);
    expect(second.response.status).toBe(200);
    expect(first.oracle!.readyState).toBe(3);
    expect(h.state.getWebSockets(ORACLE_CHANNEL_SCOPE)).toHaveLength(1);
  });

  it("fails closed for invalid token, origin, path, method, and missing transport secret", async () => {
    const h = createHarness();
    expect((await h.connect({ authorization: "Bearer wrong" })).response.status).toBe(401);
    expect((await h.connect({ origin: "https://other.example" })).response.status).toBe(403);
    const badPath = await h.channel().fetch(new Request("https://worker.example/not-the-channel", {
      method: "GET",
      headers: { upgrade: "websocket", origin: ORACLE_CHANNEL_ORIGIN, authorization: "Bearer " + TOKEN },
    }));
    expect(badPath.status).toBe(404);
    const badMethod = await h.channel().fetch(new Request(
      "https://worker.example" + ORACLE_CHANNEL_CONNECT_PATH,
      { method: "POST", headers: { upgrade: "websocket", origin: ORACLE_CHANNEL_ORIGIN, authorization: "Bearer " + TOKEN } },
    ));
    expect(badMethod.status).toBe(405);
    const missing = new UpdateControlOracleChannel(h.state, {}, {
      webSocketPairFactory: () => MemorySocket.pair() as unknown as { client: WebSocket; server: WebSocket },
      upgradeResponseFactory: makeUpgradeResponse,
    });
    const response = await missing.fetch(new Request(
      "https://worker.example" + ORACLE_CHANNEL_CONNECT_PATH,
      { method: "GET", headers: { upgrade: "websocket", origin: ORACLE_CHANNEL_ORIGIN, authorization: "Bearer " + TOKEN } },
    ));
    expect(response.status).toBe(503);
    expect(h.pairs).toHaveLength(0);
  });

  it("rejects invalid internal methods, malformed frames, oversized and binary frames", async () => {
    const h = createHarness();
    expect((await h.channel().fetch(rpcRequest("promote", {}))).status).toBe(400);
    const connected = await h.connect();
    h.channel().webSocketMessage(connected.server as unknown as WebSocket, "not json");
    await h.state.flush();
    expect(connected.server!.closeCode).toBe(1008);

    const next = await h.connect();
    h.channel().webSocketMessage(
      next.server as unknown as WebSocket,
      "x".repeat(512 * 1024 + 1),
    );
    await h.state.flush();
    expect(next.server!.closeCode).toBe(1009);

    const last = await h.connect();
    h.channel().webSocketMessage(last.server as unknown as WebSocket, new ArrayBuffer(8));
    await h.state.flush();
    expect(last.server!.closeCode).toBe(1003);
  });

  it("rejects duplicate and late response correlation IDs", async () => {
    jest.useFakeTimers();
    try {
      const h = createHarness();
      let connected = await h.connect();
      let oracle = connected.oracle!;
      let server = connected.server!;
      server.receiver = (message) => h.channel().webSocketMessage(server as unknown as WebSocket, message);
      let captured: Record<string, unknown> | undefined;
      oracle.receiver = (message) => {
        if (typeof message === "string") captured = JSON.parse(message) as Record<string, unknown>;
      };
      const first = h.channel().fetch(rpcRequest("list_runs", {}));
      await flushMicrotasks();
      const firstFrame = captured!;
      oracle.send(JSON.stringify({
        version: 1,
        type: "response",
        requestId: firstFrame.requestId,
        outcome: "success",
        result: { runs: [run], nextCursor: null, hasMore: false },
      }));
      await h.state.flush();
      expect((await first).status).toBe(200);
      oracle.send(JSON.stringify({
        version: 1,
        type: "response",
        requestId: firstFrame.requestId,
        outcome: "success",
        result: { runs: [run], nextCursor: null, hasMore: false },
      }));
      await h.state.flush();
      expect(server.closeCode).toBe(1008);

      connected = await h.connect();
      oracle = connected.oracle!;
      server = connected.server!;
      server.receiver = (message) => h.channel().webSocketMessage(server as unknown as WebSocket, message);
      captured = undefined;
      oracle.receiver = (message) => {
        if (typeof message === "string") captured = JSON.parse(message) as Record<string, unknown>;
      };
      const request = h.channel().fetch(rpcRequest("wait_events", {
        runId, afterSeq: 3, timeoutSeconds: 15, limit: 100,
      }));
      await flushMicrotasks();
      await jest.advanceTimersByTimeAsync(20_001);
      expect((await request).status).toBe(504);
      oracle.send(JSON.stringify({
        version: 1,
        type: "response",
        requestId: captured?.requestId,
        outcome: "success",
        result: { outcome: "timeout", runId, afterSeq: 3, currentSeq: 3, events: [] },
      }));
      await h.state.flush();
      expect(server.closeCode).toBe(1008);
    } finally {
      jest.useRealTimers();
    }
  });

  it("bounds in-flight RPCs and clears correlations when the socket closes", async () => {
    jest.useFakeTimers();
    try {
      const h = createHarness();
      const connected = await h.connect();
      const oracle = connected.oracle!;
      const server = connected.server!;
      server.receiver = (message) => h.channel().webSocketMessage(server as unknown as WebSocket, message);
      oracle.receiver = () => undefined;
      const requests = Array.from({ length: 33 }, () =>
        h.channel().fetch(rpcRequest("list_runs", {})));
      await flushMicrotasks();
      const overflow = await Promise.all(requests.slice(32));
      expect(overflow[0]?.status).toBe(503);
      oracle.close(1006, "test disconnect");
      h.channel().webSocketClose(server as unknown as WebSocket, 1006, "test disconnect", false);
      const settled = await Promise.all(requests.slice(0, 32));
      expect(settled.every((response) => response.status === 503)).toBe(true);
      expect(h.state.getWebSockets(ORACLE_CHANNEL_SCOPE)).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps read result sequence ordering and outcome_unknown intact", async () => {
    const h = createHarness();
    const connected = await h.connect();
    attachOraclePeer(h.channel(), h.state, connected.oracle!, connected.server!, (frame) => {
      if (frame.method === "list_runs") {
        return { runs: [run], nextCursor: null, hasMore: false } satisfies UpdateListRunsResult;
      }
      return {
        outcome: "events",
        runId,
        afterSeq: 1,
        currentSeq: 3,
        events,
        hasMore: false,
      } satisfies UpdateWaitEventsResult;
    });

    const result = await h.client.waitEvents({ runId, afterSeq: 1, timeoutSeconds: 0, limit: 10 });
    expect(result.events.map((event) => event.seq)).toEqual([2, 3]);
    const listed = await h.client.listRuns({ limit: 1 });
    expect(listed.runs[0]?.status).toBe("paused_outcome_unknown");
  });
});
