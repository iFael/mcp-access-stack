import { describe, expect, it } from "@jest/globals";
import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol";
import { isPreferredConnectorRuntime, selectPreferredConnectorProtocol } from "../src/connector-handover.js";

function runtime(
  connectorInstanceId: string,
  processStartedAt: string,
  connectionGeneration: number,
): ConnectorRuntimeIdentity {
  return {
    version: 1,
    connectorInstanceId,
    connectionGeneration,
    processStartedAt,
    catalogContractRevision: "contract",
    toolSetRevision: "tools",
    toolCount: 1,
    serverVersion: "test",
    nodePid: 100,
    hostPid: 200,
  };
}

describe("connector handover ownership selection", () => {
  it("prefers the newer healthy process", () => {
    const oldProcess = runtime(
      "11111111-1111-4111-8111-111111111111",
      "2026-09-19T12:00:00.000Z",
      1,
    );
    const newProcess = runtime(
      "22222222-2222-4222-8222-222222222222",
      "2026-09-19T12:01:00.000Z",
      1,
    );

    expect(isPreferredConnectorRuntime(newProcess, oldProcess)).toBe(true);
    expect(isPreferredConnectorRuntime(oldProcess, newProcess)).toBe(false);
  });

  it("does not let an older process steal ownership by reconnecting with a higher generation", () => {
    const activeNewProcess = runtime(
      "22222222-2222-4222-8222-222222222222",
      "2026-09-19T12:01:00.000Z",
      1,
    );
    const reconnectedOldProcess = runtime(
      "11111111-1111-4111-8111-111111111111",
      "2026-09-19T12:00:00.000Z",
      99,
    );

    expect(isPreferredConnectorRuntime(reconnectedOldProcess, activeNewProcess)).toBe(false);
  });

  it("prefers the newer connection generation for the same connector process", () => {
    const previousConnection = runtime(
      "22222222-2222-4222-8222-222222222222",
      "2026-09-19T12:01:00.000Z",
      1,
    );
    const reconnected = runtime(
      "22222222-2222-4222-8222-222222222222",
      "2026-09-19T12:01:00.000Z",
      5,
    );

    expect(isPreferredConnectorRuntime(reconnected, previousConnection)).toBe(true);
    expect(isPreferredConnectorRuntime(previousConnection, reconnected)).toBe(false);
  });

  it("uses connector instance id only as a deterministic tie breaker", () => {
    const left = runtime(
      "11111111-1111-4111-8111-111111111111",
      "2026-09-19T12:00:00.000Z",
      1,
    );
    const right = runtime(
      "22222222-2222-4222-8222-222222222222",
      "2026-09-19T12:00:00.000Z",
      1,
    );

    expect(isPreferredConnectorRuntime(right, left)).toBe(true);
    expect(isPreferredConnectorRuntime(left, right)).toBe(false);
  });

  it("prefers a runtime with a valid process start over missing runtime identity", () => {
    const candidate = runtime(
      "22222222-2222-4222-8222-222222222222",
      "2026-09-19T12:01:00.000Z",
      1,
    );

    expect(isPreferredConnectorRuntime(candidate, undefined)).toBe(true);
    expect(isPreferredConnectorRuntime(undefined, candidate)).toBe(false);
  });
});


describe("connector protocol handover priority", () => {
  it("prefers v3 while both connectors are ready", () => {
    expect(selectPreferredConnectorProtocol(true, true)).toBe(3);
  });

  it("uses legacy only as a transitional fallback when v3 is not ready", () => {
    expect(selectPreferredConnectorProtocol(false, true)).toBe(2);
    expect(selectPreferredConnectorProtocol(false, false)).toBeNull();
  });
});
