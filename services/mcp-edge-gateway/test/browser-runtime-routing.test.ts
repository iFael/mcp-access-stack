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

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, value);
      return;
    }
    for (const [key, entry] of Object.entries(keyOrEntries)) {
      this.values.set(key, entry);
    }
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  set(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

async function createSession(storage: MemoryStorage) {
  const { McpSession } = await import("../src/mcp-session.js");
  const ctx = {
    storage,
    blockConcurrencyWhile: jest.fn(() => Promise.resolve()),
    getWebSockets: jest.fn(() => []),
  };
  return new McpSession(ctx as never, {} as never);
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
