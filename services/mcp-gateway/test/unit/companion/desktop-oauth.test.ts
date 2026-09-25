import { describe, expect, it, jest } from "@jest/globals";
import {
  DesktopOAuthClient,
  type DesktopOAuthCredentialStore,
  type DesktopOAuthRefreshCredential,
} from "../../../src/companion/desktop-oauth.js";

class MemoryCredentialStore implements DesktopOAuthCredentialStore {
  value: DesktopOAuthRefreshCredential | null = null;
  readonly writes: DesktopOAuthRefreshCredential[] = [];
  clearCalls = 0;

  async read(): Promise<DesktopOAuthRefreshCredential | null> {
    return this.value ? { ...this.value } : null;
  }

  async write(value: DesktopOAuthRefreshCredential): Promise<void> {
    this.value = { ...value };
    this.writes.push({ ...value });
  }

  async clear(): Promise<void> {
    this.clearCalls += 1;
    this.value = null;
  }
}

describe("DesktopOAuthClient", () => {
  it("refreshes a persisted credential, rotates the refresh token and caches the access token in memory", async () => {
    const store = new MemoryCredentialStore();
    store.value = {
      clientId: "client-1",
      scope: "workspaces:read",
      refreshToken: "refresh-token-old-value",
    };
    const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/token");
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("client-1");
      expect(body.get("refresh_token")).toBe("refresh-token-old-value");
      return Response.json({
        access_token: "access-token-refreshed-value",
        refresh_token: "refresh-token-new-value",
        expires_in: 3600,
        token_type: "Bearer",
        scope: "workspaces:read",
      });
    });

    const client = new DesktopOAuthClient({
      edgeBaseUrl: new URL("https://edge.example/"),
      credentialStore: store,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 1_000,
    });

    await expect(client.getAccessToken()).resolves.toEqual({
      accessToken: "access-token-refreshed-value",
      scope: "workspaces:read",
      expiresAtMs: 3_601_000,
    });
    await expect(client.getAccessToken()).resolves.toEqual({
      accessToken: "access-token-refreshed-value",
      scope: "workspaces:read",
      expiresAtMs: 3_601_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.value).toEqual({
      clientId: "client-1",
      scope: "workspaces:read",
      refreshToken: "refresh-token-new-value",
    });
  });

  it("completes public-client PKCE through a loopback callback and stores only the refresh credential", async () => {
    const store = new MemoryCredentialStore();
    let authorizationUrl: URL | undefined;
    const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/register") {
        return Response.json({ client_id: "client-interactive" });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({ scopes_supported: ["workspaces:read"] });
      }
      if (url.pathname === "/token") {
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("client_id")).toBe("client-interactive");
        expect(body.get("code")).toBe("authorization-code-value");
        expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/u);
        return Response.json({
          access_token: "access-token-interactive-value",
          refresh_token: "refresh-token-interactive-value",
          expires_in: 1200,
          token_type: "Bearer",
          scope: "workspaces:read",
        });
      }
      throw new Error(`Unexpected OAuth request: ${url.href}`);
    });

    const client = new DesktopOAuthClient({
      edgeBaseUrl: new URL("https://edge.example/"),
      credentialStore: store,
      fetchImpl: fetchImpl as typeof fetch,
      openBrowser: async (url) => {
        authorizationUrl = new URL(url.href);
        const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
        const state = authorizationUrl.searchParams.get("state");
        if (!redirectUri || !state) throw new Error("Missing loopback authorization parameters.");
        const callback = new URL(redirectUri);
        callback.searchParams.set("code", "authorization-code-value");
        callback.searchParams.set("state", state);
        const response = await fetch(callback);
        expect(response.status).toBe(200);
      },
      now: () => 10_000,
    });

    await expect(client.getAccessToken()).resolves.toEqual({
      accessToken: "access-token-interactive-value",
      scope: "workspaces:read",
      expiresAtMs: 1_210_000,
    });

    expect(authorizationUrl?.pathname).toBe("/authorize");
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl?.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(store.value).toEqual({
      clientId: "client-interactive",
      scope: "workspaces:read",
      refreshToken: "refresh-token-interactive-value",
    });
  });
});
