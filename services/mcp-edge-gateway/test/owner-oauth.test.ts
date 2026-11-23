import { describe, expect, it, jest } from "@jest/globals";
import { EdgeAccountStore } from "../src/control-plane/account-store.js";
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

    const accounts = new EdgeAccountStore(storage);
    const legacyUser = await accounts.createSingleUserIdentity("Rafael");
    await oauth.recoverAccess(firstPassword);

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
      owner_password: firstPassword,
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

    const authenticated = await oauth.authenticate(new Request("https://edge.example/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }));
    expect(authenticated).toMatchObject({ scopes: ["mcp:tools"], ownerScope: "owner" });
    expect(authenticated.userId).toBe(legacyUser.id);
    expect(authenticated.subject).toBe(`user:${legacyUser.id}`);

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
    expect(persisted).not.toContain("passwordSalt");
    expect(persisted).not.toContain("passwordVerifier");
    expect(persisted).not.toContain(tokens.access_token);
    expect(persisted).not.toContain(tokens.refresh_token);
    expect(persisted).not.toContain(secondTokens.access_token);
    expect(persisted).not.toContain(secondTokens.refresh_token);
  });

  it("recovers one rotated refresh within a bounded window without persisting credentials", async () => {
    const storage = new MemoryStorage();
    const oauth = new EdgeOwnerOAuth(storage, {
      ownerSecret: "x".repeat(32),
      publicBaseUrl: new URL("https://edge.example/"),
      mcpPath: "/mcp",
      scopes: ["mcp:tools"],
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      resourceName: "MCP Access Stack",
    });
    await new EdgeAccountStore(storage).createSingleUserIdentity("Owner");
    await oauth.recoverAccess("owner-password");

    const clientResponse = await oauth.handle(jsonRequest("https://edge.example/register", {
      redirect_uris: ["https://chatgpt.com/connector/oauth/refresh-recovery"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }));
    const { client_id } = await clientResponse!.json() as { client_id: string };
    const verifier = "refresh-recovery-pkce-verifier-abcdefghijklmnopqrstuvwxyz";
    const authorize = await oauth.handle(formRequest("https://edge.example/authorize", {
      response_type: "code",
      client_id,
      redirect_uri: "https://chatgpt.com/connector/oauth/refresh-recovery",
      code_challenge: await sha256Base64Url(verifier),
      code_challenge_method: "S256",
      scope: "mcp:tools",
      resource: "https://edge.example/mcp",
      owner_password: "owner-password",
    }));
    const code = new URL(authorize!.headers.get("location")!).searchParams.get("code")!;
    const initial = await oauth.handle(formRequest("https://edge.example/token", {
      grant_type: "authorization_code",
      client_id,
      code,
      redirect_uri: "https://chatgpt.com/connector/oauth/refresh-recovery",
      code_verifier: verifier,
      resource: "https://edge.example/mcp",
    }));
    const first = await initial!.json() as { refresh_token: string };
    const refresh = (token: string, overrides: Record<string, string> = {}) => oauth.handle(
      formRequest("https://edge.example/token", {
        grant_type: "refresh_token", client_id, refresh_token: token,
        resource: "https://edge.example/mcp", ...overrides,
      }),
    );
    const [rotated, overlapping] = await Promise.all([
      refresh(first.refresh_token), refresh(first.refresh_token),
    ]);
    expect(rotated!.status).toBe(200);
    expect(overlapping!.status).toBe(200);
    const second = await rotated!.json() as { refresh_token: string };
    const overlappingTokens = await overlapping!.json() as { refresh_token: string };
    expect(overlappingTokens.refresh_token).toBe(second.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const retries = await Promise.all([refresh(first.refresh_token), refresh(first.refresh_token)]);
    expect(retries.map((response) => response!.status)).toEqual([200, 200]);
    for (const response of retries) {
      const recovered = await response!.json() as { refresh_token: string };
      expect(recovered.refresh_token).toBe(second.refresh_token);
    }
    const wrongClient = await refresh(first.refresh_token, { client_id: "unknown-client" });
    expect(wrongClient!.status).toBe(400);

    const thirdResponse = await refresh(second.refresh_token);
    expect(thirdResponse!.status).toBe(200);
    const third = await thirdResponse!.json() as { refresh_token: string };
    expect((await refresh(first.refresh_token))!.status).toBe(400);
    expect((await refresh(second.refresh_token))!.status).toBe(200);

    const clock = Date.now();
    const now = jest.spyOn(Date, "now").mockReturnValue(clock);
    try {
      const fourthResponse = await refresh(third.refresh_token);
      expect(fourthResponse!.status).toBe(200);
      const fourth = await fourthResponse!.json() as { refresh_token: string };
      expect((await refresh(third.refresh_token))!.status).toBe(200);

      now.mockReturnValue(clock + 61_000);
      expect((await refresh(third.refresh_token))!.status).toBe(400);
      const fifthResponse = await refresh(fourth.refresh_token);
      expect(fifthResponse!.status).toBe(200);
      const fifth = await fifthResponse!.json() as { refresh_token: string };
      expect((await refresh(fourth.refresh_token, { resource: "https://edge.example/wrong" }))!.status).toBe(400);
      await oauth.handle(formRequest("https://edge.example/revoke", {
        token: fifth.refresh_token, client_id,
      }));
      expect((await refresh(fourth.refresh_token))!.status).toBe(400);
      await oauth.rotateOwnerPassword("new-password");
      expect((await refresh(third.refresh_token))!.status).toBe(400);
    } finally {
      now.mockRestore();
    }

    const serialized = JSON.stringify([...storage.data.entries()]);
    expect(serialized).not.toContain(first.refresh_token);
    expect(serialized).not.toContain(second.refresh_token);
    expect(serialized).not.toContain(third.refresh_token);
  });

  it("rejects an Owner access token immediately after migrating to the historical Rafael identity", async () => {
    const storage = new MemoryStorage();
    const ownerId = "usr_54135447-1418-4a47-a300-3720970e4731";
    const rafaelId = "usr_bd5ee3a9-b231-4062-beb5-b441467cea5b";
    storage.data.set("account:user-ids:v1", [ownerId]);
    storage.data.set(`account:user:${ownerId}`, {
      version: 1,
      id: ownerId,
      displayName: "Owner",
      normalizedName: "owner",
      passwordSalt: "legacy-salt",
      passwordVerifier: "legacy-verifier",
      createdAt: "2026-09-28T00:00:00.000Z",
    });
    storage.data.set("account:user-name:owner", ownerId);

    const oauth = new EdgeOwnerOAuth(storage, {
      ownerSecret: "x".repeat(32),
      publicBaseUrl: new URL("https://edge.example/"),
      mcpPath: "/mcp",
      scopes: ["mcp:tools"],
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 2592000,
      resourceName: "MCP Access Stack",
    });
    const accounts = new EdgeAccountStore(storage);
    const password = "phase-b-access-password";
    await oauth.recoverAccess(password);

    const registered = await oauth.handle(jsonRequest("https://edge.example/register", {
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/phase-b"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }));
    const client = await registered!.json() as { client_id: string };
    const verifier = "phase-b-pkce-verifier-abcdefghijklmnopqrstuvwxyz";
    const challenge = await sha256Base64Url(verifier);
    const authorize = await oauth.handle(formRequest("https://edge.example/authorize", {
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "https://chatgpt.com/connector/oauth/phase-b",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp:tools",
      resource: "https://edge.example/mcp",
      owner_password: password,
    }));
    const code = new URL(authorize!.headers.get("location")!).searchParams.get("code")!;
    const tokenResponse = await oauth.handle(formRequest("https://edge.example/token", {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: "https://chatgpt.com/connector/oauth/phase-b",
      code_verifier: verifier,
      resource: "https://edge.example/mcp",
    }));
    const tokens = await tokenResponse!.json() as { access_token: string; refresh_token: string };

    await expect(oauth.authenticate(new Request("https://edge.example/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }))).resolves.toMatchObject({ userId: ownerId });

    await accounts.migrateSingleUserIdentity({
      fromUserId: ownerId,
      toUser: {
        id: rafaelId,
        displayName: "Rafael",
        createdAt: "2026-09-26T20:05:35.707Z",
      },
    });
    await oauth.activateSingleUser(rafaelId);
    const versionAfterCutover = await oauth.viewerCredentialVersion();
    await oauth.activateSingleUser(rafaelId);
    expect(await oauth.viewerCredentialVersion()).toBe(versionAfterCutover);

    await expect(oauth.authenticate(new Request("https://edge.example/mcp", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    }))).rejects.toMatchObject({ status: 401, oauthError: "invalid_token" });
    await expect(oauth.authenticateViewer(password)).resolves.toMatchObject({
      userId: rafaelId,
    });
    expect(await accounts.getUser(ownerId)).toBeNull();
    expect(await accounts.getUser(rafaelId)).toMatchObject({
      id: rafaelId,
      displayName: "Rafael",
      version: 2,
    });
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