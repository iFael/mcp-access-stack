import { describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    constructor(ctx: unknown) {
      this.ctx = ctx;
    }
  },
}), { virtual: true });

type StorageValue = unknown;

class MemoryStorage {
  private readonly values = new Map<string, StorageValue>();
  readonly writes: string[] = [];

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.writes.push(keyOrEntries);
      this.values.set(keyOrEntries, value);
      return;
    }
    for (const [key, entry] of Object.entries(keyOrEntries)) {
      this.writes.push(key);
      this.values.set(key, entry);
    }
  }

  async transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

async function createSession(storage: MemoryStorage, connectors: object[] = []) {
  const { McpSession } = await import("../src/mcp-session.js");
  const ctx = {
    storage,
    blockConcurrencyWhile: jest.fn((callback: () => Promise<void>) => callback()),
    getWebSockets: jest.fn(() => connectors),
  };
  const session = new McpSession(ctx as never, {} as never);
  // Mirrors Cloudflare's blockConcurrencyWhile completion before request dispatch.
  await (ctx.blockConcurrencyWhile.mock.results[0]?.value ?? Promise.resolve());
  return session;
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id = 1,
): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function callBrowserRouter(
  session: object,
  body: Record<string, unknown>,
  name: string,
  args: Record<string, unknown>,
): Promise<Response | null> {
  const router = session as unknown as {
    tryRelayBrowserTool(
      request: Request,
      body: unknown,
      principal: {
        subject: string;
        scopes: string[];
        ownerScope: string;
        userId: string;
      },
      invocation: {
        id: string | number | null;
        name: string;
        arguments: Record<string, unknown>;
      },
    ): Promise<Response | null>;
  };
  return router.tryRelayBrowserTool(
    new Request("https://edge.example/mcp", { method: "POST" }),
    body,
    {
      subject: "user:test",
      scopes: ["workspaces:read"],
      ownerScope: "owner",
      userId: USER_ID,
    },
    { id: 1, name, arguments: args },
  );
}

async function errorText(response: Response | null): Promise<string> {
  expect(response).not.toBeNull();
  const payload = await response!.json() as {
    result?: { content?: Array<{ type?: string; text?: string }> };
  };
  return payload.result?.content?.[0]?.text ?? "";
}

const USER_ID = "usr_11111111-1111-4111-8111-111111111111";
const DEVICE_ID = "dev_22222222-2222-4222-8222-222222222222";
const RUNTIME_ID = "rt_33333333-3333-4333-8333-333333333333";
const OLD_EPOCH = "44444444-4444-4444-8444-444444444444";
const NEW_EPOCH = "55555555-5555-4555-8555-555555555555";

