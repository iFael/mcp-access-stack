import { describe, expect, it } from "@jest/globals";
import { EXPECTED_MCP_CONTRACT_REVISION } from "../src/contract-compatibility.js";
import { createEdgeHealthStatus } from "../src/health.js";

describe("Edge health plane separation", () => {
  it("keeps overall status ok when control plane is ready but executor is offline", () => {
    expect(createEdgeHealthStatus(true, {
      controlPlaneReady: true,
      executionPlaneReady: false,
      connectorReady: false,
      contractCompatible: false,
    })).toEqual({
      statusCode: 200,
      body: {
        service: "mcp-edge-gateway",
        status: "ok",
        edgeEnabled: true,
        controlPlaneReady: true,
        executionPlaneReady: false,
        connectorReady: false,
        contractCompatible: false,
        expectedContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
      },
    });
  });

  it("reports a connected but contract-incompatible connector without enabling execution", () => {
    expect(createEdgeHealthStatus(true, {
      controlPlaneReady: true,
      executionPlaneReady: false,
      connectorReady: true,
      contractCompatible: false,
    })).toEqual({
      statusCode: 200,
      body: {
        service: "mcp-edge-gateway",
        status: "ok",
        edgeEnabled: true,
        controlPlaneReady: true,
        executionPlaneReady: false,
        connectorReady: true,
        contractCompatible: false,
        expectedContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
      },
    });
  });

  it("fails health when the control plane itself is unavailable", () => {
    expect(createEdgeHealthStatus(true, {
      controlPlaneReady: false,
      executionPlaneReady: true,
      connectorReady: true,
      contractCompatible: true,
    })).toMatchObject({
      statusCode: 503,
      body: {
        status: "control_plane_unavailable",
        controlPlaneReady: false,
        executionPlaneReady: false,
        connectorReady: true,
        contractCompatible: true,
        expectedContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
      },
    });
  });
});
