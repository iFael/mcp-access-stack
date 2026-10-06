import { readFile } from "node:fs/promises";
import { describe, expect, it, jest } from "@jest/globals";
import { fileURLToPath } from "node:url";
import { ORACLE_CHANNEL_CONNECT_PATH, ORACLE_CHANNEL_ORIGIN, ORACLE_CHANNEL_SCOPE } from "../../src/oracle-channel.js";
import updateControlWorker, { type UpdateControlWorkerEnv } from "../../src/worker.js";
import { createTestGitHubActionsAssertion, testGitHubActionsJwksFetch } from "./github-actions-oidc-fixture.js";

const OAUTH_REPROVISION_PATH = "/_operations/oauth/reprovision";
const INTERNAL_OIDC_HEADER = "x-update-control-internal-oidc-verified";
const INTERNAL_OIDC_MARKER = "v1";
const WORKER_OPERATION_ID = "b795a30e-90d3-4a51-95ed-3c06bbc1e2ad";
const WORKER_PUBLIC_URL = "https://mcp-update-control.example.test";

function makeWorkerEnv(doFetch: (request: Request) => Promise<Response>): UpdateControlWorkerEnv {
  const authNamespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch: doFetch }),
  };
  const channelNamespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch: doFetch }),
  };
  return {
    MCP_UPDATE_CONTROL_PUBLIC_URL: WORKER_PUBLIC_URL,
    UPDATE_CONTROL_AUTH_STATE: authNamespace,
    UPDATE_CONTROL_ORACLE_CHANNEL: channelNamespace,
  } as unknown as UpdateControlWorkerEnv;
}

const invalidTopLevelOidcClaims: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["issuer", { iss: "https://github.com" }],
  ["audience", { aud: "urn:mcp-v3-update-control:oauth-reprovision:other" }],
  ["repository", { repository: "attacker/mcp-access-stack" }],
  ["immutable subject", { sub: "repo:iFael/mcp-access-stack:environment:update-control-production" }],
  ["repository owner id", { repository_owner_id: "999999999" }],
  ["repository id", { repository_id: "999999999" }],
  ["workflow ref", { workflow_ref: "iFael/mcp-access-stack/.github/workflows/other.yml@refs/heads/main" }],
  ["ref", { ref: "refs/heads/feature" }],
  ["event", { event_name: "pull_request" }],
  ["environment", { environment: "other-environment" }],
  ["expired token", { exp: Math.floor(Date.now() / 1000) - 1 }],
  ["future nbf", { nbf: Math.floor(Date.now() / 1000) + 60 }],
  ["stale iat", { iat: Math.floor(Date.now() / 1000) - 601 }],
];



