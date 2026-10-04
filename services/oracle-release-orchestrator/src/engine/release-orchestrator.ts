import { createHash, randomUUID } from "node:crypto";
import { fail } from "../errors.js";
import { SqliteReleaseLedger } from "../storage/sqlite-release-ledger.js";
import type {
  BeginStepResult,
  EvidenceCursor,
  EvidenceInput,
  EvidencePage,
  EvidenceRecord,
  HealthGateSnapshot,
  ReconciliationOutcome,
  ReleaseAttemptStatus,
  ReleaseAuditEntry,
  ReleaseRunCursor,
  ReleaseRunEvent,
  ReleaseRunPage,
  ReleaseRunRequest,
  ReleaseRunSnapshot,
  ReleaseRunStatus,
  ReleaseStage,
  ReleaseStepSnapshot,
  ReleaseStepStatus,
  StepDefinition,
  StepOutcome,
  StepIntent,
  ReleaseWorkflowBlueprint,
} from "../types.js";
import { listWorkflowBlueprints } from "../workflows/index.js";
import { validateWorkflowBlueprint } from "../workflows/validate-blueprint.js";

interface RunRow {
  run_id: string;
  blueprint_id: string;
  blueprint_version: number;
  blueprint_sha256: string;
  target_release: string;
  source_commit_sha: string;
  status: ReleaseRunStatus;
  create_idempotency_key: string;
  create_request_sha256: string;
  created_at: string;
  updated_at: string;
  last_seq: number;
}

interface StepRow {
  run_id: string;
  step_id: string;
  ordinal: number;
  stage: ReleaseStage;
  action: StepDefinition["action"];
  execution_class: StepDefinition["executionClass"];
  definition_json: string;
  status: ReleaseStepStatus;
  attempt_count: number;
  operation_id: string | null;
  idempotency_key: string | null;
}

interface GateRow {
  run_id: string;
  gate_id: string;
  stage: ReleaseStage;
  status: HealthGateSnapshot["status"];
  required_evidence_kinds_json: string;
  evidence_ids_json: string;
}

interface AttemptRow {
  attempt_id: string;
  run_id: string;
  step_id: string;
  attempt_number: number;
  operation_id: string;
  idempotency_key: string;
  status: ReleaseAttemptStatus;
  outcome_code: string | null;
  result_request_sha256: string | null;
}

interface EvidenceRow {
  evidence_id: string;
  run_id: string;
  step_id: string | null;
  kind: string;
  source: string;
  sha256: string;
  observed_at: string;
  recorded_at: string;
}

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

export interface CreateRunResult {
  readonly run: ReleaseRunSnapshot;
  readonly created: boolean;
}

export interface RecordStepOutcomeInput {
  readonly outcome: StepOutcome;
  readonly outcomeCode?: string;
  readonly evidence?: readonly EvidenceInput[];
}

export interface ReconcileOperationInput {
  readonly idempotencyKey: string;
  readonly outcome: ReconciliationOutcome;
  readonly evidence?: readonly EvidenceInput[];
  readonly actorId: string;
}

export interface ResolveHealthGateInput {
  readonly idempotencyKey: string;
  readonly outcome: "passed" | "failed";
  readonly evidence: readonly EvidenceInput[];
  readonly actorId: string;
}

export class ReleaseOrchestrator {
  private readonly blueprints: ReadonlyMap<string, ReleaseWorkflowBlueprint>;

  public constructor(
    private readonly ledger: SqliteReleaseLedger,
    blueprints: readonly ReleaseWorkflowBlueprint[] = listWorkflowBlueprints(),
  ) {
    this.blueprints = new Map(
      blueprints.map((blueprint) => [blueprintKey(blueprint.id, blueprint.version), blueprint]),
    );
    for (const blueprint of blueprints) validateWorkflowBlueprint(blueprint);
    this.ledger.transaction(() => {
      for (const blueprint of blueprints) this.registerBlueprint(blueprint);
    });
  }

