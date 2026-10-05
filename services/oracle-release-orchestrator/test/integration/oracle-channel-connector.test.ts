import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type WebSocket from "ws";
import {
  ORACLE_CHANNEL_CONNECT_PATH,
  ORACLE_CHANNEL_ORIGIN,
  ORACLE_CHANNEL_MAX_RPC_TIMEOUT_MS,
  ORACLE_READ_API_BASE_URL,
  OracleChannelConnector,
  computeOracleConnectorReconnectDelay,
  oracleReadApiDeadlineMs,
  parseOracleChannelConnectorConfig,
  type OracleChannelConnectorConfig,
} from "../../src/oracle-channel-connector.js";

const CHANNEL_TOKEN = "c".repeat(48);
const READ_TOKEN = "r".repeat(48);
const RUN_ID = "6aa35d14-07fb-414c-9f91-f9b08c125303";
const REQUEST_ID = "9c7b7c3c-c955-4d3b-bba9-6ea7ca320000";
const CHANNEL_URL = "wss://mcp-v3-update-control.account.workers.dev" + ORACLE_CHANNEL_CONNECT_PATH;
const runSnapshot = {
  runId: RUN_ID,
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

class MemorySocket extends EventEmitter {
  readyState = 0;
  peer: MemorySocket | undefined;
  sent: string[] = [];
  closeCode: number | undefined;

  open(): void {
    if (this.readyState !== 1) {
      this.readyState = 1;
      this.emit("open");
    }
    if (this.peer && this.peer.readyState !== 1) {
      this.peer.readyState = 1;
      this.peer.emit("open");
    }
  }

  send(data: string): void {
    if (this.readyState !== 1 || !this.peer || this.peer.readyState !== 1) {
      throw new Error("socket is not open");
    }
    this.sent.push(data);
    this.peer.emit("message", Buffer.from(data), false);
  }

  sendFromPeer(data: string): void {
    if (this.readyState !== 1 || !this.peer || this.peer.readyState !== 1) {
      throw new Error("socket is not open");
    }
    this.peer.emit("message", Buffer.from(data), false);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.closeCode = code;
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason), true);
    if (this.peer && this.peer.readyState !== 3) {
      this.peer.readyState = 3;
      this.peer.closeCode = code;
      this.peer.emit("close", code, Buffer.from(reason), true);
    }
  }

  terminate(): void {
    this.close(1006, "terminated");
  }

  static pair(): { oracle: MemorySocket; worker: MemorySocket } {
    const oracle = new MemorySocket();
    const worker = new MemorySocket();
    oracle.peer = worker;
    worker.peer = oracle;
    return { oracle, worker };
  }
}

function config(overrides: Partial<OracleChannelConnectorConfig> = {}): OracleChannelConnectorConfig {
  return {
    channelUrl: new URL(CHANNEL_URL),
    channelToken: CHANNEL_TOKEN,
    orchestratorToken: READ_TOKEN,
    ...overrides,
  };
}

function requestFrame(
  method: string,
  args: Record<string, unknown>,
  requestId = REQUEST_ID,
): string {
  return JSON.stringify({
    version: 1,
    type: "request",
    requestId,
    method,
    arguments: args,
  });
}

function responseFrom(socket: MemorySocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (message: Buffer) => resolve(JSON.parse(message.toString("utf8")) as Record<string, unknown>));
  });
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(message);
}

