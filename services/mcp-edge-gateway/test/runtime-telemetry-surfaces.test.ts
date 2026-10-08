import { describe, expect, it, jest } from "@jest/globals";
import { createEdgeHealthStatus } from "../src/health.js";
import { EXPECTED_MCP_CONTRACT_REVISION } from "../src/contract-compatibility.js";
import type { EdgeRuntimeTelemetryV1 } from "../src/connector-telemetry.js";

jest.unstable_mockModule("cloudflare:workers", () => ({
  DurableObject: class {},
}), { virtual: true });

const runtimeTelemetry = {
  version: 1,
  connectorInstanceId: "11111111-1111-4111-8111-111111111111",
  connectionGeneration: 7,
  processStartedAt: "2026-09-02T12:00:00.000Z",
  catalogContractRevision: "a".repeat(64),
  toolSetRevision: "b".repeat(64),
  toolCount: 61,
  serverVersion: "1.1.0-beta.24-catalog.test",
  nodePid: 1234,
  hostPid: 4321,
  readySince: "2026-09-02T12:00:01.000Z",
  lastDisconnectedAt: "2026-09-02T11:59:59.000Z",
  lastRequestAt: "2026-09-02T12:00:02.000Z",
  lastSuccessfulRequestAt: "2026-09-02T12:00:03.000Z",
  lastRequestId: "request-secret-correlation-id",
  readyCount: 3,
  disconnectCount: 2,
  relayedRequestCount: 11,
  successfulResponseCount: 10,
} satisfies EdgeRuntimeTelemetryV1;

