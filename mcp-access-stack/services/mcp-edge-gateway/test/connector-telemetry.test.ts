import { describe, expect, it } from "@jest/globals";
import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol/source";
import {
  CONNECTOR_TELEMETRY_STORAGE_KEY,
  applyConnectorTelemetryEvent,
  createEmptyConnectorTelemetry,
} from "../src/connector-telemetry.js";

const runtime = {
  version: 1,
  connectorInstanceId: "11111111-1111-4111-8111-111111111111",
  connectionGeneration: 1,
  processStartedAt: "2026-09-02T12:00:00.000Z",
  catalogContractRevision: "a".repeat(64),
  toolSetRevision: "b".repeat(64),
  toolCount: 61,
  serverVersion: "1.1.0-beta.24-catalog.test",
  nodePid: 1234,
  hostPid: 4321,
} satisfies ConnectorRuntimeIdentity;

describe("connector telemetry reducer", () => {
  it("uses one versioned persisted key and zeroed counters", () => {
    expect(CONNECTOR_TELEMETRY_STORAGE_KEY).toBe("edge:connector-telemetry:v1");
    expect(createEmptyConnectorTelemetry()).toEqual({
      version: 1,
      readyCount: 0,
      disconnectCount: 0,
      relayedRequestCount: 0,
      successfulResponseCount: 0,
    });
  });

  it("records ready identity and advances reconnect generation without resetting counters", () => {
    const first = applyConnectorTelemetryEvent(createEmptyConnectorTelemetry(), {
      type: "ready",
      at: "2026-09-02T12:00:01.000Z",
      runtime,
    });
    expect(first).toEqual({
      version: 1,
      connectorInstanceId: runtime.connectorInstanceId,
      connectionGeneration: 1,
      processStartedAt: runtime.processStartedAt,
      catalogContractRevision: runtime.catalogContractRevision,
      toolSetRevision: runtime.toolSetRevision,
      toolCount: runtime.toolCount,
      serverVersion: runtime.serverVersion,
      nodePid: runtime.nodePid,
      hostPid: runtime.hostPid,
      readySince: "2026-09-02T12:00:01.000Z",
      readyCount: 1,
      disconnectCount: 0,
      relayedRequestCount: 0,
      successfulResponseCount: 0,
    });

    const second = applyConnectorTelemetryEvent(first, {
      type: "ready",
      at: "2026-09-02T12:00:03.000Z",
      runtime: { ...runtime, connectionGeneration: 2 },
    });
    expect(second).toMatchObject({
      connectorInstanceId: runtime.connectorInstanceId,
      connectionGeneration: 2,
      readySince: "2026-09-02T12:00:03.000Z",
      readyCount: 2,
    });
  });

  it("records disconnect, relayed request and successful response evidence", () => {
    const ready = applyConnectorTelemetryEvent(createEmptyConnectorTelemetry(), {
      type: "ready",
      at: "2026-09-02T12:00:01.000Z",
      runtime,
    });
    const disconnected = applyConnectorTelemetryEvent(ready, {
      type: "disconnected",
      at: "2026-09-02T12:00:05.000Z",
    });
    expect(disconnected.readySince).toBeUndefined();
    expect(disconnected).toMatchObject({
      lastDisconnectedAt: "2026-09-02T12:00:05.000Z",
      readyCount: 1,
      disconnectCount: 1,
    });

    const relayed = applyConnectorTelemetryEvent(disconnected, {
      type: "request",
      at: "2026-09-02T12:00:06.000Z",
      requestId: "request-1",
    });
    expect(relayed).toMatchObject({
      lastRequestAt: "2026-09-02T12:00:06.000Z",
      lastRequestId: "request-1",
      relayedRequestCount: 1,
      successfulResponseCount: 0,
    });

    const responded = applyConnectorTelemetryEvent(relayed, {
      type: "response",
      at: "2026-09-02T12:00:07.000Z",
      requestId: "request-1",
    });
    expect(responded).toMatchObject({
      lastSuccessfulRequestAt: "2026-09-02T12:00:07.000Z",
      lastRequestId: "request-1",
      relayedRequestCount: 1,
      successfulResponseCount: 1,
    });
  });

  it("keeps lastRequestId bound to the most recently relayed request when responses arrive out of order", () => {
    const firstRequest = applyConnectorTelemetryEvent(createEmptyConnectorTelemetry(), {
      type: "request",
      at: "2026-09-02T12:00:01.000Z",
      requestId: "request-1",
    });
    const secondRequest = applyConnectorTelemetryEvent(firstRequest, {
      type: "request",
      at: "2026-09-02T12:00:02.000Z",
      requestId: "request-2",
    });
    const firstResponse = applyConnectorTelemetryEvent(secondRequest, {
      type: "response",
      at: "2026-09-02T12:00:03.000Z",
      requestId: "request-1",
    });

    expect(firstResponse).toMatchObject({
      lastRequestAt: "2026-09-02T12:00:02.000Z",
      lastRequestId: "request-2",
      lastSuccessfulRequestAt: "2026-09-02T12:00:03.000Z",
      relayedRequestCount: 2,
      successfulResponseCount: 1,
    });
  });
  it("preserves prior disconnect/request evidence when the connector becomes ready again", () => {
    const prior = {
      ...createEmptyConnectorTelemetry(),
      lastDisconnectedAt: "2026-09-02T12:00:05.000Z",
      lastRequestAt: "2026-09-02T12:00:06.000Z",
      lastSuccessfulRequestAt: "2026-09-02T12:00:07.000Z",
      lastRequestId: "request-1",
      disconnectCount: 1,
      relayedRequestCount: 1,
      successfulResponseCount: 1,
    };

    const reconnected = applyConnectorTelemetryEvent(prior, {
      type: "ready",
      at: "2026-09-02T12:01:00.000Z",
      runtime: { ...runtime, connectionGeneration: 2 },
    });

    expect(reconnected).toMatchObject({
      readySince: "2026-09-02T12:01:00.000Z",
      lastDisconnectedAt: prior.lastDisconnectedAt,
      lastRequestAt: prior.lastRequestAt,
      lastSuccessfulRequestAt: prior.lastSuccessfulRequestAt,
      lastRequestId: prior.lastRequestId,
      readyCount: 1,
      disconnectCount: 1,
      relayedRequestCount: 1,
      successfulResponseCount: 1,
    });
  });
  it("clears stale runtime identity when a legacy-compatible ready has no runtime block", () => {
    const identified = applyConnectorTelemetryEvent(createEmptyConnectorTelemetry(), {
      type: "ready",
      at: "2026-09-02T12:00:01.000Z",
      runtime,
    });
    const legacy = applyConnectorTelemetryEvent(identified, {
      type: "ready",
      at: "2026-09-02T12:10:00.000Z",
    });
    expect(legacy).toEqual({
      version: 1,
      readySince: "2026-09-02T12:10:00.000Z",
      readyCount: 2,
      disconnectCount: 0,
      relayedRequestCount: 0,
      successfulResponseCount: 0,
    });
  });
});
