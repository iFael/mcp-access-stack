import { describe, expect, it } from "@jest/globals";
import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol/source";
import { ConnectorTelemetryStore } from "../src/connector-telemetry.js";

const runtime = {
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
} satisfies ConnectorRuntimeIdentity;

class FakeStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    await Promise.resolve();
    this.values.set(key, structuredClone(value));
  }
}

describe("ConnectorTelemetryStore", () => {
  it("serializes persisted lifecycle/request evidence without losing counters", async () => {
    const storage = new FakeStorage();
    const store = new ConnectorTelemetryStore(storage as unknown as DurableObjectStorage);

    const ready = store.record({ type: "ready", at: "2026-09-02T12:00:01.000Z", runtime });
    const request = store.record({ type: "request", at: "2026-09-02T12:00:02.000Z", requestId: "request-1" });
    const response = store.record({ type: "response", at: "2026-09-02T12:00:03.000Z", requestId: "request-1" });
    const disconnected = store.record({ type: "disconnected", at: "2026-09-02T12:00:04.000Z" });

    await Promise.all([ready, request, response, disconnected]);

    expect(await store.read()).toMatchObject({
      version: 1,
      connectorInstanceId: runtime.connectorInstanceId,
      connectionGeneration: runtime.connectionGeneration,
      lastDisconnectedAt: "2026-09-02T12:00:04.000Z",
      lastRequestAt: "2026-09-02T12:00:02.000Z",
      lastSuccessfulRequestAt: "2026-09-02T12:00:03.000Z",
      lastRequestId: "request-1",
      readyCount: 1,
      disconnectCount: 1,
      relayedRequestCount: 1,
      successfulResponseCount: 1,
    });
  });
});
