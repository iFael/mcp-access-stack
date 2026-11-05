import type { CompanionAuditBatchMessage, CompanionAuditEntry } from "@mcp-access-stack/edge-protocol";

const MAX_BATCHES_PER_USER = 512;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const INDEX_PREFIX = "cloud-audit-index:v1:";
const BATCH_PREFIX = "cloud-audit:v1:";

export interface CloudAuditStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  transaction<T>(callback: (txn: CloudAuditTransaction) => Promise<T>): Promise<T>;
}
export type CloudAuditTransaction = Pick<CloudAuditStorage, "get" | "put" | "delete">;

export type CloudAuditRecord = {
  deviceId: string;
  receivedAt: string;
  dropped: number;
  entries: CompanionAuditEntry[];
};

type IndexItem = { key: string; time: number };

/** Only the authenticated WebSocket attachment supplies the user and device IDs. */
export class CloudAuditStore {
  constructor(private readonly storage: CloudAuditStorage) {}

  async append(
    userId: string,
    deviceId: string,
    batch: CompanionAuditBatchMessage,
  ): Promise<void> {
    const key = `${BATCH_PREFIX}${userId}:${deviceId}:${batch.batchId}`;
    const indexKey = INDEX_PREFIX + userId;
    await this.storage.transaction(async (txn) => {
      const previous = await txn.get<CloudAuditRecord>(key);
      if (previous !== undefined) return; // ACK may have been lost; exactly one cloud record per batch.
      const now = Date.now();
      const old = (await txn.get<IndexItem[]>(indexKey)) ?? [];
      const retained: IndexItem[] = [];
      for (const item of old) {
        if (now - item.time >= MAX_AGE_MS) {
          await txn.delete(item.key);
        } else {
          retained.push(item);
        }
      }
      retained.push({ key, time: now });
      while (retained.length > MAX_BATCHES_PER_USER) {
        const expired = retained.shift()!;
        await txn.delete(expired.key);
      }
      await txn.put(key, {
        deviceId,
        receivedAt: new Date(now).toISOString(),
        dropped: batch.dropped,
        entries: batch.entries,
      } satisfies CloudAuditRecord);
      await txn.put(indexKey, retained);
    });
  }

  async latest(userId: string, limit = 50): Promise<Array<{
    deviceId: string; receivedAt: string; entry: CompanionAuditEntry; dropped: number;
  }>> {
    const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 100);
    const index = (await this.storage.get<IndexItem[]>(INDEX_PREFIX + userId)) ?? [];
    const results: Array<{
      deviceId: string; receivedAt: string; entry: CompanionAuditEntry; dropped: number;
    }> = [];
    for (const item of index.slice().reverse()) {
      const batch = await this.storage.get<CloudAuditRecord>(item.key);
      if (!batch) continue;
      for (const entry of batch.entries.slice().reverse()) {
        results.push({ deviceId: batch.deviceId, receivedAt: batch.receivedAt, entry, dropped: batch.dropped });
        if (results.length >= safeLimit) return results;
      }
    }
    return results;
  }

}
