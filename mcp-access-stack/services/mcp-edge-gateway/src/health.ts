import type { EdgeRuntimeTelemetryV1 } from "./connector-telemetry.js";

export interface EdgeSessionHealth {
  controlPlaneReady: boolean;
  executionPlaneReady: boolean;
  connectorReady: boolean;
  runtimeTelemetry?: EdgeRuntimeTelemetryV1;
}

export type PublicEdgeRuntimeHealth = {
  connectorInstanceId?: string;
  connectionGeneration?: number;
  catalogContractRevision?: string;
  toolSetRevision?: string;
  toolCount?: number;
  serverVersion?: string;
  readySince?: string;
  lastRequestAt?: string;
  lastSuccessfulRequestAt?: string;
  readyCount: number;
  disconnectCount: number;
};

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
    runtime?: PublicEdgeRuntimeHealth;
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
      ...(session.runtimeTelemetry === undefined
        ? {}
        : { runtime: toPublicRuntimeHealth(session.runtimeTelemetry) }),
    },
  };
}

function toPublicRuntimeHealth(telemetry: EdgeRuntimeTelemetryV1): PublicEdgeRuntimeHealth {
  return {
    ...(telemetry.connectorInstanceId === undefined ? {} : { connectorInstanceId: telemetry.connectorInstanceId }),
    ...(telemetry.connectionGeneration === undefined ? {} : { connectionGeneration: telemetry.connectionGeneration }),
    ...(telemetry.catalogContractRevision === undefined ? {} : { catalogContractRevision: telemetry.catalogContractRevision }),
    ...(telemetry.toolSetRevision === undefined ? {} : { toolSetRevision: telemetry.toolSetRevision }),
    ...(telemetry.toolCount === undefined ? {} : { toolCount: telemetry.toolCount }),
    ...(telemetry.serverVersion === undefined ? {} : { serverVersion: telemetry.serverVersion }),
    ...(telemetry.readySince === undefined ? {} : { readySince: telemetry.readySince }),
    ...(telemetry.lastRequestAt === undefined ? {} : { lastRequestAt: telemetry.lastRequestAt }),
    ...(telemetry.lastSuccessfulRequestAt === undefined
      ? {}
      : { lastSuccessfulRequestAt: telemetry.lastSuccessfulRequestAt }),
    readyCount: telemetry.readyCount,
    disconnectCount: telemetry.disconnectCount,
  };
}
