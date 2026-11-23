import { randomUUID } from "node:crypto";
import type { CentralMemoryStore, MemoryRecord } from "./central-memory.js";

export type MonitorSignal = "workspace_backend" | "edge_connector";
export interface MonitorSnapshot {
  workspaceBackendReady: boolean;
  edgeConnectorReady: boolean;
}
export interface MonitorFinding {
  signal: MonitorSignal;
  observed: "unhealthy" | "recovered";
  cause: "unverified";
  action: "investigate";
}

const SIGNALS: readonly MonitorSignal[] = ["workspace_backend", "edge_connector"];
const PREFIX = "mcp-monitor:";
const INTERVAL_MS = 60_000;
const FAILURES_BEFORE_REPORT = 3;
const HEALTHY_BEFORE_RECOVERY = 2;

/**
 * Runs in the Oracle connector process without a ChatGPT session or another AI.
 * It reports observations, NEVER guesses a root cause or applies a code change.
 * Current scope is local backend readiness and the Edge transport connection.
 * An external outage of this process cannot be observed by this process itself.
 */
export class CentralMemoryOperationalMonitor {
  private readonly counters = new Map<MonitorSignal, {bad: number; good: number}>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly store: CentralMemoryStore,
    private readonly sample: () => MonitorSnapshot,
    private readonly onError: (code: string) => void = () => undefined,
  ) {}

  start(signal: AbortSignal): void {
    if (this.timer || signal.aborted) return;
    this.timer = setInterval(() => this.tick(), INTERVAL_MS);
    this.timer.unref?.();
    signal.addEventListener("abort", () => this.stop(), { once: true });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One bounded synchronous pass; no external API, credentials or user input. */
  tick(): void {
    if (this.running) return;
    this.running = true;
    try {
      const status = this.sample();
      const scopes = this.store.activatedScopes();
      for (const name of SIGNALS) {
        const healthy = name === "workspace_backend"
          ? status.workspaceBackendReady : status.edgeConnectorReady;
        if (typeof healthy !== "boolean") throw new Error("MONITOR_SAMPLE_INVALID");
        const count = this.counters.get(name) ?? {bad: 0, good: 0};
        count.bad = healthy ? 0 : Math.min(FAILURES_BEFORE_REPORT, count.bad + 1);
        count.good = healthy ? Math.min(HEALTHY_BEFORE_RECOVERY, count.good + 1) : 0;
        this.counters.set(name, count);
        if (count.bad < FAILURES_BEFORE_REPORT && count.good < HEALTHY_BEFORE_RECOVERY) continue;
        const observed = healthy ? "recovered" : "unhealthy";
        for (const scope of scopes) {
          try {
            const prior = this.store.activeMonitorIssue(scope.ownerScope, scope.repositoryId, name);
            if (!prior && observed === "recovered") continue;
            const content = JSON.stringify({
              signal: name, observed, cause: "unverified", action: "investigate",
              explanation: observed === "unhealthy"
                ? "Repeated runtime signal failure. Confirm cause and impact before remediation."
                : "Runtime signal recovered. Investigate recurrence before resolving the incident.",
            } satisfies MonitorFinding & {explanation: string});
            if (prior?.content === content) continue;
            const id = prior?.recordId ?? PREFIX + name + ":" + randomUUID();
            const mutation = {
              repositoryId: scope.repositoryId,
              operationId: "monitor:" + randomUUID(),
              action: prior ? "revise" as const : "create" as const,
              recordId: id, expectedRevision: prior?.revision ?? 0,
              kind: "issue" as const, confidence: "inferred" as const,
              title: "MCP runtime signal — " + name,
              content, evidenceRefs: ["monitor:" + name],
            };
            this.store.update(scope.ownerScope, mutation);
          } catch {
            // Retain the failed observation; the next pass retries with fresh CAS.
            this.onError("MONITOR_RECORD_FAILED");
          }
        }
      }
    } catch {
      this.onError("MONITOR_TICK_FAILED");
    } finally {
      this.running = false;
    }
  }
}