  public createRun(request: ReleaseRunRequest): CreateRunResult {
    validateRunRequest(request);
    const blueprint = this.requireBlueprint(request.blueprintId, request.blueprintVersion);
    const blueprintJson = canonicalJson(blueprint);
    const blueprintSha256 = sha256(blueprintJson);
    const requestSha256 = sha256(
      canonicalJson({
        blueprintId: request.blueprintId,
        blueprintVersion: request.blueprintVersion,
        targetRelease: request.targetRelease,
        sourceCommitSha: request.sourceCommitSha,
        actorId: request.actorId,
      }),
    );

    return this.ledger.transaction(() => {
      const existing = this.ledger.get<RunRow>(
        "SELECT * FROM release_runs WHERE create_idempotency_key = ?",
        [request.idempotencyKey],
      );
      if (existing) {
        if (existing.create_request_sha256 !== requestSha256) {
          fail(
            "IDEMPOTENCY_KEY_CONFLICT",
            "Run idempotency key was already used with different release inputs.",
          );
        }
        return { run: this.getRun(existing.run_id), created: false };
      }

      const registered = this.ledger.get<{ sha256: string }>(
        "SELECT sha256 FROM workflow_blueprints WHERE blueprint_id = ? AND version = ?",
        [blueprint.id, blueprint.version],
      );
      if (!registered || registered.sha256 !== blueprintSha256) {
        fail("BLUEPRINT_VERSION_CONFLICT", "Persisted blueprint does not match source.");
      }

      const now = new Date().toISOString();
      const runId = randomUUID();
      this.ledger.run(
        `INSERT INTO release_runs (
          run_id, blueprint_id, blueprint_version, blueprint_sha256,
          target_release, source_commit_sha, status, create_idempotency_key,
          create_request_sha256, created_at, updated_at, last_seq
        ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, 0)`,
        [
          runId,
          blueprint.id,
          blueprint.version,
          blueprintSha256,
          request.targetRelease,
          request.sourceCommitSha,
          request.idempotencyKey,
          requestSha256,
          now,
          now,
        ],
      );

      blueprint.steps.forEach((step, ordinal) => {
        this.ledger.run(
          `INSERT INTO run_steps (
            run_id, step_id, ordinal, stage, action, execution_class,
            definition_json, status, attempt_count, operation_id, idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL)`,
          [
            runId,
            step.id,
            ordinal,
            step.stage,
            step.action,
            step.executionClass,
            canonicalJson(step),
          ],
        );
      });
      for (const gate of blueprint.gates) {
        this.ledger.run(
          `INSERT INTO run_health_gates (
            run_id, gate_id, stage, status, required_evidence_kinds_json, evidence_ids_json
          ) VALUES (?, ?, ?, 'pending', ?, '[]')`,
          [runId, gate.id, gate.stage, JSON.stringify(gate.requiredEvidenceKinds)],
        );
      }

      this.appendEvent(
        runId,
        "run.created",
        {
          blueprintId: blueprint.id,
          blueprintVersion: blueprint.version,
          blueprintSha256,
          targetRelease: request.targetRelease,
          sourceCommitSha: request.sourceCommitSha,
        },
        request.actorId,
        now,
      );
      return { run: this.getRun(runId), created: true };
    });
  }

  public startRun(runId: string, actorId: string): ReleaseRunSnapshot {
    validateRunId(runId);
    validateActor(actorId);
    return this.ledger.transaction(() => {
      const run = this.requireRun(runId);
      if (run.status === "running") return this.getRun(runId);
      if (run.status !== "planned") {
        fail("INVALID_TRANSITION", `Cannot start run from ${run.status}.`);
      }
      const now = new Date().toISOString();
      this.ledger.run(
        "UPDATE release_runs SET status = 'running', updated_at = ? WHERE run_id = ?",
        [now, runId],
      );
      this.appendEvent(runId, "run.started", {}, actorId, now);
      return this.getRun(runId);
    });
  }

  public beginStepAttempt(
    runId: string,
    stepId: string,
    idempotencyKey: string,
    actorId: string,
  ): BeginStepResult {
    validateRunId(runId);
    validateIdentifier(stepId, "stepId");
    validateIdempotencyKey(idempotencyKey);
    validateActor(actorId);

    return this.ledger.transaction(() => {
      const run = this.requireRun(runId);
      if (run.status !== "running") {
        fail(
          run.status === "paused_outcome_unknown" ? "RECONCILIATION_REQUIRED" : "INVALID_TRANSITION",
          `Cannot begin a step while run is ${run.status}.`,
        );
      }

      const row = this.requireStep(runId, stepId);
      const keyOwner = this.ledger.get<{ step_id: string }>(
        "SELECT step_id FROM run_steps WHERE run_id = ? AND idempotency_key = ?",
        [runId, idempotencyKey],
      );
      if (keyOwner && keyOwner.step_id !== stepId) {
        fail("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key is already assigned to another step.");
      }
      const definition = JSON.parse(row.definition_json) as StepDefinition;
      if (row.status === "succeeded" && row.operation_id) {
        if (row.idempotency_key !== idempotencyKey) {
          fail("IDEMPOTENCY_KEY_CONFLICT", "Completed step was called with another idempotency key.");
        }
        return {
          kind: "already_completed",
          runId,
          stepId,
          operationId: row.operation_id,
        };
      }
      if (row.status === "in_progress" || row.status === "outcome_unknown") {
        fail(
          "RECONCILIATION_REQUIRED",
          `Step ${stepId} has a persisted operation that must be reconciled before retry.`,
        );
      }
      if (row.status !== "pending") {
        fail("INVALID_TRANSITION", `Cannot begin step ${stepId} from ${row.status}.`);
      }

      for (const dependencyId of definition.dependsOn) {
        const dependency = this.requireStep(runId, dependencyId);
        if (dependency.status !== "succeeded") {
          fail(
            "DEPENDENCY_NOT_SATISFIED",
            `Step ${stepId} is waiting for ${dependencyId}.`,
          );
        }
      }
      for (const gateId of definition.requiredGates) {
        const gate = this.ledger.get<GateRow>(
          "SELECT * FROM run_health_gates WHERE run_id = ? AND gate_id = ?",
          [runId, gateId],
        );
        if (!gate || gate.status !== "passed") {
          fail("GATE_NOT_PASSED", `Step ${stepId} requires passed gate ${gateId}.`);
        }
      }

      let operationId = row.operation_id;
      if (operationId) {
        if (row.idempotency_key !== idempotencyKey) {
          fail(
            "IDEMPOTENCY_KEY_CONFLICT",
            "A reconciled retry must reuse the original idempotency key.",
          );
        }
        const previousAttempt = this.ledger.get<AttemptRow>(
          `SELECT * FROM step_attempts
           WHERE run_id = ? AND step_id = ?
           ORDER BY attempt_number DESC LIMIT 1`,
          [runId, stepId],
        );
        if (previousAttempt?.status !== "resolved_not_applied") {
          fail(
            "RECONCILIATION_REQUIRED",
            "The previous operation must be proven not applied before retry.",
          );
        }
      } else {
        operationId = randomUUID();
      }

      const attemptNumber = row.attempt_count + 1;
      const attemptId = randomUUID();
      const now = new Date().toISOString();
      this.ledger.run(
        `UPDATE run_steps
         SET status = 'in_progress', attempt_count = ?, operation_id = ?, idempotency_key = ?
         WHERE run_id = ? AND step_id = ?`,
        [attemptNumber, operationId, idempotencyKey, runId, stepId],
      );
      this.ledger.run(
        `INSERT INTO step_attempts (
          attempt_id, run_id, step_id, attempt_number, operation_id,
          idempotency_key, status, intent_recorded_at, completed_at, outcome_code
        ) VALUES (?, ?, ?, ?, ?, ?, 'intent_recorded', ?, NULL, NULL)`,
        [attemptId, runId, stepId, attemptNumber, operationId, idempotencyKey, now],
      );
      this.appendEvent(
        runId,
        "step.intent_recorded",
        {
          stepId,
          action: definition.action,
          operationId,
          attemptNumber,
          executionClass: definition.executionClass,
        },
        actorId,
        now,
      );

      const intent: StepIntent = {
        kind: "intent",
        runId,
        stepId,
        action: definition.action,
        operationId,
        idempotencyKey,
        attemptNumber,
        executionClass: definition.executionClass,
      };
      return intent;
    });
  }

