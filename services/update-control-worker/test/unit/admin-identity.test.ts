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
  const url = new URL("/authorize", BASE_URL);
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
  expect(response.status).toBe(200);
  return { state: hiddenState(await response.text()), verifier };
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
  const provisioning = /data-provisioning-uri="([^"]+)"/u.exec(html)?.[1]?.replaceAll("&amp;", "&");
  expect(provisioning).toContain("otpauth://totp/");
  const secret = new URL(provisioning!).searchParams.get("secret")!;
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

async function adminLogin(
  controller: UpdateControlAuthController,
  code: string,
): Promise<Response> {
  const begin = await controller.fetch(new Request(new URL("/admin/login", BASE_URL)));
  expect(begin.status).toBe(200);
  const state = hiddenState(await begin.text());
  return form(controller, "/admin/login", {
    state,
    email: "rafael@example.com",
    code,
  });
}

function cookieFrom(response: Response): string {
  const pair = (response.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
  expect(pair).toMatch(/^update_control_admin_session=/u);
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
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe(new URL("/admin", BASE_URL).href);
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
      role: "viewer",
    }, cookie);
    expect(invite.status).toBe(200);
    const inviteHtml = await invite.text();
    const joinUrl = /href="(https:[^"]+\/join\?invite=[^"]+)"/u.exec(inviteHtml)?.[1];
    expect(joinUrl).toBeTruthy();

    const viewerEnrollment = await enroll(controller, joinUrl!, "felipe@example.com", "Felipe");
    expect(viewerEnrollment.recoveryCodes).toHaveLength(8);

    const replay = await controller.fetch(new Request(joinUrl!));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_invite" });

    const viewerLoginBegin = await controller.fetch(new Request(new URL("/admin/login", BASE_URL)));
    const viewerState = hiddenState(await viewerLoginBegin.text());
    const viewerLogin = await form(controller, "/admin/login", {
      state: viewerState,
      email: "felipe@example.com",
      code: viewerEnrollment.recoveryCodes[0]!,
    });
    expect(viewerLogin.status).toBe(403);
    expect(await viewerLogin.json()).toEqual({ error: "admin_required" });

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
      { csrf: refreshedPage.csrf, role: "operator" },
      cookie,
    );
    expect(roleChanged.status).toBe(303);
    expect((storage.values.get("update-control:identity:user:" + viewer!.id) as { role: string }).role)
      .toBe("operator");
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
      { csrf: page.csrf, role: "viewer" },
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
      role: "viewer",
    }, cookie);
    const joinUrl = /href="(https:[^"]+\/join\?invite=[^"]+)"/u.exec(await invite.text())?.[1]!;
    const viewerEnrollment = await enroll(controller, joinUrl, "felipe@example.com", "Felipe");

    const clientId = await registerClient(controller);
    const started = await beginMcpAuthorization(controller, clientId);
    const authorized = await form(controller, "/authorize", {
      state: started.state,
      email: "felipe@example.com",
      code: viewerEnrollment.recoveryCodes[0]!,
    });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get("location")!).searchParams.get("code")!;

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
