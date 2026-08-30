import { describe, expect, it } from "@jest/globals";
import { createEdgeHealthStatus } from "../src/health.js";

describe("Edge health plane separation", () => {
  it("keeps overall status ok when control plane is ready but executor is offline", () => {
    expect(createEdgeHealthStatus(true, {
      controlPlaneReady: true,
      executionPlaneReady: false,
      connectorReady: false,
    })).toEqual({
      statusCode: 200,
      body: {
        service: "mcp-edge-gateway",
        status: "ok",
        edgeEnabled: true,
        controlPlaneReady: true,
        executionPlaneReady: false,
        connectorReady: false,
      },
    });
  });

  it("fails health when the control plane itself is unavailable", () => {
    expect(createEdgeHealthStatus(true, {
      controlPlaneReady: false,
      executionPlaneReady: true,
      connectorReady: true,
    })).toMatchObject({
      statusCode: 503,
      body: {
        status: "control_plane_unavailable",
        controlPlaneReady: false,
        executionPlaneReady: false,
        connectorReady: true,
      },
    });
  });
});