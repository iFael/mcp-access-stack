import { describe, expect, it } from "@jest/globals";
import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import { UpdateControlAuthController, type UpdateControlDurableState } from "../../src/auth-state.js";

const BASE_URL = "https://update-control.example/";
const ADMIN_MARKER = "x-update-control-internal-admin-operation-authenticated";
const MICROSOFT_MARKER = "x-update-control-internal-microsoft-authenticated";
const INTERNAL_VALUE = "v1";

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
      MICROSOFT_CLIENT_ID: "11111111-2222-4333-8444-555555555555",
      MICROSOFT_TENANT: "organizations",
      UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "rafael@example.com",
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
  expect(response.status).toBe(302);
  const state = new URL(response.headers.get("location")!).searchParams.get("state");
  expect(state).toBeTruthy();
  return { state: state!, verifier };
}

async function completeMicrosoft(
  controller: UpdateControlAuthController,
  state: string,
  subject: string,
  name: string,
): Promise<Response> {
  return controller.fetch(new Request(new URL("/_internal/microsoft/complete", BASE_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [MICROSOFT_MARKER]: INTERNAL_VALUE,
    },
    body: JSON.stringify({
      state,
      subject,
      displayName: name,
      email: name.toLowerCase().replaceAll(" ", ".") + "@example.com",
    }),
  }));
}

async function createFirstAdmin(
  controller: UpdateControlAuthController,
  subject = "microsoft-admin-subject",
) {
  await bootstrap(controller);
  const clientId = await registerClient(controller);
  const started = await beginMcpAuthorization(controller, clientId);
  const completed = await completeMicrosoft(controller, started.state, subject, "Rafael");
  expect(completed.status).toBe(302);
}

async function adminLogin(controller: UpdateControlAuthController, subject: string) {
  const begin = await controller.fetch(new Request(new URL("/admin/login", BASE_URL)));
  expect(begin.status).toBe(302);
  const state = new URL(begin.headers.get("location")!).searchParams.get("state")!;
  const complete = await completeMicrosoft(controller, state, subject, "Rafael");
  return complete;
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const pair = setCookie.split(";", 1)[0] ?? "";
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

async function formPost(
  controller: UpdateControlAuthController,
  path: string,
  cookie: string,
  fields: Record<string, string>,
) {
  return controller.fetch(new Request(new URL(path, BASE_URL), {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields),
  }));
}

describe("Update Control multi-user admin surface", () => {
  it("authenticates admin with Microsoft, invites a second user one-shot, and manages roles without HMAC", async () => {
    const { controller, storage } = makeController();
    const adminSubject = "microsoft-admin-subject";
    await createFirstAdmin(controller, adminSubject);

    const login = await adminLogin(controller, adminSubject);
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe(new URL("/admin", BASE_URL).href);
    const cookie = cookieFrom(login);

    const firstPage = await adminPage(controller, cookie);
    expect(firstPage.html).toContain("Rafael");
    expect(firstPage.html).toContain("admin");

    const badCsrf = await formPost(controller, "/admin/invites", cookie, {
      csrf: "x".repeat(43),
      role: "viewer",
    });
    expect(badCsrf.status).toBe(403);
    expect(await badCsrf.json()).toEqual({ error: "csrf_rejected" });

    const invite = await formPost(controller, "/admin/invites", cookie, {
      csrf: firstPage.csrf,
      role: "viewer",
    });
    expect(invite.status).toBe(200);
    const inviteHtml = await invite.text();
    const joinUrl = /href="(https:[^"]+\/join\?invite=[^"]+)"/u.exec(inviteHtml)?.[1];
    expect(joinUrl).toBeTruthy();

    const join = await controller.fetch(new Request(joinUrl!));
    expect(join.status).toBe(302);
    const joinState = new URL(join.headers.get("location")!).searchParams.get("state")!;
    const enrolled = await completeMicrosoft(controller, joinState, "microsoft-viewer-subject", "Felipe");
    expect(enrolled.status).toBe(200);
    expect(await enrolled.text()).toContain("viewer");

    const replay = await controller.fetch(new Request(joinUrl!));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_invite" });

    const viewerLogin = await adminLogin(controller, "microsoft-viewer-subject");
    expect(viewerLogin.status).toBe(403);
    expect(await viewerLogin.json()).toEqual({ error: "admin_required" });

    const viewer = [...storage.values.values()].find((value) =>
      typeof value === "object" && value !== null &&
      "providerSubject" in value && value.providerSubject === "microsoft-viewer-subject"
    ) as { id: string } | undefined;
    expect(viewer?.id).toMatch(/^usr_/u);

    const refreshedPage = await adminPage(controller, cookie);
    const roleChanged = await formPost(
      controller,
      "/admin/users/" + viewer!.id + "/role",
      cookie,
      { csrf: refreshedPage.csrf, role: "operator" },
    );
    expect(roleChanged.status).toBe(303);
    expect((storage.values.get("update-control:identity:user:" + viewer!.id) as { role: string }).role)
      .toBe("operator");
  });

  it("cannot demote or revoke the final admin", async () => {
    const { controller, storage } = makeController();
    const adminSubject = "microsoft-only-admin";
    await createFirstAdmin(controller, adminSubject);
    const login = await adminLogin(controller, adminSubject);
    const cookie = cookieFrom(login);
    const page = await adminPage(controller, cookie);
    const admin = [...storage.values.values()].find((value) =>
      typeof value === "object" && value !== null &&
      "providerSubject" in value && value.providerSubject === adminSubject
    ) as { id: string } | undefined;

    const demote = await formPost(
      controller,
      "/admin/users/" + admin!.id + "/role",
      cookie,
      { csrf: page.csrf, role: "viewer" },
    );
    expect(demote.status).toBe(409);
    expect(await demote.json()).toEqual({ error: "last_admin_required" });

    const revoke = await formPost(
      controller,
      "/admin/users/" + admin!.id + "/revoke",
      cookie,
      { csrf: page.csrf },
    );
    expect(revoke.status).toBe(409);
    expect(await revoke.json()).toEqual({ error: "last_admin_required" });
  });

  it("revoking an enrolled user immediately invalidates that user's existing MCP access token", async () => {
    const { controller, storage } = makeController();
    const adminSubject = "microsoft-admin-for-revoke";
    const viewerSubject = "microsoft-viewer-for-revoke";
    await createFirstAdmin(controller, adminSubject);
    const login = await adminLogin(controller, adminSubject);
    const cookie = cookieFrom(login);
    let page = await adminPage(controller, cookie);

    const invite = await formPost(controller, "/admin/invites", cookie, {
      csrf: page.csrf,
      role: "viewer",
    });
    const joinUrl = /href="(https:[^"]+\/join\?invite=[^"]+)"/u.exec(await invite.text())?.[1]!;
    const join = await controller.fetch(new Request(joinUrl));
    const joinState = new URL(join.headers.get("location")!).searchParams.get("state")!;
    expect((await completeMicrosoft(controller, joinState, viewerSubject, "Felipe")).status).toBe(200);

    const clientId = await registerClient(controller);
    const started = await beginMcpAuthorization(controller, clientId);
    const authorized = await completeMicrosoft(controller, started.state, viewerSubject, "Felipe");
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
      "providerSubject" in value && value.providerSubject === viewerSubject
    ) as { id: string } | undefined;
    page = await adminPage(controller, cookie);
    const revoked = await formPost(
      controller,
      "/admin/users/" + viewer!.id + "/revoke",
      cookie,
      { csrf: page.csrf },
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

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
