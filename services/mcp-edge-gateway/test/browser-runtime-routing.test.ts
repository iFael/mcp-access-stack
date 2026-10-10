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

  async list({ limit }: { limit?: number } = {}): Promise<Map<string, unknown>> {
    return new Map(Array.from(this.values.entries()).slice(0, limit));
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

  it("preserves a beta.84 candidate, historic active catalog, and unrelated KV across cold-start inspection", async () => {
    const { MCP_CONTRACT_ROLLOUT_STORAGE_KEY: key, EXPECTED_MCP_CONTRACT_REVISION: next } =
      await import("../src/contract-compatibility.js");
    const { readMcpCatalogSnapshot } = await import("../src/control-plane/active-catalog.js");
    const active = "39889807df9cb6f09fdb51a1940fce4783de302c1fd161f0429061a9a27e264c";
    const candidate = "a35a966fee8333618c3018e2b621196a64860dc3d6d578a6d4173d09ee984e59";
    expect(next).not.toBe(candidate);
    const state = {
      version: 1 as const, activeContractRevision: active, candidateContractRevision: candidate,
      preparedAt: "2026-10-08T03:27:40.414Z", previousContractRevision: "f".repeat(64),
    };
    const storage = new MemoryStorage();
    storage.set(key, state);
    storage.set(`edge:mcp-catalog:v1:${active}:header`, {
      version: 1, contractRevision: active, chunkCount: 1, toolCount: 1,
      catalogMetadata: { contractRevision: active, toolCount: 1 },
      serverIdentity: { name: "legacy-catalog", version: "beta" },
    });
    storage.set(`edge:mcp-catalog:v1:${active}:chunk:0`, [{ name: "legacy_tool" }]);
    storage.set("edge:account-store:legacy", { privateData: "not-for-inspection" });
    const originalCatalog = await readMcpCatalogSnapshot(storage, active);
    const session = await createSession(storage);
    const inspection = JSON.parse(await session.inspectContractRollout()) as {
      status: number; body: Record<string, unknown>;
    };
    expect(inspection).toEqual({
      status: 200,
      body: {
        activeContractRevision: active, candidateContractRevision: candidate,
        candidateConnectorReady: false, preparedAt: state.preparedAt,
      },
    });
    expect(JSON.stringify(inspection)).not.toContain("not-for-inspection");
    expect(JSON.stringify(inspection)).not.toContain("legacy_tool");
    expect((await session.getStatus()).activeContractRevision).toBe(active);
    expect(JSON.parse(await session.prepareContractRollout({
      expectedActiveContractRevision: active, expectedCandidateContractRevision: next,
    }))).toMatchObject({ status: 409, body: { error: "candidate_contract_mismatch" } });
    expect(JSON.parse(await session.bootstrapContractRollout({
      expectedState: "absent", expectedActiveContractRevision: next,
    }))).toMatchObject({ status: 409 });
    expect(await storage.get(key)).toEqual(state);
    expect(await readMcpCatalogSnapshot(storage, active)).toEqual(originalCatalog);
    expect(storage.writes).toEqual([]);
  });

  it("fails closed without repairing missing or damaged beta.83 snapshots under the beta.84 candidate", async () => {
    const { MCP_CONTRACT_ROLLOUT_STORAGE_KEY: key } =
      await import("../src/contract-compatibility.js");
    const { readMcpCatalogSnapshot } = await import("../src/control-plane/active-catalog.js");
    const active = "39889807df9cb6f09fdb51a1940fce4783de302c1fd161f0429061a9a27e264c";
    const candidate = "a35a966fee8333618c3018e2b621196a64860dc3d6d578a6d4173d09ee984e59";
    const state = {
      version: 1 as const, activeContractRevision: active, candidateContractRevision: candidate,
      preparedAt: "2026-10-08T03:27:40.414Z",
    };
    const header = {
      version: 1, contractRevision: active, chunkCount: 1, toolCount: 1,
      catalogMetadata: { contractRevision: active, toolCount: 1 },
      serverIdentity: { name: "mcp-edge-gateway", version: "1.1.0-beta.83" },
    };
    for (const snapshot of [
      {}, // No historical snapshot at all.
      { header }, // Incomplete: required tool chunk missing.
      { header: { ...header, contractRevision: candidate }, chunk: [{ name: "legacy" }] },
      { header: { ...header, toolCount: 2 }, chunk: [{ name: "legacy" }] },
    ]) {
      const storage = new MemoryStorage();
      storage.set(key, state);
      storage.set("edge:unrelated:keep", { marker: "intact" });
      if ("header" in snapshot) storage.set("edge:mcp-catalog:v1:" + active + ":header", snapshot.header);
      if ("chunk" in snapshot) storage.set("edge:mcp-catalog:v1:" + active + ":chunk:0", snapshot.chunk);
      expect(await readMcpCatalogSnapshot(storage, active)).toBeNull();
      const session = await createSession(storage);
      const inspection = JSON.parse(await session.inspectContractRollout()) as {
        status: number; body: Record<string, unknown>;
      };
      expect(inspection).toEqual({
        status: 200,
        body: {
          activeContractRevision: active,
          candidateContractRevision: candidate,
          candidateConnectorReady: false,
          preparedAt: state.preparedAt,
        },
      });
      expect((await session.getStatus()).controlPlaneReady).toBe(false);
      expect(await storage.get(key)).toEqual(state);
      expect(await storage.get("edge:unrelated:keep")).toEqual({ marker: "intact" });
      expect(storage.writes).toEqual([]);
    }
  });

  it("re-reads a legacy rollout after an external change without repairing it", async () => {
    const { MCP_CONTRACT_ROLLOUT_STORAGE_KEY: key } =
      await import("../src/contract-compatibility.js");
    const storage = new MemoryStorage();
    const active = "1".repeat(64);
    storage.set(key, { version: 1, activeContractRevision: active });
    const session = await createSession(storage);
    const candidate = "2".repeat(64);
    storage.set(key, { version: 1, activeContractRevision: active, candidateContractRevision: candidate });
    expect(JSON.parse(await session.inspectContractRollout())).toEqual({
      status: 200, body: {
        activeContractRevision: active, candidateContractRevision: candidate,
        candidateConnectorReady: false,
      },
    });
    expect(storage.writes).toEqual([]);
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

describe("McpSession explicit first-install bootstrap", () => {
  const invoke = async (session: object, input: unknown) =>
    JSON.parse(await (session as { bootstrapContractRollout(input: unknown): Promise<string> })
      .bootstrapContractRollout(input)) as { status: number; body: Record<string, unknown> };

  it("initializes only an empty store with the exact build revision; replay is write-free", async () => {
    const { EXPECTED_MCP_CONTRACT_REVISION: revision, MCP_CONTRACT_ROLLOUT_STORAGE_KEY: key } =
      await import("../src/contract-compatibility.js");
    const { readMcpCatalogSnapshot } = await import("../src/control-plane/active-catalog.js");
    const storage = new MemoryStorage();
    const session = await createSession(storage);
    expect(storage.writes).toEqual([]);
    const input = { expectedState: "absent", expectedActiveContractRevision: revision };
    expect(await invoke(session, input)).toEqual({
      status: 200, body: { status: "bootstrapped", activeContractRevision: revision },
    });
    expect(await storage.get(key)).toEqual({ version: 1, activeContractRevision: revision });
    expect((await readMcpCatalogSnapshot(storage, revision))?.catalogMetadata.contractRevision).toBe(revision);
    const writes = storage.writes.slice();
    expect(writes).toContain(key);
    expect(await invoke(session, input)).toEqual({
      status: 200, body: { status: "already-bootstrapped", activeContractRevision: revision },
    });
    expect(storage.writes).toEqual(writes);
    const restarted = await createSession(storage);
    expect((await invoke(restarted, input)).body.status).toBe("already-bootstrapped");
    expect(storage.writes).toEqual(writes);
  });

  it("rejects malformed input, mismatched CAS and a nonempty or malformed store without writing", async () => {
    const { EXPECTED_MCP_CONTRACT_REVISION: revision, MCP_CONTRACT_ROLLOUT_STORAGE_KEY: key } =
      await import("../src/contract-compatibility.js");
    const base = { expectedState: "absent", expectedActiveContractRevision: revision };
    for (const [existing, input, status] of [
      [undefined, { ...base, unexpected: true }, 400],
      [undefined, { ...base, expectedState: "present" }, 400],
      [undefined, { ...base, expectedActiveContractRevision: "b".repeat(64) }, 409],
      [{ version: 1, activeContractRevision: "a".repeat(64) }, base, 409],
      [{ version: 1, activeContractRevision: revision, candidateContractRevision: "a".repeat(64) }, base, 409],
      [{ version: 1, activeContractRevision: "broken" }, base, 409],
    ] as const) {
      const storage = new MemoryStorage();
      if (existing) storage.set(key, existing);
      const session = await createSession(storage);
      const result = await invoke(session, input);
      expect(result.status).toBe(status);
      expect(storage.writes).toEqual([]);
      expect(await storage.get(key)).toEqual(existing);
    }
  });

  it("rejects an empty rollout with existing runtime evidence rather than claiming a fresh installation", async () => {
    const { EXPECTED_MCP_CONTRACT_REVISION: revision, MCP_CONTRACT_ROLLOUT_STORAGE_KEY: key } =
      await import("../src/contract-compatibility.js");
    const { CONNECTOR_TELEMETRY_STORAGE_KEY } = await import("../src/connector-telemetry.js");
    const storage = new MemoryStorage();
    storage.set(CONNECTOR_TELEMETRY_STORAGE_KEY, { version: 1, readyCount: 1 });
    const session = await createSession(storage);
    const result = await invoke(session, {
      expectedState: "absent", expectedActiveContractRevision: revision,
    });
    expect(result).toEqual({ status: 409, body: { error: "bootstrap_storage_not_empty" } });
    expect(await storage.get(key)).toBeUndefined();
    expect(storage.writes).toEqual([]);
  });
  it("refuses an empty store if a connector or companion is already attached", async () => {
    const { EXPECTED_MCP_CONTRACT_REVISION: revision, MCP_CONTRACT_ROLLOUT_STORAGE_KEY: key } =
      await import("../src/contract-compatibility.js");
    const storage = new MemoryStorage();
    const session = await createSession(storage, [{ readyState: WebSocket.OPEN }]);
    expect(await invoke(session, {
      expectedState: "absent", expectedActiveContractRevision: revision,
    })).toEqual({ status: 409, body: { error: "bootstrap_connections_present" } });
    expect(await storage.get(key)).toBeUndefined();
    expect(storage.writes).toEqual([]);
  });

  it("refuses unrelated historical storage and sanitizes storage inspection failures", async () => {
    const { EXPECTED_MCP_CONTRACT_REVISION: revision, MCP_CONTRACT_ROLLOUT_STORAGE_KEY: key } =
      await import("../src/contract-compatibility.js");
    const args = { expectedState: "absent", expectedActiveContractRevision: revision };
    const storage = new MemoryStorage();
    storage.set("edge:account-store:v1", { private: "do-not-reveal" });
    const session = await createSession(storage);
    expect(await invoke(session, args)).toEqual({
      status: 409, body: { error: "bootstrap_storage_not_empty" },
    });
    expect(await storage.get(key)).toBeUndefined();
    expect(storage.writes).toEqual([]);

    const empty = new MemoryStorage();
    const inaccessible = await createSession(empty);
    empty.list = async () => { throw new Error("secret-read-failure"); };
    const result = await invoke(inaccessible, args);
    expect(result).toEqual({ status: 503, body: { error: "contract_bootstrap_unavailable" } });
    expect(JSON.stringify(result)).not.toContain("secret-read-failure");
    expect(empty.writes).toEqual([]);
  });

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
