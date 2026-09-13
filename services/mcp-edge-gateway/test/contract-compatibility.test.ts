import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol";
import { describe, expect, it } from "@jest/globals";
import {
  EXPECTED_MCP_CONTRACT_REVISION,
  isConnectorContractCompatible,
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
});
