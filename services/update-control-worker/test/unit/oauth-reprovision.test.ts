import { describe, expect, it } from "@jest/globals";
import {
  EdgeOwnerOAuth,
  type OwnerOAuthStorage,
  type OwnerIdentity,
} from "@mcp-access-stack/mcp-owner-auth";
import { UpdateControlAuthController, type UpdateControlDurableState } from "../../src/auth-state.js";
import { createTestGitHubActionsAssertion, testGitHubActionsJwksFetch } from "./github-actions-oidc-fixture.js";

const PUBLIC_URL = "https://update-control.example/";
const REPROVISION_URL = new URL("/_operations/oauth/reprovision", PUBLIC_URL).href;
const FIRST_OWNER_TOKEN = "first-owner-token-with-more-than-thirty-two-characters";
const SECOND_OWNER_TOKEN = "second-owner-token-with-more-than-thirty-two-characters";
const THIRD_OWNER_TOKEN = "third-owner-token-with-more-than-thirty-two-characters";
const RUN_LEDGER_SENTINEL = "orchestrator:run:sentinel";

class MemoryStorage implements OwnerOAuthStorage {
  readonly values = new Map<string, unknown>();
  failDeleteManyOnce = false;

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
    if (this.failDeleteManyOnce) {
      this.failDeleteManyOnce = false;
      throw new Error("simulated interruption after durable deletion");
    }
    return deleted;
  }
}

function makeController(
  storage: MemoryStorage,
  ownerToken: string,
  fetchImpl: typeof fetch = testGitHubActionsJwksFetch,
) {
  const state: UpdateControlDurableState = { storage };
  const env = {
    MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL,
    MCP_OWNER_TOKEN: ownerToken,
  };
  return new UpdateControlAuthController(state, env, fetchImpl);
}

async function reprovisionRequest(operationId: string): Promise<Request> {
  return new Request(REPROVISION_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ operationId }),
  });
}

async function runReprovision(controller: UpdateControlAuthController, operationId: string): Promise<Response> {
  return controller.fetch(await reprovisionRequest(operationId));
}

async function registerClient(controller: UpdateControlAuthController): Promise<string> {
  const response = await controller.fetch(new Request(new URL("/register", PUBLIC_URL), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "synthetic Update Control client",
      redirect_uris: ["http://localhost:55321/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  }));
  expect(response.status).toBe(201);
  return (await response.json() as { client_id: string }).client_id;
}

async function authorize(
  controller: UpdateControlAuthController,
  clientId: string,
  ownerToken: string,
  verifier: string,
): Promise<{ response: Response; code?: string }> {
  const challengeBytes = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  ));
  const challenge = base64Url(challengeBytes);
  const response = await controller.fetch(new Request(new URL("/authorize", PUBLIC_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "http://localhost:55321/oauth/callback",
      scope: "update:read",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: new URL("/mcp", PUBLIC_URL).href,
      state: "synthetic-state",
      owner_password: ownerToken,
    }),
  }));
  if (response.status !== 302) return { response };
  const callback = new URL(response.headers.get("location")!);
  return { response, code: callback.searchParams.get("code") ?? undefined };
}

async function issueTokens(
  controller: UpdateControlAuthController,
  ownerToken: string,
): Promise<{ clientId: string; code: string; accessToken: string; refreshToken: string }> {
  const clientId = await registerClient(controller);
  const verifier = "v".repeat(64);
  const authorized = await authorize(controller, clientId, ownerToken, verifier);
  expect(authorized.response.status).toBe(302);
  expect(authorized.code).toBeTruthy();
  const response = await controller.fetch(new Request(new URL("/token", PUBLIC_URL), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: authorized.code!,
      redirect_uri: "http://localhost:55321/oauth/callback",
      code_verifier: verifier,
      resource: new URL("/mcp", PUBLIC_URL).href,
    }),
  }));
  expect(response.status).toBe(200);
  const tokens = await response.json() as { access_token: string; refresh_token: string };
  return {
    clientId,
    code: authorized.code!,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
  };
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