function makeHarness(
  fetchImpl: typeof fetch = jest.fn(async () => json({ ok: true })),
  overrides: {
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    monotonicNow?: () => number;
  } = {},
) {
  const connections: Array<{ oracle: MemorySocket; worker: MemorySocket; options: unknown; url: URL }> = [];
  const socketFactory = (url: URL, options: unknown): WebSocket => {
    const pair = MemorySocket.pair();
    connections.push({ ...pair, options, url });
    queueMicrotask(() => pair.oracle.open());
    return pair.oracle as unknown as WebSocket;
  };
  const controller = new AbortController();
  const connector = new OracleChannelConnector(config(), {
    socketFactory,
    fetchImpl,
    sleep: overrides.sleep ?? (async () => { await tick(); }),
    random: () => 0.5,
    ...(overrides.monotonicNow ? { monotonicNow: overrides.monotonicNow } : {}),
  });
  const running = connector.run(controller.signal);
  return { connections, controller, running };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function stop(harness: ReturnType<typeof makeHarness>): Promise<void> {
  harness.controller.abort();
  await harness.running;
}

function rpcRequest(
  method: string,
  args: Record<string, unknown>,
  requestId = REQUEST_ID,
): Record<string, unknown> {
  return { version: 1, type: "request", requestId, method, arguments: args };
}

describe("Oracle reverse-WSS read connector", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("requires a fixed workers.dev WSS path and protected credential files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "mcp-v3-oracle-channel-"));
    temporaryDirectories.push(directory);
    const credentialDirectory = path.join(directory, "credentials");
    mkdirSync(credentialDirectory, { mode: 0o700 });
    const channelPath = path.join(credentialDirectory, "channel-token");
    const readPath = path.join(credentialDirectory, "read-token");
    writeFileSync(channelPath, CHANNEL_TOKEN, { mode: 0o600 });
    writeFileSync(readPath, READ_TOKEN, { mode: 0o600 });

    const env = {
      UPDATE_CONTROL_ORACLE_CHANNEL_URL: CHANNEL_URL,
      UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE: channelPath,
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: readPath,
    };
    const loaded = parseOracleChannelConnectorConfig(env);
    expect(loaded.channelUrl.href).toBe(CHANNEL_URL);
    expect(loaded.channelToken).toBe(CHANNEL_TOKEN);
    expect(loaded.orchestratorToken).toBe(READ_TOKEN);

    for (const unsafeUrl of [
      "https://mcp-v3-update-control.account.workers.dev" + ORACLE_CHANNEL_CONNECT_PATH,
      "ws://mcp-v3-update-control.account.workers.dev" + ORACLE_CHANNEL_CONNECT_PATH,
      "wss://evil.example" + ORACLE_CHANNEL_CONNECT_PATH,
      "wss://mcp-v3-update-control.account.workers.dev/_internal/other",
      CHANNEL_URL + "?query=unexpected",
      CHANNEL_URL.replace("wss://", "wss://user:pass@"),
    ]) {
      expect(() => parseOracleChannelConnectorConfig({ ...env, UPDATE_CONTROL_ORACLE_CHANNEL_URL: unsafeUrl }))
        .toThrow();
    }
    expect(() => parseOracleChannelConnectorConfig({
      ...env,
      UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE: undefined,
    })).toThrow();
    expect(ORACLE_READ_API_BASE_URL).toBe("http://127.0.0.1:9381");
  });

  it("accepts systemd LoadCredential mode 0440 only inside CREDENTIALS_DIRECTORY", () => {
    if (process.platform === "win32") return;

    const directory = mkdtempSync(path.join(tmpdir(), "mcp-v3-oracle-channel-systemd-"));
    temporaryDirectories.push(directory);
    const credentialDirectory = path.join(directory, "credentials");
    mkdirSync(credentialDirectory, { mode: 0o700 });

    const channelPath = path.join(credentialDirectory, "channel-token");
    const readPath = path.join(credentialDirectory, "read-token");
    writeFileSync(channelPath, CHANNEL_TOKEN, { mode: 0o600 });
    writeFileSync(readPath, READ_TOKEN, { mode: 0o600 });
    chmodSync(channelPath, 0o440);
    chmodSync(readPath, 0o440);

    const loaded = parseOracleChannelConnectorConfig({
      UPDATE_CONTROL_ORACLE_CHANNEL_URL: CHANNEL_URL,
      UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE: channelPath,
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: readPath,
      CREDENTIALS_DIRECTORY: credentialDirectory,
    });
    expect(loaded.channelToken).toBe(CHANNEL_TOKEN);
    expect(loaded.orchestratorToken).toBe(READ_TOKEN);

    const outsidePath = path.join(directory, "outside-token");
    writeFileSync(outsidePath, CHANNEL_TOKEN, { mode: 0o600 });
    chmodSync(outsidePath, 0o440);
    expect(() => parseOracleChannelConnectorConfig({
      UPDATE_CONTROL_ORACLE_CHANNEL_URL: CHANNEL_URL,
      UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE: outsidePath,
      UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE: readPath,
      CREDENTIALS_DIRECTORY: credentialDirectory,
    })).toThrow(/unavailable or invalid/u);
  });

  it("uses the exact authenticated Worker handshake and translates list/get/wait without changing results", async () => {
    let listResult: { runs: Array<typeof runSnapshot>; nextCursor: string | null; hasMore: boolean } = { runs: [runSnapshot], nextCursor: "opaque-cursor", hasMore: true };
    const getResult = {
      run: runSnapshot,
      evidence: [{ evidenceId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320010", runId: RUN_ID, stepId: null, kind: "health", sha256: "c".repeat(64), observedAt: "2026-10-01T00:00:00Z", recordedAt: "2026-10-01T00:00:01Z" }],
      nextEvidenceCursor: null,
      hasMoreEvidence: false,
    };
    const waitResult = {
      outcome: "events",
      runId: RUN_ID,
      afterSeq: 1,
      events: [
        { runId: RUN_ID, seq: 2, eventId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320011", eventType: "step.intent_recorded", payload: { stepId: "oracle-health" }, occurredAt: "2026-10-01T00:00:30Z", redacted: true },
        { runId: RUN_ID, seq: 3, eventId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320012", eventType: "operation.outcome_unknown", payload: { stepId: "oracle-health" }, occurredAt: "2026-10-01T00:01:00Z", redacted: true },
      ],
      currentSeq: 3,
      hasMore: false,
    };
    const calls: Array<{ url: URL; authorization: string | null; signal: AbortSignal | null }> = [];
    const fetchImpl = jest.fn(async (input: string | Request | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
        signal: init?.signal instanceof AbortSignal ? init.signal : null,
      });
      if (url.pathname === "/internal/v1/runs") return json(listResult);
      if (url.pathname === `/internal/v1/runs/${RUN_ID}`) return json(getResult);
      if (url.pathname === `/internal/v1/runs/${RUN_ID}/events`) return json(waitResult);
      return json({ error: "not_found" }, 404);
    });
    const harness = makeHarness(fetchImpl as typeof fetch);
    try {
      await waitFor(() => harness.connections.length === 1 && harness.connections[0]?.oracle.readyState === 1, "connector did not connect");
      const { oracle, worker, options, url } = harness.connections[0]!;
      expect(url.href).toBe(CHANNEL_URL);
      expect(options).toMatchObject({
        origin: ORACLE_CHANNEL_ORIGIN,
        rejectUnauthorized: true,
        handshakeTimeout: expect.any(Number),
        maxPayload: expect.any(Number),
        perMessageDeflate: false,
      });
      expect(options).toMatchObject({ headers: { authorization: `Bearer ${CHANNEL_TOKEN}` } });

      const listResponse = responseFrom(worker);
      worker.sendFromPeer(requestFrame("list_runs", { limit: 1, cursor: "opaque-cursor" }));
      const listFrame = await listResponse;
      expect(listFrame).toEqual({ version: 1, type: "response", requestId: REQUEST_ID, outcome: "success", result: listResult });

      listResult = { runs: [], nextCursor: null, hasMore: false };
      const repeatedList = responseFrom(worker);
      worker.sendFromPeer(requestFrame("list_runs", { limit: 1, cursor: "opaque-cursor" }, "9c7b7c3c-c955-4d3b-bba9-6ea7ca320021"));
      expect(await repeatedList).toEqual({ version: 1, type: "response", requestId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320021", outcome: "success", result: listResult });

      const getResponse = responseFrom(worker);
      worker.sendFromPeer(requestFrame("get_run", { runId: RUN_ID, evidenceLimit: 10 }));
      expect(await getResponse).toEqual({ version: 1, type: "response", requestId: REQUEST_ID, outcome: "success", result: getResult });

      const waitResponse = responseFrom(worker);
      worker.sendFromPeer(requestFrame("wait_events", { runId: RUN_ID, afterSeq: 1, limit: 100, timeoutSeconds: 15 }, "9c7b7c3c-c955-4d3b-bba9-6ea7ca320020"));
      expect(await waitResponse).toEqual({
        version: 1,
        type: "response",
        requestId: "9c7b7c3c-c955-4d3b-bba9-6ea7ca320020",
        outcome: "success",
        result: waitResult,
      });

      expect(calls.map((call) => call.url.href)).toEqual([
        "http://127.0.0.1:9381/internal/v1/runs?limit=1&cursor=opaque-cursor",
        "http://127.0.0.1:9381/internal/v1/runs?limit=1&cursor=opaque-cursor",
        `http://127.0.0.1:9381/internal/v1/runs/${RUN_ID}?evidenceLimit=10`,
        `http://127.0.0.1:9381/internal/v1/runs/${RUN_ID}/events?afterSeq=1&limit=100&waitMs=15000`,
      ]);
      expect(calls.every((call) => call.authorization === `Bearer ${READ_TOKEN}`)).toBe(true);
      expect(calls.every((call) => call.signal instanceof AbortSignal)).toBe(true);
      expect(oracle.sent).toHaveLength(4);
    } finally {
      await stop(harness);
    }
  });

  it("maps only the read API's typed run_not_found response to RUN_NOT_FOUND", async () => {
    const harness = makeHarness(jest.fn(async () => json({ error: "run_not_found" }, 404)) as typeof fetch);
    try {
      await waitFor(() => harness.connections.length === 1 && harness.connections[0]?.oracle.readyState === 1, "connector did not connect");
      const worker = harness.connections[0]!.worker;
      const reply = responseFrom(worker);
      worker.sendFromPeer(requestFrame("get_run", { runId: RUN_ID }));
      expect(await reply).toEqual({ version: 1, type: "response", requestId: REQUEST_ID, outcome: "error", errorCode: "RUN_NOT_FOUND" });
    } finally {
      await stop(harness);
    }

    const generic404 = makeHarness(jest.fn(async () => json({ error: "not_found" }, 404)) as typeof fetch);
    try {
      await waitFor(() => generic404.connections.length === 1 && generic404.connections[0]?.oracle.readyState === 1, "connector did not connect");
      const worker = generic404.connections[0]!.worker;
      const reply = responseFrom(worker);
      worker.sendFromPeer(requestFrame("get_run", { runId: RUN_ID }));
      expect(await reply).toEqual({ version: 1, type: "response", requestId: REQUEST_ID, outcome: "error", errorCode: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });
    } finally {
      await stop(generic404);
    }
  });

  it("preserves a legitimate wait timeout and maps local API failure to transport unavailability", async () => {
    const timeoutResult = { outcome: "timeout", runId: RUN_ID, afterSeq: 7, events: [], currentSeq: 7 };
    const legitimate = makeHarness(jest.fn(async () => json(timeoutResult)) as typeof fetch);
    try {
      await waitFor(() => legitimate.connections.length === 1 && legitimate.connections[0]?.oracle.readyState === 1, "connector did not connect");
      const worker = legitimate.connections[0]!.worker;
      const reply = responseFrom(worker);
      worker.sendFromPeer(requestFrame("wait_events", { runId: RUN_ID, afterSeq: 7, timeoutSeconds: 0 }));
      expect(await reply).toEqual({ version: 1, type: "response", requestId: REQUEST_ID, outcome: "success", result: timeoutResult });
    } finally {
      await stop(legitimate);
    }

    const unavailable = makeHarness(jest.fn(async () => { throw new Error("local API unavailable"); }) as typeof fetch);
    try {
      await waitFor(() => unavailable.connections.length === 1 && unavailable.connections[0]?.oracle.readyState === 1, "connector did not connect");
      const worker = unavailable.connections[0]!.worker;
      const reply = responseFrom(worker);
      worker.sendFromPeer(requestFrame("wait_events", { runId: RUN_ID, afterSeq: 7, timeoutSeconds: 15 }));
      expect(await reply).toEqual({ version: 1, type: "response", requestId: REQUEST_ID, outcome: "error", errorCode: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });
    } finally {
      await stop(unavailable);
    }
  });

  it("rejects malformed, unknown, oversized, and duplicate in-flight frames", async () => {
    const malformed = makeHarness();
    try {
      await waitFor(() => malformed.connections.length === 1 && malformed.connections[0]?.oracle.readyState === 1, "connector did not connect");
      malformed.connections[0]!.worker.sendFromPeer("{");
      await waitFor(() => malformed.connections[0]!.oracle.readyState === 3, "malformed frame did not close the socket");
      expect(malformed.connections[0]!.oracle.closeCode).toBe(1008);
    } finally {
      await stop(malformed);
    }

    const unknown = makeHarness();
    try {
      await waitFor(() => unknown.connections.length === 1 && unknown.connections[0]?.oracle.readyState === 1, "connector did not connect");
      unknown.connections[0]!.worker.sendFromPeer(requestFrame("mutate_release", {}));
      await waitFor(() => unknown.connections[0]!.oracle.readyState === 3, "unknown method did not close the socket");
      expect(unknown.connections[0]!.oracle.closeCode).toBe(1008);
    } finally {
      await stop(unknown);
    }

    const oversized = makeHarness();
    try {
      await waitFor(() => oversized.connections.length === 1 && oversized.connections[0]?.oracle.readyState === 1, "connector did not connect");
      oversized.connections[0]!.worker.sendFromPeer(" ".repeat(512 * 1024 + 1));
      await waitFor(() => oversized.connections[0]!.oracle.readyState === 3, "oversized frame did not close the socket");
      expect(oversized.connections[0]!.oracle.closeCode).toBe(1009);
    } finally {
      await stop(oversized);
    }

    const pending = new Map<string, (value: Response) => void>();
    const duplicate = makeHarness(jest.fn((input: string | Request | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      pending.set(url.pathname, resolve);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    })) as typeof fetch);
    try {
      await waitFor(() => duplicate.connections.length === 1 && duplicate.connections[0]?.oracle.readyState === 1, "connector did not connect");
      const peer = duplicate.connections[0]!.worker;
      peer.sendFromPeer(requestFrame("get_run", { runId: RUN_ID }));
      await waitFor(() => pending.size === 1, "first RPC did not enter local API");
      peer.sendFromPeer(requestFrame("get_run", { runId: RUN_ID }));
      await waitFor(() => duplicate.connections[0]!.oracle.readyState === 3, "duplicate in-flight ID did not close the socket");
      expect(duplicate.connections[0]!.oracle.closeCode).toBe(1008);
    } finally {
      await stop(duplicate);
    }
  });

  it("aborts in-flight local reads on disconnect and never resends them after reconnect", async () => {
    const aborted = jest.fn();
    const fetchImpl = jest.fn(async (_input: string | Request | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("request signal missing");
      signal.addEventListener("abort", () => {
        aborted();
        reject(new Error("aborted"));
      }, { once: true });
    }));
    const harness = makeHarness(fetchImpl as typeof fetch);
    try {
      await waitFor(() => harness.connections.length === 1 && harness.connections[0]?.oracle.readyState === 1, "connector did not connect");
      harness.connections[0]!.worker.sendFromPeer(requestFrame("wait_events", { runId: RUN_ID, afterSeq: 3, timeoutSeconds: 15 }));
      await waitFor(() => fetchImpl.mock.calls.length === 1, "local API request did not start");
      harness.connections[0]!.worker.close(1012, "fake Worker restart");
      await waitFor(() => aborted.mock.calls.length === 1, "disconnect did not abort the local read");
      await waitFor(() => harness.connections.length === 2 && harness.connections[1]?.oracle.readyState === 1, "connector did not reconnect");
      await tick();
      expect(harness.connections[1]!.oracle.sent).toHaveLength(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      await stop(harness);
    }
  });

  it("uses bounded deadlines and exponential backoff with bounded jitter", () => {
    expect(oracleReadApiDeadlineMs({ method: "list_runs", arguments: { limit: 20 } })).toBe(4_000);
    expect(oracleReadApiDeadlineMs({ method: "wait_events", arguments: { runId: RUN_ID, afterSeq: 0, timeoutSeconds: 0 } })).toBe(4_000);
    expect(oracleReadApiDeadlineMs({ method: "wait_events", arguments: { runId: RUN_ID, afterSeq: 0, timeoutSeconds: 10 } })).toBe(13_000);
    expect(oracleReadApiDeadlineMs({ method: "wait_events", arguments: { runId: RUN_ID, afterSeq: 0, timeoutSeconds: 15 } })).toBe(18_000);
    expect(18_000).toBeLessThan(ORACLE_CHANNEL_MAX_RPC_TIMEOUT_MS);
    expect(computeOracleConnectorReconnectDelay(0, () => 0)).toBeGreaterThanOrEqual(500);
    expect(computeOracleConnectorReconnectDelay(0, () => 1)).toBeLessThanOrEqual(1_500);
    expect(computeOracleConnectorReconnectDelay(1, () => 0.5)).toBe(2_000);
    expect(computeOracleConnectorReconnectDelay(100, () => 1)).toBeLessThanOrEqual(60_000);
  });

  it("resets reconnect backoff after a stable connection", async () => {
    const delays: number[] = [];
    let monotonic = 0;
    const harness = makeHarness(undefined, {
      monotonicNow: () => monotonic,
      sleep: async (milliseconds) => { delays.push(milliseconds); await tick(); },
    });
    try {
      await waitFor(() => harness.connections.length === 1 && harness.connections[0]?.oracle.readyState === 1, "connector did not connect");
      harness.connections[0]!.worker.close(1012, "early disconnect one");
      await waitFor(() => harness.connections.length === 2 && harness.connections[1]?.oracle.readyState === 1, "connector did not reconnect after first disconnect");
      harness.connections[1]!.worker.close(1012, "early disconnect two");
      await waitFor(() => harness.connections.length === 3 && harness.connections[2]?.oracle.readyState === 1, "connector did not reconnect after second disconnect");
      monotonic = 31_000;
      harness.connections[2]!.worker.close(1012, "stable connection test");
      await waitFor(() => harness.connections.length === 4 && harness.connections[3]?.oracle.readyState === 1, "connector did not reconnect after a stable socket");
      expect(delays).toEqual([1_000, 2_000, 1_000]);
    } finally {
      await stop(harness);
    }
  });

  it("bounds concurrent local reads at the Worker contract maximum", async () => {
    const fetchImpl = jest.fn((_input: string | Request | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) throw new Error("request signal missing");
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const harness = makeHarness(fetchImpl as typeof fetch);
    try {
      await waitFor(() => harness.connections.length === 1 && harness.connections[0]?.oracle.readyState === 1, "connector did not connect");
      const worker = harness.connections[0]!.worker;
      for (let index = 1; index <= 32; index += 1) {
        const id = `9c7b7c3c-c955-4d3b-bba9-${index.toString(16).padStart(12, "0")}`;
        worker.sendFromPeer(requestFrame("get_run", { runId: RUN_ID }, id));
      }
      await waitFor(() => fetchImpl.mock.calls.length === 32, "connector did not start all allowed reads");
      const overflowId = "9c7b7c3c-c955-4d3b-bba9-000000000033";
      const overflowResponse = responseFrom(worker);
      worker.sendFromPeer(requestFrame("get_run", { runId: RUN_ID }, overflowId));
      expect(await overflowResponse).toEqual({ version: 1, type: "response", requestId: overflowId, outcome: "error", errorCode: "UPDATE_ORCHESTRATOR_UNAVAILABLE" });
      expect(fetchImpl).toHaveBeenCalledTimes(32);
    } finally {
      await stop(harness);
    }
  });

  it("performs graceful shutdown by closing the socket and resolving the runner", async () => {
    const harness = makeHarness();
    await waitFor(() => harness.connections.length === 1 && harness.connections[0]?.oracle.readyState === 1, "connector did not connect");
    await stop(harness);
    expect(harness.connections[0]!.oracle.readyState).toBe(3);
    expect(harness.connections[0]!.oracle.closeCode).toBe(1001);
  });
});
