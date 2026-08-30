import { describe, expect, it } from "@jest/globals";
import { EdgeOwnerOAuth, type EdgeOwnerOAuthConfig, type OwnerOAuthStorage } from "../src/control-plane/owner-oauth.js";

class MemoryStorage implements OwnerOAuthStorage {
  readonly data = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> { return this.data.get(key) as T | undefined; }
  async put<T>(key: string, value: T): Promise<void> { this.data.set(key, structuredClone(value)); }
  async delete(key: string): Promise<boolean> { return this.data.delete(key); }
}

const publicBaseUrl = new URL("https://edge.example/");
const ownerSecret = "owner-secret-abcdefghijklmnopqrstuvwxyz";
const baseConfig: EdgeOwnerOAuthConfig = {
  ownerSecret,
  publicBaseUrl,
  mcpPath: "/mcp",
  scopes: ["workspaces:read"],
  accessTokenTtlSeconds: 3600,
  refreshTokenTtlSeconds: 2592000,
  resourceName: "MCP Access Stack",
};

describe("Owner OAuth v2 -> Edge v3 cutover migration", () => {
  it("reports durable Owner credentials unready before bootstrap and ready afterwards", async () => {
    const storage = new MemoryStorage();
    const oauth = new EdgeOwnerOAuth(storage, { ...baseConfig, ownerSecret: undefined } as unknown as EdgeOwnerOAuthConfig) as unknown as {
      isConfigured(): Promise<boolean>;
      bootstrapLegacyState(snapshot: unknown, suppliedOwnerSecret: string): Promise<void>;
    };
    await expect(oauth.isConfigured()).resolves.toBe(false);
    await oauth.bootstrapLegacyState({
      version: 1,
      resourceServerUrl: "https://edge.example/mcp",
      clients: [],
      accessTokens: [],
      refreshTokens: [],
    }, ownerSecret);
    await expect(oauth.isConfigured()).resolves.toBe(true);
  });

  it("imports only hashed legacy credentials and keeps existing access and refresh tokens usable", async () => {
    const storage = new MemoryStorage();
    const legacyAccessToken = "legacy-access-opaque-token-0123456789";
    const legacyRefreshToken = "legacy-refresh-opaque-token-0123456789";
    const clientId = "legacy-chatgpt-client";
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const refreshExpiresAt = expiresAt + 86400;
    const snapshot = {
      version: 1,
      resourceServerUrl: "https://edge.example/mcp",
      clients: [{
        redirect_uris: ["https://chatgpt.com/connector/oauth/legacy-client"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "ChatGPT",
        client_id: clientId,
        client_id_issued_at: 1_700_000_000,
      }],
      accessTokens: [{
        hash: await sha256Base64Url(legacyAccessToken),
        clientId,
        scopes: ["workspaces:read"],
        expiresAt,
        resource: "https://edge.example/mcp",
      }],
      refreshTokens: [{
        hash: await sha256Base64Url(legacyRefreshToken),
        clientId,
        scopes: ["workspaces:read"],
        expiresAt: refreshExpiresAt,
        resource: "https://edge.example/mcp",
      }],
    };

    const bootstrap = new EdgeOwnerOAuth(storage, baseConfig) as unknown as {
      bootstrapLegacyState(snapshot: unknown, suppliedOwnerSecret: string): Promise<void>;
    };
    await bootstrap.bootstrapLegacyState(snapshot, ownerSecret);

    const durableConfig = { ...baseConfig, ownerSecret: undefined } as unknown as EdgeOwnerOAuthConfig;
    const oauth = new EdgeOwnerOAuth(storage, durableConfig);

    await expect(oauth.authenticate(new Request("https://edge.example/mcp", {
      headers: { authorization: `Bearer ${legacyAccessToken}` },
    }))).resolves.toEqual({
      subject: `owner:${clientId}`,
      scopes: ["workspaces:read"],
      ownerScope: "owner",
    });

    const refreshed = await oauth.handle(formRequest("https://edge.example/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: legacyRefreshToken,
      resource: "https://edge.example/mcp",
    }));
    expect(refreshed?.status).toBe(200);
    const refreshedTokens = await refreshed!.json() as { access_token: string; refresh_token: string };
    expect(refreshedTokens.access_token.split(".")).toHaveLength(3);
    await expect(oauth.authenticate(new Request("https://edge.example/mcp", {
      headers: { authorization: `Bearer ${refreshedTokens.access_token}` },
    }))).resolves.toMatchObject({ subject: `owner:${clientId}` });

    const persisted = JSON.stringify([...storage.data.entries()]);
    expect(persisted).not.toContain(ownerSecret);
    expect(persisted).not.toContain(legacyAccessToken);
    expect(persisted).not.toContain(legacyRefreshToken);
    expect(persisted).not.toContain(refreshedTokens.access_token);
    expect(persisted).not.toContain(refreshedTokens.refresh_token);
  });

  it("is one-shot and preserves owner authorization after the raw owner secret leaves runtime configuration", async () => {
    const storage = new MemoryStorage();
    const bootstrap = new EdgeOwnerOAuth(storage, baseConfig) as unknown as {
      bootstrapLegacyState(snapshot: unknown, suppliedOwnerSecret: string): Promise<void>;
    };
    const snapshot = {
      version: 1,
      resourceServerUrl: "https://edge.example/mcp",
      clients: [{
        redirect_uris: ["https://chatgpt.com/connector/oauth/legacy-client"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "ChatGPT",
        client_id: "legacy-chatgpt-client",
        client_id_issued_at: 1_700_000_000,
      }],
      accessTokens: [],
      refreshTokens: [],
    };
    await bootstrap.bootstrapLegacyState(snapshot, ownerSecret);
    await expect(bootstrap.bootstrapLegacyState(snapshot, ownerSecret)).rejects.toThrow(/already bootstrapped/u);

    const oauth = new EdgeOwnerOAuth(storage, { ...baseConfig, ownerSecret: undefined } as unknown as EdgeOwnerOAuthConfig);
    const verifier = "pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
    const challenge = await sha256Base64Url(verifier);
    const authorized = await oauth.handle(formRequest("https://edge.example/authorize", {
      response_type: "code",
      client_id: "legacy-chatgpt-client",
      redirect_uri: "https://chatgpt.com/connector/oauth/legacy-client",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "workspaces:read",
      state: "state-cutover",
      resource: "https://edge.example/mcp",
      owner_token: ownerSecret,
    }));
    expect(authorized?.status).toBe(302);
  });
});

function formRequest(url: string, fields: Record<string, string>): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
