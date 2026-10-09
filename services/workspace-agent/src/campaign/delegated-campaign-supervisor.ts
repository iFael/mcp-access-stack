import { setTimeout as delay } from "node:timers/promises";
import type { CampaignRecord } from "./delegated-campaign-ledger.js";
import { DelegatedCampaignLedger } from "./delegated-campaign-ledger.js";
import type { TypedCampaignCapability } from "./delegated-campaign-coordinator.js";
import { DelegatedCampaignSessionRunner } from "./delegated-campaign-session-runner.js";

/**
 * In-process supervisor for a trusted host. Registrations are supplied by
 * an authenticated host bootstrap; they are never reconstructed from a chat
 * message or a persisted arbitrary tool name.
 *
 * Calling serve() does NOT install or start a daemon. Only an explicitly
 * deployed, trusted service may keep this process alive after a conversation.
 */
export interface TrustedCampaignRegistration {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly ledger: DelegatedCampaignLedger;
  readonly bind: (record: CampaignRecord) =>
    Promise<ReadonlyMap<string, TypedCampaignCapability>>;
}
export type SupervisedCampaignState =
  | "ready" | "queued" | "awaiting_reconciliation" | "completed" | "blocked" | "needs_attention";
export interface SupervisedCampaignStatus {
  readonly workspaceId: string;
  readonly campaignId: string;
  readonly state: SupervisedCampaignState;
  readonly wakes: number;
  readonly executed: number;
  readonly reconciled: number;
  readonly failures: number;
  readonly nextDelayMs: number;
}
export interface CampaignSupervisorOptions {
  /** Maximum operations in a single call to the bounded session runner. */
  readonly maxStepsPerWake?: number;
  readonly idlePollMs?: number;
  readonly unknownPollMs?: number;
  readonly failureBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Trusted host clock, test-only override. */
  readonly now?: () => number;
  /** Trusted test seam. Production waits using an abort-aware Node timer. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}
export interface CampaignSupervisorReport {
  readonly stop: "all_completed" | "stopped" | "wake_budget" | "needs_attention";
  readonly wakes: number;
  readonly campaigns: readonly SupervisedCampaignStatus[];
}
type MutableStatus = {
  workspaceId: string;
  campaignId: string;
  state: SupervisedCampaignState;
  wakes: number;
  executed: number;
  reconciled: number;
  failures: number;
  nextDelayMs: number;
};
type Entry = {
  readonly registration: TrustedCampaignRegistration;
  readonly status: MutableStatus;
  dueAt: number;
  readonly runner: DelegatedCampaignSessionRunner;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WORKSPACE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("CAMPAIGN_INVALID: " + name);
  }
  return value;
}
function abortAwareWait(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).then(() => undefined);
}
/**
 * Fail-closed policy: authorization/binder errors require a new trusted
 * registration. A temporarily occupied run lock may be polled after backoff;
 * no native mutating operation is replayed by the coordinator.
 */
function recoverableLock(error: unknown): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error && error.code === "EEXIST";
}

export class DelegatedCampaignSupervisor {
  private readonly entries: Entry[];
  private readonly maxSteps: number;
  private readonly idlePollMs: number;
  private readonly unknownPollMs: number;
  private readonly failureBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private serving = false;

  constructor(
    registrations: readonly TrustedCampaignRegistration[],
    options: CampaignSupervisorOptions = {},
  ) {
    if (registrations.length < 1 || registrations.length > 16) {
      throw new Error("CAMPAIGN_INVALID: bounded trusted registrations");
    }
    this.maxSteps = bounded(options.maxStepsPerWake ?? 8, 1, 128, "maxStepsPerWake");
    this.idlePollMs = bounded(options.idlePollMs ?? 1000, 100, 86_400_000, "idlePollMs");
    this.unknownPollMs = bounded(options.unknownPollMs ?? 5000, 100, 86_400_000, "unknownPollMs");
    this.failureBackoffMs = bounded(options.failureBackoffMs ?? 5000, 100, 86_400_000, "failureBackoffMs");
    this.maxBackoffMs = bounded(options.maxBackoffMs ?? 60000,
      Math.max(this.unknownPollMs, this.failureBackoffMs), 86_400_000, "maxBackoffMs");
    this.wait = options.wait ?? abortAwareWait;
    this.now = options.now ?? Date.now;

    this.entries = [];
    for (const registration of registrations) this.addTrustedRegistration(registration);
  }

