import path from "node:path";
import type { LocalAgent } from "../local-agent.js";
import { DelegatedCampaignLedger, type CampaignRecord } from "./delegated-campaign-ledger.js";
import {
  DelegatedCampaignSupervisor,
  type CampaignSupervisorOptions, type CampaignSupervisorReport,
  type TrustedCampaignRegistration,
  type SupervisedCampaignStatus,
} from "./delegated-campaign-supervisor.js";
import type { TypedCampaignCapability } from "./delegated-campaign-coordinator.js";
import { CampaignResourceClaims } from "./campaign-resource-claims.js";

export interface TrustedCampaignEnrollment {
  readonly workspaceId: string;
  readonly campaignId: string;
  /** Supplied by trusted authentication, never restored from user text. */
  readonly ownerScope: string;
  /** A trusted host must reconstruct exact typed arguments on every restart. */
  readonly bind: (agent: LocalAgent, record: CampaignRecord) =>
    Promise<ReadonlyMap<string, TypedCampaignCapability>>;
}
export interface TrustedCampaignHostOptions {
  /** A single secure LOCAL directory shared by all agent processes. */
  readonly stateDirectory: string;
  readonly supervisor?: CampaignSupervisorOptions;
}

/**
 * Opt-in host lifecycle. LocalAgent.create() does not start a campaign;
 * a trusted service must explicitly enroll and call serve(). No tool/schema
 * is exposed. The host, not persisted campaign text, supplies all bindings.
 */
export class TrustedCampaignAgentLifecycle {
  private readonly claims: CampaignResourceClaims;
  private readonly controller = new AbortController();
  private readonly entries: Array<{
    enrollment: TrustedCampaignEnrollment;
    ledger: DelegatedCampaignLedger;
    workspaceKey: string;
  }>;
  private readonly admitted = new Set<string>();
  private readonly completedAtStartup = new Set<string>();
  private active: Promise<CampaignSupervisorReport> | undefined;
  private initialized = false;
  private supervisor: DelegatedCampaignSupervisor | undefined;

  constructor(
    private readonly agent: LocalAgent,
    enrollments: readonly TrustedCampaignEnrollment[],
    private readonly options: TrustedCampaignHostOptions,
  ) {
    if (!path.isAbsolute(options.stateDirectory) ||
        enrollments.length < 1 || enrollments.length > 16) {
      throw new Error("CAMPAIGN_INVALID: host directory or enrollment count");
    }
    const seen = new Set<string>();
    this.claims = new CampaignResourceClaims(options.stateDirectory);
    this.entries = enrollments.map(enrollment => {
      if (!enrollment.ownerScope || enrollment.ownerScope.length > 256 ||
          typeof enrollment.bind !== "function") {
        throw new Error("CAMPAIGN_INVALID: trusted host enrollment");
      }
      const key = enrollment.workspaceId + ":" + enrollment.campaignId;
      if (seen.has(key)) throw new Error("CAMPAIGN_INVALID: duplicate host enrollment");
      seen.add(key);
      return {
        enrollment,
        ledger: new DelegatedCampaignLedger(options.stateDirectory, enrollment.ownerScope),
        // Uses policy-resolved CANONICAL workspace root, not a user-supplied path.
        workspaceKey: agent.resolveWorkspaceConcurrencyKey(enrollment.workspaceId),
      };
    });
  }

  status(): readonly SupervisedCampaignStatus[] {
    if (!this.initialized) return [];
    const admitted = this.supervisor?.status() ?? [];
    const queued = this.entries.filter(e =>
      !this.admitted.has(this.key(e.enrollment)) &&
      !this.completedAtStartup.has(this.key(e.enrollment)),
    ).map(e => ({
      workspaceId: e.enrollment.workspaceId,
      campaignId: e.enrollment.campaignId,
      state: "queued" as const, wakes: 0, executed: 0,
      reconciled: 0, failures: 0, nextDelayMs: 0,
    }));
    return [...admitted, ...queued];
  }

  private key(enrollment: TrustedCampaignEnrollment): string {
    return enrollment.workspaceId + ":" + enrollment.campaignId;
  }

  private register(entry: typeof this.entries[number]): TrustedCampaignRegistration {
    this.admitted.add(this.key(entry.enrollment));
    return {
      workspaceId: entry.enrollment.workspaceId,
      campaignId: entry.enrollment.campaignId,
      ledger: entry.ledger,
      bind: record => entry.enrollment.bind(this.agent, record),
    };
  }