  public recordStepOutcome(
    operationId: string,
    input: RecordStepOutcomeInput,
    actorId: string,
  ): ReleaseRunSnapshot {
    validateIdentifier(operationId, "operationId");
    validateActor(actorId);
    validateOutcomeCode(input.outcomeCode);
    const resultRequestSha256 = sha256(
      canonicalJson({
        outcome: input.outcome,
        outcomeCode: input.outcomeCode ?? null,
        evidence: input.evidence ?? [],
        actorId,
      }),
    );
    return this.ledger.transaction(() => {
      const attempt = this.requireLatestAttempt(operationId);
      const step = this.requireStep(attempt.run_id, attempt.step_id);
      if (attempt.status === "succeeded" || attempt.status === "failed") {
        if (
          attempt.result_request_sha256 &&
          attempt.result_request_sha256 !== resultRequestSha256
        ) {
          fail("IDEMPOTENCY_KEY_CONFLICT", "Operation result was already recorded differently.");
        }
        return this.getRun(attempt.run_id);
      }
      if (attempt.status !== "intent_recorded") {
        fail(
          "RECONCILIATION_REQUIRED",
          "An ambiguous operation must be reconciled before accepting a new result.",
        );
      }

      const definition = JSON.parse(step.definition_json) as StepDefinition;
      const now = new Date().toISOString();
      const evidenceIds = this.persistEvidence(
        attempt.run_id,
        attempt.step_id,
        input.evidence ?? [],
        now,
      );
      const succeeded = input.outcome === "succeeded";
      this.ledger.run(
        `UPDATE step_attempts
         SET status = ?, completed_at = ?, outcome_code = ?, result_request_sha256 = ?
         WHERE attempt_id = ?`,
        [
          succeeded ? "succeeded" : "failed",
          now,
          input.outcomeCode ?? null,
          resultRequestSha256,
          attempt.attempt_id,
        ],
      );
      this.ledger.run(
        "UPDATE run_steps SET status = ? WHERE run_id = ? AND step_id = ?",
        [succeeded ? "succeeded" : "failed", attempt.run_id, attempt.step_id],
      );

      if (
        succeeded &&
        definition.healthGateId &&
        evidenceIds.length === 0
      ) {
        fail(
          "INVALID_ARGUMENT",
          `Health gate measurement ${attempt.step_id} requires evidence.`,
        );
      }

      if (!succeeded) {
        this.ledger.run(
          "UPDATE release_runs SET status = 'failed', updated_at = ? WHERE run_id = ?",
          [now, attempt.run_id],
        );
      }
      this.appendEvent(
        attempt.run_id,
        succeeded ? "step.succeeded" : "step.failed",
        {
          stepId: attempt.step_id,
          operationId,
          attemptNumber: attempt.attempt_number,
          outcomeCode: input.outcomeCode ?? null,
          evidenceIds,
        },
        actorId,
        now,
      );
      if (succeeded) this.maybeCompleteRun(attempt.run_id, actorId, now);
      return this.getRun(attempt.run_id);
    });
  }

