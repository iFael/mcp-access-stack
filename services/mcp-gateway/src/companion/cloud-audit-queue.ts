import { randomUUID } from "node:crypto";
import type { AuditEntry } from "@vs-code-gpt/shared";
import {
  COMPANION_PROTOCOL_VERSION,
  parseCompanionAuditEntry,
  type CompanionAuditBatchMessage,
  type CompanionAuditEntry,
} from "@mcp-access-stack/edge-protocol";

const MAX_PENDING_ENTRIES = 512;
const MAX_BATCH_ENTRIES = 16;
const RETRY_MS = 5_000;

export type CloudAuditStatus = {
  state: "delayed" | "restored" | "records_lost";
  pending: number;
  dropped: number;
};

/**
 * Cloud-only best-effort audit delivery. This is observation, not authorization:
 * network failures never change an operation's result. Pending entries live
 * only in bounded process memory; loss is reported, never silently claimed safe.
 */
export class CloudAuditQueue {
  private readonly pending: CompanionAuditEntry[] = [];
  private inFlight: CompanionAuditBatchMessage | undefined;
  private transmit: ((batch: CompanionAuditBatchMessage) => boolean) | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private dropped = 0;
  private degraded = false;

  constructor(private readonly onStatus: (status: CloudAuditStatus) => void = () => {}) {}

  async write(entry: AuditEntry): Promise<{
    appendDurationMs: number;
    totalDurationMs: number;
    rotated: boolean;
    activeFileBytes: number;
  }> {
    try {
      const validated = parseCompanionAuditEntry(entry);
      if (!validated) {
        this.dropped++;
        this.warn("records_lost");
        return { appendDurationMs: 0, totalDurationMs: 0, rotated: false, activeFileBytes: 0 };
      }
      const inFlightCount = this.inFlight?.entries.length ?? 0;
      if (this.pending.length + inFlightCount >= MAX_PENDING_ENTRIES) {
        if (this.pending.length > 0) this.pending.shift();
        else {
          this.dropped++;
          this.warn("records_lost");
          return { appendDurationMs: 0, totalDurationMs: 0, rotated: false, activeFileBytes: 0 };
        }
        this.dropped++;
        this.warn("records_lost");
      }
      this.pending.push(validated);
      if (!this.transmit) this.warn("delayed");
      this.pump();
    } catch {
      this.dropped++;
      this.warn("records_lost");
    }
    // No local audit file, network wait, or blocking permission gate.
    return { appendDurationMs: 0, totalDurationMs: 0, rotated: false, activeFileBytes: 0 };
  }

  connect(transmit: (batch: CompanionAuditBatchMessage) => boolean): void {
    this.transmit = transmit;
    this.pump(true);
  }

  disconnect(): void {
    this.transmit = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  acknowledge(batchId: string): void {
    if (this.inFlight?.batchId !== batchId) return;
    this.inFlight = undefined;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.pump();
    if (this.pending.length === 0 && this.inFlight === undefined && this.degraded) {
      this.degraded = false;
      this.safeNotify({ state: "restored", pending: 0, dropped: this.dropped });
    }
  }

  get status(): { pending: number; dropped: number; connected: boolean } {
    return {
      pending: this.pending.length + (this.inFlight?.entries.length ?? 0),
      dropped: this.dropped,
      connected: this.transmit !== undefined,
    };
  }

  private warn(state: "delayed" | "records_lost"): void {
    if (state === "delayed" && this.degraded) return;
    if (state === "records_lost" && this.degraded && this.dropped % 100 !== 1) return;
    this.degraded = true;
    this.safeNotify({ state, pending: this.status.pending, dropped: this.dropped });
  }

  private safeNotify(status: CloudAuditStatus): void {
    try { this.onStatus(status); } catch { /* telemetry cannot change execution */ }
  }

  private pump(resend = false): void {
    if (!this.transmit) return;
    if (!this.inFlight && this.pending.length > 0) {
      this.inFlight = {
        type: "companion-audit-batch",
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        batchId: randomUUID(),
        entries: this.pending.splice(0, MAX_BATCH_ENTRIES),
        dropped: this.dropped,
      };
    }
    if (!this.inFlight) return;
    if (this.retry && !resend) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    try {
      if (!this.transmit(this.inFlight)) {
        this.warn("delayed");
      }
    } catch {
      this.warn("delayed");
    }
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.inFlight) this.warn("delayed");
      this.pump(true);
    }, RETRY_MS);
    this.retry.unref?.();
  }
}
