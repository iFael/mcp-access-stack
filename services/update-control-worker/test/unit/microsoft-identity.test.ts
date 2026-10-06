import { describe, expect, it } from "@jest/globals";
import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import { UpdateControlAuthController, type UpdateControlDurableState } from "../../src/auth-state.js";

const PUBLIC_URL = "https://update-control.example/";
const MICROSOFT_CLIENT_ID = "11111111-2222-4333-8444-555555555555";
const ADMIN_OPERATION_MARKER = "x-update-control-internal-admin-operation-authenticated";
const MICROSOFT_MARKER = "x-update-control-internal-microsoft-authenticated";
const REPROVISION_MARKER = "x-update-control-internal-reprovision-authenticated";
const INTERNAL_VALUE = "v1";

class MemoryStorage implements OwnerOAuthStorage {
  readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

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
      MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL,
      MICROSOFT_CLIENT_ID,
      MICROSOFT_TENANT: "organizations",
      UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL: "rafael@example.com",
    }),
  };
}

async function bootstrap(controller: UpdateControlAuthController, operationId: string): Promise<void> {
  const response = await controller.fetch(new Request(new URL("/_operations/admin/bootstrap", PUBLIC_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [ADMIN_OPERATION_MARKER]: INTERNAL_VALUE,
    },
    body: JSON.stringify({ operationId }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ operationId, status: "ready" });
}

async function registerClient(controller: UpdateControlAuthController): Promise<string> {
  const response = await controller.fetch(new Request(new URL("/register", PUBLIC_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "ChatGPT",
      redirect_uris: ["https://chatgpt.com/connector/oauth/update-control-test"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }));
  expect(response.status).toBe(201);
  return (await response.json() as { client_id: string }).client_id;
}

async function beginAuthorization(controller: UpdateControlAuthController, clientId: string) {
  const verifier = "chatgpt-pkce-verifier-abcdefghijklmnopqrstuvwxyz0123456789";
  const challenge = await sha256Base64Url(verifier);
  const url = new URL("/authorize", PUBLIC_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://chatgpt.com/connector/oauth/update-control-test",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "update:read",
    resource: new URL("/mcp", PUBLIC_URL).href,
    state: "chatgpt-state",
  }).toString();
  const response = await controller.fetch(new Request(url));
  return { response, verifier };
}

async function completeMicrosoft(
  controller: UpdateControlAuthController,
  state: string,
  subject: string,
  displayName: string,
): Promise<Response> {
  return controller.fetch(new Request(new URL("/_internal/microsoft/complete", PUBLIC_URL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [MICROSOFT_MARKER]: INTERNAL_VALUE,
    },
    body: JSON.stringify({
      state,
      subject,
      displayName,
      email: displayName.toLowerCase().replaceAll(" ", ".") + "@example.com",
    }),
  }));
}

async function exchangeCode(
  controller: UpdateControlAuthController,
  clientId: string,
  code: string,
  verifier: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const response = await controller.fetch(new Request(new URL("/token", PUBLIC_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://chatgpt.com/connector/oauth/update-control-test",
      code_verifier: verifier,
      resource: new URL("/mcp", PUBLIC_URL).href,
    }),
  }));
  expect(response.status).toBe(200);
  const body = await response.json() as { access_token: string; refresh_token: string };
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