describe("McpSession read-only contract inspection", () => {
  it("never writes storage on a cold-start with an existing active contract", async () => {
    const { MCP_CONTRACT_ROLLOUT_STORAGE_KEY } = await import("../src/contract-compatibility.js");
    const storage = new MemoryStorage();
    const state = { version: 1, activeContractRevision: "a".repeat(64) };
    storage.set(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, state);
    const session = await createSession(storage);
    await session.getStatus();
    expect(storage.writes).toEqual([]);
    const inspection = JSON.parse(await (session as unknown as {
      inspectContractRollout(): Promise<string>;
    }).inspectContractRollout()) as { status: number; body: Record<string, unknown> };
    expect(inspection).toMatchObject({
      status: 200,
      body: { activeContractRevision: state.activeContractRevision, candidateConnectorReady: false },
    });
    expect(storage.writes).toEqual([]);
    expect(await storage.get(MCP_CONTRACT_ROLLOUT_STORAGE_KEY)).toEqual(state);
  });

  it("fails closed on absent and malformed persisted state without any writes", async () => {
    const { MCP_CONTRACT_ROLLOUT_STORAGE_KEY } = await import("../src/contract-compatibility.js");
    for (const invalid of [undefined, { version: 1, activeContractRevision: "not-a-revision" }]) {
      const storage = new MemoryStorage();
      if (invalid !== undefined) storage.set(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, invalid);
      const session = await createSession(storage);
      const health = await session.getStatus();
      expect(health.controlPlaneReady).toBe(false);
      expect(health.executionPlaneReady).toBe(false);
      const inspection = JSON.parse(await (session as unknown as {
        inspectContractRollout(): Promise<string>;
      }).inspectContractRollout()) as { status: number; body: Record<string, unknown> };
      expect(inspection).toEqual({ status: 503, body: { error: "contract_rollout_state_unavailable" } });
      expect(storage.writes).toEqual([]);
    }
  });

  it("returns bounded candidate state without disclosing arbitrary fields or mutating storage", async () => {
    const { MCP_CONTRACT_ROLLOUT_STORAGE_KEY } = await import("../src/contract-compatibility.js");
    const storage = new MemoryStorage();
    storage.set(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, {
      version: 1, activeContractRevision: "a".repeat(64),
      candidateContractRevision: "b".repeat(64),
      preparedAt: "2026-10-08T15:00:00.000Z", secret: "never-echo-me",
    });
    const session = await createSession(storage);
    const response = JSON.parse(await (session as unknown as {
      inspectContractRollout(): Promise<string>;
    }).inspectContractRollout()) as { status: number; body: Record<string, unknown> };
    expect(response).toMatchObject({
      status: 200, body: {
        activeContractRevision: "a".repeat(64),
        candidateContractRevision: "b".repeat(64),
        candidateConnectorReady: false,
        preparedAt: "2026-10-08T15:00:00.000Z",
      },
    });
    expect(JSON.stringify(response)).not.toContain("never-echo-me");
    expect(storage.writes).toEqual([]);
  });
});

  it("reports live connector readiness only for an open matching WebSocket", async () => {
    const { EDGE_PROTOCOL_VERSION } = await import("../src/protocol.js");
    const { MCP_CONTRACT_ROLLOUT_STORAGE_KEY } = await import("../src/contract-compatibility.js");
    const storage = new MemoryStorage();
    const candidate = "b".repeat(64);
    storage.set(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, {
      version: 1, activeContractRevision: "a".repeat(64), candidateContractRevision: candidate,
    });
    const socket = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({
        role: "connector", ready: true, protocolVersion: EDGE_PROTOCOL_VERSION,
        runtime: {
          version: 1,
          connectorInstanceId: "11111111-1111-4111-8111-111111111111",
          connectionGeneration: 7,
          processStartedAt: "2026-10-10T12:00:00.000Z",
          catalogContractRevision: candidate, toolSetRevision: "c".repeat(64),
          toolCount: 93, serverVersion: "1.1.0-test", nodePid: 123, hostPid: 456,
        },
      }),
    };
    const session = await createSession(storage, [socket]);
    const inspect = async () => JSON.parse(await (session as unknown as {
      inspectContractRollout(): Promise<string>;
    }).inspectContractRollout()) as { status: number; body: { candidateConnectorReady: boolean } };
    expect((await inspect()).body.candidateConnectorReady).toBe(true);
    socket.readyState = WebSocket.CLOSED;
    expect((await inspect()).body.candidateConnectorReady).toBe(false);
    expect(storage.writes).toEqual([]);
  });

  it("returns a bounded error if persisted state becomes unreadable", async () => {
    const { MCP_CONTRACT_ROLLOUT_STORAGE_KEY } = await import("../src/contract-compatibility.js");
    const storage = new MemoryStorage();
    storage.set(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, {
      version: 1, activeContractRevision: "a".repeat(64),
    });
    const session = await createSession(storage);
    storage.get = async () => { throw new Error("sensitive storage failure"); };
    const response = await (session as unknown as {
      inspectContractRollout(): Promise<string>;
    }).inspectContractRollout();
    expect(JSON.parse(response)).toEqual({
      status: 503, body: { error: "contract_rollout_state_unavailable" },
    });
    expect(response).not.toContain("sensitive");
    expect(storage.writes).toEqual([]);
  });

