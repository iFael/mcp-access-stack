import { describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule("cloudflare:workers", () => ({
  DurableObject: class {},
}), { virtual: true });

async function loadEdgeGateway() {
  return (await import("../src/index.js")).default;
}

function createEnv(ownerToken?: string) {
  const migrateSingleUserIdentity = jest.fn(async (_input: unknown) => JSON.stringify({
    status: 200,
    body: {
      status: "migrated",
      user: {
        id: "usr_bd5ee3a9-b231-4062-beb5-b441467cea5b",
        displayName: "Rafael",
        createdAt: "2026-09-26T20:05:35.707Z",
      },
      repositoryCount: 2,
      deviceCount: 1,
      materializationCount: 2,
      disconnectedCompanions: 1,
    },
  }));
  const session = { migrateSingleUserIdentity };
  const env = {
    ...(ownerToken === undefined ? {} : { MCP_OWNER_TOKEN: ownerToken }),
    MCP_SESSION: {
      idFromName: () => ({}) as unknown,
      get: () => session,
    },
  };
  return { env, session };
}

const migration = {
  fromUserId: "usr_54135447-1418-4a47-a300-3720970e4731",
  toUser: {
    id: "usr_bd5ee3a9-b231-4062-beb5-b441467cea5b",
    displayName: "Rafael",
    createdAt: "2026-09-26T20:05:35.707Z",
  },
};

describe("Single-user identity migration route", () => {
  it("requires the technical break-glass credential", async () => {
    const edgeGateway = await loadEdgeGateway();
    const missing = createEnv();
    expect((await edgeGateway.fetch(
      jsonRequest("https://edge.example/_internal/single-user/migrate", migration),
      missing.env as never,
    )).status).toBe(503);
    expect(missing.session.migrateSingleUserIdentity).not.toHaveBeenCalled();

    const configured = createEnv("x".repeat(48));
    expect((await edgeGateway.fetch(
      jsonRequest(
        "https://edge.example/_internal/single-user/migrate",
        migration,
        "Bearer wrong-token",
      ),
      configured.env as never,
    )).status).toBe(401);
    expect(configured.session.migrateSingleUserIdentity).not.toHaveBeenCalled();
  }, 15_000);

  it("passes only the migration payload after break-glass authentication", async () => {
    const edgeGateway = await loadEdgeGateway();
    const ownerToken = "x".repeat(48);
    const { env, session } = createEnv(ownerToken);
    const response = await edgeGateway.fetch(
      jsonRequest(
        "https://edge.example/_internal/single-user/migrate",
        migration,
        `Bearer ${ownerToken}`,
      ),
      env as never,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "migrated",
      user: { id: migration.toUser.id, displayName: "Rafael" },
      repositoryCount: 2,
      deviceCount: 1,
      materializationCount: 2,
    });
    expect(session.migrateSingleUserIdentity).toHaveBeenCalledTimes(1);
    expect(session.migrateSingleUserIdentity).toHaveBeenCalledWith(migration);
  }, 15_000);
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