  /**
   * Admit the next preflighted campaign after its predecessor has released
   * the durable workspace claim. Not an externally accessible enrollment API.
   */
  addTrustedRegistration(registration: TrustedCampaignRegistration): void {
    if (this.serving) throw new Error("CAMPAIGN_ALREADY_SUPERVISING");
    if (this.entries.length >= 16 ||
        !WORKSPACE.test(registration.workspaceId) ||
        !UUID.test(registration.campaignId) ||
        !(registration.ledger instanceof DelegatedCampaignLedger) ||
        typeof registration.bind !== "function") {
      throw new Error("CAMPAIGN_INVALID: trusted campaign registration");
    }
    if (this.entries.some(e => e.registration.workspaceId === registration.workspaceId &&
        e.registration.campaignId === registration.campaignId)) {
      throw new Error("CAMPAIGN_INVALID: duplicate campaign registration");
    }
    this.entries.push({
      registration,
      status: {
        workspaceId: registration.workspaceId, campaignId: registration.campaignId,
        state: "ready", wakes: 0, executed: 0, reconciled: 0, failures: 0, nextDelayMs: 0,
      },
      dueAt: 0,
      runner: new DelegatedCampaignSessionRunner(registration.ledger, registration.bind),
    });
  }

  status(): readonly SupervisedCampaignStatus[] {
    return this.entries.map(entry => ({ ...entry.status }));
  }

  /**
   * One bounded supervision epoch. The caller may create a new supervisor
   * after restart using the same persisted ledgers and trusted registrations.
   */
  async serve(signal: AbortSignal, maxWakes = 64): Promise<CampaignSupervisorReport> {
    bounded(maxWakes, 1, 1024, "maxWakes");
    if (this.serving) throw new Error("CAMPAIGN_ALREADY_SUPERVISING");
    this.serving = true;
    let wakes = 0;
    try {
      while (!signal.aborted && wakes < maxWakes) {
        const eligible = this.entries.filter(e =>
          e.status.state === "ready" || e.status.state === "awaiting_reconciliation",
        );
        if (eligible.length === 0) break;
        // Round-robin on ties to prevent one busy campaign monopolizing a
        // worker. Defer each campaign by idlePollMs even on step_budget.
        eligible.sort((a, b) => a.dueAt - b.dueAt ||
          a.status.wakes - b.status.wakes);
        const entry = eligible[0]!;
        if (entry.dueAt > this.now()) {
          try { await this.wait(entry.dueAt - this.now(), signal); }
          catch (error) {
            if (signal.aborted) break;
            throw error;
          }
          if (signal.aborted) break;
        }
        wakes++;
        await this.wake(entry);
      }
    } finally {
      this.serving = false;
    }
    return {
      stop: signal.aborted ? "stopped"
        : this.entries.every(e => e.status.state === "completed") ? "all_completed"
        : this.entries.some(e => e.status.state === "needs_attention" || e.status.state === "blocked") &&
          this.entries.every(e => !["ready","awaiting_reconciliation"].includes(e.status.state))
          ? "needs_attention" : "wake_budget",
      wakes,
      campaigns: this.status(),
    };
  }

  private async wake(entry: Entry): Promise<void> {
    const s = entry.status;
    s.wakes++;
    try {
      // All dispatches go through the bounded trusted typed session runner.
      const result = await entry.runner.run({
        workspaceId: entry.registration.workspaceId,
        campaignId: entry.registration.campaignId,
        maxPasses: 1,
        maxStepsPerPass: this.maxSteps,
      });
      s.executed += result.executed;
      s.reconciled += result.reconciled;
      s.failures = 0;
      if (result.stop === "all_completed") {
        s.state = "completed"; s.nextDelayMs = 0; return;
      }
      if (result.stop === "no_runnable_step") {
        s.state = "blocked"; s.nextDelayMs = 0; return;
      }
      if (result.stop === "awaiting_reconciliation") {
        s.state = "awaiting_reconciliation";
        s.nextDelayMs = Math.min(this.maxBackoffMs,
          Math.max(this.unknownPollMs, s.nextDelayMs * 2));
      } else {
        s.state = "ready";
        s.nextDelayMs = this.idlePollMs;
      }
    } catch (error) {
      // A lock holder could be running in another process. Poll safely later;
      // never override it or create a second operationId.
      if (!recoverableLock(error)) {
        s.state = "needs_attention"; s.nextDelayMs = 0; return;
      }
      s.failures++;
      if (s.failures >= 4) {
        s.state = "needs_attention";
        s.nextDelayMs = 0;
        return;
      }
      s.state = "awaiting_reconciliation";
      s.nextDelayMs = Math.min(this.maxBackoffMs,
        Math.max(this.failureBackoffMs,
          this.failureBackoffMs * 2 ** Math.min(s.failures - 1, 16)));
    }
    entry.dueAt = this.now() + s.nextDelayMs;
  }
}
