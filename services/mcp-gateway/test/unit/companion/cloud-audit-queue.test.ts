import { describe, expect, it, jest } from "@jest/globals";
import type { AuditEntry } from "@vs-code-gpt/shared";
import type { CompanionAuditBatchMessage } from "@mcp-access-stack/edge-protocol";
import { CloudAuditQueue, type CloudAuditStatus } from "../../../src/companion/cloud-audit-queue.js";

const event = (number: number): AuditEntry => ({
  timestamp: new Date(1_700_000_000_000 + number).toISOString(),
  operation: "readFile",
  workspaceId: "computer",
  status: "allowed",
  durationMs: 1,
  correlationId: "test-" + number,
});

describe("CloudAuditQueue", () => {
  it("never waits for the cloud or creates a local log, and warns on delivery delays", async () => {
    const notices: CloudAuditStatus[] = [];
    const queue = new CloudAuditQueue((item) => { notices.push(item); });
    const result = await queue.write(event(1));
    expect(result.totalDurationMs).toBe(0);
    expect(queue.status).toMatchObject({ pending: 1, connected: false, dropped: 0 });
    expect(notices.map((item) => item.state)).toEqual(["delayed"]);

    const batches: CompanionAuditBatchMessage[] = [];
    queue.connect((batch) => { batches.push(batch); return true; });
    expect(batches).toHaveLength(1);
    expect(batches[0]?.entries[0]?.correlationId).toBe("test-1");
    queue.acknowledge("wrong-ack");
    expect(queue.status.pending).toBe(1);
    queue.acknowledge(batches[0]!.batchId);
    expect(queue.status.pending).toBe(0);
    expect(notices.at(-1)?.state).toBe("restored");
    queue.disconnect();
  });

  it("retries exactly the same batch after disconnect and does not block operations", async () => {
    const queue = new CloudAuditQueue();
    const sent: CompanionAuditBatchMessage[] = [];
    queue.connect((batch) => { sent.push(batch); return false; });
    await queue.write(event(1));
    expect(sent).toHaveLength(1);
    queue.disconnect();
    await queue.write(event(2));
    queue.connect((batch) => { sent.push(batch); return true; });
    expect(sent[1]?.batchId).toBe(sent[0]?.batchId);
    queue.acknowledge(sent[1]!.batchId);
    expect(sent[2]?.entries[0]?.correlationId).toBe("test-2");
    queue.acknowledge(sent[2]!.batchId);
    expect(queue.status).toMatchObject({ pending: 0, dropped: 0 });
    queue.disconnect();
  });

  it("bounds its memory and surfaces dropped telemetry without blocking tools", async () => {
    const statuses: CloudAuditStatus[] = [];
    const queue = new CloudAuditQueue((item) => { statuses.push(item); });
    await Promise.all(Array.from({ length: 530 }, (_, index) => queue.write(event(index))));
    expect(queue.status.pending).toBe(512);
    expect(queue.status.dropped).toBe(18);
    expect(statuses.some((item) => item.state === "records_lost")).toBe(true);
    const batches: CompanionAuditBatchMessage[] = [];
    queue.connect((batch) => { batches.push(batch); return true; });
    expect(batches[0]?.dropped).toBe(18);
    queue.disconnect();
  });

  it("does not transmit malformed audit events that could disconnect the device", async () => {
    const notices: CloudAuditStatus[] = [];
    const queue = new CloudAuditQueue((item) => { notices.push(item); });
    const batches: CompanionAuditBatchMessage[] = [];
    queue.connect((batch) => { batches.push(batch); return true; });
    await expect(queue.write({
      ...event(2),
      path: "x".repeat(10_000),
    })).resolves.toBeDefined();
    expect(batches).toHaveLength(0);
    expect(queue.status).toMatchObject({ dropped: 1, pending: 0 });
    expect(notices.some((item) => item.state === "records_lost")).toBe(true);
    queue.disconnect();
  });

  it("ignores a throwing notification callback", async () => {
    const queue = new CloudAuditQueue(() => { throw new Error("toast failed"); });
    await expect(queue.write(event(1))).resolves.toMatchObject({ totalDurationMs: 0 });
    expect(queue.status.pending).toBe(1);
  });
});