describe("McpSession explicit contract preparation persistence", () => {
  it("persists an exact candidate and returns an idempotent replay without changing preparedAt", async () => {
    const { EXPECTED_MCP_CONTRACT_REVISION, MCP_CONTRACT_ROLLOUT_STORAGE_KEY } =
      await import("../src/contract-compatibility.js");
    const storage = new MemoryStorage();
    const active = "1".repeat(64);
    storage.set(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, {
      version: 1, activeContractRevision: active,
    });
    const session = await createSession(storage);
    const input = {
      expectedActiveContractRevision: active,
      expectedCandidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
    };
    const first = JSON.parse(await session.prepareContractRollout(input)) as {
      status: number; body: { status: string; candidateConnectorReady: boolean };
    };
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("prepared");
    expect(first.body.candidateConnectorReady).toBe(false);

    const persisted = await storage.get<{
      activeContractRevision: string;
      candidateContractRevision: string;
      preparedAt: string;
    }>(MCP_CONTRACT_ROLLOUT_STORAGE_KEY);
    expect(persisted).toMatchObject({
      activeContractRevision: active,
      candidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
    });
    expect(persisted?.preparedAt).toBeDefined();

    const writesAfterFirstPrepare = storage.writes.length;
    expect(writesAfterFirstPrepare).toBeGreaterThan(0);
    const again = JSON.parse(await session.prepareContractRollout(input)) as {
      status: number; body: { status: string };
    };
    expect(storage.writes).toHaveLength(writesAfterFirstPrepare);
    expect(again).toMatchObject({ status: 200, body: { status: "already-prepared" } });
    expect(await storage.get(MCP_CONTRACT_ROLLOUT_STORAGE_KEY)).toEqual(persisted);
  });

  it("refuses competing candidates, incorrect CAS and malformed inputs without persistence", async () => {
    const { EXPECTED_MCP_CONTRACT_REVISION, MCP_CONTRACT_ROLLOUT_STORAGE_KEY } =
      await import("../src/contract-compatibility.js");
    const storage = new MemoryStorage();
    const current = {
      version: 1 as const,
      activeContractRevision: "1".repeat(64),
      candidateContractRevision: "2".repeat(64),
    };
    storage.set(MCP_CONTRACT_ROLLOUT_STORAGE_KEY, current);
    const session = await createSession(storage);
    const invalid = await session.prepareContractRollout({
      expectedActiveContractRevision: current.activeContractRevision,
      expectedCandidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
      unexpected: true,
    });
    expect(JSON.parse(invalid)).toMatchObject({ status: 400 });
    const conflict = await session.prepareContractRollout({
      expectedActiveContractRevision: current.activeContractRevision,
      expectedCandidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
    });
    expect(JSON.parse(conflict)).toMatchObject({
      status: 409,
      body: { error: "candidate_contract_mismatch" },
    });
    expect(await storage.get(MCP_CONTRACT_ROLLOUT_STORAGE_KEY)).toEqual(current);
    expect(storage.writes).toEqual([]);
  });
});

describe("McpSession Browser runtime routing", () => {
  it("does not fall back to the remote runtime when a companion-owned task is offline", async () => {
    const storage = new MemoryStorage();
    storage.set(
      `browser-affinity:v1:${USER_ID}:task:task-local`,
      DEVICE_ID,
    );
    const session = await createSession(storage);
    const internals = session as unknown as {
      getReadyCompanionsForUser(userId: string): unknown[];
      getExecutionReadyConnector(): object | null;
      getOrCreatePrimaryRuntimeId(): Promise<string>;
    };
    internals.getReadyCompanionsForUser = jest.fn(() => []);
    internals.getExecutionReadyConnector = jest.fn(() => null);
    internals.getOrCreatePrimaryRuntimeId = jest.fn(async () => RUNTIME_ID);

    const args = { taskId: "task-local" };
    const response = await callBrowserRouter(
      session,
      toolCall("browser_tabs", args),
      "browser_tabs",
      args,
    );

    await expect(errorText(response)).resolves.toMatch(/^AGENT_UNAVAILABLE:/u);
  });

  it("marks remote task references stale when browserEpoch changes without treating transport reconnect as a new runtime", async () => {
    const storage = new MemoryStorage();
    storage.set(
      `browser-affinity:v3:${USER_ID}:task:task-remote`,
      {
        version: 3,
        runtimeId: RUNTIME_ID,
        browserEpoch: OLD_EPOCH,
      },
    );
    const session = await createSession(storage);
    const connector = {};
    const internals = session as unknown as {
      getReadyCompanionsForUser(userId: string): unknown[];
      getExecutionReadyConnector(): object;
      getOrCreatePrimaryRuntimeId(): Promise<string>;
      readConnectorAttachment(webSocket: object): {
        runtime: { browserEpoch: string };
      };
    };
    internals.getReadyCompanionsForUser = jest.fn(() => []);
    internals.getExecutionReadyConnector = jest.fn(() => connector);
    internals.getOrCreatePrimaryRuntimeId = jest.fn(async () => RUNTIME_ID);
    internals.readConnectorAttachment = jest.fn(() => ({
      runtime: { browserEpoch: NEW_EPOCH },
    }));

    const args = { taskId: "task-remote" };
    const response = await callBrowserRouter(
      session,
      toolCall("browser_tabs", args),
      "browser_tabs",
      args,
    );

    await expect(errorText(response)).resolves.toMatch(/^BROWSER_SESSION_STALE:/u);
  });
});
