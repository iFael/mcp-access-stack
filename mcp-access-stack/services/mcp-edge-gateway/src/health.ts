export interface EdgeSessionHealth {
  controlPlaneReady: boolean;
  executionPlaneReady: boolean;
  connectorReady: boolean;
}

export function createEdgeHealthStatus(
  edgeEnabled: boolean,
  session: EdgeSessionHealth,
): {
  statusCode: 200 | 503;
  body: {
    service: "mcp-edge-gateway";
    status: "ok" | "control_plane_unavailable";
    edgeEnabled: boolean;
    controlPlaneReady: boolean;
    executionPlaneReady: boolean;
    connectorReady: boolean;
  };
} {
  const controlPlaneReady = edgeEnabled && session.controlPlaneReady;
  const executionPlaneReady = controlPlaneReady && session.executionPlaneReady;
  return {
    statusCode: controlPlaneReady ? 200 : 503,
    body: {
      service: "mcp-edge-gateway",
      status: controlPlaneReady ? "ok" : "control_plane_unavailable",
      edgeEnabled,
      controlPlaneReady,
      executionPlaneReady,
      connectorReady: session.connectorReady,
    },
  };
}