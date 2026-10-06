import { readFile } from "node:fs/promises";
import { describe, expect, it, jest } from "@jest/globals";
import { fileURLToPath } from "node:url";
import { ORACLE_CHANNEL_CONNECT_PATH, ORACLE_CHANNEL_ORIGIN, ORACLE_CHANNEL_SCOPE } from "../../src/oracle-channel.js";
import updateControlWorker, { type UpdateControlWorkerEnv } from "../../src/worker.js";

const OAUTH_REPROVISION_PATH = "/_operations/oauth/reprovision";
const INTERNAL_AUTH_HEADER = "x-update-control-internal-reprovision-authenticated";
const INTERNAL_AUTH_MARKER = "v1";
const OPERATION_ID = "b795a30e-90d3-4a51-95ed-3c06bbc1e2ad";
const PUBLIC_URL = "https://mcp-update-control.example.test";
const HMAC_KEY = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join("");

function decodeHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function encodeHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedAuthorization(
  method: "GET" | "POST",
  operationId: string,
  key = HMAC_KEY,
): Promise<string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    decodeHex(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonical = [
    "mcp-v3-update-control:oauth-reprovision",
    "v1",
    method,
    OAUTH_REPROVISION_PATH,
    operationId,
    timestamp,
  ].join("\n");
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(canonical),
  ));
  return `HMAC-SHA256 v1=${timestamp}.${encodeHex(signature)}`;
}

function makeWorkerEnv(
  doFetch: (request: Request) => Promise<Response>,
  hmacKey: string | undefined = HMAC_KEY,
): UpdateControlWorkerEnv {
  const authNamespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch: doFetch }),
  };
  const channelNamespace = {
    idFromName: (name: string) => ({ name }),
    get: () => ({ fetch: doFetch }),
  };
  return {
    MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL,
    UPDATE_CONTROL_ADMIN_HMAC_KEY: hmacKey,
    UPDATE_CONTROL_AUTH_STATE: authNamespace,
    UPDATE_CONTROL_ORACLE_CHANNEL: channelNamespace,
  } as unknown as UpdateControlWorkerEnv;
}

function operationRequest(method: "GET" | "POST", authorization?: string, extraHeaders: Record<string, string> = {}) {
  const url = method === "GET"
    ? PUBLIC_URL + OAUTH_REPROVISION_PATH + "?operationId=" + OPERATION_ID
    : PUBLIC_URL + OAUTH_REPROVISION_PATH;
  return new Request(url, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...extraHeaders,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ operationId: OPERATION_ID }) } : {}),
  });
}

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
      new Request(PUBLIC_URL + "/mcp", { method: "POST" }),
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

  it("authenticates a signed GET locally and forwards a read-only status request to the DO", async () => {
    let forwarded: Request | undefined;
    const doFetch = jest.fn(async (request: Request) => {
      forwarded = request;
      return new Response("status", { status: 200 });
    });
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    try {
      const input = operationRequest("GET", await signedAuthorization("GET", OPERATION_ID));
      const response = await updateControlWorker.fetch(input, makeWorkerEnv(doFetch));

      expect(await response.text()).toBe("status");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(doFetch).toHaveBeenCalledTimes(1);
      expect(forwarded?.method).toBe("GET");
      expect(forwarded?.url).toBe(input.url);
      expect(forwarded?.headers.has("authorization")).toBe(false);
      expect(forwarded?.headers.get(INTERNAL_AUTH_HEADER)).toBe(INTERNAL_AUTH_MARKER);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("authenticates a signed POST and preserves the same operation body", async () => {
    let forwarded: Request | undefined;
    const doFetch = jest.fn(async (request: Request) => {
      forwarded = request;
      return new Response("operation", { status: 200 });
    });
    const body = JSON.stringify({ operationId: OPERATION_ID });
    const input = new Request(PUBLIC_URL + OAUTH_REPROVISION_PATH, {
      method: "POST",
      headers: {
        authorization: await signedAuthorization("POST", OPERATION_ID),
        "content-type": "application/json",
      },
      body,
    });
    const response = await updateControlWorker.fetch(input, makeWorkerEnv(doFetch));

    expect(await response.text()).toBe("operation");
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(forwarded?.method).toBe("POST");
    expect(await forwarded?.clone().text()).toBe(body);
    expect(forwarded?.headers.has("authorization")).toBe(false);
    expect(forwarded?.headers.get(INTERNAL_AUTH_HEADER)).toBe(INTERNAL_AUTH_MARKER);
  });

  it("rejects a bearer assertion, a wrong key, and client-spoofed markers before reaching the DO", async () => {
    const doFetch = jest.fn(async () => new Response("must-not-route", { status: 200 }));
    const requests = [
      operationRequest("GET", "Bearer synthetic-github-oidc-token", {
        [INTERNAL_AUTH_HEADER]: INTERNAL_AUTH_MARKER,
      }),
      operationRequest("GET", await signedAuthorization("GET", OPERATION_ID, Array.from({ length: 32 }, (_, index) => (255 - index).toString(16).padStart(2, "0")).join(""))),
      operationRequest("GET", undefined, { [INTERNAL_AUTH_HEADER]: INTERNAL_AUTH_MARKER }),
    ];

    for (const request of requests) {
      const response = await updateControlWorker.fetch(request, makeWorkerEnv(doFetch));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "operation_auth_required" });
    }
    expect(doFetch).not.toHaveBeenCalled();
  });

  it("keeps normal routes on the same DO and strips a client-supplied internal marker", async () => {
    let forwarded: Request | undefined;
    const doFetch = jest.fn(async (request: Request) => {
      forwarded = request;
      return new Response("normal-route", { status: 200 });
    });
    const response = await updateControlWorker.fetch(new Request(PUBLIC_URL + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer normal-client-token",
        [INTERNAL_AUTH_HEADER]: INTERNAL_AUTH_MARKER,
      },
      body: "{}",
    }), makeWorkerEnv(doFetch));

    expect(await response.text()).toBe("normal-route");
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(forwarded?.headers.get("authorization")).toBe("Bearer normal-client-token");
    expect(forwarded?.headers.has(INTERNAL_AUTH_HEADER)).toBe(false);
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
