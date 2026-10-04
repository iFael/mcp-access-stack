import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { ReleaseOrchestratorError } from "../../src/errors.js";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";
import type { EvidenceInput } from "../../src/types.js";

const ACTOR = "test:phase1";
const SOURCE_COMMIT = "0".repeat(40);

describe("Oracle Release Orchestrator durable run", () => {
  let root: string;
  let releaseRoot: string;
  let databasePath: string;
  let ledger: SqliteReleaseLedger;
  let orchestrator: ReleaseOrchestrator;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mcp-v3-orchestrator-run-"));
    releaseRoot = path.join(root, "release-tree");
    mkdirSync(releaseRoot, { recursive: true });
    databasePath = path.join(root, "durable-state", "orchestrator.sqlite");
    ({ ledger, orchestrator } = openOrchestrator());
  });

  afterEach(() => {
    try {
      orchestrator.close();
    } catch {
      // A restart test may already have closed this handle.
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("creates one stable run for an idempotency key and rejects conflicting reuse", () => {
    const request = runRequest("create-run-1");
    const first = orchestrator.createRun(request);
    const duplicate = orchestrator.createRun(request);

    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.run.runId).toBe(first.run.runId);
    expect(duplicate.run.lastSeq).toBe(first.run.lastSeq);

    expect(() =>
      orchestrator.createRun({
        ...request,
        targetRelease: "synthetic-different-target",
      }),
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));
  });

  it("persists intent before effects and pauses an ambiguous operation after restart", () => {
    const { run } = orchestrator.createRun(runRequest("restart-run"));
    orchestrator.startRun(run.runId, ACTOR);

    expect(() =>
      orchestrator.beginStepAttempt(
        run.runId,
        "verify_canonical_ci",
        "verify-ci",
        ACTOR,
      ),
    ).toThrow(expect.objectContaining({ code: "DEPENDENCY_NOT_SATISFIED" }));

    finishStep(run.runId, "resolve_main_commit", "resolve-main");
    finishStep(run.runId, "verify_canonical_ci", "verify-ci");

    const intent = orchestrator.beginStepAttempt(
      run.runId,
      "publish_release_tag",
      "publish-tag",
      ACTOR,
    );
    expect(intent.kind).toBe("intent");
    if (intent.kind !== "intent") throw new Error("expected a persisted step intent");
    const beforeRestart = orchestrator.getRun(run.runId);
    const previousSeq = beforeRestart.lastSeq;

    // No production adapter is attached in Phase 1; the missing result simulates a lost reply.
    orchestrator.close();
    ({ ledger, orchestrator } = openOrchestrator());

    expect(orchestrator.recoverInterruptedOperations(ACTOR)).toBe(1);
    const recovered = orchestrator.getRun(run.runId);
    expect(recovered.runId).toBe(run.runId);
    expect(recovered.status).toBe("paused_outcome_unknown");
    expect(recovered.steps.find((step) => step.stepId === "publish_release_tag"))
      .toMatchObject({
        status: "outcome_unknown",
        attemptCount: 1,
        operationId: intent.operationId,
      });
    expect(recovered.lastSeq).toBe(previousSeq + 1);

    const replay = orchestrator.replayEvents(run.runId, previousSeq);
    expect(replay.map((event) => event.seq)).toEqual([previousSeq + 1]);
    expect(replay[0]?.eventType).toBe("operation.recovered_as_unknown");
    expect(orchestrator.recoverInterruptedOperations(ACTOR)).toBe(0);
    expect(orchestrator.getRun(run.runId).lastSeq).toBe(recovered.lastSeq);

    expect(() =>
      orchestrator.reconcileOperation(intent.operationId, {
        idempotencyKey: "reconcile-without-evidence",
        outcome: "not_applied",
        actorId: ACTOR,
      }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

    expect(() =>
      orchestrator.beginStepAttempt(run.runId, "publish_release_tag", "publish-tag", ACTOR),
    ).toThrow(expect.objectContaining({ code: "RECONCILIATION_REQUIRED" }));

    const stillUnknown = orchestrator.reconcileOperation(intent.operationId, {
      idempotencyKey: "reconcile-still-unknown",
      outcome: "still_unknown",
      actorId: ACTOR,
    });
    expect(stillUnknown.status).toBe("paused_outcome_unknown");
    const stillUnknownSeq = stillUnknown.lastSeq;

    // Repeating an identical reconciliation is idempotent and does not create another event.
    const sameReconciliation = orchestrator.reconcileOperation(intent.operationId, {
      idempotencyKey: "reconcile-still-unknown",
      outcome: "still_unknown",
      actorId: ACTOR,
    });
    expect(sameReconciliation.lastSeq).toBe(stillUnknownSeq);
    expect(() =>
      orchestrator.reconcileOperation(intent.operationId, {
        idempotencyKey: "reconcile-still-unknown",
        outcome: "applied",
        evidence: [evidence("release-observation")],
        actorId: ACTOR,
      }),
    ).toThrow(expect.objectContaining({ code: "IDEMPOTENCY_KEY_CONFLICT" }));

    const provenNotApplied = orchestrator.reconcileOperation(intent.operationId, {
      idempotencyKey: "reconcile-not-applied",
      outcome: "not_applied",
      evidence: [evidence("no-tag-found")],
      actorId: ACTOR,
    });
    expect(provenNotApplied.status).toBe("running");
    expect(provenNotApplied.steps.find((step) => step.stepId === "publish_release_tag"))
      .toMatchObject({ status: "pending", attemptCount: 1 });
    expect(
      orchestrator.replayEvents(run.runId).some((event) => event.eventType === "step.retry_started"),
    ).toBe(false);

    // A retry can start only after explicit proof of non-application and reuses the same IDs.
    const retry = orchestrator.beginStepAttempt(
      run.runId,
      "publish_release_tag",
      "publish-tag",
      ACTOR,
    );
    expect(retry).toMatchObject({
      kind: "intent",
      operationId: intent.operationId,
      idempotencyKey: "publish-tag",
      attemptNumber: 2,
    });
    expect(orchestrator.markOutcomeUnknown(intent.operationId, "SYNTHETIC_REPLY_LOST", ACTOR).status)
      .toBe("paused_outcome_unknown");

    const reconciledApplied = orchestrator.reconcileOperation(intent.operationId, {
      idempotencyKey: "reconcile-applied",
      outcome: "applied",
      evidence: [evidence("tag-identity-confirmed")],
      actorId: ACTOR,
    });
    expect(reconciledApplied.status).toBe("running");
    expect(reconciledApplied.steps.find((step) => step.stepId === "publish_release_tag"))
      .toMatchObject({ status: "succeeded", attemptCount: 2 });
    expect(orchestrator.beginStepAttempt(run.runId, "publish_release_tag", "publish-tag", ACTOR))
      .toMatchObject({ kind: "already_completed", operationId: intent.operationId });
    expect(orchestrator.listEvidence(run.runId)).toHaveLength(2);
  });

  it("requires evidence for health decisions and blocks Windows promotion until Oracle is healthy", () => {
    const { run } = orchestrator.createRun(runRequest("health-gates-run"));
    orchestrator.startRun(run.runId, ACTOR);

    expect(() =>
      orchestrator.resolveHealthGate(run.runId, "oracle_healthy", {
        idempotencyKey: "oracle-gate-before-measurement",
        outcome: "passed",
        evidence: [evidence("premature-oracle-approval")],
        actorId: ACTOR,
      }),
    ).toThrow(expect.objectContaining({ code: "DEPENDENCY_NOT_SATISFIED" }));

    for (const step of beta80ReleaseBlueprint.steps) {
      if (step.id === "verify_oracle_health") {
        finishStep(run.runId, step.id, `op-${step.id}`, [evidence("oracle-health-observation")]);
        break;
      }
      finishStep(
        run.runId,
        step.id,
        `op-${step.id}`,
        step.healthGateId ? [evidence(`${step.id}-observation`)] : [],
      );
      if (step.healthGateId) {
        orchestrator.resolveHealthGate(run.runId, step.healthGateId, {
          idempotencyKey: `gate-${step.healthGateId}`,
          outcome: "passed",
          evidence: evidenceForGate(step.healthGateId),
          actorId: ACTOR,
        });
      }
    }

    const windowPromotion = () =>
      orchestrator.beginStepAttempt(run.runId, "promote_windows", "promote-windows", ACTOR);
    expect(windowPromotion).toThrow(expect.objectContaining({ code: "GATE_NOT_PASSED" }));

    const withoutEvidence = () =>
      orchestrator.resolveHealthGate(run.runId, "oracle_healthy", {
        idempotencyKey: "oracle-gate-empty-evidence",
        outcome: "passed",
        evidence: [],
        actorId: ACTOR,
      });
    expect(withoutEvidence).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENT" }));

    const incompleteEvidence = () =>
      orchestrator.resolveHealthGate(run.runId, "oracle_healthy", {
        idempotencyKey: "oracle-gate-incomplete-evidence",
        outcome: "passed",
        evidence: [evidence("generic-health-report")],
        actorId: ACTOR,
      });
    expect(incompleteEvidence).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );

    orchestrator.resolveHealthGate(run.runId, "oracle_healthy", {
      idempotencyKey: "oracle-gate-passed",
      outcome: "passed",
      evidence: evidenceForGate("oracle_healthy"),
      actorId: ACTOR,
    });
    expect(windowPromotion()).toMatchObject({ kind: "intent", action: "promote_windows" });
  });

  it("keeps event seq contiguous, replayable and audit-linked through a full synthetic run", () => {
    const { run } = orchestrator.createRun(runRequest("complete-run"));
    orchestrator.startRun(run.runId, ACTOR);

    for (const step of beta80ReleaseBlueprint.steps) {
      finishStep(
        run.runId,
        step.id,
        `full-${step.id}`,
        step.healthGateId ? [evidence(`${step.id}-measurement`)] : [],
      );
      if (step.healthGateId) {
        orchestrator.resolveHealthGate(run.runId, step.healthGateId, {
          idempotencyKey: `full-gate-${step.healthGateId}`,
          outcome: "passed",
          evidence: evidenceForGate(step.healthGateId),
          actorId: ACTOR,
        });
      }
    }

    const completed = orchestrator.getRun(run.runId);
    expect(completed.status).toBe("succeeded");
    expect(completed.steps.every((step) => step.status === "succeeded")).toBe(true);
    expect(completed.gates.every((gate) => gate.status === "passed")).toBe(true);
    const events = orchestrator.replayEvents(run.runId, 0, 1_000);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: completed.lastSeq }, (_, index) => index + 1),
    );
    expect(
      orchestrator.listAuditEntries(run.runId).length,
    ).toBe(completed.lastSeq);
  });

  it("fails closed on invalid run and step transitions", () => {
    const { run } = orchestrator.createRun(runRequest("transition-run"));
    expect(() =>
      orchestrator.beginStepAttempt(run.runId, "resolve_main_commit", "before-start", ACTOR),
    ).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));
    expect(() => orchestrator.startRun(run.runId, ACTOR)).not.toThrow();
    expect(() => orchestrator.startRun(run.runId, ACTOR)).not.toThrow();
    expect(() =>
      orchestrator.beginStepAttempt(run.runId, "missing-step", "unknown-step", ACTOR),
    ).toThrow(expect.objectContaining({ code: "STEP_NOT_FOUND" }));
    expect(orchestrator.getRun(run.runId).lastSeq).toBe(2);
  });

  function finishStep(
    runId: string,
    stepId: string,
    idempotencyKey: string,
    evidenceItems: readonly EvidenceInput[] = [],
  ): void {
    const intent = orchestrator.beginStepAttempt(runId, stepId, idempotencyKey, ACTOR);
    if (intent.kind !== "intent") return;
    orchestrator.recordStepOutcome(
      intent.operationId,
      { outcome: "succeeded", evidence: evidenceItems },
      ACTOR,
    );
  }

  function openOrchestrator(): {
    ledger: SqliteReleaseLedger;
    orchestrator: ReleaseOrchestrator;
  } {
    const openedLedger = SqliteReleaseLedger.open({ databasePath, releaseRoot });
    return {
      ledger: openedLedger,
      orchestrator: new ReleaseOrchestrator(openedLedger),
    };
  }
});

function runRequest(idempotencyKey: string) {
  return {
    blueprintId: beta80ReleaseBlueprint.id,
    blueprintVersion: beta80ReleaseBlueprint.version,
    targetRelease: "synthetic-beta80-rehearsal",
    sourceCommitSha: SOURCE_COMMIT,
    idempotencyKey,
    actorId: ACTOR,
  };
}

function evidenceForGate(gateId: string): EvidenceInput[] {
  const requiredKinds: Record<string, string[]> = {
    signed_release_validated: [
      "canonical_ci_run",
      "signed_manifest",
      "release_asset_digest",
    ],
    edge_healthy: ["edge_health_report"],
    oracle_healthy: ["oracle_active_manifest", "oracle_health_report"],
    windows_healthy: ["windows_active_manifest", "windows_health_report"],
  };
  const kinds = requiredKinds[gateId];
  if (!kinds) throw new Error(`No synthetic evidence mapping exists for ${gateId}.`);
  return kinds.map(evidence);
}

function evidence(kind: string): EvidenceInput {
  return {
    kind,
    source: "synthetic_test",
    sha256: "a".repeat(64),
    observedAt: "2026-10-03T00:00:00.000Z",
  };
}