describe("runtime telemetry surfaces", () => {
  it("projects safe runtime identity on public health without PIDs or request IDs", () => {
    const result = createEdgeHealthStatus(true, {
      controlPlaneReady: true,
      executionPlaneReady: true,
      connectorReady: true,
      runtimeTelemetry,
    });

    expect(result.body).toMatchObject({
      runtime: {
        connectorInstanceId: runtimeTelemetry.connectorInstanceId,
        connectionGeneration: runtimeTelemetry.connectionGeneration,
        catalogContractRevision: runtimeTelemetry.catalogContractRevision,
        toolSetRevision: runtimeTelemetry.toolSetRevision,
        toolCount: runtimeTelemetry.toolCount,
        serverVersion: runtimeTelemetry.serverVersion,
        readySince: runtimeTelemetry.readySince,
        lastRequestAt: runtimeTelemetry.lastRequestAt,
        lastSuccessfulRequestAt: runtimeTelemetry.lastSuccessfulRequestAt,
        readyCount: runtimeTelemetry.readyCount,
        disconnectCount: runtimeTelemetry.disconnectCount,
      },
    });
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain("nodePid");
    expect(serialized).not.toContain("hostPid");
    expect(serialized).not.toContain("lastRequestId");
    expect(serialized).not.toContain("processStartedAt");
    expect(serialized).not.toContain("relayedRequestCount");
    expect(serialized).not.toContain("successfulResponseCount");
  });

  it("keeps detailed runtime telemetry behind connector-token authentication", async () => {
    const { default: edgeWorker } = await import("../src/index.js");
    const session = {
      getSessionDiagnostics: async () => JSON.stringify({
        version: 1,
        events: [{ version: 1, atMs: 1, route: "/mcp", httpMethod: "POST", status: 401 }],
      }),
      getRuntimeTelemetry: async () => runtimeTelemetry,
    };
    const env = {
      MCP_CONNECTOR_TOKEN: "connector-token-fixture",
      MCP_SESSION: {
        idFromName: () => ({ toString: () => "session-id" }),
        get: () => session,
      },
    } as never;

    const unauthorized = await edgeWorker.fetch(
      new Request("https://edge.example/_internal/session-diagnostics"),
      env,
      {} as ExecutionContext,
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await edgeWorker.fetch(
      new Request("https://edge.example/_internal/session-diagnostics", {
        headers: { authorization: "Bearer connector-token-fixture" },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      version: 1,
      events: [{ version: 1, atMs: 1, route: "/mcp", httpMethod: "POST", status: 401 }],
      runtimeTelemetry,
    });
  });

  it("requires connector-token authentication for contract promotion", async () => {
    const { default: edgeWorker } = await import("../src/index.js");
    const candidateRevision = "c".repeat(64);
    const activeRevision = "a".repeat(64);
    let received: unknown;
    const session = {
      promoteContractRollout: async (input: unknown) => {
        received = input;
        return JSON.stringify({
          status: 200,
          body: { status: "promoted", activeContractRevision: candidateRevision },
        });
      },
    };
    const env = {
      MCP_CONNECTOR_TOKEN: "connector-token-fixture",
      MCP_SESSION: {
        idFromName: () => ({ toString: () => "session-id" }),
        get: () => session,
      },
    } as never;
    const body = {
      expectedActiveContractRevision: activeRevision,
      expectedCandidateContractRevision: candidateRevision,
    };

    const unauthorized = await edgeWorker.fetch(
      new Request("https://edge.example/_internal/contract-rollout/promote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await edgeWorker.fetch(
      new Request("https://edge.example/_internal/contract-rollout/promote", {
        method: "POST",
        headers: {
          authorization: "Bearer connector-token-fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      status: "promoted",
      activeContractRevision: candidateRevision,
    });
    expect(received).toEqual(body);
  });

  it("requires connector-token authentication for contract rollback", async () => {
    const { default: edgeWorker } = await import("../src/index.js");
    const activeRevision = "c".repeat(64);
    const previousRevision = "a".repeat(64);
    let received: unknown;
    const session = {
      rollbackContractRollout: async (input: unknown) => {
        received = input;
        return JSON.stringify({
          status: 200,
          body: {
            status: "rolled-back",
            activeContractRevision: previousRevision,
            candidateContractRevision: activeRevision,
          },
        });
      },
    };
    const env = {
      MCP_CONNECTOR_TOKEN: "connector-token-fixture",
      MCP_SESSION: {
        idFromName: () => ({ toString: () => "session-id" }),
        get: () => session,
      },
    } as never;
    const body = {
      expectedActiveContractRevision: activeRevision,
      expectedPreviousContractRevision: previousRevision,
    };

    const unauthorized = await edgeWorker.fetch(
      new Request("https://edge.example/_internal/contract-rollout/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await edgeWorker.fetch(
      new Request("https://edge.example/_internal/contract-rollout/rollback", {
        method: "POST",
        headers: {
          authorization: "Bearer connector-token-fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext,
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      status: "rolled-back",
      activeContractRevision: previousRevision,
      candidateContractRevision: activeRevision,
    });
    expect(received).toEqual(body);
  });

  it("rejects unauthenticated explicit contract preparation before touching the session", async () => {
    const { default: edgeWorker } = await import("../src/index.js");
    let calls = 0;
    const env = {
      MCP_CONNECTOR_TOKEN: "connector-token-fixture",
      MCP_CONTRACT_PREPARE_TOKEN: "prepare-token-fixture",
      MCP_SESSION: {
        idFromName: () => ({ toString: () => "session-id" }),
        get: () => ({
          prepareContractRollout: async () => {
            calls += 1;
            return JSON.stringify({ status: 200, body: { status: "prepared" } });
          },
        }),
      },
    } as never;

    const response = await edgeWorker.fetch(
      new Request("https://edge.example/_internal/contract-rollout/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedActiveContractRevision: "a".repeat(64),
          expectedCandidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
        }),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("forwards authenticated exact-revision CAS preparation to the Durable Object", async () => {
    const { default: edgeWorker } = await import("../src/index.js");
    const body = {
      expectedActiveContractRevision: "a".repeat(64),
      expectedCandidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
    };
    let received: unknown;
    const env = {
      MCP_CONNECTOR_TOKEN: "connector-token-fixture",
      MCP_CONTRACT_PREPARE_TOKEN: "prepare-token-fixture",
      MCP_SESSION: {
        idFromName: () => ({ toString: () => "session-id" }),
        get: () => ({
          prepareContractRollout: async (input: unknown) => {
            received = input;
            return JSON.stringify({
              status: 200,
              body: {
                status: "prepared",
                activeContractRevision: body.expectedActiveContractRevision,
                candidateContractRevision: body.expectedCandidateContractRevision,
                candidateConnectorReady: false,
              },
            });
          },
        }),
      },
    } as never;

    const response = await edgeWorker.fetch(
      new Request("https://edge.example/_internal/contract-rollout/prepare", {
        method: "POST",
        headers: {
          authorization: "Bearer prepare-token-fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "prepared",
      activeContractRevision: body.expectedActiveContractRevision,
      candidateContractRevision: body.expectedCandidateContractRevision,
      candidateConnectorReady: false,
    });
    expect(received).toEqual(body);
  });

  it("preserves the expected-active CAS conflict instead of claiming preparation succeeded", async () => {
    const { default: edgeWorker } = await import("../src/index.js");
    let received: unknown;
    const body = {
      expectedActiveContractRevision: "f".repeat(64),
      expectedCandidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
    };
    const env = {
      MCP_CONNECTOR_TOKEN: "connector-token-fixture",
      MCP_CONTRACT_PREPARE_TOKEN: "prepare-token-fixture",
      MCP_SESSION: {
        idFromName: () => ({ toString: () => "session-id" }),
        get: () => ({
          prepareContractRollout: async (input: unknown) => {
            received = input;
            return JSON.stringify({
              status: 409,
              body: { error: "active_contract_mismatch" },
            });
          },
        }),
      },
    } as never;

    const response = await edgeWorker.fetch(
      new Request("https://edge.example/_internal/contract-rollout/prepare", {
        method: "POST",
        headers: {
          authorization: "Bearer prepare-token-fixture",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "active_contract_mismatch" });
    expect(received).toEqual(body);
  });

  it("does not accept connector identity for contract preparation and fails closed without dedicated credential", async () => {
    const { default: edgeWorker } = await import("../src/index.js");
    let calls = 0;
    const session = {
      prepareContractRollout: async () => {
        calls += 1;
        return JSON.stringify({ status: 200, body: { status: "prepared" } });
      },
    };
    const sessionNamespace = {
      idFromName: () => ({ toString: () => "session-id" }),
      get: () => session,
    };
    const request = () => new Request("https://edge.example/_internal/contract-rollout/prepare", {
      method: "POST",
      headers: {
        authorization: "Bearer connector-token-fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedActiveContractRevision: "a".repeat(64),
        expectedCandidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
      }),
    });
    const forbidden = await edgeWorker.fetch(request(), {
      MCP_CONNECTOR_TOKEN: "connector-token-fixture",
      MCP_CONTRACT_PREPARE_TOKEN: "prepare-token-fixture",
      MCP_SESSION: sessionNamespace,
    } as never, {} as ExecutionContext);
    expect(forbidden.status).toBe(401);

    const unconfigured = await edgeWorker.fetch(request(), {
      MCP_CONNECTOR_TOKEN: "connector-token-fixture",
      MCP_SESSION: sessionNamespace,
    } as never, {} as ExecutionContext);
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: "contract_preparation_auth_not_configured" });

    for (const reusedSecret of [
      { MCP_CONNECTOR_TOKEN: "connector-token-fixture", MCP_CONTRACT_PREPARE_TOKEN: "connector-token-fixture" },
      { MCP_OWNER_TOKEN: "owner-token-fixture", MCP_CONTRACT_PREPARE_TOKEN: "owner-token-fixture" },
    ]) {
      const notIsolated = await edgeWorker.fetch(request(), {
        ...reusedSecret, MCP_SESSION: sessionNamespace,
      } as never, {} as ExecutionContext);
      expect(notIsolated.status).toBe(503);
      expect(await notIsolated.json()).toEqual({ error: "contract_preparation_auth_not_isolated" });
    }
    expect(calls).toBe(0);
  });

  it("reports candidate prepared independently of candidate connector readiness", () => {
    const activeRevision = "a".repeat(64);
    const candidateRevision = "c".repeat(64);
    const response = createEdgeHealthStatus(true, {
      controlPlaneReady: true,
      executionPlaneReady: true,
      connectorReady: true,
      contractCompatible: true,
      activeContractRevision: activeRevision,
      candidateContractRevision: candidateRevision,
      candidateConnectorReady: false,
      runtimeTelemetry,
    });
    expect(response.body).toMatchObject({
      activeContractRevision: activeRevision,
      candidateContractRevision: candidateRevision,
      candidateConnectorReady: false,
      executionPlaneReady: true,
    });
    expect(response.body.candidateRuntime).toBeUndefined();
  });
});