  public markOutcomeUnknown(
    operationId: string,
    reasonCode: string,
    actorId: string,
  ): ReleaseRunSnapshot {
    validateIdentifier(operationId, "operationId");
    validateIdentifier(reasonCode, "reasonCode");
    validateActor(actorId);
    return this.ledger.transaction(() => {
      const attempt = this.requireLatestAttempt(operationId);
      const step = this.requireStep(attempt.run_id, attempt.step_id);
      if (attempt.status === "outcome_unknown") return this.getRun(attempt.run_id);
      if (attempt.status !== "intent_recorded") {
        fail("INVALID_TRANSITION", `Cannot mark operation unknown from ${attempt.status}.`);
      }
      const now = new Date().toISOString();
      const definition = JSON.parse(step.definition_json) as StepDefinition;
      this.ledger.run(
        "UPDATE step_attempts SET status = 'outcome_unknown' WHERE attempt_id = ?",
        [attempt.attempt_id],
      );
      this.ledger.run(
        "UPDATE run_steps SET status = 'outcome_unknown' WHERE run_id = ? AND step_id = ?",
        [attempt.run_id, attempt.step_id],
      );
      if (definition.healthGateId) {
        this.ledger.run(
          "UPDATE run_health_gates SET status = 'outcome_unknown' WHERE run_id = ? AND gate_id = ?",
          [attempt.run_id, definition.healthGateId],
        );
      }
      this.ledger.run(
        "UPDATE release_runs SET status = 'paused_outcome_unknown', updated_at = ? WHERE run_id = ?",
        [now, attempt.run_id],
      );
      this.appendEvent(
        attempt.run_id,
        "operation.outcome_unknown",
        {
          stepId: attempt.step_id,
          operationId,
          attemptNumber: attempt.attempt_number,
          reasonCode,
        },
        actorId,
        now,
      );
      return this.getRun(attempt.run_id);
    });
  }

