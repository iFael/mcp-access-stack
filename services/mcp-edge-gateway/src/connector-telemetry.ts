import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol/source";

export const CONNECTOR_TELEMETRY_STORAGE_KEY = "edge:connector-telemetry:v1";

export type EdgeRuntimeTelemetryV1 = {
  version: 1;
  connectorInstanceId?: string;
  connectionGeneration?: number;
  processStartedAt?: string;
  catalogContractRevision?: string;
  toolSetRevision?: string;
  toolCount?: number;
  serverVersion?: string;
  nodePid?: number;
  hostPid?: number;
  readySince?: string;
  lastDisconnectedAt?: string;
  lastRequestAt?: string;
  lastSuccessfulRequestAt?: string;
  lastRequestId?: string;
  readyCount: number;
  disconnectCount: number;
  relayedRequestCount: number;
  successfulResponseCount: number;
};

export type ConnectorTelemetryEvent =
  | { type: "ready"; at: string; runtime?: ConnectorRuntimeIdentity }
  | { type: "disconnected"; at: string }
  | { type: "request"; at: string; requestId: string }
  | { type: "response"; at: string; requestId: string };

export function createEmptyConnectorTelemetry(): EdgeRuntimeTelemetryV1 {
  return {
    version: 1,
    readyCount: 0,
    disconnectCount: 0,
    relayedRequestCount: 0,
    successfulResponseCount: 0,
  };
}

export function applyConnectorTelemetryEvent(
  current: EdgeRuntimeTelemetryV1,
  event: ConnectorTelemetryEvent,
): EdgeRuntimeTelemetryV1 {
  switch (event.type) {
    case "ready":
      return applyReady(current, event.at, event.runtime);
    case "disconnected": {
      const { readySince: _readySince, ...rest } = current;
      return {
        ...rest,
        lastDisconnectedAt: event.at,
        disconnectCount: current.disconnectCount + 1,
      };
    }
    case "request":
      return {
        ...current,
        lastRequestAt: event.at,
        lastRequestId: event.requestId,
        relayedRequestCount: current.relayedRequestCount + 1,
      };
    case "response":
      return {
        ...current,
        lastSuccessfulRequestAt: event.at,
        successfulResponseCount: current.successfulResponseCount + 1,
      };
  }
}

export class ConnectorTelemetryStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly storage: DurableObjectStorage) {}

  record(event: ConnectorTelemetryEvent): Promise<EdgeRuntimeTelemetryV1> {
    const operation = this.queue.then(async () => {
      const current = await this.readPersisted();
      const next = applyConnectorTelemetryEvent(current, event);
      await this.storage.put(CONNECTOR_TELEMETRY_STORAGE_KEY, next);
      return next;
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async read(): Promise<EdgeRuntimeTelemetryV1> {
    await this.queue;
    return this.readPersisted();
  }

  private async readPersisted(): Promise<EdgeRuntimeTelemetryV1> {
    return (await this.storage.get<EdgeRuntimeTelemetryV1>(CONNECTOR_TELEMETRY_STORAGE_KEY))
      ?? createEmptyConnectorTelemetry();
  }
}

function applyReady(
  current: EdgeRuntimeTelemetryV1,
  at: string,
  runtime: ConnectorRuntimeIdentity | undefined,
): EdgeRuntimeTelemetryV1 {
  const {
    connectorInstanceId: _connectorInstanceId,
    connectionGeneration: _connectionGeneration,
    processStartedAt: _processStartedAt,
    catalogContractRevision: _catalogContractRevision,
    toolSetRevision: _toolSetRevision,
    toolCount: _toolCount,
    serverVersion: _serverVersion,
    nodePid: _nodePid,
    hostPid: _hostPid,
    readySince: _readySince,
    ...continuity
  } = current;

  const base: EdgeRuntimeTelemetryV1 = {
    ...continuity,
    version: 1,
    readySince: at,
    readyCount: current.readyCount + 1,
    disconnectCount: current.disconnectCount,
    relayedRequestCount: current.relayedRequestCount,
    successfulResponseCount: current.successfulResponseCount,
  };

  if (!runtime) return base;

  return {
    ...base,
    connectorInstanceId: runtime.connectorInstanceId,
    connectionGeneration: runtime.connectionGeneration,
    processStartedAt: runtime.processStartedAt,
    catalogContractRevision: runtime.catalogContractRevision,
    toolSetRevision: runtime.toolSetRevision,
    toolCount: runtime.toolCount,
    serverVersion: runtime.serverVersion,
    nodePid: runtime.nodePid,
    hostPid: runtime.hostPid,
  };
}
