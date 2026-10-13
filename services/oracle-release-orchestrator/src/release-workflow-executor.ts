import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ReleaseOrchestrator } from "./engine/release-orchestrator.js";
import { getWorkflowBlueprint } from "./workflows/index.js";
import type {
  EvidenceInput, ReleaseAction, ReleaseRunSnapshot, StepExecutionClass, StepIntent,
} from "./types.js";

/**
 * Internal typed capability. The trusted host binds implementations to canonical
 * release actions; never accept shell strings or arbitrary names from run data.
 * Authorization is checked by the bound capability before its side effect.
 */
export interface ReleaseStepCapability {
  readonly action: ReleaseAction;
  readonly executionClass: StepExecutionClass;
  authorize(step: ReleaseRunSnapshot["steps"][number], run: ReleaseRunSnapshot): Promise<boolean>;
  execute(intent: StepIntent, run: ReleaseRunSnapshot): Promise<ReleaseStepObservation>;
  reconcile(intent: StepIntent, run: ReleaseRunSnapshot): Promise<ReleaseReconciliation>;
}

export type ReleaseStepObservation =
  | { readonly state: "succeeded"; readonly evidence: readonly EvidenceInput[] }
  | { readonly state: "failed"; readonly evidence: readonly EvidenceInput[]; readonly outcomeCode: string }
  | { readonly state: "outcome_unknown" };

export type ReleaseReconciliation =
  | { readonly outcome: "still_unknown" }
  | { readonly outcome: "applied" | "not_applied"; readonly evidence: readonly EvidenceInput[] };

export type ReleaseExecutionStop =
  | "succeeded" | "failed" | "blocked_missing_capability" | "blocked_unauthorized"
  | "blocked_gate" | "operation_in_progress" | "outcome_unknown" | "reconciled_not_applied" | "step_limit";
export interface ReleaseExecutionResult {
  readonly stop: ReleaseExecutionStop;
  readonly run: ReleaseRunSnapshot;
  readonly executed: number;
  readonly reconciled: number;
}

export interface ReleasePollingOptions {
  readonly maxPolls?: number;
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  /** Used by a trusted host or a deterministic test; no shell/task creation. */
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
export interface ReleasePollingResult {
  readonly status: "terminal" | "poll_limit";
  readonly polls: number;
  readonly latest: ReleaseExecutionResult;
}

const key = (runId: string, stepId: string) =>
  "release-" + createHash("sha256").update(runId + ":" + stepId).digest("hex");
const snapshotIntent = (
  run: ReleaseRunSnapshot, step: ReleaseRunSnapshot["steps"][number],
): StepIntent => ({
  kind: "intent", runId: run.runId, stepId: step.stepId,
  action: step.action, executionClass: step.executionClass,
  operationId: step.operationId!, idempotencyKey: step.idempotencyKey!,
  attemptNumber: step.attemptCount,
});
const stop = (status: ReleaseExecutionStop, run: ReleaseRunSnapshot, executed: number,
  reconciled: number): ReleaseExecutionResult => ({ stop: status, run, executed, reconciled });

/**
 * Executes only capabilities already registered by the trusted host. A persisted
 * intent is reconciled, NEVER dispatched again, including after a process crash.
 * No independent ledger, workflow dispatch client, or public MCP tool is created.
 */
export class ReleaseWorkflowExecutor {
  constructor(
    private readonly orchestrator: ReleaseOrchestrator,
    private readonly capabilities: ReadonlyMap<ReleaseAction, ReleaseStepCapability>,
  ) {}