describe("Update Control Worker independent deployment", () => {
  it("routes MCP traffic only to its own authorization/session DO", async () => {
    const doResponse = new Response("independent-worker", { status: 200 });
    const doFetch = jest.fn(async () => doResponse);
    const requestedIds: string[] = [];
    const env = {
      UPDATE_CONTROL_AUTH_STATE: {
        idFromName: (name: string) => {
          requestedIds.push(name);
          return { id: name };
        },
        get: (id: { id: string }) => {
          requestedIds.push(id.id);
          return { fetch: doFetch };
        },
      },
    } as unknown as UpdateControlWorkerEnv;

    const response = await updateControlWorker.fetch(
      new Request("https://mcp-update-control.example.test/mcp", { method: "POST" }),
      env,
    );

    expect(await response.text()).toBe("independent-worker");
    expect(requestedIds).toEqual(["update-control-auth-v1", "update-control-auth-v1"]);
    expect(doFetch).toHaveBeenCalledTimes(1);
  });

  it("routes only the fixed Oracle WSS path to the separate transport DO", async () => {
    const authFetch = jest.fn(async () => new Response("auth"));
    const channelFetch = jest.fn(async () => new Response("channel"));
    const authIds: string[] = [];
    const channelIds: string[] = [];
    const env = {
      UPDATE_CONTROL_AUTH_STATE: {
        idFromName: (name: string) => {
          authIds.push(name);
          return { id: name };
        },
        get: () => ({ fetch: authFetch }),
      },
      UPDATE_CONTROL_ORACLE_CHANNEL: {
        idFromName: (name: string) => {
          channelIds.push(name);
          return { id: name };
        },
        get: (id: { id: string }) => {
          channelIds.push(id.id);
          return { fetch: channelFetch };
        },
      },
    } as unknown as UpdateControlWorkerEnv;

    const handshake = await updateControlWorker.fetch(
      new Request("https://mcp-v3-update-control.workers.dev" + ORACLE_CHANNEL_CONNECT_PATH, {
        method: "GET",
        headers: {
          upgrade: "websocket",
          origin: ORACLE_CHANNEL_ORIGIN,
          authorization: "Bearer test-oracle-channel-token",
        },
      }),
      env,
    );
    expect(await handshake.text()).toBe("channel");
    expect(channelIds).toEqual([ORACLE_CHANNEL_SCOPE, ORACLE_CHANNEL_SCOPE]);
    expect(authIds).toEqual([]);
    expect(authFetch).not.toHaveBeenCalled();

    const internalRpcPathIsNotRoutedPublicly = await updateControlWorker.fetch(
      new Request("https://mcp-v3-update-control.workers.dev/_internal/rpc", { method: "POST" }),
      env,
    );
    expect(await internalRpcPathIsNotRoutedPublicly.text()).toBe("auth");
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(channelFetch).toHaveBeenCalledTimes(1);
  });

  it("verifies a valid GET assertion at the top level and forwards it once to the DO", async () => {
    const doResponse = new Response("do-status", { status: 200 });
    let forwarded: Request | undefined;
    const doFetch = jest.fn(async (request: Request) => {
      forwarded = request;
      return doResponse;
    });
    const env = makeWorkerEnv(doFetch);
    const token = await createTestGitHubActionsAssertion(WORKER_OPERATION_ID);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(testGitHubActionsJwksFetch);
    try {
      const input = new Request(
        WORKER_PUBLIC_URL + OAUTH_REPROVISION_PATH + "?operationId=" + WORKER_OPERATION_ID,
        { headers: { authorization: "Bearer " + token } },
      );
      const response = await updateControlWorker.fetch(input, env);

      expect(await response.text()).toBe("do-status");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(doFetch).toHaveBeenCalledTimes(1);
      expect(forwarded).toBeDefined();
      expect(forwarded!.headers.get(INTERNAL_OIDC_HEADER)).toBe(INTERNAL_OIDC_MARKER);
      expect(forwarded!.headers.has("authorization")).toBe(false);
      expect(forwarded!.url).toBe(input.url);
      expect(forwarded!.method).toBe("GET");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("verifies a valid POST assertion at the top level and forwards the same operation body", async () => {
    const doResponse = new Response("do-status", { status: 200 });
    let forwarded: Request | undefined;
    const doFetch = jest.fn(async (request: Request) => {
      forwarded = request;
      return doResponse;
    });
    const env = makeWorkerEnv(doFetch);
    const token = await createTestGitHubActionsAssertion(WORKER_OPERATION_ID);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(testGitHubActionsJwksFetch);
    try {
      const body = JSON.stringify({ operationId: WORKER_OPERATION_ID });
      const input = new Request(WORKER_PUBLIC_URL + OAUTH_REPROVISION_PATH, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body,
      });
      const response = await updateControlWorker.fetch(input, env);

      expect(await response.text()).toBe("do-status");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(doFetch).toHaveBeenCalledTimes(1);
      expect(forwarded).toBeDefined();
      expect(forwarded!.headers.get(INTERNAL_OIDC_HEADER)).toBe(INTERNAL_OIDC_MARKER);
      expect(forwarded!.headers.has("authorization")).toBe(false);
      expect(forwarded!.method).toBe("POST");
      expect(await forwarded!.text()).toBe(body);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects invalid OIDC at the top level without calling the DO", async () => {
    const doFetch = jest.fn(async () => new Response(JSON.stringify({ error: "must-not-route" }), { status: 200 }));
    const env = makeWorkerEnv(doFetch);
    const token = await createTestGitHubActionsAssertion(WORKER_OPERATION_ID, {
      repository_id: "999999999",
    });
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(testGitHubActionsJwksFetch);
    try {
      const response = await updateControlWorker.fetch(new Request(
        WORKER_PUBLIC_URL + OAUTH_REPROVISION_PATH + "?operationId=" + WORKER_OPERATION_ID,
        { headers: { authorization: "Bearer " + token } },
      ), env);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "operation_auth_required" });
      expect(doFetch).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each(invalidTopLevelOidcClaims)(
    "keeps the %s OIDC guard at the top-level trust boundary",
    async (_label, claims) => {
      const doFetch = jest.fn(async () => new Response(JSON.stringify({ error: "must-not-route" }), { status: 200 }));
      const env = makeWorkerEnv(doFetch);
      const token = await createTestGitHubActionsAssertion(WORKER_OPERATION_ID, claims);
      const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(testGitHubActionsJwksFetch);
      try {
        const response = await updateControlWorker.fetch(new Request(
          WORKER_PUBLIC_URL + OAUTH_REPROVISION_PATH + "?operationId=" + WORKER_OPERATION_ID,
          { headers: { authorization: "Bearer " + token } },
        ), env);

        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "operation_auth_required" });
        expect(doFetch).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    },
  );

  it("rejects an invalid OIDC signature before calling the DO", async () => {
    const doFetch = jest.fn(async () => new Response(JSON.stringify({ error: "must-not-route" }), { status: 200 }));
    const env = makeWorkerEnv(doFetch);
    const tokenParts = (await createTestGitHubActionsAssertion(WORKER_OPERATION_ID)).split(".");
    tokenParts[2] = "A".repeat(tokenParts[2]!.length);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(testGitHubActionsJwksFetch);
    try {
      const response = await updateControlWorker.fetch(new Request(
        WORKER_PUBLIC_URL + OAUTH_REPROVISION_PATH + "?operationId=" + WORKER_OPERATION_ID,
        { headers: { authorization: "Bearer " + tokenParts.join(".") } },
      ), env);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "operation_auth_required" });
      expect(doFetch).not.toHaveBeenCalled();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("removes a client-spoofed internal marker and refuses it without valid OIDC", async () => {
    const doFetch = jest.fn(async () => new Response(JSON.stringify({ error: "must-not-route" }), { status: 200 }));
    const env = makeWorkerEnv(doFetch);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(testGitHubActionsJwksFetch);
    try {
      const response = await updateControlWorker.fetch(new Request(
        WORKER_PUBLIC_URL + OAUTH_REPROVISION_PATH + "?operationId=" + WORKER_OPERATION_ID,
        { headers: { [INTERNAL_OIDC_HEADER]: INTERNAL_OIDC_MARKER } },
      ), env);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "operation_auth_required" });
      expect(doFetch).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps a normal route on the same DO and strips a client-supplied internal marker", async () => {
    let forwarded: Request | undefined;
    const doFetch = jest.fn(async (request: Request) => {
      forwarded = request;
      return new Response("normal-route", { status: 200 });
    });
    const env = makeWorkerEnv(doFetch);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(testGitHubActionsJwksFetch);

    try {
      const response = await updateControlWorker.fetch(new Request(WORKER_PUBLIC_URL + "/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer normal-client-token",
          [INTERNAL_OIDC_HEADER]: INTERNAL_OIDC_MARKER,
        },
        body: "{}",
      }), env);

      expect(await response.text()).toBe("normal-route");
      expect(doFetch).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(forwarded).toBeDefined();
      expect(forwarded!.headers.get("authorization")).toBe("Bearer normal-client-token");
      expect(forwarded!.headers.has(INTERNAL_OIDC_HEADER)).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns only the sanitized allowlisted fields for an opt-in diagnostic GET", async () => {
    const doFetch = jest.fn(async () => new Response(JSON.stringify({ error: "must-not-route" }), { status: 200 }));
    const env = makeWorkerEnv(doFetch);
    const rawMessage = "unsafe fetch detail sentinel";
    const rawStack = "unsafe stack sentinel";
    const rawCause = "unsafe cause sentinel";
    const rejected = new TypeError(rawMessage);
    rejected.stack = rawStack;
    Object.defineProperty(rejected, "cause", { value: rawCause });
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw rejected;
    });
    try {
      const token = await createTestGitHubActionsAssertion(WORKER_OPERATION_ID);
      const response = await updateControlWorker.fetch(new Request(
        WORKER_PUBLIC_URL + OAUTH_REPROVISION_PATH + "?operationId=" + WORKER_OPERATION_ID,
        {
          headers: {
            authorization: "Bearer " + token,
            "x-update-control-oidc-diagnose": "v1",
          },
        },
      ), env);
      const body = await response.json();

      expect(response.status).toBe(401);
      expect(body).toEqual({
        error: "operation_auth_required",
        diagnosticStage: "jwks_fetch",
        diagnosticFailureCategory: "fetch_rejected",
        diagnosticRejectionClass: "type_error",
        diagnosticTypeErrorReason: "unknown_type_error",
      });
      expect(JSON.stringify(body)).not.toContain(rawMessage);
      expect(JSON.stringify(body)).not.toContain(rawStack);
      expect(JSON.stringify(body)).not.toContain(rawCause);
      expect(doFetch).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("keeps normal GET and POST auth failures free of internal diagnostics", async () => {
    const doFetch = jest.fn(async () => new Response(JSON.stringify({ error: "must-not-route" }), { status: 200 }));
    const env = makeWorkerEnv(doFetch);
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new TypeError("untrusted raw fetch detail");
    });
    try {
      const token = await createTestGitHubActionsAssertion(WORKER_OPERATION_ID);
      const normalGet = await updateControlWorker.fetch(new Request(
        WORKER_PUBLIC_URL + OAUTH_REPROVISION_PATH + "?operationId=" + WORKER_OPERATION_ID,
        { headers: { authorization: "Bearer " + token } },
      ), env);
      expect(normalGet.status).toBe(401);
      expect(await normalGet.json()).toEqual({ error: "operation_auth_required" });

      const post = await updateControlWorker.fetch(new Request(
        WORKER_PUBLIC_URL + OAUTH_REPROVISION_PATH,
        {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
            "x-update-control-oidc-diagnose": "v1",
          },
          body: JSON.stringify({ operationId: WORKER_OPERATION_ID }),
        },
      ), env);
      expect(post.status).toBe(401);
      expect(await post.json()).toEqual({ error: "operation_auth_required" });
      expect(doFetch).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("deploys as a separate Worker with no Edge service binding or shared workflow storage", async () => {
    const configPath = fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url));
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      name: string;
      compatibility_date: string;
      workers_dev: boolean;
      preview_urls: boolean;
      durable_objects: { bindings: Array<{ name: string; class_name: string; script_name?: string }> };
      services?: unknown;
      migrations: Array<{ tag: string; new_sqlite_classes?: string[] }>;
      vars?: Record<string, string>;
    };

    expect(config.name).toBe("mcp-v3-update-control");
    expect(config.name).not.toBe("mcp-access-stack");
    expect(config.compatibility_date).toBe("2026-08-17");
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.services).toBeUndefined();
    expect(config.durable_objects.bindings).toEqual([
      { name: "UPDATE_CONTROL_AUTH_STATE", class_name: "UpdateControlAuthState" },
      { name: "UPDATE_CONTROL_ORACLE_CHANNEL", class_name: "UpdateControlOracleChannel" },
    ]);
    expect(config.migrations).toEqual([
      { tag: "v1", new_sqlite_classes: ["UpdateControlAuthState"] },
      { tag: "v2", new_sqlite_classes: ["UpdateControlOracleChannel"] },
    ]);
    expect(config.vars).toBeUndefined();
    expect(await readFile(configPath, "utf8")).not.toContain(".workers.dev");
  });
});