  public reconcileOperation(
    operationId: string,
    input: ReconcileOperationInput,
  ): ReleaseRunSnapshot {
    validateIdentifier(operationId, "operationId");
    validateIdempotencyKey(input.idempotencyKey);
    validateActor(input.actorId);
    if (input.outcome !== "still_unknown" && (input.evidence?.length ?? 0) === 0) {
      fail(
        "INVALID_ARGUMENT",
        "A conclusive reconciliation requires evidence proving the external state.",
      );
    }
    return this.ledger.transaction(() => {
      const attempt = this.requireLatestAttempt(operationId);
      const requestSha256 = sha256(
        canonicalJson({
          operationId,
          outcome: input.outcome,
          evidence: input.evidence ?? [],
          actorId: input.actorId,
        }),
      );
      const prior = this.ledger.get<{
        request_sha256: string;
      }>(
        "SELECT request_sha256 FROM operation_reconciliations WHERE run_id = ? AND idempotency_key = ?",
        [attempt.run_id, input.idempotencyKey],
      );
      if (prior) {
        if (prior.request_sha256 !== requestSha256) {
          fail(
            "IDEMPOTENCY_KEY_CONFLICT",
            "Reconciliation idempotency key was reused with a different observation.",
          );
        }
        return this.getRun(attempt.run_id);
      }
      if (attempt.status !== "outcome_unknown") {
        fail("INVALID_TRANSITION", "Only an outcome_unknown operation can be reconciled.");
      }

      const now = new Date().toISOString();
      const evidenceIds = this.persistEvidence(
        attempt.run_id,
        attempt.step_id,
        input.evidence ?? [],
        now,
      );
      this.ledger.run(
        `INSERT INTO operation_reconciliations (
          reconciliation_id, run_id, step_id, operation_id, idempotency_key,
          request_sha256, outcome, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          attempt.run_id,
          attempt.step_id,
          operationId,
          input.idempotencyKey,
          requestSha256,
          input.outcome,
          now,
        ],
      );

      const step = this.requireStep(attempt.run_id, attempt.step_id);
      const definition = JSON.parse(step.definition_json) as StepDefinition;
      if (input.outcome === "applied") {
        this.ledger.run(
          "UPDATE step_attempts SET status = 'succeeded', completed_at = ?, outcome_code = 'RECONCILED_APPLIED' WHERE attempt_id = ?",
          [now, attempt.attempt_id],
        );
        this.ledger.run(
          "UPDATE run_steps SET status = 'succeeded' WHERE run_id = ? AND step_id = ?",
          [attempt.run_id, attempt.step_id],
        );
        if (definition.healthGateId) {
          this.ledger.run(
            "UPDATE run_health_gates SET status = 'pending', evidence_ids_json = '[]' WHERE run_id = ? AND gate_id = ?",
            [attempt.run_id, definition.healthGateId],
          );
        }
      } else if (input.outcome === "not_applied") {
        this.ledger.run(
          "UPDATE step_attempts SET status = 'resolved_not_applied', completed_at = ?, outcome_code = 'RECONCILED_NOT_APPLIED' WHERE attempt_id = ?",
          [now, attempt.attempt_id],
        );
        this.ledger.run(
          "UPDATE run_steps SET status = 'pending' WHERE run_id = ? AND step_id = ?",
          [attempt.run_id, attempt.step_id],
        );
        if (definition.healthGateId) {
          this.ledger.run(
            "UPDATE run_health_gates SET status = 'pending' WHERE run_id = ? AND gate_id = ?",
            [attempt.run_id, definition.healthGateId],
          );
        }
      }

      this.appendEvent(
        attempt.run_id,
        `operation.reconciled_${input.outcome}`,
        {
          stepId: attempt.step_id,
          operationId,
          attemptNumber: attempt.attempt_number,
          evidenceIds,
        },
        input.actorId,
        now,
      );
      this.resumeIfNoUnknownOperations(attempt.run_id, now);
      this.maybeCompleteRun(attempt.run_id, input.actorId, now);
      return this.getRun(attempt.run_id);
    });
  }

  /**
   * Must run exactly once when the single authoritative Oracle process starts.
   * Persisted intents cannot prove whether their external effect happened.
   */
  public recoverInterruptedOperations(actorId: string): number {
    validateActor(actorId);
    return this.ledger.transaction(() => {
      const interrupted = this.ledger.all<AttemptRow>(
        `SELECT * FROM step_attempts
         WHERE status = 'intent_recorded'
         ORDER BY run_id, step_id, attempt_number`,
      );
      let recovered = 0;
      for (const attempt of interrupted) {
        const step = this.requireStep(attempt.run_id, attempt.step_id);
        const definition = JSON.parse(step.definition_json) as StepDefinition;
        const now = new Date().toISOString();
        this.ledger.run(
          "UPDATE step_attempts SET status = 'outcome_unknown' WHERE attempt_id = ? AND status = 'intent_recorded'",
          [attempt.attempt_id],
        );
        this.ledger.run(
          "UPDATE run_steps SET status = 'outcome_unknown' WHERE run_id = ? AND step_id = ?",
          [attempt.run_id, attempt.step_id],
        );
        if (definition.healthGateId) {
          this.ledger.run(
            "UPDATE run_health_gates SET status = 'outcome_unknown' WHERE run_id = ? AND gate_id = ?",
            [attempt.run_id, definition.healthGateId],
          );
        }
        this.ledger.run(
          "UPDATE release_runs SET status = 'paused_outcome_unknown', updated_at = ? WHERE run_id = ?",
          [now, attempt.run_id],
        );
        this.appendEvent(
          attempt.run_id,
          "operation.recovered_as_unknown",
          {
            stepId: attempt.step_id,
            operationId: attempt.operation_id,
            attemptNumber: attempt.attempt_number,
          },
          actorId,
          now,
        );
        recovered += 1;
      }
      return recovered;
    });
  }

  public resolveHealthGate(
    runId: string,
    gateId: string,
    input: ResolveHealthGateInput,
  ): ReleaseRunSnapshot {
    validateRunId(runId);
    validateIdentifier(gateId, "gateId");
    validateIdempotencyKey(input.idempotencyKey);
    validateActor(input.actorId);
    if (input.outcome === "passed" && input.evidence.length === 0) {
      fail("INVALID_ARGUMENT", "A passing health gate requires evidence.");
    }
    const requestSha256 = sha256(
      canonicalJson({
        runId,
        gateId,
        outcome: input.outcome,
        evidence: input.evidence,
      }),
    );

    return this.ledger.transaction(() => {
      const run = this.requireRun(runId);
      const prior = this.ledger.get<{ request_sha256: string }>(
        "SELECT request_sha256 FROM health_gate_decisions WHERE run_id = ? AND idempotency_key = ?",
        [runId, input.idempotencyKey],
      );
      if (prior) {
        if (prior.request_sha256 !== requestSha256) {
          fail("IDEMPOTENCY_KEY_CONFLICT", "Gate idempotency key was reused differently.");
        }
        return this.getRun(runId);
      }
      const priorGate = this.ledger.get<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM health_gate_decisions WHERE run_id = ? AND gate_id = ?",
        [runId, gateId],
      );
      if (priorGate) {
        fail("INVALID_TRANSITION", "Health gate decision is immutable once recorded.");
      }
      if (run.status !== "running") {
        fail("INVALID_TRANSITION", `Cannot resolve a health gate while run is ${run.status}.`);
      }

      const gate = this.ledger.get<GateRow>(
        "SELECT * FROM run_health_gates WHERE run_id = ? AND gate_id = ?",
        [runId, gateId],
      );
      if (!gate) fail("GATE_NOT_FOUND", `Health gate ${gateId} does not exist in run ${runId}.`);
      if (gate.status !== "pending") {
        fail("INVALID_TRANSITION", `Cannot resolve health gate ${gateId} from ${gate.status}.`);
      }
      const healthStep = this.ledger
        .all<StepRow>("SELECT * FROM run_steps WHERE run_id = ? ORDER BY ordinal", [runId])
        .find((step) => {
          const definition = JSON.parse(step.definition_json) as StepDefinition;
          return definition.healthGateId === gateId;
        });
      if (!healthStep || healthStep.status !== "succeeded") {
        fail(
          "DEPENDENCY_NOT_SATISFIED",
          `Health measurement for gate ${gateId} must succeed before its decision.`,
        );
      }
      if (input.outcome === "passed") {
        const providedKinds = new Set(input.evidence.map((item) => item.kind));
        const requiredKinds = JSON.parse(gate.required_evidence_kinds_json) as string[];
        const missingKinds = requiredKinds.filter((kind) => !providedKinds.has(kind));
        if (missingKinds.length > 0) {
          fail(
            "INVALID_ARGUMENT",
            `Health gate ${gateId} is missing required evidence kinds: ${missingKinds.join(", ")}.`,
          );
        }
      }

      const now = new Date().toISOString();
      const evidenceIds = this.persistEvidence(
        runId,
        healthStep.step_id,
        input.evidence,
        now,
      );
      this.ledger.run(
        `INSERT INTO health_gate_decisions (
          decision_id, run_id, gate_id, idempotency_key, request_sha256, outcome, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          runId,
          gateId,
          input.idempotencyKey,
          requestSha256,
          input.outcome,
          now,
        ],
      );
      this.ledger.run(
        "UPDATE run_health_gates SET status = ?, evidence_ids_json = ? WHERE run_id = ? AND gate_id = ?",
        [input.outcome, JSON.stringify(evidenceIds), runId, gateId],
      );
      if (input.outcome === "failed") {
        this.ledger.run(
          "UPDATE release_runs SET status = 'failed', updated_at = ? WHERE run_id = ?",
          [now, runId],
        );
      }
      this.appendEvent(
        runId,
        `health_gate.${input.outcome}`,
        { gateId, evidenceIds },
        input.actorId,
        now,
      );
      if (input.outcome === "passed") this.maybeCompleteRun(runId, input.actorId, now);
      return this.getRun(runId);
    });
  }