  private async releaseCompletedAndAdmit(): Promise<boolean> {
    // A status label is not sufficient: only persisted verified task proofs
    // allow releasing a writer and admitting the next one for that workspace.
    const occupied = new Set<string>();
    for (const entry of this.entries) {
      if (!this.admitted.has(this.key(entry.enrollment))) continue;
      const plan = await entry.ledger.get(entry.enrollment.workspaceId, entry.enrollment.campaignId);
      if (!plan) throw new Error("CAMPAIGN_NOT_ENROLLED");
      if (!CampaignResourceClaims.needsReservation(plan)) continue;
      const completed = plan.tasks.every(t => t.state === "completed" &&
        t.proof?.kind === "verified");
      if (completed) await this.claims.releaseCompleted(entry.workspaceKey, plan);
      else occupied.add(entry.workspaceKey);
    }
    let added = false;
    for (const entry of this.entries) {
      if (this.admitted.has(this.key(entry.enrollment)) ||
          this.completedAtStartup.has(this.key(entry.enrollment))) continue;
      const plan = await entry.ledger.get(entry.enrollment.workspaceId, entry.enrollment.campaignId);
      if (!plan) throw new Error("CAMPAIGN_NOT_ENROLLED");
      if (!CampaignResourceClaims.needsReservation(plan)) {
        // Read-only tasks were admitted at initialization, never queued.
        throw new Error("CAMPAIGN_INVALID: unadmitted read-only plan");
      }
      if (occupied.has(entry.workspaceKey)) continue;
      // This checks the SAME durable claim across trusted host processes;
      // unknown or malformed ownership is never silently overwritten.
      await this.claims.reserve(entry.workspaceKey, plan);
      if (!this.supervisor) throw new Error("CAMPAIGN_INVALID: supervisor absent");
      this.supervisor.addTrustedRegistration(this.register(entry));
      occupied.add(entry.workspaceKey);
      added = true;
    }
    return added;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    const registrations: TrustedCampaignRegistration[] = [];
    const active = [];
    const mutationRoots = new Set<string>();

    // FULL trusted preflight before touching any mutation reservation.
    for (const entry of this.entries) {
      const record = await entry.ledger.get(
        entry.enrollment.workspaceId, entry.enrollment.campaignId,
      );
      if (!record) throw new Error("CAMPAIGN_NOT_ENROLLED: no persisted delegated objective");
      const bound = await entry.enrollment.bind(this.agent, record);
      for (const task of record.tasks) {
        const capability = bound.get(task.id);
        if (!capability || capability.action !== task.action ||
            capability.targetResource !== task.targetResource ||
            capability.expectedState !== task.expectedState ||
            capability.argumentsDigest !== task.argumentsDigest ||
            typeof capability.execute !== "function" ||
            typeof capability.reconcile !== "function" ||
            typeof capability.verify !== "function") {
          throw new Error("CAMPAIGN_BINDING_MISMATCH: trusted enrollment changed");
        }
      }
      const isCompleted = record.tasks.every(t => t.state === "completed" &&
        t.proof?.kind === "verified");
      const mutating = CampaignResourceClaims.needsReservation(record);
      active.push({ ...entry, record, isCompleted, mutating });
    }
    // Reconcile reservations of already-completed plans FIRST. Crashes may
    // happen after the verified ledger transition but before release.
    for (const entry of active) {
      if (entry.isCompleted && entry.mutating) {
        await this.claims.releaseCompleted(entry.workspaceKey, entry.record);
      }
    }
    for (const entry of active) {
      if (entry.isCompleted) {
        this.completedAtStartup.add(this.key(entry.enrollment));
        continue;
      }
      if (entry.mutating && mutationRoots.has(entry.workspaceKey)) {
        // Preserve admission order; do not mutate a resource already owned by
        // an unfinished campaign. It can enter once that owner completes.
        continue;
      }
      if (entry.mutating) {
        await this.claims.reserve(entry.workspaceKey, entry.record);
        mutationRoots.add(entry.workspaceKey);
      }
      registrations.push(this.register(entry));
    }
    if (registrations.length > 0) {
      this.supervisor = new DelegatedCampaignSupervisor(registrations,
        this.options.supervisor);
    }
    this.initialized = true;
  }

  async serve(maxWakes = 64, signal?: AbortSignal): Promise<CampaignSupervisorReport> {
    if (!Number.isSafeInteger(maxWakes) || maxWakes < 1 || maxWakes > 1024) {
      throw new Error("CAMPAIGN_INVALID: maxWakes");
    }
    if (this.active) throw new Error("CAMPAIGN_ALREADY_SUPERVISING");
    if (this.controller.signal.aborted) throw new Error("CAMPAIGN_HOST_STOPPED");
    const run = async (): Promise<CampaignSupervisorReport> => {
      if (this.controller.signal.aborted || signal?.aborted) {
        return { stop: "stopped", wakes: 0, campaigns: this.status() };
      }
      await this.initialize();
      const effective = signal
        ? AbortSignal.any([signal, this.controller.signal])
        : this.controller.signal;
      if (!this.supervisor) return {
        stop: "all_completed", wakes: 0, campaigns: this.status(),
      };
      let wakes = 0;
      while (!effective.aborted && wakes < maxWakes) {
        // Admission is checked between bounded wakeups, not while a typed
        // invocation is in flight. Other workspaces remain runnable.
        await this.releaseCompletedAndAdmit();
        const report = await this.supervisor.serve(effective, 1);
        wakes += report.wakes;
        const admitted = await this.releaseCompletedAndAdmit();
        if (report.wakes === 0 && !admitted) break;
        if (this.status().every(s => s.state === "completed")) break;
      }
      const status = this.status();
      return {
        stop: effective.aborted ? "stopped"
          : status.every(s => s.state === "completed") ? "all_completed"
          : status.some(s => s.state === "needs_attention" || s.state === "blocked") &&
            status.every(s => s.state !== "ready" && s.state !== "awaiting_reconciliation")
            ? "needs_attention" : "wake_budget",
        wakes, campaigns: status,
      };
    };
    const pending = run();
    this.active = pending;
    try { return await pending; }
    finally { if (this.active === pending) this.active = undefined; }
  }

  /** Cooperative stop, awaiting any typed invocation already in progress. */
  async shutdown(): Promise<void> {
    this.controller.abort();
    if (this.active) await this.active;
  }
}
