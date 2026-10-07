import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  BASE_URL,
  CHATGPT_REDIRECT,
  RESOURCE,
  authorizationUrl,
  beginOAuth,
  beginUserLogin,
  bootstrapAndEnrollAdmin,
  cookiePair,
  createHarness,
  csrfFromHtml,
  joinUser,
  postForm,
  registerClient,
  registerClientRaw,
  submitUserLogin,
  totp,
} from "../helpers/oauth-session-fixtures.js";

const FIXED_NOW = new Date("2026-10-07T13:00:00.000Z");

type TokenSet = {
  access_token: string;
  refresh_token: string;
};

describe("OAuth human-session authorization flow", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("advertises /oauth canonically and preserves token, DCR, revocation, and PKCE metadata", async () => {
    const { controller } = createHarness();
    const response = await controller.fetch(new Request(new URL("/.well-known/oauth-authorization-server", BASE_URL)));
    expect(response.status).toBe(200);
    const metadata = await response.json() as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      revocation_endpoint: string;
      code_challenge_methods_supported: string[];
      response_types_supported: string[];
      grant_types_supported: string[];
    };

    expect(new URL(metadata.authorization_endpoint).pathname).toBe("/oauth");
    expect(new URL(metadata.token_endpoint).pathname).toBe("/token");
    expect(new URL(metadata.registration_endpoint).pathname).toBe("/register");
    expect(new URL(metadata.revocation_endpoint).pathname).toBe("/revoke");
    expect(metadata.code_challenge_methods_supported).toContain("S256");
    expect(metadata.response_types_supported).toContain("code");
    expect(metadata.grant_types_supported).toEqual(
      expect.arrayContaining(["authorization_code", "refresh_token"]),
    );
  });

  it("preserves a no-session OAuth transaction server-side through /user and echoes client state only to the callback", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const clientId = await registerClient(controller);
    const verifier = "p".repeat(64);
    const clientState = "oauth-client-state-synthetic";
    const storageBeforeAuthorization = JSON.stringify([...storage.values.entries()]);
    const started = await beginOAuth(controller, clientId, { verifier, state: clientState });

    expect(started.response.status).toBe(302);
    const loginTarget = new URL(started.response.headers.get("location") ?? BASE_URL);
    expect(loginTarget.pathname).toBe("/user");
    const forbiddenQueryKeys = [
      "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "scope", "resource",
    ];
    expect(forbiddenQueryKeys.some((key) => loginTarget.searchParams.has(key))).toBe(false);
    expect(loginTarget.searchParams.get("state") === clientState).toBe(false);

    const storageAfterAuthorization = JSON.stringify([...storage.values.entries()]);
    expect(storageAfterAuthorization !== storageBeforeAuthorization).toBe(true);

    const userPage = await beginUserLogin(
      controller,
      loginTarget.pathname + loginTarget.search,
    );
    expect(userPage.response.status).toBe(200);
    expect(userPage.state.length > 0).toBe(true);
    expect(userPage.state === clientState).toBe(false);

    jest.advanceTimersByTime(30_000);
    const code = await totp(enrollment.secret, Date.now());
    const login = await postForm(
      controller,
      loginTarget.pathname + loginTarget.search,
      { state: userPage.state, email: enrollment.email, code },
    );
    expect(login.status).toBe(302);
    const callback = new URL(login.headers.get("location") ?? BASE_URL);
    expect(callback.origin + callback.pathname).toBe(
      new URL(CHATGPT_REDIRECT).origin + new URL(CHATGPT_REDIRECT).pathname,
    );
    expect(callback.searchParams.get("state")).toBe(clientState);
    const authorizationCode = callback.searchParams.get("code") ?? "";
    expect(authorizationCode.length > 0).toBe(true);

    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(/(?:^|;\s*)HttpOnly(?:;|$)/iu.test(setCookie)).toBe(true);
    const sessionCookie = cookiePair(login);
    const admin = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie: sessionCookie },
    }));
    expect(admin.status).toBe(200);

    const tokenResponse = await postForm(controller, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code: authorizationCode,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = await tokenResponse.json() as TokenSet;
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");

    const loginStateReplay = await postForm(
      controller,
      loginTarget.pathname + loginTarget.search,
      { state: userPage.state, email: enrollment.email, code },
    );
    expect(loginStateReplay.status === 302).toBe(false);

    const codeReplay = await postForm(controller, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code: authorizationCode,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(codeReplay.status).toBe(400);
    expect((await codeReplay.json() as { error: string }).error).toBe("invalid_grant");

    const repeatedClientState = await beginOAuth(controller, clientId, {
      verifier: "q".repeat(64),
      state: clientState,
    });
    expect(repeatedClientState.response.status).toBe(302);
    const repeatedTarget = new URL(repeatedClientState.response.headers.get("location") ?? BASE_URL);
    const repeatedLoginForm = await beginUserLogin(
      controller,
      repeatedTarget.pathname + repeatedTarget.search,
    );
    expect(repeatedLoginForm.response.status).toBe(200);
    expect(repeatedLoginForm.state === userPage.state).toBe(false);

    const repeatedLogin = await postForm(
      controller,
      repeatedTarget.pathname + repeatedTarget.search,
      {
        state: repeatedLoginForm.state,
        email: enrollment.email,
        code: enrollment.recoveryCodes[0] ?? "",
      },
    );
    expect(repeatedLogin.status).toBe(302);
    const repeatedCallback = new URL(repeatedLogin.headers.get("location") ?? BASE_URL);
    expect(repeatedCallback.searchParams.get("state")).toBe(clientState);
    expect(
      repeatedCallback.searchParams.get("code") !== authorizationCode,
    ).toBe(true);
  });

  it("reuses one valid human session at /oauth and the temporary /authorize alias without asking for TOTP again", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const loginForm = await beginUserLogin(controller);
    const session = await submitUserLogin(
      controller,
      loginForm.state,
      enrollment.email,
      enrollment.recoveryCodes[0] ?? "",
    );
    expect(session.status).toBe(302);
    const cookie = cookiePair(session);
    const clientId = await registerClient(controller);

    const canonical = await beginOAuth(controller, clientId, { state: "canonical-client-state" });
    const canonicalResponse = await controller.fetch(new Request(canonical.requestUrl, {
      headers: { cookie },
    }));
    expect(canonicalResponse.status).toBe(302);
    const canonicalCallback = new URL(canonicalResponse.headers.get("location") ?? BASE_URL);
    expect(canonicalCallback.searchParams.get("state")).toBe("canonical-client-state");
    expect((canonicalCallback.searchParams.get("code") ?? "").length > 0).toBe(true);

    const legacyAlias = await beginOAuth(controller, clientId, {
      path: "/authorize",
      state: "alias-client-state",
    });
    const aliasResponse = await controller.fetch(new Request(legacyAlias.requestUrl, {
      headers: { cookie },
    }));
    expect(aliasResponse.status).toBe(302);
    const aliasCallback = new URL(aliasResponse.headers.get("location") ?? BASE_URL);
    expect(aliasCallback.searchParams.get("state")).toBe("alias-client-state");
    expect((aliasCallback.searchParams.get("code") ?? "").length > 0).toBe(true);
    expect(aliasCallback.origin + aliasCallback.pathname).toBe(
      new URL(CHATGPT_REDIRECT).origin + new URL(CHATGPT_REDIRECT).pathname,
    );

  });

  it("requires PKCE S256 and binds one-shot codes to client, redirect URI, verifier, and resource", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const loginForm = await beginUserLogin(controller);
    const session = await submitUserLogin(
      controller,
      loginForm.state,
      enrollment.email,
      enrollment.recoveryCodes[0] ?? "",
    );
    const cookie = cookiePair(session);
    const clientId = await registerClient(controller);
    const otherClientId = await registerClient(controller, "https://chatgpt.com/connector/oauth/synthetic-other");
    const verifier = "v".repeat(64);
    const start = await beginOAuth(controller, clientId, { verifier, state: "pkce-state" });
    const response = await controller.fetch(new Request(start.requestUrl, { headers: { cookie } }));
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("location") ?? BASE_URL);
    const code = callback.searchParams.get("code") ?? "";
    expect(code.length > 0).toBe(true);

    const plain = await controller.fetch(new Request(authorizationUrl(clientId, {
      code_challenge: "A".repeat(43),
      code_challenge_method: "plain",
    }), { headers: { cookie } }));
    expect(plain.status).toBe(400);

    const wrongVerifier = await postForm(controller, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: "w".repeat(64),
      resource: RESOURCE,
    });
    expect(wrongVerifier.status).toBe(400);
    expect((await wrongVerifier.json() as { error: string }).error).toBe("invalid_grant");

    const wrongClient = await postForm(controller, "/token", {
      grant_type: "authorization_code",
      client_id: otherClientId,
      code,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(wrongClient.status).toBe(400);
    expect((await wrongClient.json() as { error: string }).error).toBe("invalid_grant");

    const wrongRedirect = await postForm(controller, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://chatgpt.com/connector/oauth/changed",
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(wrongRedirect.status).toBe(400);
    expect((await wrongRedirect.json() as { error: string }).error).toBe("invalid_grant");

    const wrongResource = await postForm(controller, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      resource: "https://wrong-resource.example/mcp",
    });
    expect(wrongResource.status).toBe(400);
    expect((await wrongResource.json() as { error: string }).error).toBe("invalid_grant");

    const exchanged = await postForm(controller, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(exchanged.status).toBe(200);
  });

  it("keeps DCR and redirect allowlists closed while accepting synthetic ChatGPT callbacks", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const loginForm = await beginUserLogin(controller);
    const session = await submitUserLogin(
      controller,
      loginForm.state,
      enrollment.email,
      enrollment.recoveryCodes[0] ?? "",
    );
    const cookie = cookiePair(session);
    const accepted = await registerClient(controller);
    expect(accepted.startsWith("mcp-")).toBe(true);

    const invalidClients = await Promise.all([
      registerClientRaw(controller, {
        redirect_uris: ["https://attacker.example/callback"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      registerClientRaw(controller, {
        redirect_uris: ["javascript:alert(1)"],
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    ]);
    expect(invalidClients.map((response) => response.status)).toEqual([400, 400]);

    const evilRedirect = await beginOAuth(controller, accepted, {
      redirectUri: "https://attacker.example/collect",
    });
    const openRedirect = await controller.fetch(new Request(evilRedirect.requestUrl, { headers: { cookie } }));
    expect([301, 302, 303, 307, 308].includes(openRedirect.status)).toBe(false);
    expect(openRedirect.status).toBe(400);
  });

  it("rotates refresh tokens, rejects reuse, and revokes both access and refresh credentials", async () => {
    const { controller, storage } = createHarness();
    const enrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const loginForm = await beginUserLogin(controller);
    const session = await submitUserLogin(
      controller,
      loginForm.state,
      enrollment.email,
      enrollment.recoveryCodes[0] ?? "",
    );
    expect(session.status).toBe(302);
    const clientId = await registerClient(controller);
    const verifier = "r".repeat(64);
    const started = await beginOAuth(controller, clientId, { verifier, state: "refresh-state" });
    const callback = await controller.fetch(new Request(started.requestUrl, {
      headers: { cookie: cookiePair(session) },
    }));
    const code = new URL(callback.headers.get("location") ?? BASE_URL).searchParams.get("code") ?? "";
    const issued = await postForm(controller, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(issued.status).toBe(200);
    const original = await issued.json() as TokenSet;

    const rotatedResponse = await postForm(controller, "/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: original.refresh_token,
      resource: RESOURCE,
    });
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as TokenSet;

    const reused = await postForm(controller, "/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: original.refresh_token,
      resource: RESOURCE,
    });
    expect(reused.status).toBe(400);
    expect((await reused.json() as { error: string }).error).toBe("invalid_grant");

    const revokeRefresh = await postForm(controller, "/revoke", {
      token: rotated.refresh_token,
      token_type_hint: "refresh_token",
    });
    expect(revokeRefresh.status).toBe(200);
    const revokedRefreshReuse = await postForm(controller, "/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: rotated.refresh_token,
      resource: RESOURCE,
    });
    expect(revokedRefreshReuse.status).toBe(400);
    expect((await revokedRefreshReuse.json() as { error: string }).error).toBe("invalid_grant");

    const revokeAccess = await postForm(controller, "/revoke", {
      token: rotated.access_token,
      token_type_hint: "access_token",
    });
    expect(revokeAccess.status).toBe(200);
    const mcp = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + rotated.access_token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }));
    expect(mcp.status).toBe(401);
  });

  it("revoking a user invalidates their access token, refresh token, and human session", async () => {
    const { controller, storage } = createHarness();
    const adminEnrollment = await bootstrapAndEnrollAdmin(controller, storage);
    const adminForm = await beginUserLogin(controller);
    const adminSession = await submitUserLogin(
      controller,
      adminForm.state,
      adminEnrollment.email,
      adminEnrollment.recoveryCodes[0] ?? "",
    );
    expect(adminSession.status).toBe(302);
    const adminCookie = cookiePair(adminSession);

    const userEmail = "oauth-user@example.invalid";
    const userEnrollment = await joinUser(controller, storage, adminCookie, userEmail);
    const userForm = await beginUserLogin(controller);
    const userSession = await submitUserLogin(
      controller,
      userForm.state,
      userEnrollment.email,
      userEnrollment.recoveryCodes[0] ?? "",
    );
    const userCookie = cookiePair(userSession);

    const clientId = await registerClient(controller);
    const verifier = "u".repeat(64);
    const started = await beginOAuth(controller, clientId, { verifier, state: "revoked-user-state" });
    const callback = await controller.fetch(new Request(started.requestUrl, {
      headers: { cookie: userCookie },
    }));
    const code = new URL(callback.headers.get("location") ?? BASE_URL).searchParams.get("code") ?? "";
    const issued = await postForm(controller, "/token", {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: CHATGPT_REDIRECT,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(issued.status).toBe(200);
    const tokens = await issued.json() as TokenSet;

    const page = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie: adminCookie },
    }));
    const csrf = csrfFromHtml(await page.text());
    const revoked = await postForm(
      controller,
      `/admin/users/${userEnrollment.userId}/revoke`,
      { csrf },
      adminCookie,
    );
    expect([302, 303].includes(revoked.status)).toBe(true);

    const mcp = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + tokens.access_token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    }));
    expect(mcp.status).toBe(401);

    const refresh = await postForm(controller, "/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      resource: RESOURCE,
    });
    expect(refresh.status).toBe(400);
    expect((await refresh.json() as { error: string }).error).toBe("invalid_grant");

    const revokedSession = await controller.fetch(new Request(new URL("/oauth", BASE_URL), {
      headers: { cookie: userCookie },
    }));
    expect(revokedSession.status).toBe(302);
    expect(new URL(revokedSession.headers.get("location") ?? BASE_URL).pathname).toBe("/user");
  });
});
