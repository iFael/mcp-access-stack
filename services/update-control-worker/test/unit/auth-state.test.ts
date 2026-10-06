import { describe, expect, it } from "@jest/globals";
import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import { UpdateControlAuthController } from "../../src/auth-state.js";
import { createTestGitHubActionsAssertion, testGitHubActionsJwksFetch } from "./github-actions-oidc-fixture.js";

const OWNER_SECRET = "phase2-test-owner-secret-which-is-long";
const BASE_URL = "https://update-control.example/";

class MemoryStorage implements OwnerOAuthStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async listPrefix(prefix: string, limit: number): Promise<Map<string, unknown>> {
    return new Map([...this.values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .slice(0, limit));
  }

  async deleteMany(keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) if (this.values.delete(key)) deleted += 1;
    return deleted;
  }
}

function makeController(storage = new MemoryStorage(), publicUrl = BASE_URL) {
  const env = {
    MCP_UPDATE_CONTROL_PUBLIC_URL: publicUrl,
    MCP_OWNER_TOKEN: OWNER_SECRET,
  };
  return { controller: new UpdateControlAuthController({ storage }, env, testGitHubActionsJwksFetch), storage };
}

async function completeInitialReprovision(controller: UpdateControlAuthController, operationId: string): Promise<void> {
  const response = await controller.fetch(new Request(
    new URL("/_operations/oauth/reprovision", BASE_URL),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}`,
        "content-type": "application/json",
        "x-update-control-internal-oidc-verified": "v1",
      },
      body: JSON.stringify({ operationId }),
    },
  ));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ operationId, status: "completed" });
}

async function ownerAccessToken(controller: UpdateControlAuthController): Promise<string> {
  const registration = await controller.fetch(new Request(new URL("/register", BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Update Control test client",
      redirect_uris: ["http://localhost:55321/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }));
  expect(registration.status).toBe(201);
  const client = await registration.json() as { client_id: string };
  const verifier = "v".repeat(64);
  const challengeBytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  ));
  const challenge = base64Url(challengeBytes);
  const authorize = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: "http://localhost:55321/oauth/callback",
    scope: "update:read",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: new URL("/mcp", BASE_URL).href,
    state: "test-state",
    owner_password: OWNER_SECRET,
  });
  const authorization = await controller.fetch(new Request(new URL("/authorize", BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: authorize,
  }));
  expect(authorization.status).toBe(302);
  const callback = new URL(authorization.headers.get("location")!);
  const code = callback.searchParams.get("code");
  expect(callback.searchParams.get("state")).toBe("test-state");
  expect(code).toBeTruthy();

  const tokenResponse = await controller.fetch(new Request(new URL("/token", BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: code!,
      redirect_uri: "http://localhost:55321/oauth/callback",
      code_verifier: verifier,
      resource: new URL("/mcp", BASE_URL).href,
    }),
  }));
  expect(tokenResponse.status).toBe(200);
  return (await tokenResponse.json() as { access_token: string }).access_token;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("Update Control owner authorization boundary", () => {
  it("rejects an invalid GitHub OIDC bearer without writing OAuth state", async () => {
    const { controller, storage } = makeController();
    const response = await controller.fetch(new Request(
      new URL("/_operations/oauth/reprovision", BASE_URL),
      {
        method: "POST",
        headers: {
          authorization: "Bearer attacker-controlled-header",
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationId: "05c60a6f-5f30-47fb-a2fc-43bf4e1c0dc4" }),
      },
    ));
    expect(response.status).toBe(401);
    expect(storage.values.size).toBe(0);
  });

  it.each([
    "http://update-control.example/",
    "https://update-control.example/nested",
    "https://update-control.example/?unexpected=1",
    "https://update-control.example/#unexpected",
    "https://update-control.example/../",
    "https://user@update-control.example/",
    "https://update-control.example:8443/",
    "not a URL",
  ])("fails closed for an invalid public origin: %s", async (publicUrl) => {
    const { controller } = makeController(new MemoryStorage(), publicUrl);
    const response = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "update_control_not_configured" });
  });

  it("fails closed before the controlled initial OAuth reprovision", async () => {
    const { controller } = makeController();
    const response = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "oauth_reprovision_required" });
  });

  it("protects MCP and API reads, while exposing only OAuth protocol metadata", async () => {
    const { controller } = makeController();
    await completeInitialReprovision(controller, "701edb98-15eb-4a8e-b998-2bd6f6a5eb62");
    const metadata = await controller.fetch(new Request(new URL("/.well-known/oauth-authorization-server", BASE_URL)));
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ scopes_supported: ["update:read"] });

    const mcp = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    const api = await controller.fetch(new Request(new URL("/api/v1/runs", BASE_URL)));

    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("www-authenticate")).toContain("update:read");
    expect(api.status).toBe(401);
  });

  it("completes bounded owner OAuth and exposes exactly three read-only MCP tools", async () => {
    const { controller, storage } = makeController();
    await completeInitialReprovision(controller, "4c764152-20b8-4e0b-a27a-492efbbeb6ee");
    const token = await ownerAccessToken(controller);
    const response = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }));
    const body = await response.json() as {
      result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> };
    };

    expect(response.status).toBe(200);
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "update_list_runs",
      "update_get_run",
      "update_wait_events",
    ]);
    expect(body.result.tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
    expect([...storage.values.keys()].some((key) => key.includes("run:"))).toBe(false);
    expect([...storage.values.keys()].some((key) => key.includes("ledger"))).toBe(false);
  });

  it("rejects protected control routes when owner OAuth configuration is missing", async () => {
    const controller = new UpdateControlAuthController({ storage: new MemoryStorage() }, {
      MCP_UPDATE_CONTROL_PUBLIC_URL: BASE_URL,
    });
    const response = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "update_control_not_configured" });
  });
});
