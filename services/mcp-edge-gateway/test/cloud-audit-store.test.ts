import { describe, expect, it } from "@jest/globals";
import type { CompanionAuditBatchMessage } from "@mcp-access-stack/edge-protocol";
import { CloudAuditStore } from "../src/control-plane/cloud-audit-store.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<boolean> { return this.values.delete(key); }
  async transaction<T>(callback: (txn: MemoryStorage) => Promise<T>): Promise<T> { return callback(this); }
}

const U1 = "usr_11111111-1111-4111-8111-111111111111";
const U2 = "usr_22222222-2222-4222-8222-222222222222";
const DEVICE = "dev_33333333-3333-4333-8333-333333333333";
const batch = (batchId: string): CompanionAuditBatchMessage => ({
  type: "companion-audit-batch",
  protocolVersion: 1,
  batchId,
  dropped: 0,
  entries: [{
    timestamp: "2026-11-04T22:00:00.000Z",
    operation: "runCommand",
    workspaceId: "computer",
    durationMs: 20,
    status: "allowed",
    correlationId: "c1",
  }],
});

describe("CloudAuditStore", () => {
  it("bounds cloud retention and keeps the newest events under repeated deliveries", async () => {
    const storage = new MemoryStorage();
    const store = new CloudAuditStore(storage);
    for (let i = 0; i < 515; i++) {
      await store.append(U1, DEVICE, batch("batch-" + i));
    }
    const index = await storage.get<Array<{ key: string }>>("cloud-audit-index:v1:" + U1);
    expect(index).toHaveLength(512);
    expect([...storage.values.keys()].filter((key) => key.startsWith("cloud-audit:v1:" + U1))).toHaveLength(512);
    expect((await store.latest(U1, 2)).map((x) => x.entry.operation)).toEqual([
      "runCommand", "runCommand",
    ]);
    await store.append(U1, DEVICE, batch("batch-514")); // replay must not duplicate.
    expect(await storage.get("cloud-audit-index:v1:" + U1)).toHaveLength(512);
  });


  it("persists once and scopes every listing to its authenticated owner", async () => {
    const store = new CloudAuditStore(new MemoryStorage());
    await store.append(U1, DEVICE, batch("batch-1"));
    await store.append(U1, DEVICE, batch("batch-1"));
    expect(await store.latest(U1)).toHaveLength(1);
    expect(await store.latest(U2)).toEqual([]);
    await store.append(U2, DEVICE, batch("batch-1"));
    expect(await store.latest(U2)).toHaveLength(1);
    expect(await store.latest(U1)).toHaveLength(1);
  });

  it("records loss counts without blocking an unrelated user", async () => {
    const store = new CloudAuditStore(new MemoryStorage());
    await store.append(U1, DEVICE, { ...batch("batch-2"), dropped: 42 });
    expect((await store.latest(U1))[0]).toMatchObject({
      deviceId: DEVICE, dropped: 42, entry: { operation: "runCommand" },
    });
    expect(await store.latest(U2)).toEqual([]);
  });
});
