import { describe, expect, it, jest } from "@jest/globals";
import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import { UpdateControlAuthController, type UpdateControlDurableState } from "../../src/auth-state.js";

const PUBLIC_URL = "https://update-control.example/";
const REPROVISION_URL = new URL("/_operations/oauth/reprovision", PUBLIC_URL).href;
const INTERNAL_AUTH_HEADER = "x-update-control-internal-reprovision-authenticated";
const INTERNAL_AUTH_MARKER = "v1";

class MemoryStorage implements OwnerOAuthStorage {
  readonly values = new Map<string, unknown>();
  failDeleteManyOnce = false;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async listPrefix(prefix: string, limit: number): Promise<Map<string, unknown>> {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }

  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.values.delete(key)) deleted += 1;
    if (this.failDeleteManyOnce) {
      this.failDeleteManyOnce = false;
      throw new Error("simulated interruption after durable deletion");
    }
    return deleted;
  }
}

function makeController(storage: MemoryStorage) {
  const state: UpdateControlDurableState = { storage };
  return new UpdateControlAuthController(state, {
    MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL,
    UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "rafael@example.com",
    UPDATE_CONTROL_TOTP_ENCRYPTION_KEY: "e".repeat(64),
  });
}

function operationRequest(operationId: string, method: "GET" | "POST" = "POST", marker = true): Request {
  const url = method === "GET"
    ? REPROVISION_URL + "?operationId=" + encodeURIComponent(operationId)
    : REPROVISION_URL;
  return new Request(url, {
    method,
    headers: {
      ...(marker ? { [INTERNAL_AUTH_HEADER]: INTERNAL_AUTH_MARKER } : {}),
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ operationId }) } : {}),
  });
}

describe("controlled passwordless Update Control OAuth reprovision", () => {
  it("keeps GET status read-only and trusts only the Worker-internal marker", async () => {
    const storage = new MemoryStorage();
    const controller = makeController(storage);
    const operationId = "b795a30e-90d3-4a51-95ed-3c06bbc1e2ad";
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    try {
      const status = await controller.fetch(operationRequest(operationId, "GET"));
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ operationId, status: "not_executed", events: [] });
      expect(storage.values.size).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();

      const rejected = await controller.fetch(operationRequest(operationId, "GET", false));
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toEqual({ error: "operation_auth_required" });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("reprovisions OAuth without an owner token, preserves identities, and is idempotent", async () => {
    const storage = new MemoryStorage();
    storage.values.set("update-control:identity:user:usr_11111111-2222-4333-8444-555555555555", {
      sentinel: "identity-must-survive",
    });
    storage.values.set("update-control:oauth:client:legacy", { client_id: "legacy" });
    storage.values.set("update-control:oauth:signing:v1", { key: "x".repeat(43), version: "old" });
    const controller = makeController(storage);
    const operationId = "7b4f734f-a459-4bf9-8eec-dbe0de7e35cf";

    const first = await controller.fetch(operationRequest(operationId));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ operationId, status: "completed", attempt: 1 });
    expect(storage.values.has("update-control:oauth:client:legacy")).toBe(false);
    expect(storage.values.has("update-control:oauth:signing:v1")).toBe(false);
    expect(storage.values.get("update-control:identity:user:usr_11111111-2222-4333-8444-555555555555"))
      .toEqual({ sentinel: "identity-must-survive" });

    const replay = await controller.fetch(operationRequest(operationId));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ operationId, status: "completed", attempt: 1 });
  });

  it("blocks a different operation while an unresolved reprovision is active", async () => {
    const storage = new MemoryStorage();
    const activeOperationId = "05a67010-1800-4a03-8c16-31054f39bcf2";
    storage.values.set("update-control:oauth-reprovision:v1:active", {
      operationId: activeOperationId,
      status: "in_progress",
      updatedAt: new Date().toISOString(),
    });
    const controller = makeController(storage);
    const competing = await controller.fetch(operationRequest("4d29eafc-fab0-4a22-8d66-e1f8de621c9a"));

    expect(competing.status).toBe(409);
    expect(await competing.json()).toMatchObject({
      status: "in_progress",
      error: "another_operation_active",
    });
  });

  it("marks interruption outcome_unknown, blocks normal traffic, and resumes only the same operation id", async () => {
    const storage = new MemoryStorage();
    storage.values.set("update-control:identity:sentinel", { survives: true });
    storage.values.set("update-control:oauth:client:to-delete", { legacy: true });
    storage.failDeleteManyOnce = true;
    const operationId = "25720dc0-bd34-47a5-a2dd-dd18ce0d6e97";
    const controller = makeController(storage);

    const interrupted = await controller.fetch(operationRequest(operationId));
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toMatchObject({ operationId, status: "outcome_unknown" });

    const normal = await controller.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(normal.status).toBe(503);
    expect(await normal.json()).toEqual({ error: "oauth_reprovision_required" });

    const competing = await controller.fetch(operationRequest("4d29eafc-fab0-4a22-8d66-e1f8de621c9a"));
    expect(competing.status).toBe(409);

    const resumed = await makeController(storage).fetch(operationRequest(operationId));
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({ operationId, status: "completed", attempt: 2 });
    expect(storage.values.get("update-control:identity:sentinel")).toEqual({ survives: true });
  });

  it("restricts reprovision to the exact same-origin fixed path", async () => {
    const storage = new MemoryStorage();
    const controller = makeController(storage);
    const operationId = "ef3f96d6-61e3-4d4e-a96c-7c4f4cda39a1";

    for (const url of [
      "https://wrong-update-control.example/_operations/oauth/reprovision",
      "http://update-control.example/_operations/oauth/reprovision",
      "https://update-control.example/_operations/oauth/reprovision/extra",
    ]) {
      const response = await controller.fetch(new Request(url, {
        method: "POST",
        headers: {
          [INTERNAL_AUTH_HEADER]: INTERNAL_AUTH_MARKER,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationId }),
      }));
      expect(response.status).toBe(404);
    }

    const generic = await controller.fetch(new Request(new URL("/_operations/admin/reset", PUBLIC_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId }),
    }));
    expect(generic.status).toBe(404);
  });
});
