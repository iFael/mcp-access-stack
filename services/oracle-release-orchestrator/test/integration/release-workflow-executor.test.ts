import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { ReleaseWorkflowExecutor, type ReleaseStepCapability } from "../../src/release-workflow-executor.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";
import type { ReleaseAction, EvidenceInput, StepIntent } from "../../src/types.js";

const actor = "test:runner";
const evidence = (kind: string): EvidenceInput => ({
  kind, source: "typed_fixture", sha256: "a".repeat(64), observedAt: "2026-10-12T15:00:00Z",
});
const gates = new Map(beta80ReleaseBlueprint.steps
  .filter(s => s.healthGateId)
  .map(s => [s.action, beta80ReleaseBlueprint.gates.find(g => g.id === s.healthGateId)!.requiredEvidenceKinds]));
describe("ReleaseWorkflowExecutor with the canonical durable ledger", () => {
  let root: string;
  let orchestrator: ReleaseOrchestrator;
  let releaseRoot: string;
  let databasePath: string;
  const calls: Array<{ action: ReleaseAction; operationId: string }> = [];
  const authorized = new Set<ReleaseAction>();

  function reopen() {
    return new ReleaseOrchestrator(SqliteReleaseLedger.open({ databasePath, releaseRoot }));
  }
  function runner(orchestratorInstance = orchestrator) {
    const capabilities = new Map<ReleaseAction, ReleaseStepCapability>();
    for (const step of beta80ReleaseBlueprint.steps) {
      capabilities.set(step.action, {
        action: step.action, executionClass: step.executionClass,
        authorize: async () => step.executionClass === "read_only" || authorized.has(step.action),
        execute: async (intent: StepIntent) => {
          calls.push({ action: intent.action, operationId: intent.operationId });
          return { state: "succeeded" as const,
            evidence: (gates.get(step.action) ?? []).map(evidence) };
        },
        reconcile: async () => ({ outcome: "still_unknown" as const }),
      });
    }
    return new ReleaseWorkflowExecutor(orchestratorInstance, capabilities);
  }
  function create() {
    return orchestrator.createRun({
      blueprintId: beta80ReleaseBlueprint.id, blueprintVersion: beta80ReleaseBlueprint.version,
      targetRelease: "synthetic-runner", sourceCommitSha: "a".repeat(40),
      idempotencyKey: "runner-case", actorId: actor,
    }).run;
  }

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "mcp-orchestrated-runner-"));
    releaseRoot = path.join(root, "release");
    mkdirSync(releaseRoot);
    databasePath = path.join(root, "state", "ledger.sqlite");
    orchestrator = reopen();
    calls.length = 0;
    authorized.clear();
  });
  afterEach(() => { orchestrator.close(); rmSync(root, { recursive: true, force: true }); });

  it("blocks before recording a privileged intent and resumes after gate authorization", async () => {
    const run = create();
    const one = await runner().advance(run.runId, actor);
    expect(one.stop).toBe("blocked_unauthorized");
    expect(one.executed).toBe(2);
    expect(calls).toHaveLength(2);
    expect(one.run.steps[2]).toMatchObject({ status: "pending", operationId: null });
    authorized.add("publish_release_tag");
    const two = await runner().advance(run.runId, actor);
    expect(two.stop).toBe("blocked_unauthorized");
    expect(calls.filter(c => c.action === "resolve_main_commit")).toHaveLength(1);
    expect(calls.filter(c => c.action === "publish_release_tag")).toHaveLength(1);
  });

  it("finishes sequentially including all health gates and cleanup, with no duplicate dispatch", async () => {
    const run = create();
    for (const step of beta80ReleaseBlueprint.steps) authorized.add(step.action);
    const complete = await runner().advance(run.runId, actor);
    expect(complete.stop).toBe("succeeded");
    expect(complete.run.status).toBe("succeeded");
    expect(complete.run.gates.every(g => g.status === "passed")).toBe(true);
    expect(calls.map(c => c.action)).toEqual(beta80ReleaseBlueprint.steps.map(s => s.action));
    const replay = await runner().advance(run.runId, actor);
    expect(replay.stop).toBe("succeeded");
    expect(calls).toHaveLength(beta80ReleaseBlueprint.steps.length);
  });

  it("never dispatches an ambiguous intent again after a restart", async () => {
    const run = create();
    orchestrator.startRun(run.runId, actor);
    const intent = orchestrator.beginStepAttempt(run.runId, "resolve_main_commit", "reentered-step", actor);
    expect(intent.kind).toBe("intent");
    orchestrator.close();
    orchestrator = reopen();
    const concurrent = await runner().advance(run.runId, actor);
    expect(concurrent.stop).toBe("operation_in_progress");
    expect(concurrent.executed).toBe(0);
    expect(orchestrator.recoverInterruptedOperations(actor)).toBe(1);
    const resumed = await runner().advance(run.runId, actor);
    expect(resumed.stop).toBe("outcome_unknown");
    expect(resumed.reconciled).toBe(1);
    expect(calls).toHaveLength(0);
    expect(resumed.run.status).toBe("paused_outcome_unknown");
    expect(resumed.run.steps[0]?.operationId).toBe(intent.operationId);
  });

  it("rejects an unbound step before recording any side-effect intent", async () => {
    const run = create();
    const result = await new ReleaseWorkflowExecutor(orchestrator, new Map()).advance(run.runId, actor);
    expect(result.stop).toBe("blocked_missing_capability");
    expect(result.executed).toBe(0);
    expect(result.run.steps[0]?.status).toBe("pending");
  });

  it("marks thrown executor results as outcome_unknown instead of retrying", async () => {
    const run = create();
    const cap: ReleaseStepCapability = {
      action: "resolve_main_commit", executionClass: "read_only", authorize: async () => true,
      execute: async () => { throw new Error("disconnected after effect"); },
      reconcile: async () => ({ outcome: "still_unknown" }),
    };
    const result = await new ReleaseWorkflowExecutor(orchestrator,
      new Map([["resolve_main_commit", cap]])).advance(run.runId, actor);
    expect(result.stop).toBe("outcome_unknown");
    const operationId = result.run.steps[0]?.operationId;
    expect(operationId).not.toBeNull();
    const again = await new ReleaseWorkflowExecutor(orchestrator,
      new Map([["resolve_main_commit", cap]])).advance(run.runId, actor);
    expect(again.executed).toBe(0);
    expect(again.run.steps[0]?.operationId).toBe(operationId);
  });
});
