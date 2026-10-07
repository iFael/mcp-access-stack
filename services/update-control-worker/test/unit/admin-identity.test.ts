import { describe, expect, it } from "@jest/globals";
import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import { UpdateControlAuthController, type UpdateControlDurableState } from "../../src/auth-state.js";

const BASE_URL = "https://update-control.example/";
const ADMIN_MARKER = "x-update-control-internal-admin-operation-authenticated";
const INTERNAL_VALUE = "v1";
const TOTP_KEY = "e".repeat(64);

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

function makeController(storage = new MemoryStorage()) {
  const state: UpdateControlDurableState = { storage };
  return {
    storage,
    controller: new UpdateControlAuthController(state, {
      MCP_UPDATE_CONTROL_PUBLIC_URL: BASE_URL,
      UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "rafael@example.com",
      UPDATE_CONTROL_TOTP_ENCRYPTION_KEY: TOTP_KEY,
    }),
  };
}

async function bootstrap(controller: UpdateControlAuthController) {
  const operationId = "11111111-2222-4333-8444-555555555555";
  const response = await controller.fetch(new Request(new URL("/_operations/admin/bootstrap", BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ADMIN_MARKER]: INTERNAL_VALUE,
    },
    body: JSON.stringify({ operationId }),
  }));
  expect(response.status).toBe(200);
}

async function registerClient(controller: UpdateControlAuthController): Promise<string> {
  const response = await controller.fetch(new Request(new URL("/register", BASE_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/admin-test"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }));
  expect(response.status).toBe(201);
  return (await response.json() as { client_id: string }).client_id;
}

async function beginMcpAuthorization(controller: UpdateControlAuthController, clientId: string) {
  const verifier = "v".repeat(64);
  const challenge = await sha256Base64Url(verifier);
  const url = new URL("/oauth", BASE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://chatgpt.com/connector/oauth/admin-test",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "update:read",
    resource: new URL("/mcp", BASE_URL).href,
    state: "chatgpt-state",
  }).toString();
  const response = await controller.fetch(new Request(url));
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe(new URL("/user", BASE_URL).href);
  const loginCookie = cookieFrom(response, "update_control_login");
  const loginPage = await controller.fetch(new Request(new URL("/user", BASE_URL), {
    headers: { cookie: loginCookie },
  }));
  expect(loginPage.status).toBe(200);
  return { state: hiddenState(await loginPage.text()), verifier, loginCookie };
}

async function form(
  controller: UpdateControlAuthController,
  path: string,
  fields: Record<string, string>,
  cookie?: string,
) {
  return controller.fetch(new Request(new URL(path, BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams(fields),
  }));
}

async function enroll(
  controller: UpdateControlAuthController,
  url: string,
  email: string,
  name: string,
): Promise<{ recoveryCodes: string[]; secret: string }> {
  const page = await controller.fetch(new Request(url));
  expect(page.status).toBe(200);
  const html = await page.text();
  const state = hiddenState(html);
  const secret = /data-manual-totp-secret="([A-Z2-7]+)"/u.exec(html)?.[1];
  expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
  const response = await form(controller, "/enroll", {
    state,
    email,
    display_name: name,
    code: await totp(secret, Date.now()),
  });
  expect(response.status).toBe(200);
  const completed = await response.text();
  return {
    secret,
    recoveryCodes: [...completed.matchAll(/data-recovery-code="([A-Z0-9-]+)"/gu)]
      .map((match) => match[1]!),
  };
}

async function createFirstAdmin(controller: UpdateControlAuthController) {
  await bootstrap(controller);
  return enroll(controller, new URL("/enroll", BASE_URL).href, "rafael@example.com", "Rafael");
}

async function humanLogin(
  controller: UpdateControlAuthController,
  email: string,
  code: string,
): Promise<Response> {
  const begin = await controller.fetch(new Request(new URL("/user", BASE_URL)));
  expect(begin.status).toBe(200);
  const state = hiddenState(await begin.text());
  const loginCookie = cookieFrom(begin, "update_control_login");
  return form(controller, "/user", { state, email, code }, loginCookie);
}

async function adminLogin(
  controller: UpdateControlAuthController,
  code: string,
): Promise<Response> {
  return humanLogin(controller, "rafael@example.com", code);
}

function cookieFrom(response: Response, name = "update_control_session"): string {
  const pair = (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  expect(pair).toMatch(new RegExp("^" + name + "="));
  return pair;
}

async function adminPage(controller: UpdateControlAuthController, cookie: string) {
  const response = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
    headers: { cookie },
  }));
  const html = await response.text();
  const csrf = /name="csrf" value="([^"]+)"/u.exec(html)?.[1];
  expect(response.status).toBe(200);
  expect(csrf).toBeTruthy();
  return { html, csrf: csrf! };
}