describe("Update Control passwordless Microsoft identity", () => {
  it("redirects OAuth authorization to Microsoft without rendering or accepting an Access password", async () => {
    const { controller } = makeController();
    await bootstrap(controller, "1f5422a6-614e-4c56-b0cb-5c79dc5eb1da");
    const clientId = await registerClient(controller);
    const { response } = await beginAuthorization(controller, clientId);

    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toContain("https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    expect(location).toContain("client_id=" + MICROSOFT_CLIENT_ID);
    expect(location).not.toContain("owner_password");
    expect(await response.text()).not.toContain("Access password");
  });

  it("bootstraps the first Microsoft identity as admin, binds tokens to userId, and never stores the legacy owner token", async () => {
    const { controller, storage } = makeController();
    await bootstrap(controller, "b4c209cf-e09c-4669-9255-a4bfbe7af6fb");
    const clientId = await registerClient(controller);
    const started = await beginAuthorization(controller, clientId);
    const microsoft = new URL(started.response.headers.get("location")!);
    const pendingState = microsoft.searchParams.get("state");
    expect(pendingState).toBeTruthy();

    const completed = await completeMicrosoft(
      controller,
      pendingState!,
      "microsoft-subject-rafael",
      "Rafael",
    );
    expect(completed.status).toBe(302);
    const callback = new URL(completed.headers.get("location")!);
    expect(callback.hostname).toBe("chatgpt.com");
    expect(callback.searchParams.get("state")).toBe("chatgpt-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokens = await exchangeCode(controller, clientId, code!, started.verifier);
    const authenticated = await controller.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + tokens.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(authenticated.status).toBe(200);

    const persisted = JSON.stringify([...storage.values.entries()]);
    expect(persisted).toContain('"role":"admin"');
    expect(persisted).toContain("microsoft-subject-rafael");
    expect(persisted).not.toContain("ownerVerifierHash");
    expect(persisted).not.toContain("owner:credential-material");
  });

  it("pins the first-admin bootstrap to the configured Microsoft email", async () => {
    const { controller, storage } = makeController();
    await bootstrap(controller, "1b4d43df-b9ce-4c8a-8f40-94057677bd4e");

    const wrongClient = await registerClient(controller);
    const wrongStarted = await beginAuthorization(controller, wrongClient);
    const wrongState = new URL(wrongStarted.response.headers.get("location")!).searchParams.get("state")!;
    const rejected = await completeMicrosoft(
      controller,
      wrongState,
      "microsoft-subject-racer",
      "Wrong User",
    );
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: "bootstrap_identity_mismatch" });
    expect(JSON.stringify([...storage.values.entries()])).not.toContain("microsoft-subject-racer");

    const intendedClient = await registerClient(controller);
    const intendedStarted = await beginAuthorization(controller, intendedClient);
    const intendedState = new URL(intendedStarted.response.headers.get("location")!).searchParams.get("state")!;
    expect((await completeMicrosoft(
      controller,
      intendedState,
      "microsoft-subject-rafael",
      "Rafael",
    )).status).toBe(302);
  });

  it("denies an unknown second Microsoft identity when no invitation or bootstrap is active", async () => {
    const { controller } = makeController();
    await bootstrap(controller, "e8759782-bd54-4e38-a809-82c7b8a99670");
    const firstClient = await registerClient(controller);
    const firstStarted = await beginAuthorization(controller, firstClient);
    const firstState = new URL(firstStarted.response.headers.get("location")!).searchParams.get("state")!;
    expect((await completeMicrosoft(controller, firstState, "microsoft-subject-admin", "Rafael")).status).toBe(302);

    const secondClient = await registerClient(controller);
    const secondStarted = await beginAuthorization(controller, secondClient);
    const secondState = new URL(secondStarted.response.headers.get("location")!).searchParams.get("state")!;
    const denied = await completeMicrosoft(controller, secondState, "microsoft-subject-unknown", "Unknown User");

    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "identity_not_enrolled" });
  });

  it("reprovisions OAuth signing/grants while preserving Microsoft identities and roles", async () => {
    const { controller, storage } = makeController();
    await bootstrap(controller, "6e079f5d-dc1f-4694-a4f2-fc9954165685");
    const clientId = await registerClient(controller);
    const started = await beginAuthorization(controller, clientId);
    const state = new URL(started.response.headers.get("location")!).searchParams.get("state")!;
    const completed = await completeMicrosoft(controller, state, "microsoft-subject-admin", "Rafael");
    const code = new URL(completed.headers.get("location")!).searchParams.get("code")!;
    const tokens = await exchangeCode(controller, clientId, code, started.verifier);

    const identityBefore = JSON.stringify([...storage.values.entries()]
      .filter(([key]) => key.startsWith("update-control:identity:")));

    const operationId = "19f43a91-48b9-48b0-b6e2-0a41244c5f05";
    const reprovision = await controller.fetch(new Request(new URL("/_operations/oauth/reprovision", PUBLIC_URL), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [REPROVISION_MARKER]: INTERNAL_VALUE,
      },
      body: JSON.stringify({ operationId }),
    }));
    expect(reprovision.status).toBe(200);
    expect(await reprovision.json()).toMatchObject({ operationId, status: "completed" });

    const identityAfter = JSON.stringify([...storage.values.entries()]
      .filter(([key]) => key.startsWith("update-control:identity:")));
    expect(identityAfter).toBe(identityBefore);

    const stale = await controller.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + tokens.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }));
    expect(stale.status).toBe(401);
  });
});

async function sha256Base64Url(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
