import { describe, expect, it, jest } from "@jest/globals";
import { createEdgeHealthStatus } from "../src/health.js";
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
});