describe("Update Control multi-user local admin surface", () => {
  it("authenticates admin locally, invites a second user one-shot, and manages roles without HMAC login", async () => {
    const { controller, storage } = makeController();
    const adminEnrollment = await createFirstAdmin(controller);
    expect(adminEnrollment.recoveryCodes).toHaveLength(8);

    const login = await adminLogin(controller, adminEnrollment.recoveryCodes[0]!);
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/user");
    const cookie = cookieFrom(login);

    const firstPage = await adminPage(controller, cookie);
    expect(firstPage.html).toContain("Rafael");
    expect(firstPage.html).toContain("admin");

    const badCsrf = await form(controller, "/admin/invites", {
      csrf: "x".repeat(43),
      role: "viewer",
    }, cookie);
    expect(badCsrf.status).toBe(403);

    const invite = await form(controller, "/admin/invites", {
      csrf: firstPage.csrf,
      role: "user",
    }, cookie);
    const rejectedLegacyInvite = await form(controller, "/admin/invites", {
      csrf: firstPage.csrf,
      role: "viewer",
    }, cookie);
    expect(rejectedLegacyInvite.status).toBe(400);
    expect(await rejectedLegacyInvite.json()).toEqual({ error: "invalid_role" });
    expect(invite.status).toBe(200);
    const inviteHtml = await invite.text();
    const joinUrl = /href="(https:[^"]+\/join\?invite=[^"]+)"/u.exec(inviteHtml)?.[1];
    expect(joinUrl).toBeTruthy();

    const viewerEnrollment = await enroll(controller, joinUrl!, "felipe@example.com", "Felipe");
    expect(viewerEnrollment.recoveryCodes).toHaveLength(8);

    const replay = await controller.fetch(new Request(joinUrl!));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_invite" });

    const viewerLogin = await humanLogin(
      controller,
      "felipe@example.com",
      viewerEnrollment.recoveryCodes[0]!,
    );
    expect(viewerLogin.status).toBe(303);
    const viewerCookie = cookieFrom(viewerLogin);
    const deniedAdmin = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie: viewerCookie },
    }));
    expect(deniedAdmin.status).toBe(403);
    const cookieOnlyMcp = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(cookieOnlyMcp.status).toBe(401);

    const viewer = [...storage.values.values()].find((value) =>
      typeof value === "object" && value !== null &&
      "email" in value && value.email === "felipe@example.com" &&
      "provider" in value && value.provider === "local-totp"
    ) as { id: string } | undefined;
    expect(viewer?.id).toMatch(/^usr_/u);

    const refreshedPage = await adminPage(controller, cookie);
    const roleChanged = await form(
      controller,
      "/admin/users/" + viewer!.id + "/role",
      { csrf: refreshedPage.csrf, role: "admin" },
      cookie,
    );
    expect(roleChanged.status).toBe(400);
    expect(await roleChanged.json()).toEqual({ error: "invalid_role" });
    const viewerKey = "update-control:identity:user:" + viewer!.id;
    expect((storage.values.get(viewerKey) as { role: string }).role).toBe("user");

    storage.values.set(viewerKey, {
      ...(storage.values.get(viewerKey) as object),
      role: "admin",
    });
    const staleAdminSession = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie: viewerCookie },
    }));
    expect(staleAdminSession.status).toBe(403);
    expect((storage.values.get(viewerKey) as { role: string }).role).toBe("user");
  });

  it("stores human session tokens only by hash and requires CSRF to log out", async () => {
    const { controller, storage } = makeController();
    const enrollment = await createFirstAdmin(controller);
    const login = await adminLogin(controller, enrollment.recoveryCodes[0]!);
    expect(login.status).toBe(303);
    const cookie = cookieFrom(login);
    const token = cookie.slice("update_control_session=".length);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("Secure");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(login.headers.get("set-cookie")).toContain("Path=/");

    const sessionKey = "update-control:identity:session:" + await sha256Base64Url(token);
    expect(storage.values.has(sessionKey)).toBe(true);
    expect([...storage.values.keys()].some((key) => key.includes(token))).toBe(false);
    expect(JSON.stringify([...storage.values.values()])).not.toContain(token);

    const userPage = await controller.fetch(new Request(new URL("/user", BASE_URL), {
      headers: { cookie },
    }));
    expect(userPage.status).toBe(200);
    const csrf = /name="csrf" value="([^"]+)"/u.exec(await userPage.text())?.[1];
    expect(csrf).toBeTruthy();

    const rejected = await form(controller, "/user/logout", { csrf: "x".repeat(43) }, cookie);
    expect(rejected.status).toBe(403);
    const logout = await form(controller, "/user/logout", { csrf: csrf! }, cookie);
    expect(logout.status).toBe(303);
    expect(logout.headers.get("location")).toBe("/user");
    expect(storage.values.has(sessionKey)).toBe(false);

    const adminAfterLogout = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie },
    }));
    expect(adminAfterLogout.status).toBe(302);
    expect(adminAfterLogout.headers.get("location")).toBe(new URL("/user", BASE_URL).href);
  });

  it("maps known legacy roles to user and fails closed for unknown roles", async () => {
    const { controller, storage } = makeController();
    const adminEnrollment = await createFirstAdmin(controller);
    const adminCookie = cookieFrom(await adminLogin(controller, adminEnrollment.recoveryCodes[0]!));
    const page = await adminPage(controller, adminCookie);
    const invite = await form(controller, "/admin/invites", {
      csrf: page.csrf,
      role: "user",
    }, adminCookie);
    const joinUrl = /href="(https:[^"]+\/join\?invite=[^"]+)"/u.exec(await invite.text())?.[1]!;
    const enrolled = await enroll(controller, joinUrl, "felipe@example.com", "Felipe");
    const user = [...storage.values.values()].find((value) =>
      typeof value === "object" && value !== null &&
      "email" in value && value.email === "felipe@example.com" &&
      "provider" in value && value.provider === "local-totp"
    ) as { id: string; role: string } | undefined;
    expect(user?.id).toMatch(/^usr_/u);

    const userKey = "update-control:identity:user:" + user!.id;
    storage.values.set(userKey, { ...user, role: "operator" });
    const userLogin = await humanLogin(controller, "felipe@example.com", enrolled.recoveryCodes[0]!);
    expect(userLogin.status).toBe(303);
    expect((storage.values.get(userKey) as { role: string }).role).toBe("user");
    const userCookie = cookieFrom(userLogin);
    const deniedAdmin = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie: userCookie },
    }));
    expect(deniedAdmin.status).toBe(403);

    storage.values.set(userKey, { ...storage.values.get(userKey) as object, role: "unknown" });
    const unknownRoleAdmin = await controller.fetch(new Request(new URL("/admin", BASE_URL), {
      headers: { cookie: userCookie },
    }));
    expect(unknownRoleAdmin.status).toBe(302);
    expect(unknownRoleAdmin.headers.get("location")).toBe(new URL("/user", BASE_URL).href);
  });

  it("reuses the human session at /oauth and keeps the OAuth callback state", async () => {
    const { controller } = makeController();
    const enrollment = await createFirstAdmin(controller);
    const cookie = cookieFrom(await adminLogin(controller, enrollment.recoveryCodes[0]!));
    const clientId = await registerClient(controller);
    const url = new URL("/oauth", BASE_URL);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://chatgpt.com/connector/oauth/admin-test",
      code_challenge: "A".repeat(43),
      code_challenge_method: "S256",
      scope: "update:read",
      resource: new URL("/mcp", BASE_URL).href,
      state: "chatgpt-state",
    }).toString();

    const response = await controller.fetch(new Request(url, { headers: { cookie } }));
    expect(response.status).toBe(302);
    const callback = new URL(response.headers.get("location")!);
    expect(callback.pathname).toBe("/connector/oauth/admin-test");
    expect(callback.searchParams.get("state")).toBe("chatgpt-state");
    expect(callback.searchParams.get("code")).toMatch(/^code-/u);
  });

  it("accepts only an exact legacy /authorize form for a live MCP transaction", async () => {
    const { controller, storage } = makeController();
    const enrollment = await createFirstAdmin(controller);
    const clientId = await registerClient(controller);
    const verifier = "v".repeat(64);
    const redirectUri = "https://chatgpt.com/connector/oauth/admin-test";
    const resource = new URL("/mcp", BASE_URL).href;
    const pendingKey = "update-control:oauth:login-pending:";
    const pendingState = "L".repeat(43);
    const pending = {
      version: 1,
      state: pendingState,
      kind: "mcp",
      clientId,
      redirectUri,
      codeChallenge: await sha256Base64Url(verifier),
      scopes: ["update:read"],
      resource,
      clientState: "legacy-client-state",
      expiresAtMs: Date.now() + 60_000,
    };

    const extraFieldState = "E".repeat(43);
    storage.values.set(pendingKey + extraFieldState, { ...pending, state: extraFieldState });
    const extraField = await form(controller, "/authorize", {
      state: extraFieldState,
      email: "rafael@example.com",
      code: enrollment.recoveryCodes[0]!,
      extra: "not-legacy",
    });
    expect(extraField.status).toBe(400);
    expect(await extraField.json()).toEqual({ error: "invalid_request" });
    expect(storage.values.has(pendingKey + extraFieldState)).toBe(true);

    storage.values.set(pendingKey + pendingState, pending);
    const completed = await form(controller, "/authorize", {
      state: pendingState,
      email: "rafael@example.com",
      code: enrollment.recoveryCodes[0]!,
    });
    expect(completed.status).toBe(302);
    expect(completed.headers.get("set-cookie")).toContain("update_control_session=");
    const callback = new URL(completed.headers.get("location")!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("legacy-client-state");
    expect(callback.searchParams.get("code")).toMatch(/^code-/u);
    expect(storage.values.has(pendingKey + pendingState)).toBe(false);

    const replay = await form(controller, "/authorize", {
      state: pendingState,
      email: "rafael@example.com",
      code: enrollment.recoveryCodes[0]!,
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_request" });
    expect([...storage.values.keys()].filter((key) => key.startsWith("update-control:oauth:code:")))
      .toHaveLength(1);

    const nonMcpState = "N".repeat(43);
    storage.values.set(pendingKey + nonMcpState, {
      ...pending,
      state: nonMcpState,
      kind: "oauth",
    });
    const nonMcp = await form(controller, "/authorize", {
      state: nonMcpState,
      email: "rafael@example.com",
      code: enrollment.recoveryCodes[1]!,
    });
    expect(nonMcp.status).toBe(400);
    expect(await nonMcp.json()).toEqual({ error: "invalid_request" });
    expect(storage.values.has(pendingKey + nonMcpState)).toBe(true);

    const ordinaryLogin = await humanLogin(
      controller,
      "rafael@example.com",
      enrollment.recoveryCodes[1]!,
    );
    expect(ordinaryLogin.status).toBe(303);
  });

  it("converts legacy admin invitations and pending enrollments to user", async () => {
    const { controller, storage } = makeController();
    await createFirstAdmin(controller);
    const admin = [...storage.values.values()].find((value) =>
      typeof value === "object" && value !== null &&
      "email" in value && value.email === "rafael@example.com" &&
      "provider" in value && value.provider === "local-totp"
    ) as { id: string; role: string } | undefined;
    expect(admin?.id).toMatch(/^usr_/u);

    const inviteToken = "I".repeat(43);
    const inviteKey = "update-control:identity:invite:" + await sha256Base64Url(inviteToken);
    storage.values.set(inviteKey, {
      version: 1,
      role: "admin",
      createdByUserId: admin!.id,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const joinUrl = new URL("/join", BASE_URL);
    joinUrl.searchParams.set("invite", inviteToken);
    const page = await controller.fetch(new Request(joinUrl));
    expect(page.status).toBe(200);
    const html = await page.text();
    const state = hiddenState(html);
    const secret = /data-manual-totp-secret="([A-Z2-7]+)"/u.exec(html)?.[1];
    expect(secret).toMatch(/^[A-Z2-7]{32}$/u);
    expect((storage.values.get(inviteKey) as { role: string }).role).toBe("user");

    const pendingKey = "update-control:identity:enrollment:" + state;
    const pending = storage.values.get(pendingKey) as object;
    expect((pending as { role: string }).role).toBe("user");
    storage.values.set(pendingKey, { ...pending, role: "admin" });

    const completed = await form(controller, "/enroll", {
      state,
      email: "felipe@example.com",
      display_name: "Felipe",
      code: await totp(secret, Date.now()),
    });
    expect(completed.status).toBe(200);
    const invitedUser = [...storage.values.values()].find((value) =>
      typeof value === "object" && value !== null &&
      "email" in value && value.email === "felipe@example.com" &&
      "provider" in value && value.provider === "local-totp"
    ) as { role: string } | undefined;
    expect(invitedUser?.role).toBe("user");
    expect((storage.values.get("update-control:identity:user:" + admin!.id) as { role: string }).role)
      .toBe("admin");
  });

  it("cannot demote or revoke the final admin", async () => {
    const { controller, storage } = makeController();
    const adminEnrollment = await createFirstAdmin(controller);
    const login = await adminLogin(controller, adminEnrollment.recoveryCodes[0]!);
    const cookie = cookieFrom(login);
    const page = await adminPage(controller, cookie);
    const admin = [...storage.values.values()].find((value) =>
      typeof value === "object" && value !== null &&
      "email" in value && value.email === "rafael@example.com" &&
      "provider" in value && value.provider === "local-totp"
    ) as { id: string } | undefined;

    const demote = await form(
      controller,
      "/admin/users/" + admin!.id + "/role",
      { csrf: page.csrf, role: "user" },
      cookie,
    );
    expect(demote.status).toBe(409);
    expect(await demote.json()).toEqual({ error: "last_admin_required" });

    const revoke = await form(
      controller,
      "/admin/users/" + admin!.id + "/revoke",
      { csrf: page.csrf },
      cookie,
    );
    expect(revoke.status).toBe(409);
    expect(await revoke.json()).toEqual({ error: "last_admin_required" });
  });

  it("revoking an enrolled user immediately invalidates that user's existing MCP access token", async () => {
    const { controller, storage } = makeController();
    const adminEnrollment = await createFirstAdmin(controller);
    const login = await adminLogin(controller, adminEnrollment.recoveryCodes[0]!);
    const cookie = cookieFrom(login);
    let page = await adminPage(controller, cookie);

    const invite = await form(controller, "/admin/invites", {
      csrf: page.csrf,
      role: "user",
    }, cookie);
    const joinUrl = /href="(https:[^"]+\/join\?invite=[^"]+)"/u.exec(await invite.text())?.[1]!;
    const viewerEnrollment = await enroll(controller, joinUrl, "felipe@example.com", "Felipe");

    const clientId = await registerClient(controller);
    const started = await beginMcpAuthorization(controller, clientId);
    const authorized = await form(controller, "/user", {
      state: started.state,
      email: "felipe@example.com",
      code: viewerEnrollment.recoveryCodes[0]!,
    }, started.loginCookie);
    expect(authorized.status).toBe(302);
    const callback = new URL(authorized.headers.get("location")!);
    expect(callback.searchParams.get("state")).toBe("chatgpt-state");
    const replay = await form(controller, "/user", {
      state: started.state,
      email: "felipe@example.com",
      code: viewerEnrollment.recoveryCodes[0]!,
    }, started.loginCookie);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "authorization_expired" });
    const code = callback.searchParams.get("code")!;

    const tokenResponse = await controller.fetch(new Request(new URL("/token", BASE_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: "https://chatgpt.com/connector/oauth/admin-test",
        code_verifier: started.verifier,
        resource: new URL("/mcp", BASE_URL).href,
      }),
    }));
    const accessToken = (await tokenResponse.json() as { access_token: string }).access_token;
    const before = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(before.status).toBe(200);

    const viewer = [...storage.values.values()].find((value) =>
      typeof value === "object" && value !== null &&
      "email" in value && value.email === "felipe@example.com" &&
      "provider" in value && value.provider === "local-totp"
    ) as { id: string } | undefined;
    page = await adminPage(controller, cookie);
    const revoked = await form(
      controller,
      "/admin/users/" + viewer!.id + "/revoke",
      { csrf: page.csrf },
      cookie,
    );
    expect(revoked.status).toBe(303);

    const after = await controller.fetch(new Request(new URL("/mcp", BASE_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }));
    expect(after.status).toBe(401);
  });
});

function hiddenState(html: string): string {
  const state = /name="state" value="([^"]+)"/u.exec(html)?.[1];
  expect(state).toBeTruthy();
  return state!;
}

async function totp(secret: string, nowMs: number): Promise<string> {
  const keyBytes = decodeBase32(secret);
  const counter = Math.floor(nowMs / 30_000);
  const message = new Uint8Array(8);
  let value = BigInt(counter);
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

function decodeBase32(value: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("invalid base32");
    accumulator = (accumulator << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
