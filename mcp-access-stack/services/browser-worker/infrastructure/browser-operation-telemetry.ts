import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { BrowserOperation } from "@vs-code-gpt/shared";

export type BrowserOperationalFailureLayer =
  | "http_server"
  | "idempotency"
  | "queue"
  | "executor"
  | "browser_context"
  | "policy";

export interface BrowserOperationTraceContext {
  traceId?: string;
  operation: BrowserOperation;
}

export interface BrowserOperationalEvent {
  event: string;
  traceId?: string;
  operation?: BrowserOperation;
  status?: string;
  reason?: string;
  failureLayer?: BrowserOperationalFailureLayer;
  durationMs?: number;
  queueWaitMs?: number;
  operationUnits?: number;
  queueDepth?: number;
  selection?: "exact" | "recycled" | "created";
  cache?: "hit" | "miss" | "not_applicable";
  navigated?: boolean;
  taskRef?: string;
  tabRef?: string;
  taskState?: string;
  tabLifecycle?: string;
  reusable?: boolean;
  protected?: boolean;
  sticky?: boolean;
  browserClosed?: boolean;
  closedTabs?: number;
  contextRestarted?: boolean;
  pagesRecreated?: number;
  staleBindingsRemoved?: number;
  stabilizationScope?: "page" | "frame";
  stabilizationSamples?: number;
  pendingRelevantRequests?: number;
  unreadyFrames?: number;
  extractionScope?: "page" | "frame";
  extractionMode?: "visible" | "document" | "document-and-safe-pagination";
  extractionPages?: number;
  extractionScrolls?: number;
  extractionBytes?: number;
  paginationAvailable?: boolean;
  idempotencyDisposition?: "hit" | "miss" | "conflict" | "capacity" | "expiration";
}

interface StoredTraceContext {
  traceId?: string;
  operation: BrowserOperation;
}

export class BrowserOperationTelemetry {
  readonly filePath: string;
  private readonly context = new AsyncLocalStorage<StoredTraceContext>();
  private writeTail: Promise<void> = Promise.resolve();

  constructor(runtimeDirectory: string) {
    this.filePath = path.join(runtimeDirectory, "browser-operations.ndjson");
  }

  run<T>(
    trace: BrowserOperationTraceContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.context.run(trace, operation);
  }

  record(event: BrowserOperationalEvent): void {
    const trace = this.context.getStore();
    const entry = {
      timestamp: new Date().toISOString(),
      ...(trace?.traceId === undefined ? {} : { traceId: trace.traceId }),
      ...(trace?.operation === undefined ? {} : { operation: trace.operation }),
      ...event,
    };
    this.writeTail = this.writeTail
      .then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, "utf8");
      })
      .catch(() => undefined);
  }

  reference(kind: "task" | "tab", value: string): string {
    return createHash("sha256")
      .update(`browser-observability-ref-v1\0${kind}\0${value}`, "utf8")
      .digest("hex")
      .slice(0, 16);
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }
}
