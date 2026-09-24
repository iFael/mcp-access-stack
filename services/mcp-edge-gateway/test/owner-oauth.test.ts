import { describe, expect, it } from "@jest/globals";
import { EdgeOwnerOAuth, type OwnerOAuthStorage } from "../src/control-plane/owner-oauth.js";

class MemoryStorage implements OwnerOAuthStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.data.delete(key); }
}

describe("Edge Owner OAuth durable state", () => {
  it("uses one-shot codes, revokes access and never persists raw secrets", async () => {
    const storage = new MemoryStorage();
    const ownerSecret = "x".repeat(32);
    const firstPassword = "4$Z!";
    const secondPassword = "§";
    const oauth = new EdgeOwnerOAuth(storage, {
      ownerSecret,
      publicBaseUrl: new URL("https://edge.example/"),
      mcpPath: "/mcp",
      scopes: ["mcp:tools"],
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      resourceName: "MCP Access Stack",
    });

    const registered = await oauth.handle(jsonRequest("https://edge.example/register", {
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/test-client"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }));
    expect(registered?.status).toBe(201);
    const client = await registered!.json() as { client_id: string };

    const verifier = "pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
    const challenge = await sha256Base64Url(verifier);
    const authorize = await oauth.handle(formRequest("https://edge.example/authorize", {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://chatgpt.com/connector/oauth/test-client",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:tools",
      state: "state-1",
      resource: "https://edge.example/mcp",
      owner_token: ownerSecret,
      owner_password: firstPassword,
      owner_password_confirm: firstPassword,
    }));
    expect(authorize?.status).toBe(302);
    const location = new URL(authorize!.headers.get("location")!);
    const code = location.searchParams.get("code")!;
    expect(location.searchParams.get("state")).toBe("state-1");

    const tokenFields = {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: "https://chatgpt.com/connector/oauth/test-client",
      code_verifier: verifier,
      resource: "https://edge.example/mcp",
    };
    const tokenResponse = await oauth.handle(formRequest("https://edge.example/token", tokenFields));
    expect(tokenResponse?.status).toBe(200);
    const tokens = await tokenResponse!.json() as { access_token: string; refresh_token: string; scope: string };

    const replay = await oauth.handle(formRequest("https://edge.example/token", tokenFields));
    expect(replay?.status).toBe(400);
    expect(await replay!.json()).toEqual({ error: "invalid_grant" });

    await expect(oauth.authenticate(new Request("https://edge.example/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }))).resolves.toEqual({ subject: `owner:${client.client_id}`, scopes: ["mcp:tools"], ownerScope: "owner" });

    await oauth.rotateOwnerPassword(secondPassword);
    await expect(oauth.authenticate(new Request("https://edge.example/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }))).rejects.toMatchObject({ status: 401, oauthError: "invalid_token" });
    const staleRefresh = await oauth.handle(formRequest("https://edge.example/token", {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource: "https://edge.example/mcp",
    }));
    expect(staleRefresh?.status).toBe(400);
    expect(await staleRefresh!.json()).toEqual({ error: "invalid_grant" });

    const authorizeAgain = await oauth.handle(formRequest("https://edge.example/authorize", {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://chatgpt.com/connector/oauth/test-client",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:tools",
      state: "state-2",
      resource: "https://edge.example/mcp",
      owner_password: secondPassword,
    }));
    expect(authorizeAgain?.status).toBe(302);
    const secondCode = new URL(authorizeAgain!.headers.get("location")!).searchParams.get("code")!;
    const secondTokenResponse = await oauth.handle(formRequest("https://edge.example/token", {
      ...tokenFields,
      code: secondCode,
    }));
    expect(secondTokenResponse?.status).toBe(200);
    const secondTokens = await secondTokenResponse!.json() as { access_token: string; refresh_token: string };

    expect((await oauth.handle(formRequest("https://edge.example/revoke", {
      token: secondTokens.access_token,
      client_id: client.client_id,
    })))?.status).toBe(200);
    await expect(oauth.authenticate(new Request("https://edge.example/mcp", {
      headers: { authorization: `Bearer ${secondTokens.access_token}` },
    }))).rejects.toMatchObject({ status: 401, oauthError: "invalid_token" });

    const persisted = JSON.stringify([...storage.data.entries()]);
    expect(persisted).not.toContain(ownerSecret);
    expect(persisted).not.toContain(firstPassword);
    expect(persisted).not.toContain(secondPassword);
    expect(persisted).not.toContain(tokens.access_token);
    expect(persisted).not.toContain(tokens.refresh_token);
    expect(persisted).not.toContain(secondTokens.access_token);
    expect(persisted).not.toContain(secondTokens.refresh_token);
  });
});

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function formRequest(url: string, fields: Record<string, string>): Request {
  return new Request(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}