describe("controlled Update Control OAuth reprovision", () => {
  it("allows protected status preflight before MCP_OWNER_TOKEN exists, then provisions the first owner", async () => {
    const storage = new MemoryStorage();
    const operationId = "a3a1f91e-4a82-40fd-9f82-6f7fe4d8d0e4";
    const unconfigured = makeController(storage, "");
    const normalMcp = await unconfigured.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list" }),
    }));
    expect(normalMcp.status).toBe(503);

    const status = await unconfigured.fetch(new Request(
      REPROVISION_URL + "?operationId=" + operationId,
      { headers: { authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}` } },
    ));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ operationId, status: "not_executed", events: [] });
    expect(storage.values.size).toBe(0);

    const provisioned = makeController(storage, SECOND_OWNER_TOKEN);
    const completed = await runReprovision(provisioned, operationId);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ operationId, status: "completed" });
    await issueTokens(provisioned, SECOND_OWNER_TOKEN);
  });

  it("exposes bounded verification stage only for read-only diagnostic GETs", async () => {
    const storage = new MemoryStorage();
    const operationId = "c29e6014-5da0-4191-a509-f0e18ab2ff80";
    const controller = makeController(storage, "");
    const invalidAssertion = await createTestGitHubActionsAssertion(operationId, {
      repository: "attacker/mcp-access-stack",
    });
    const url = REPROVISION_URL + "?operationId=" + operationId;

    const normal = await controller.fetch(new Request(url, {
      headers: { authorization: `Bearer ${invalidAssertion}` },
    }));
    expect(normal.status).toBe(401);
    expect(await normal.json()).toEqual({ error: "operation_auth_required" });

    const diagnostic = await controller.fetch(new Request(url, {
      headers: {
        authorization: `Bearer ${invalidAssertion}`,
        "x-update-control-oidc-diagnose": "v1",
      },
    }));
    expect(diagnostic.status).toBe(401);
    expect(await diagnostic.json()).toEqual({
      error: "operation_auth_required",
      diagnosticStage: "claims",
    });

    const post = await controller.fetch(new Request(REPROVISION_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${invalidAssertion}`,
        "content-type": "application/json",
        "x-update-control-oidc-diagnose": "v1",
      },
      body: JSON.stringify({ operationId }),
    }));
    expect(post.status).toBe(401);
    expect(await post.json()).toEqual({ error: "operation_auth_required" });
  });

  it("returns a fetch rejection class only on the opt-in GET and never on POST", async () => {
    const storage = new MemoryStorage();
    const operationId = "6f7fcf36-00f5-4d98-bf66-55c1d9dfd465";
    const assertion = await createTestGitHubActionsAssertion(operationId);
    const fetchImpl = (async () => {
      throw new TypeError("unsafe fetch detail");
    }) as typeof fetch;
    const controller = makeController(storage, "", fetchImpl);
    const url = REPROVISION_URL + "?operationId=" + operationId;

    const normal = await controller.fetch(new Request(url, {
      headers: { authorization: `Bearer ${assertion}` },
    }));
    expect(await normal.json()).toEqual({ error: "operation_auth_required" });

    const diagnostic = await controller.fetch(new Request(url, {
      headers: {
        authorization: `Bearer ${assertion}`,
        "x-update-control-oidc-diagnose": "v1",
      },
    }));
    const diagnosticBody = await diagnostic.json();
    expect(diagnosticBody).toEqual({
      error: "operation_auth_required",
      diagnosticStage: "jwks_fetch",
      diagnosticFailureCategory: "fetch_rejected",
      diagnosticRejectionClass: "type_error",
    });
    expect(JSON.stringify(diagnosticBody)).not.toContain("unsafe fetch detail");
    expect(JSON.stringify(diagnosticBody)).not.toContain("TypeError");

    const post = await controller.fetch(new Request(REPROVISION_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${assertion}`,
        "content-type": "application/json",
        "x-update-control-oidc-diagnose": "v1",
      },
      body: JSON.stringify({ operationId }),
    }));
    expect(await post.json()).toEqual({ error: "operation_auth_required" });
  });

  it("invalidates OAuth state, rotates authority, preserves non-OAuth state, and is idempotent", async () => {
    const storage = new MemoryStorage();
    const initialController = makeController(storage, FIRST_OWNER_TOKEN);
    const firstOperationId = "7b4f734f-a459-4bf9-8eec-dbe0de7e35cf";
    const initial = await runReprovision(initialController, firstOperationId);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ operationId: firstOperationId, status: "completed" });

    const oldTokens = await issueTokens(initialController, FIRST_OWNER_TOKEN);
    const pending = await authorize(initialController, oldTokens.clientId, FIRST_OWNER_TOKEN, "p".repeat(64));
    expect(pending.response.status).toBe(302);
    expect(pending.code).toBeTruthy();
    storage.values.set(RUN_LEDGER_SENTINEL, { status: "active", runId: "synthetic-run" });
    storage.values.set("future:non-oauth-state", { keep: true });

    const rotatedController = makeController(storage, SECOND_OWNER_TOKEN);
    const blockedDuringSecretMismatch = await rotatedController.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + oldTokens.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(blockedDuringSecretMismatch.status).toBe(503);

    const operationId = "087aed0a-53ec-42ad-9e73-d005aa2de61e";
    const unauthenticated = await rotatedController.fetch(new Request(REPROVISION_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operationId }),
    }));
    expect(unauthenticated.status).toBe(401);

    const completed = await runReprovision(rotatedController, operationId);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ operationId, status: "completed" });

    const oauthKeysAfterReset = [...storage.values.keys()].filter((key) =>
      key.startsWith("owner:") || key === "update-control:owner-identity:v1");
    expect(oauthKeysAfterReset.sort()).toEqual([
      "owner:credential-material:v1",
      "owner:user-id:v1",
      "update-control:owner-identity:v1",
    ]);
    expect(storage.values.get(RUN_LEDGER_SENTINEL)).toEqual({ status: "active", runId: "synthetic-run" });
    expect(storage.values.get("future:non-oauth-state")).toEqual({ keep: true });

    const oldAccess = await rotatedController.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + oldTokens.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }));
    expect(oldAccess.status).toBe(401);

    const oldRefresh = await rotatedController.fetch(new Request(new URL("/token", PUBLIC_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: oldTokens.clientId,
        refresh_token: oldTokens.refreshToken,
      }),
    }));
    expect(oldRefresh.status).toBe(400);
    expect(await oldRefresh.json()).toMatchObject({ error: "invalid_client" });

    const oldCode = await rotatedController.fetch(new Request(new URL("/token", PUBLIC_URL), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: oldTokens.clientId,
        code: pending.code!,
        redirect_uri: "http://localhost:55321/oauth/callback",
        code_verifier: "p".repeat(64),
        resource: new URL("/mcp", PUBLIC_URL).href,
      }),
    }));
    expect(oldCode.status).toBe(400);
    expect(await oldCode.json()).toMatchObject({ error: "invalid_client" });

    const newTokens = await issueTokens(rotatedController, SECOND_OWNER_TOKEN);
    const newAccess = await rotatedController.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + newTokens.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    }));
    expect(newAccess.status).toBe(200);

    const newClientId = await registerClient(rotatedController);
    const oldOwnerPassword = await authorize(
      rotatedController,
      newClientId,
      FIRST_OWNER_TOKEN,
      "o".repeat(64),
    );
    expect(oldOwnerPassword.response.status).toBe(401);
    const newOwnerPassword = await authorize(
      rotatedController,
      newClientId,
      SECOND_OWNER_TOKEN,
      "n".repeat(64),
    );
    expect(newOwnerPassword.response.status).toBe(302);

    const beforeReplay = storage.values.size;
    const replay = await runReprovision(rotatedController, operationId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ operationId, status: "completed" });
    expect(storage.values.size).toBe(beforeReplay);

    const auditJson = JSON.stringify([...storage.values.entries()]
      .filter(([key]) => key.startsWith("update-control:oauth-reprovision:v1:")));
    expect(auditJson).not.toContain(FIRST_OWNER_TOKEN);
    expect(auditJson).not.toContain(SECOND_OWNER_TOKEN);
    expect(auditJson).not.toContain(oldTokens.accessToken);
    expect(auditJson).not.toContain(oldTokens.refreshToken);
  });

  it("repairs completion audit after a crash between durable operation and active markers", async () => {
    const storage = new MemoryStorage();
    const controller = makeController(storage, FIRST_OWNER_TOKEN);
    const operationId = "05a67010-1800-4a03-8c16-31054f39bcf2";
    const completed = await runReprovision(controller, operationId);
    expect(completed.status).toBe(200);

    const completionEventKey = `update-control:oauth-reprovision:v1:event:${operationId}:000001:completed`;
    storage.values.delete(completionEventKey);
    storage.values.set("update-control:oauth-reprovision:v1:active", {
      operationId,
      status: "in_progress",
      updatedAt: new Date().toISOString(),
    });

    const replay = await runReprovision(controller, operationId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ operationId, status: "completed" });
    expect(storage.values.has(completionEventKey)).toBe(true);
    expect(await storage.get<{ status: string }>("update-control:oauth-reprovision:v1:active"))
      .toMatchObject({ operationId, status: "completed" });
  });

  it("keeps normal OAuth blocked after interruption, then reconciles the same operation id safely", async () => {
    const storage = new MemoryStorage();
    const firstController = makeController(storage, FIRST_OWNER_TOKEN);
    await runReprovision(firstController, "25720dc0-bd34-47a5-a2dd-dd18ce0d6e97");
    const priorTokens = await issueTokens(firstController, FIRST_OWNER_TOKEN);

    const nextController = makeController(storage, SECOND_OWNER_TOKEN);
    storage.failDeleteManyOnce = true;
    const operationId = "97f45c65-c207-4eac-b3a0-d293574aec26";
    const interrupted = await runReprovision(nextController, operationId);
    expect(interrupted.status).toBe(503);
    expect(await interrupted.json()).toMatchObject({ operationId, status: "outcome_unknown" });

    const blocked = await nextController.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + priorTokens.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    }));
    expect(blocked.status).toBe(503);

    const status = await nextController.fetch(new Request(
      REPROVISION_URL + "?operationId=" + operationId,
      { headers: { authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}` } },
    ));
    expect(await status.json()).toMatchObject({ operationId, status: "outcome_unknown" });

    const competingOperationId = "d94bad79-6370-4fe6-b793-a872e3720c16";
    const competingStatus = await nextController.fetch(new Request(
      REPROVISION_URL + "?operationId=" + competingOperationId,
      { headers: { authorization: `Bearer ${await createTestGitHubActionsAssertion(competingOperationId)}` } },
    ));
    const competingBody = await competingStatus.json();
    expect(competingStatus.status).toBe(409);
    expect(competingBody).toMatchObject({
      operationId: competingOperationId,
      status: "outcome_unknown",
      error: "another_operation_active",
    });
    expect(JSON.stringify(competingBody)).not.toContain(operationId);

    const reconciled = await runReprovision(nextController, operationId);
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ operationId, status: "completed", attempt: 2 });

    const after = await nextController.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + priorTokens.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
    }));
    expect(after.status).toBe(401);

    const rollbackController = makeController(storage, FIRST_OWNER_TOKEN);
    const rollbackBlocked = await rollbackController.fetch(new Request(new URL("/mcp", PUBLIC_URL), {
      method: "POST",
      headers: {
        authorization: "Bearer " + priorTokens.accessToken,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }),
    }));
    expect(rollbackBlocked.status).toBe(503);

    const rollbackOAuth = new EdgeOwnerOAuth(storage, {
      ownerSecret: FIRST_OWNER_TOKEN,
      publicBaseUrl: new URL(PUBLIC_URL),
      mcpPath: "/mcp",
      scopes: ["update:read"],
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      resourceName: "MCP V3 Update Center",
    }, {
      async getUser(userId) {
        const owner = await storage.get<OwnerIdentity>("update-control:owner-identity:v1");
        return owner?.id === userId ? owner : null;
      },
      async listUsers() {
        const owner = await storage.get<OwnerIdentity>("update-control:owner-identity:v1");
        return owner ? [owner] : [];
      },
    });
    await expect(rollbackOAuth.authenticate(new Request(new URL("/mcp", PUBLIC_URL), {
      headers: { authorization: "Bearer " + priorTokens.accessToken },
    }))).rejects.toMatchObject({ status: 401 });

    const state = await storage.get<{ status: string }>("update-control:oauth-reprovision:v1:active");
    expect(state?.status).toBe("completed");
    expect([...storage.values.keys()].some((key) => key.startsWith("owner:client:"))).toBe(false);
    const allStoredValues = JSON.stringify([...storage.values.entries()]);
    expect(allStoredValues).not.toContain(FIRST_OWNER_TOKEN);
    expect(allStoredValues).not.toContain(SECOND_OWNER_TOKEN);
  });

  it("restricts OAuth reprovision to the same-origin fixed path and rejects generic admin paths", async () => {
    const storage = new MemoryStorage();
    const controller = makeController(storage, FIRST_OWNER_TOKEN);
    const operationId = "ef3f96d6-61e3-4d4e-a96c-7c4f4cda39a1";
    const status = await controller.fetch(new Request(REPROVISION_URL + "?operationId=" + operationId, {
      headers: { authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}` },
    }));
    expect(await status.json()).toMatchObject({ operationId, status: "not_executed", events: [] });

    const wrongHost = await controller.fetch(new Request(
      "https://wrong-update-control.example/_operations/oauth/reprovision",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationId }),
      },
    ));
    expect(wrongHost.status).toBe(404);
    expect(storage.values.size).toBe(0);

    const wrongHttpOrigin = await controller.fetch(new Request(
      "http://update-control.example/_operations/oauth/reprovision",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationId }),
      },
    ));
    expect(wrongHttpOrigin.status).toBe(404);
    expect(storage.values.size).toBe(0);

    const wrongPath = await controller.fetch(new Request(
      "https://update-control.example/_operations/oauth/reprovision/extra",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationId }),
      },
    ));
    expect(wrongPath.status).toBe(404);
    expect(storage.values.size).toBe(0);

    const unexpectedGetQuery = await controller.fetch(new Request(
      REPROVISION_URL + "?operationId=" + operationId + "&unexpected=1",
      { headers: { authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}` } },
    ));
    expect(unexpectedGetQuery.status).toBe(400);
    expect(storage.values.size).toBe(0);

    const unexpectedPostQuery = await controller.fetch(new Request(REPROVISION_URL + "?unexpected=1", {
      method: "POST",
      headers: {
        authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operationId }),
    }));
    expect(unexpectedPostQuery.status).toBe(405);
    expect(storage.values.size).toBe(0);

    await runReprovision(controller, operationId);
    const beforeGenericRoute = JSON.stringify([...storage.values.entries()]);
    const genericAdmin = await controller.fetch(new Request(
      "https://update-control.example/_operations/admin/reset",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${await createTestGitHubActionsAssertion(operationId)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ operationId }),
      },
    ));
    expect(genericAdmin.status).toBe(404);
    expect(JSON.stringify([...storage.values.entries()])).toBe(beforeGenericRoute);
  });

  it("rejects a valid OIDC token when the request names a different operation UUID", async () => {
    const storage = new MemoryStorage();
    const controller = makeController(storage, FIRST_OWNER_TOKEN);
    const audienceOperationId = "3bfb5fd8-45c6-4293-862b-879c4b1d0915";
    const requestOperationId = "b47e245e-ec36-4932-aa97-15ddef3bb5fa";
    const response = await controller.fetch(new Request(REPROVISION_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await createTestGitHubActionsAssertion(audienceOperationId)}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ operationId: requestOperationId }),
    }));
    expect(response.status).toBe(401);
    expect(storage.values.size).toBe(0);
  });
});
