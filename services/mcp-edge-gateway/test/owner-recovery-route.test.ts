import { describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("cloudflare:workers", () => ({
  DurableObject: class {},
}), { virtual: true });

async function loadEdgeGateway() {
  return (await import("../src/index.js")).default;
}

function createEnv(ownerToken?: string) {
  const recoverOwnerAccess = jest.fn(async (_input: unknown) => JSON.stringify({
    status: 200,
    body: {
      status: "recovered",
      userId: "usr_00000000-0000-0000-0000-000000000001",
      displayName: "Rafael",
    },
  }));
  const session = { recoverOwnerAccess };
  const env = {
    ...(ownerToken === undefined ? {} : { MCP_OWNER_TOKEN: ownerToken }),
    MCP_SESSION: {
      idFromName: () => ({}) as unknown,
      get: () => session,
    },
  };
  return { env, session };
}

describe("Owner OAuth recovery route", () => {
  it("requires the technical break-glass credential", async () => {
    const edgeGateway = await loadEdgeGateway();
    const missing = createEnv();
    const missingResponse = await edgeGateway.fetch(
      jsonRequest("https://edge.example/_internal/owner-oauth/recover-access", { password: "new-access-password" }),
      missing.env as never,
    );
    expect(missingResponse.status).toBe(503);
    expect(await missingResponse.json()).toEqual({ error: "owner_recovery_not_configured" });
    expect(missing.session.recoverOwnerAccess).not.toHaveBeenCalled();

    const configured = createEnv("x".repeat(48));
    const deniedResponse = await edgeGateway.fetch(
      jsonRequest(
        "https://edge.example/_internal/owner-oauth/recover-access",
        { password: "new-access-password" },
        "Bearer wrong-token",
      ),
      configured.env as never,
    );
    expect(deniedResponse.status).toBe(401);
    expect(configured.session.recoverOwnerAccess).not.toHaveBeenCalled();
  });

  it("accepts a valid break-glass credential without exposing it to the session", async () => {
    const edgeGateway = await loadEdgeGateway();
    const ownerToken = "x".repeat(48);
    const { env, session } = createEnv(ownerToken);
    const response = await edgeGateway.fetch(
      jsonRequest(
        "https://edge.example/_internal/owner-oauth/recover-access",
        { password: "new-access-password" },
        `Bearer ${ownerToken}`,
      ),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "recovered",
      userId: "usr_00000000-0000-0000-0000-000000000001",
      displayName: "Rafael",
    });
    expect(session.recoverOwnerAccess).toHaveBeenCalledTimes(1);
    expect(session.recoverOwnerAccess).toHaveBeenCalledWith({ password: "new-access-password" });
  });

  it("rejects non-json and malformed recovery bodies before reaching the session", async () => {
    const edgeGateway = await loadEdgeGateway();
    const ownerToken = "x".repeat(48);
    const first = createEnv(ownerToken);
    const wrongType = await edgeGateway.fetch(
      new Request("https://edge.example/_internal/owner-oauth/recover-access", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "text/plain",
        },
        body: "password",
      }),
      first.env as never,
    );
    expect(wrongType.status).toBe(415);
    expect(first.session.recoverOwnerAccess).not.toHaveBeenCalled();

    const second = createEnv(ownerToken);
    const malformed = await edgeGateway.fetch(
      new Request("https://edge.example/_internal/owner-oauth/recover-access", {
        method: "POST",
        headers: {
          authorization: `Bearer ${ownerToken}`,
          "content-type": "application/json",
        },
        body: "{",
      }),
      second.env as never,
    );
    expect(malformed.status).toBe(400);
    expect(second.session.recoverOwnerAccess).not.toHaveBeenCalled();
  });
});

function jsonRequest(url: string, body: unknown, authorization?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization) headers.set("authorization", authorization);
  return new Request(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}
