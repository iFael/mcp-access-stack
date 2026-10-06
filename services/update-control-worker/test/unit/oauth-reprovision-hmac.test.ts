import { describe, expect, it, jest } from "@jest/globals";
import updateControlWorker, { type UpdateControlWorkerEnv } from "../../src/worker.js";

const PUBLIC_URL = "https://update-control.example/";
const REPROVISION_PATH = "/_operations/oauth/reprovision";
const REPROVISION_URL = new URL(REPROVISION_PATH, PUBLIC_URL).href;
const HMAC_SECRET = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(2, "0")).join("");
const WRONG_HMAC_SECRET = Array.from({ length: 32 }, (_, index) => (255 - index).toString(16).padStart(2, "0")).join("");
const INTERNAL_AUTH_HEADER = "x-update-control-internal-reprovision-authenticated";
const INTERNAL_AUTH_MARKER = "v1";

function decodeHex(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16));
}

function encodeHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedAuthorization(
  method: string,
  operationId: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
  path = REPROVISION_PATH,
  secret = HMAC_SECRET,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    decodeHex(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const canonicalRequest = [
    "mcp-v3-update-control:oauth-reprovision",
    "v1",
    method,
    path,
    operationId,
    timestamp,
  ].join("\n");
  const signature = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalRequest),
  ));
  return "HMAC-SHA256 v1=" + timestamp + "." + encodeHex(signature);
}

function createRequest(
  method: "GET" | "POST",
  operationId: string,
  authorization?: string,
  headers: Record<string, string> = {},
): Request {
  const url = method === "GET"
    ? REPROVISION_URL + "?operationId=" + encodeURIComponent(operationId)
    : REPROVISION_URL;
  return new Request(url, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...headers,
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: JSON.stringify({ operationId }) } : {}),
  });
}