  async advance(runId: string, actorId: string, maxSteps = 24): Promise<ReleaseExecutionResult> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 32) {
      throw new Error("RELEASE_STEP_BUDGET_INVALID");
    }
    let executed = 0, reconciled = 0;
    let run = this.orchestrator.getRun(runId);
    if (run.status === "planned") run = this.orchestrator.startRun(runId, actorId);
    for (let i = 0; i < maxSteps; i++) {
      run = this.orchestrator.getRun(runId);
      if (run.status === "succeeded" || run.status === "failed") {
        return stop(run.status, run, executed, reconciled);
      }

      const pendingOperation = run.steps.find(s => s.status === "in_progress" || s.status === "outcome_unknown");
      if (pendingOperation) {
        const binding = this.binding(pendingOperation);
        if (!binding) return stop("blocked_missing_capability", run, executed, reconciled);
        const original = snapshotIntent(run, pendingOperation);
        // Another caller may still own an in-flight operation. Only the
        // authoritative startup recovery may transition it to outcome_unknown.
        if (pendingOperation.status === "in_progress") {
          return stop("operation_in_progress", run, executed, reconciled);
        }
        let observation: ReleaseReconciliation = { outcome: "still_unknown" };
        try {
          observation = await binding.reconcile(original, run);
        } catch {
          // An unverifiable observation cannot authorize a retry.
          return stop("outcome_unknown", this.orchestrator.getRun(runId), executed, reconciled);
        }
        reconciled++;
        if (observation.outcome === "still_unknown") {
          return stop("outcome_unknown", this.orchestrator.getRun(runId), executed, reconciled);
        }
        run = this.orchestrator.reconcileOperation(original.operationId, {
          idempotencyKey: key(runId, pendingOperation.stepId) + "-reconciliation",
          actorId, outcome: observation.outcome, evidence: observation.evidence,
        });
        if (observation.outcome === "not_applied") {
          // Retrying even a conclusively not-applied side effect is a separate pass.
          return stop("reconciled_not_applied", run, executed, reconciled);
        }
        const reconciledGate = this.resolveMeasuredGate(run, pendingOperation.stepId,
          observation.evidence, actorId);
        if (reconciledGate === null) return stop("blocked_gate", run, executed, reconciled);
        continue;
      }
      const next = run.steps.find(s => s.status === "pending");
      if (!next) return stop("blocked_gate", run, executed, reconciled);
      const binding = this.binding(next);
      if (!binding) return stop("blocked_missing_capability", run, executed, reconciled);
      // No readiness is inferred by order alone: the canonical ledger enforces
      // dependencies and health gates before the intent is written.
      if (!(await binding.authorize(next, run))) {
        return stop("blocked_unauthorized", run, executed, reconciled);
      }
      const attempt = this.orchestrator.beginStepAttempt(runId, next.stepId, key(runId, next.stepId), actorId);
      if (attempt.kind === "already_completed") continue;
      executed++;
      let result: ReleaseStepObservation;
      try {
        result = await binding.execute(attempt, this.orchestrator.getRun(runId));
      } catch {
        run = this.orchestrator.markOutcomeUnknown(attempt.operationId, "EXECUTION_RESULT_UNVERIFIED", actorId);
        return stop("outcome_unknown", run, executed, reconciled);
      }
      if (result.state === "outcome_unknown") {
        run = this.orchestrator.markOutcomeUnknown(attempt.operationId, "EXECUTION_RESULT_UNVERIFIED", actorId);
        return stop("outcome_unknown", run, executed, reconciled);
      }
      run = this.orchestrator.recordStepOutcome(attempt.operationId, {
        outcome: result.state, evidence: [...result.evidence],
        ...(result.state === "failed" ? { outcomeCode: result.outcomeCode } : {}),
      }, actorId);
      if (result.state === "failed") return stop("failed", run, executed, reconciled);
      const updated = this.resolveMeasuredGate(run, next.stepId, result.evidence, actorId);
      if (updated === null) return stop("blocked_gate", run, executed, reconciled);
      run = updated;
    }
    return stop("step_limit", this.orchestrator.getRun(runId), executed, reconciled);
  }

  /**
   * Wait on the SAME canonical run/operation identities. A new poll reconciles
   * only saved outcome_unknown or observes a concurrently running step; it
   * never retries an uncertain effect. All other stops remain terminal here.
   */
  async poll(
    runId: string, actorId: string, options: ReleasePollingOptions = {},
  ): Promise<ReleasePollingResult> {
    const maxPolls = options.maxPolls ?? 20;
    const intervalMs = options.intervalMs ?? 5_000;
    if (!Number.isSafeInteger(maxPolls) || maxPolls < 1 || maxPolls > 120 ||
        !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 30_000) {
      throw new Error("RELEASE_POLL_BOUNDS_INVALID");
    }
    const wait = options.wait ?? (async (ms: number, signal?: AbortSignal) => {
      await sleep(ms, undefined, signal ? { signal } : {});
    });
    let latest: ReleaseExecutionResult | undefined;
    for (let attempt = 1; attempt <= maxPolls; attempt++) {
      if (options.signal?.aborted) throw new Error("RELEASE_POLL_CANCELLED");
      latest = await this.advance(runId, actorId);
      if (latest.stop !== "outcome_unknown" && latest.stop !== "operation_in_progress") {
        return { status: "terminal", polls: attempt, latest };
      }
      if (attempt < maxPolls) await wait(intervalMs, options.signal);
    }
    return { status: "poll_limit", polls: maxPolls, latest: latest! };
  }

  private resolveMeasuredGate(run: ReleaseRunSnapshot, stepId: string,
    evidence: readonly EvidenceInput[], actorId: string): ReleaseRunSnapshot | null {
    const gate = run.gates.find(g =>
      g.status === "pending" && g.gateId === this.healthGateId(run, stepId));
    if (!gate) return run;
    const provided = new Set(evidence.map(e => e.kind));
    if (!gate.requiredEvidenceKinds.every(kind => provided.has(kind))) return null;
    return this.orchestrator.resolveHealthGate(run.runId, gate.gateId, {
      outcome: "passed", evidence: [...evidence],
      idempotencyKey: key(run.runId, gate.gateId) + "-health", actorId,
    });
  }

  private binding(step: ReleaseRunSnapshot["steps"][number]) {
    const binding = this.capabilities.get(step.action);
    return binding?.action === step.action && binding.executionClass === step.executionClass
      ? binding : undefined;
  }

  private healthGateId(run: ReleaseRunSnapshot, stepId: string): string | undefined {
    // Reuse the registered immutable blueprint; never duplicate gate mappings.
    const blueprint = getWorkflowBlueprint(run.blueprintId, run.blueprintVersion);
    const id = blueprint.steps.find(s => s.id === stepId)?.healthGateId;
    return id && run.gates.some(g => g.gateId === id) ? id : undefined;
  }
}
