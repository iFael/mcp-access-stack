import { describe, expect, it, jest } from "@jest/globals";
import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import { UpdateControlAuthController } from "../../src/auth-state.js";

const BASE_URL = "https://update-control.example/";

class MemoryStorage implements OwnerOAuthStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.values.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.values.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async listPrefix(prefix: string, limit: number): Promise<Map<string, unknown>> {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.values.delete(key)) deleted += 1;
    return deleted;
  }
}

function makeController(
  storage = new MemoryStorage(),
  overrides: Record<string, string | undefined> = {},
) {
  return {
    storage,
    controller: new UpdateControlAuthController({ storage }, {
      MCP_UPDATE_CONTROL_PUBLIC_URL: BASE_URL,
      UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "rafael@example.com",
      UPDATE_CONTROL_TOTP_ENCRYPTION_KEY: "e".repeat(64),
      ...overrides,
    }),
  };
}

describe("Update Control authorization boundary", () => {
  it.each([
    "http://update-control.example/",
    "https://update-control.example/nested",
    "https://update-control.example/?unexpected=1",
    "https://user@update-control.example/",
    "https://update-control.example:8443/",
    "not a URL",
  ])("fails closed for an invalid public origin: %s", async (publicUrl) => {
    const { controller } = makeController(new MemoryStorage(), {
      MCP_UPDATE_CONTROL_PUBLIC_URL: publicUrl,
    });
    const response = await controller.fetch(new Request(new URL("/mcp", BASE_URL), { method: "POST" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "update_control_not_configured" });
  });

  it("fails closed when local identity configuration is missing or malformed", async () => {
    for (const overrides of [
      { UPDATE_CONTROL_TOTP_ENCRYPTION_KEY: undefined },
      { UPDATE_CONTROL_TOTP_ENCRYPTION_KEY: "short" },
      { UPDATE_CONTROL_TOTP_ENCRYPTION_KEY: "A".repeat(64) },
      { UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: undefined },
      { UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "not-an-email" },
    ]) {
      const { controller } = makeController(new MemoryStorage(), overrides);
      const response = await controller.fetch(new Request(new URL("/mcp", BASE_URL), { method: "POST" }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "update_control_not_configured" });
    }
  });

  it("exposes OAuth metadata while protecting MCP/API and contains no password or external-IdP authorization UX", async () => {
    const { controller } = makeController();
    const metadata = await controller.fetch(new Request(new URL("/.well-known/oauth-authorization-server", BASE_URL)));
    expect(metadata.status).toBe(200);
    const body = await metadata.json() as Record<string, unknown>;
    expect(body.scopes_supported).toEqual(["update:read"]);
    expect(body.authorization_endpoint).toBe(new URL("/oauth", BASE_URL).href);
    expect(JSON.stringify(body)).not.toContain("microsoft");

    const mcp = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("update:read");

    const api = await controller.fetch(new Request(new URL("/api/v1/runs", BASE_URL)));
    expect(api.status).toBe(401);

    const persisted = JSON.stringify([...new MemoryStorage().values.entries()]);
    expect(persisted).not.toContain("owner_password");
  });

  it("emits OAuth stage logs with only allowlisted fields", async () => {
    const { controller } = makeController();
    const log = jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      await controller.fetch(new Request(new URL(
        "/token?query_secret=must-not-log",
        BASE_URL,
      ), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: "authorization-code-secret",
          code_verifier: "pkce-verifier-secret",
          refresh_token: "refresh-token-secret",
          state: "oauth-state-secret",
          email: "person@example.com",
          code_field: "123456",
        }),
      }));
      const eventArgs = log.mock.calls.find(([event]) => event === "update_control_auth_stage");
      expect(eventArgs).toBeTruthy();
      const event = JSON.parse(String(eventArgs?.[1])) as Record<string, unknown>;
      expect(Object.keys(event).sort()).toEqual([
        "durationMs",
        "flowId",
        "method",
        "pathname",
        "result",
        "stage",
        "status",
      ]);
      expect(event.pathname).toBe("/token");
      expect(event.method).toBe("POST");
      const serialized = JSON.stringify(eventArgs);
      for (const secret of [
        "query_secret",
        "must-not-log",
        "authorization-code-secret",
        "pkce-verifier-secret",
        "refresh-token-secret",
        "oauth-state-secret",
        "person@example.com",
        "123456",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("blocks normal traffic fail-closed while a reprovision operation is unresolved", async () => {
    const { controller, storage } = makeController();
    storage.values.set("update-control:oauth-reprovision:v1:active", {
      operationId: "11111111-2222-4333-8444-555555555555",
      status: "outcome_unknown",
      updatedAt: new Date().toISOString(),
    });
    const response = await controller.fetch(new Request(new URL("/mcp", BASE_URL), { method: "POST" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "oauth_reprovision_required" });
  });

  it("does not use MCP_OWNER_TOKEN or owner_password as a human authentication input", async () => {
    const { controller } = makeController(new MemoryStorage(), {
      MCP_OWNER_TOKEN: "legacy-owner-token-with-more-than-thirty-two-characters",
    });
    const registration = await controller.fetch(new Request(new URL("/register", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: ["https://chatgpt.com/connector/oauth/test"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }));
    expect(registration.status).toBe(201);
    const clientId = (await registration.json() as { client_id: string }).client_id;
    const authorize = new URL("/oauth", BASE_URL);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://chatgpt.com/connector/oauth/test",
      scope: "update:read",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      resource: new URL("/mcp", BASE_URL).href,
      owner_password: "legacy-owner-token-with-more-than-thirty-two-characters",
    }).toString();
    const response = await controller.fetch(new Request(authorize));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(new URL("/user", BASE_URL).href);
    expect(response.headers.get("location")).not.toContain("owner_password");

    const aliasGet = new URL("/authorize", BASE_URL);
    aliasGet.search = authorize.search;
    const aliasGetResponse = await controller.fetch(new Request(aliasGet));
    expect(aliasGetResponse.status).toBe(302);
    expect(aliasGetResponse.headers.get("location")).toBe(new URL("/user", BASE_URL).href);

    const aliasPost = await controller.fetch(new Request(new URL("/authorize", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://chatgpt.com/connector/oauth/test",
        scope: "update:read",
        code_challenge: "A".repeat(43),
        code_challenge_method: "S256",
        resource: new URL("/mcp", BASE_URL).href,
        state: "alias-client-state",
      }),
    }));
    expect(aliasPost.status).toBe(302);
    expect(aliasPost.headers.get("location")).toBe(new URL("/user", BASE_URL).href);
  });
});