async function dispatch(
  request: Request,
  secret: string | null = HMAC_SECRET,
): Promise<{ response: Response; forwarded: Request[] }> {
  const forwarded: Request[] = [];
  const authState = {
    idFromName: () => "update-control-auth-v1",
    get: () => ({
      fetch: async (internalRequest: Request) => {
        forwarded.push(internalRequest);
        const parsedUrl = new URL(internalRequest.url);
        const operationId = internalRequest.method === "GET"
          ? parsedUrl.searchParams.get("operationId")
          : (await internalRequest.clone().json() as { operationId: string }).operationId;
        return new Response(JSON.stringify({
          operationId,
          status: "not_executed",
          events: [],
        }), {
          status: 200,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      },
    }),
  };
  const env = {
    MCP_UPDATE_CONTROL_PUBLIC_URL: PUBLIC_URL,
    UPDATE_CONTROL_ADMIN_HMAC_KEY: secret === null ? undefined : secret,
    UPDATE_CONTROL_AUTH_STATE: authState,
  } as unknown as UpdateControlWorkerEnv;
  return {
    response: await updateControlWorker.fetch(request, env),
    forwarded,
  };
}

describe("Update Control OAuth reprovision HMAC authorization", () => {
  it("accepts a valid signed GET as a read-only status request without network access", async () => {
    const operationId = "d3492d2d-b9d1-4eaa-bc6d-3c20a06700fb";
    const authorization = await signedAuthorization("GET", operationId);
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    try {
      const { response, forwarded } = await dispatch(createRequest("GET", operationId, authorization));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ operationId, status: "not_executed", events: [] });
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]?.method).toBe("GET");
      expect(forwarded[0]?.headers.get("authorization")).toBeNull();
      expect(forwarded[0]?.headers.get(INTERNAL_AUTH_HEADER)).toBe(INTERNAL_AUTH_MARKER);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("accepts a valid signed POST while preserving the operation ID and request body", async () => {
    const operationId = "b58e6471-822f-4ee4-8b69-2eab1979704b";
    const authorization = await signedAuthorization("POST", operationId);
    const { response, forwarded } = await dispatch(createRequest("POST", operationId, authorization));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ operationId, status: "not_executed" });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.method).toBe("POST");
    expect(await forwarded[0]?.clone().json()).toEqual({ operationId });
    expect(forwarded[0]?.headers.get("authorization")).toBeNull();
    expect(forwarded[0]?.headers.get(INTERNAL_AUTH_HEADER)).toBe(INTERNAL_AUTH_MARKER);
  });

  it("rejects OIDC bearer tokens and client-spoofed internal markers without forwarding", async () => {
    const operationId = "d3492d2d-b9d1-4eaa-bc6d-3c20a06700fb";
    const { response, forwarded } = await dispatch(createRequest(
      "GET",
      operationId,
      "Bearer synthetic-github-oidc-token",
      { [INTERNAL_AUTH_HEADER]: INTERNAL_AUTH_MARKER },
    ));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "operation_auth_required" });
    expect(forwarded).toHaveLength(0);
  });

  it.each([
    ["method", "method"],
    ["fixed path", "path"],
    ["operation ID", "operation"],
    ["timestamp", "timestamp"],
  ])("rejects an HMAC signature not bound to the request %s", async (_label, mutation) => {
    const signedOperationId = "d3492d2d-b9d1-4eaa-bc6d-3c20a06700fb";
    const requestedOperationId = mutation === "operation"
      ? "d3492d2d-b9d1-4eaa-bc6d-3c20a06700fc"
      : signedOperationId;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signedMethod = mutation === "method" ? "GET" : "POST";
    const signedPath = mutation === "path" ? "/_operations/not-reprovision" : REPROVISION_PATH;
    const authorization = await signedAuthorization(
      signedMethod,
      signedOperationId,
      timestamp,
      signedPath,
    );
    const tamperedAuthorization = mutation === "timestamp"
      ? authorization.replace("v1=" + timestamp + ".", "v1=" + String(Number(timestamp) + 1) + ".")
      : authorization;
    const requestedMethod = mutation === "method" ? "POST" : "POST";
    const { response, forwarded } = await dispatch(createRequest(
      requestedMethod,
      requestedOperationId,
      tamperedAuthorization,
    ));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "operation_auth_required" });
    expect(forwarded).toHaveLength(0);
  });

  it.each([
    ["expired", -301],
    ["too far in the future", 301],
  ])("rejects a correctly signed timestamp that is %s", async (_label, offsetSeconds) => {
    const operationId = "d3492d2d-b9d1-4eaa-bc6d-3c20a06700fb";
    const timestamp = String(Math.floor(Date.now() / 1000) + offsetSeconds);
    const authorization = await signedAuthorization("GET", operationId, timestamp);
    const { response, forwarded } = await dispatch(createRequest("GET", operationId, authorization));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "operation_auth_required" });
    expect(forwarded).toHaveLength(0);
  });

  it("rejects a well-formed HMAC signed with the wrong 256-bit key", async () => {
    const operationId = "d3492d2d-b9d1-4eaa-bc6d-3c20a06700fb";
    const authorization = await signedAuthorization(
      "GET",
      operationId,
      undefined,
      REPROVISION_PATH,
      WRONG_HMAC_SECRET,
    );
    const { response, forwarded } = await dispatch(
      createRequest("GET", operationId, authorization),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "operation_auth_required" });
    expect(forwarded).toHaveLength(0);
  });

  it.each([
    ["missing", null],
    ["malformed", "short-secret"],
  ])("fails closed when the dedicated Worker HMAC key is %s", async (_label, secret) => {
    const operationId = "d3492d2d-b9d1-4eaa-bc6d-3c20a06700fb";
    const authorization = await signedAuthorization("GET", operationId);
    const { response, forwarded } = await dispatch(
      createRequest("GET", operationId, authorization),
      secret,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "operation_auth_required" });
    expect(forwarded).toHaveLength(0);
  });

  it("rejects malformed and unsupported authorization formats", async () => {
    const operationId = "d3492d2d-b9d1-4eaa-bc6d-3c20a06700fb";
    for (const authorization of [
      "HMAC-SHA256 v2=1770330000." + "0".repeat(64),
      "HMAC-SHA256 v1=1770330000." + "0".repeat(63),
      "HMAC-SHA256 v1=01770330000." + "0".repeat(64),
      "HMAC-SHA256 v1=1770330000." + "A".repeat(64),
      "HMAC-SHA256 v1=1770330000." + "0".repeat(64) + ", ignored",
    ]) {
      const { response, forwarded } = await dispatch(
        createRequest("GET", operationId, authorization),
      );
      expect(response.status).toBe(401);
      expect(forwarded).toHaveLength(0);
    }
  });
});
