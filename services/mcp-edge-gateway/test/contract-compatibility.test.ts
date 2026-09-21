import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol";
import { describe, expect, it } from "@jest/globals";
import {
  EXPECTED_MCP_CONTRACT_REVISION,
  isConnectorContractCompatible,
  isExpectedContractPrepared,
  promoteMcpContractRolloutState,
  reconcileMcpContractRolloutState,
  rollbackMcpContractRolloutState,
} from "../src/contract-compatibility.js";
import { EDGE_MCP_CATALOG_METADATA } from "../src/generated/mcp-tool-manifest.js";

const BETA_28_CONTRACT_REVISION =
  "12f282e5c5e62b095fb7c3327af3324fbffc802ae450f5ff90e4a3844a63b4c2";

function runtimeIdentity(overrides: Partial<ConnectorRuntimeIdentity> = {}): ConnectorRuntimeIdentity {
  return {
    version: 1,
    connectorInstanceId: "2fc94e69-439f-4f9f-a76b-71da6141b17f",
    connectionGeneration: 1,
    processStartedAt: "2026-09-13T12:00:00.000Z",
    catalogContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
    toolSetRevision: "a".repeat(64),
    toolCount: 999,
    serverVersion: "telemetry-only-version",
    nodePid: 1234,
    hostPid: 4321,
    ...overrides,
  };
}

describe("Edge/connector MCP contract compatibility", () => {
  it("projects the canonical mcp-core contract revision into the Edge build", () => {
    expect(EXPECTED_MCP_CONTRACT_REVISION).toBe(EDGE_MCP_CATALOG_METADATA.contractRevision);
  });

  it("accepts a connector when the single canonical contract revision matches", () => {
    expect(isConnectorContractCompatible(runtimeIdentity())).toBe(true);
  });

  it("does not use tool count, tool-set revision or server version as compatibility authorities", () => {
    expect(isConnectorContractCompatible(runtimeIdentity({
      toolSetRevision: "f".repeat(64),
      toolCount: 1,
      serverVersion: "intentionally-different-observability",
    }))).toBe(true);
  });

  it("rejects the currently deployed beta.28 connector contract", () => {
    expect(isConnectorContractCompatible(runtimeIdentity({
      catalogContractRevision: BETA_28_CONTRACT_REVISION,
    }))).toBe(false);
  });

  it("fails closed when runtime contract identity is missing", () => {
    expect(isConnectorContractCompatible(undefined)).toBe(false);
  });

  it("prepares the new build while preserving the observed active revision", () => {
    const activeRevision = "1".repeat(64);
    const prepared = reconcileMcpContractRolloutState(
      undefined,
      activeRevision,
      "2026-09-21T00:00:00.000Z",
    );

    expect(prepared.changed).toBe(true);
    expect(prepared.state).toEqual({
      version: 1,
      activeContractRevision: activeRevision,
      candidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
      preparedAt: "2026-09-21T00:00:00.000Z",
    });
    expect(isExpectedContractPrepared(prepared.state)).toBe(true);
    expect(isConnectorContractCompatible(runtimeIdentity({ catalogContractRevision: activeRevision }), prepared.state)).toBe(true);
    expect(isConnectorContractCompatible(runtimeIdentity(), prepared.state)).toBe(true);
  });

  it("does not silently replace an already prepared candidate with another build", () => {
    const state = {
      version: 1 as const,
      activeContractRevision: "1".repeat(64),
      candidateContractRevision: "2".repeat(64),
      preparedAt: "2026-09-20T00:00:00.000Z",
    };
    const reconciled = reconcileMcpContractRolloutState(
      state,
      state.activeContractRevision,
      "2026-09-21T00:00:00.000Z",
    );

    expect(reconciled).toEqual({ state, changed: false });
    expect(isExpectedContractPrepared(reconciled.state)).toBe(false);
  });

  it("promotes only when the prepared candidate is the selected runtime", () => {
    const activeRevision = "1".repeat(64);
    const state = {
      version: 1 as const,
      activeContractRevision: activeRevision,
      candidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
      preparedAt: "2026-09-21T00:00:00.000Z",
    };

    expect(promoteMcpContractRolloutState(
      state,
      activeRevision,
      EXPECTED_MCP_CONTRACT_REVISION,
      activeRevision,
      "2026-09-21T00:01:00.000Z",
    )).toEqual({ ok: false, code: "candidate_not_ready" });

    const promoted = promoteMcpContractRolloutState(
      state,
      activeRevision,
      EXPECTED_MCP_CONTRACT_REVISION,
      EXPECTED_MCP_CONTRACT_REVISION,
      "2026-09-21T00:01:00.000Z",
    );
    expect(promoted).toEqual({
      ok: true,
      alreadyPromoted: false,
      state: {
        version: 1,
        activeContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
        previousContractRevision: activeRevision,
        promotedAt: "2026-09-21T00:01:00.000Z",
      },
    });

    if (!promoted.ok) throw new Error("promotion unexpectedly failed");
    expect(promoteMcpContractRolloutState(
      promoted.state,
      activeRevision,
      EXPECTED_MCP_CONTRACT_REVISION,
      EXPECTED_MCP_CONTRACT_REVISION,
      "2026-09-21T00:02:00.000Z",
    )).toEqual({ ok: true, state: promoted.state, alreadyPromoted: true });

    expect(isConnectorContractCompatible(
      runtimeIdentity({ catalogContractRevision: activeRevision }),
      promoted.state,
    )).toBe(false);

    expect(rollbackMcpContractRolloutState(
      promoted.state,
      EXPECTED_MCP_CONTRACT_REVISION,
      activeRevision,
      EXPECTED_MCP_CONTRACT_REVISION,
      "2026-09-21T00:03:00.000Z",
    )).toEqual({ ok: false, code: "previous_not_ready" });

    const rolledBack = rollbackMcpContractRolloutState(
      promoted.state,
      EXPECTED_MCP_CONTRACT_REVISION,
      activeRevision,
      activeRevision,
      "2026-09-21T00:03:00.000Z",
    );
    expect(rolledBack).toEqual({
      ok: true,
      alreadyRolledBack: false,
      state: {
        version: 1,
        activeContractRevision: activeRevision,
        candidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
        preparedAt: "2026-09-21T00:03:00.000Z",
      },
    });
  });
});