  public listRuns(limit = 20, cursor?: ReleaseRunCursor): ReleaseRunPage {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      fail("INVALID_ARGUMENT", "Run page limit must be between 1 and 100.");
    }
    if (cursor) {
      validateRunId(cursor.runId);
      if (!Number.isFinite(Date.parse(cursor.createdAt))) {
        fail("INVALID_ARGUMENT", "Run cursor timestamp is invalid.");
      }
    }
    const rows = cursor
      ? this.ledger.all<{ run_id: string; created_at: string }>(
          `SELECT run_id, created_at FROM release_runs
           WHERE created_at < ? OR (created_at = ? AND run_id < ?)
           ORDER BY created_at DESC, run_id DESC LIMIT ?`,
          [cursor.createdAt, cursor.createdAt, cursor.runId, limit + 1],
        )
      : this.ledger.all<{ run_id: string; created_at: string }>(
          "SELECT run_id, created_at FROM release_runs ORDER BY created_at DESC, run_id DESC LIMIT ?",
          [limit + 1],
        );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      runs: pageRows.map((row) => this.getRun(row.run_id)),
      nextCursor: hasMore && last
        ? { createdAt: last.created_at, runId: last.run_id }
        : null,
    };
  }

  public getRun(runId: string): ReleaseRunSnapshot {
    validateRunId(runId);
    const run = this.requireRun(runId);
    const steps = this.ledger.all<StepRow>(
      "SELECT * FROM run_steps WHERE run_id = ? ORDER BY ordinal",
      [runId],
    );
    const gates = this.ledger.all<GateRow>(
      "SELECT * FROM run_health_gates WHERE run_id = ? ORDER BY gate_id",
      [runId],
    );
    return {
      runId: run.run_id,
      blueprintId: run.blueprint_id,
      blueprintVersion: run.blueprint_version,
      blueprintSha256: run.blueprint_sha256,
      targetRelease: run.target_release,
      sourceCommitSha: run.source_commit_sha,
      status: run.status,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      lastSeq: run.last_seq,
      steps: steps.map((step) => ({
        stepId: step.step_id,
        stage: step.stage,
        action: step.action,
        executionClass: step.execution_class,
        status: step.status,
        attemptCount: step.attempt_count,
        operationId: step.operation_id,
        idempotencyKey: step.idempotency_key,
      })),
      gates: gates.map((gate) => ({
        gateId: gate.gate_id,
        stage: gate.stage,
        status: gate.status,
        requiredEvidenceKinds: JSON.parse(gate.required_evidence_kinds_json) as string[],
        evidenceIds: JSON.parse(gate.evidence_ids_json) as string[],
      })),
    };
  }

  public replayEvents(
    runId: string,
    afterSeq = 0,
    limit = 200,
  ): readonly ReleaseRunEvent[] {
    validateRunId(runId);
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      fail("INVALID_ARGUMENT", "afterSeq must be a non-negative integer.");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      fail("INVALID_ARGUMENT", "Event replay limit must be between 1 and 1000.");
    }
    this.requireRun(runId);
    return this.ledger
      .all<{
        run_id: string;
        seq: number;
        event_id: string;
        event_type: string;
        payload_json: string;
        occurred_at: string;
      }>(
        `SELECT run_id, seq, event_id, event_type, payload_json, occurred_at
         FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        [runId, afterSeq, limit],
      )
      .map((event) => ({
        runId: event.run_id,
        seq: event.seq,
        eventId: event.event_id,
        eventType: event.event_type,
        payload: JSON.parse(event.payload_json) as Readonly<Record<string, unknown>>,
        occurredAt: event.occurred_at,
      }));
  }

  public listAuditEntries(runId: string): readonly ReleaseAuditEntry[] {
    validateRunId(runId);
    this.requireRun(runId);
    return this.ledger
      .all<{
        audit_id: string;
        run_id: string;
        event_seq: number;
        actor_id: string;
        action: string;
        details_json: string;
        occurred_at: string;
      }>(
        "SELECT * FROM audit_log WHERE run_id = ? ORDER BY event_seq ASC",
        [runId],
      )
      .map((entry) => ({
        auditId: entry.audit_id,
        runId: entry.run_id,
        eventSeq: entry.event_seq,
        actorId: entry.actor_id,
        action: entry.action,
        details: JSON.parse(entry.details_json) as Readonly<Record<string, unknown>>,
        occurredAt: entry.occurred_at,
      }));
  }

  public pageEvidence(runId: string, limit = 50, cursor?: EvidenceCursor): EvidencePage {
    validateRunId(runId);
    this.requireRun(runId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      fail("INVALID_ARGUMENT", "Evidence page limit must be between 1 and 200.");
    }
    if (cursor && !Number.isFinite(Date.parse(cursor.recordedAt))) {
      fail("INVALID_ARGUMENT", "Evidence cursor timestamp is invalid.");
    }
    const rows = cursor
      ? this.ledger.all<EvidenceRow>(
          `SELECT * FROM evidence_records
           WHERE run_id = ? AND
             (recorded_at > ? OR (recorded_at = ? AND evidence_id > ?))
           ORDER BY recorded_at, evidence_id LIMIT ?`,
          [runId, cursor.recordedAt, cursor.recordedAt, cursor.evidenceId, limit + 1],
        )
      : this.ledger.all<EvidenceRow>(
          "SELECT * FROM evidence_records WHERE run_id = ? ORDER BY recorded_at, evidence_id LIMIT ?",
          [runId, limit + 1],
        );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      records: pageRows.map((row) => ({
        evidenceId: row.evidence_id,
        runId: row.run_id,
        stepId: row.step_id,
        kind: row.kind,
        source: row.source,
        sha256: row.sha256,
        observedAt: row.observed_at,
        recordedAt: row.recorded_at,
      })),
      nextCursor: hasMore && last
        ? { recordedAt: last.recorded_at, evidenceId: last.evidence_id }
        : null,
    };
  }

  public listEvidence(runId: string): readonly EvidenceRecord[] {
    validateRunId(runId);
    this.requireRun(runId);
    return this.ledger
      .all<EvidenceRow>(
        "SELECT * FROM evidence_records WHERE run_id = ? ORDER BY recorded_at, evidence_id",
        [runId],
      )
      .map((row) => ({
        evidenceId: row.evidence_id,
        runId: row.run_id,
        stepId: row.step_id,
        kind: row.kind,
        source: row.source,
        sha256: row.sha256,
        observedAt: row.observed_at,
        recordedAt: row.recorded_at,
      }));
  }

  public close(): void {
    this.ledger.close();
  }

  private registerBlueprint(blueprint: ReleaseWorkflowBlueprint): void {
    const json = canonicalJson(blueprint);
    const checksum = sha256(json);
    const existing = this.ledger.get<{ sha256: string }>(
      "SELECT sha256 FROM workflow_blueprints WHERE blueprint_id = ? AND version = ?",
      [blueprint.id, blueprint.version],
    );
    if (existing) {
      if (existing.sha256 !== checksum) {
        fail(
          "BLUEPRINT_VERSION_CONFLICT",
          `Blueprint ${blueprint.id}@${blueprint.version} is immutable.`,
        );
      }
      return;
    }
    this.ledger.run(
      "INSERT INTO workflow_blueprints (blueprint_id, version, sha256, definition_json, registered_at) VALUES (?, ?, ?, ?, ?)",
      [blueprint.id, blueprint.version, checksum, json, new Date().toISOString()],
    );
  }

  private requireBlueprint(id: string, version: number): ReleaseWorkflowBlueprint {
    const blueprint = this.blueprints.get(blueprintKey(id, version));
    if (!blueprint) fail("BLUEPRINT_NOT_FOUND", `Unknown workflow blueprint ${id}@${version}.`);
    return blueprint;
  }

  private requireRun(runId: string): RunRow {
    const row = this.ledger.get<RunRow>("SELECT * FROM release_runs WHERE run_id = ?", [runId]);
    if (!row) fail("RUN_NOT_FOUND", `Run ${runId} does not exist.`);
    return row;
  }

  private requireStep(runId: string, stepId: string): StepRow {
    const row = this.ledger.get<StepRow>(
      "SELECT * FROM run_steps WHERE run_id = ? AND step_id = ?",
      [runId, stepId],
    );
    if (!row) fail("STEP_NOT_FOUND", `Step ${stepId} does not exist in run ${runId}.`);
    return row;
  }

  private requireLatestAttempt(operationId: string): AttemptRow {
    const row = this.ledger.get<AttemptRow>(
      `SELECT * FROM step_attempts WHERE operation_id = ?
       ORDER BY attempt_number DESC LIMIT 1`,
      [operationId],
    );
    if (!row) fail("OPERATION_NOT_FOUND", `Operation ${operationId} does not exist.`);
    return row;
  }

  private persistEvidence(
    runId: string,
    stepId: string,
    evidence: readonly EvidenceInput[],
    recordedAt: string,
  ): string[] {
    const ids: string[] = [];
    for (const item of evidence) {
      validateEvidence(item);
      const evidenceId = randomUUID();
      this.ledger.run(
        `INSERT INTO evidence_records (
          evidence_id, run_id, step_id, kind, source, sha256, observed_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          evidenceId,
          runId,
          stepId,
          item.kind,
          item.source,
          item.sha256,
          item.observedAt,
          recordedAt,
        ],
      );
      ids.push(evidenceId);
    }
    return ids;
  }

  private appendEvent(
    runId: string,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
    actorId: string,
    occurredAt: string,
  ): number {
    const run = this.requireRun(runId);
    const seq = run.last_seq + 1;
    const eventId = randomUUID();
    this.ledger.run(
      "UPDATE release_runs SET last_seq = ?, updated_at = ? WHERE run_id = ?",
      [seq, occurredAt, runId],
    );
    this.ledger.run(
      "INSERT INTO run_events (run_id, seq, event_id, event_type, payload_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
      [runId, seq, eventId, eventType, canonicalJson(payload), occurredAt],
    );
    this.ledger.run(
      "INSERT INTO audit_log (audit_id, run_id, event_seq, actor_id, action, details_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [randomUUID(), runId, seq, actorId, eventType, canonicalJson(payload), occurredAt],
    );
    return seq;
  }

  private resumeIfNoUnknownOperations(runId: string, now: string): void {
    const active = this.ledger.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM step_attempts
       WHERE run_id = ? AND status IN ('intent_recorded', 'outcome_unknown')`,
      [runId],
    );
    if (Number(active?.count ?? 0) !== 0) return;

    const failed = this.ledger.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM run_steps WHERE run_id = ? AND status = 'failed'",
      [runId],
    );
    const nextStatus = Number(failed?.count ?? 0) > 0 ? "failed" : "running";
    this.ledger.run(
      "UPDATE release_runs SET status = ?, updated_at = ? WHERE run_id = ? AND status = 'paused_outcome_unknown'",
      [nextStatus, now, runId],
    );
  }

  private maybeCompleteRun(runId: string, actorId: string, now: string): void {
    const run = this.requireRun(runId);
    if (run.status === "failed" || run.status === "paused_outcome_unknown") return;
    const incomplete = this.ledger.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM run_steps WHERE run_id = ? AND status <> 'succeeded'",
      [runId],
    );
    const unpassed = this.ledger.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM run_health_gates WHERE run_id = ? AND status <> 'passed'",
      [runId],
    );
    if (Number(incomplete?.count ?? 0) !== 0 || Number(unpassed?.count ?? 0) !== 0) return;
    this.ledger.run(
      "UPDATE release_runs SET status = 'succeeded', updated_at = ? WHERE run_id = ?",
      [now, runId],
    );
    this.appendEvent(runId, "run.succeeded", {}, actorId, now);
  }
}

function validateRunRequest(request: ReleaseRunRequest): void {
  validateIdentifier(request.blueprintId, "blueprintId");
  if (!Number.isInteger(request.blueprintVersion) || request.blueprintVersion < 1) {
    fail("INVALID_ARGUMENT", "blueprintVersion must be a positive integer.");
  }
  if (!IDENTIFIER_PATTERN.test(request.targetRelease)) {
    fail("INVALID_ARGUMENT", "targetRelease must be a bounded identifier.");
  }
  if (!COMMIT_PATTERN.test(request.sourceCommitSha)) {
    fail("INVALID_ARGUMENT", "sourceCommitSha must be a full hexadecimal commit id.");
  }
  validateIdempotencyKey(request.idempotencyKey);
  validateActor(request.actorId);
}

function validateEvidence(item: EvidenceInput): void {
  validateIdentifier(item.kind, "evidence kind");
  validateIdentifier(item.source, "evidence source");
  if (!HASH_PATTERN.test(item.sha256)) {
    fail("INVALID_ARGUMENT", "Evidence sha256 must be lowercase hexadecimal.");
  }
  if (!Number.isFinite(Date.parse(item.observedAt))) {
    fail("INVALID_ARGUMENT", "Evidence observedAt must be a valid timestamp.");
  }
}

function validateOutcomeCode(value: string | undefined): void {
  if (value !== undefined && !/^[A-Z0-9][A-Z0-9_.-]{0,79}$/u.test(value)) {
    fail("INVALID_ARGUMENT", "outcomeCode must be a bounded uppercase code.");
  }
}

function validateRunId(value: string): void {
  if (!/^[0-9a-f-]{36}$/u.test(value)) fail("INVALID_ARGUMENT", "runId must be a UUID.");
}

function validateIdentifier(value: string, name: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    fail("INVALID_ARGUMENT", `${name} must be a bounded identifier.`);
  }
}

function validateIdempotencyKey(value: string): void {
  validateIdentifier(value, "idempotencyKey");
}

function validateActor(value: string): void {
  if (!ACTOR_PATTERN.test(value)) fail("INVALID_ARGUMENT", "actorId is invalid.");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function blueprintKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}
