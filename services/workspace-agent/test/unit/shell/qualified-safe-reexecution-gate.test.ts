import { describe, expect, it } from "@jest/globals";
import type {
  CommandDiagnosis,
  CommandPlan,
  CommandPostconditionResult,
  RunCommandResult,
} from "@vs-code-gpt/shared";
import type { DeterministicRepairProposal } from "../../../src/shell/qualified/deterministic-repair.js";
import { evaluateSafeReexecution } from "../../../src/shell/qualified/safe-reexecution-gate.js";

function plan(overrides: Partial<CommandPlan> = {}): CommandPlan {
  return {
    invocationId: "gate",
    source: "explicit-command",
    shell: "powershell",
    cwd: ".",
    execution: { kind: "argv", executable: "git", argv: ["status"] },
    timeoutMs: 30_000,
    absoluteDeadline: "2099-01-01T00:00:00.000Z",
    riskClass: "safe",
    effectClass: "pure_read",
    expectedOutcomes: [{ kind: "exit_code", value: 0 }],
    postconditions: [{ kind: "exit_code", value: 0 }],
    fingerprint: "a".repeat(64),
    provenance: { source: "explicit-command", sanitized: true },
    ...overrides,
  };
}

function result(
  overrides: Partial<Extract<RunCommandResult, { status: "executed" }>> = {},
): Extract<RunCommandResult, { status: "executed" }> {
  return {
    status: "executed",
    shell: "powershell",
    cwd: ".",
    exitCode: 1,
    stdout: "",
    stderr: "ECONNRESET",
    timedOut: false,
    ...overrides,
  };
}

function diagnosis(
  category: CommandDiagnosis["category"] = "transient_failure",
): CommandDiagnosis {
  return { category, confidence: 0.95, source: "deterministic" };
}

function proposal(
  overrides: Partial<DeterministicRepairProposal> = {},
): DeterministicRepairProposal {
  return {
    ruleId: "retry.transient-read",
    confidence: 0.95,
    reason: "retry",
    correctedInput: {
      workspaceId: "project",
      command: "git status",
      shell: "powershell",
      executionMode: "qualified",
      autoCorrection: "off",
      timeoutMs: 30_000,
    },
    bindingChanged: false,
    waitBeforeRetryMs: 100,
    requiredEvidence: "none",
    ...overrides,
  };
}

const postcondition: CommandPostconditionResult = {
  passed: false,
  checked: 1,
  failed: 1,
};

function evaluate(overrides: {
  originalPlan?: CommandPlan;
  correctedPlan?: CommandPlan;
  firstResult?: Extract<RunCommandResult, { status: "executed" }>;
  firstPostcondition?: CommandPostconditionResult;
  diagnosis?: CommandDiagnosis;
  proposal?: DeterministicRepairProposal;
  nowMs?: number;
}) {
  return evaluateSafeReexecution({
    originalPlan: overrides.originalPlan ?? plan(),
    correctedPlan: overrides.correctedPlan ?? plan(),
    firstResult: overrides.firstResult ?? result(),
    firstPostcondition: overrides.firstPostcondition ?? postcondition,
    diagnosis: overrides.diagnosis ?? diagnosis(),
    proposal: overrides.proposal ?? proposal(),
    nowMs: overrides.nowMs ?? Date.now(),
  });
}

describe("safe reexecution gate", () => {
  it("allows one fully bound pure-read retry", () => {
    expect(evaluate({})).toEqual({
      allowed: true,
      requiresFreshConfirmation: false,
    });
  });

  it("requires a fresh confirmation for a corrected confirmable plan", () => {
    expect(
      evaluate({
        correctedPlan: plan({
          fingerprint: "b".repeat(64),
          riskClass: "confirmation_required",
        }),
        proposal: proposal({ bindingChanged: true }),
      }),
    ).toEqual({ allowed: true, requiresFreshConfirmation: true });
  });

  it("blocks mutable and unknown effects", () => {
    for (const effectClass of [
      "local_mutation",
      "external_mutation",
      "destructive",
      "unknown",
    ] as const) {
      expect(
        evaluate({ originalPlan: plan({ effectClass }) }),
      ).toMatchObject({ allowed: false });
      expect(
        evaluate({ correctedPlan: plan({ effectClass }) }),
      ).toMatchObject({ allowed: false });
    }
  });

  it("blocks timeout, cancellation, authentication and possible partial completion", () => {
    for (const category of [
      "timeout",
      "cancelled",
      "authentication_failed",
      "authorization_failed",
      "permission_denied",
      "partial_completion_possible",
      "outcome_unknown",
    ] as const) {
      expect(evaluate({ diagnosis: diagnosis(category) })).toMatchObject({
        allowed: false,
      });
    }
    expect(
      evaluate({
        firstResult: result({ stderr: "some operations succeeded before failure" }),
      }),
    ).toMatchObject({ allowed: false });
  });

  it("blocks timed-out or non-terminal first attempts", () => {
    expect(
      evaluate({ firstResult: result({ timedOut: true, exitCode: null }) }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({ firstResult: result({ exitCode: null }) }),
    ).toMatchObject({ allowed: false });
  });

  it("blocks fingerprint drift that disagrees with the repair declaration", () => {
    expect(
      evaluate({ correctedPlan: plan({ fingerprint: "b".repeat(64) }) }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({ proposal: proposal({ bindingChanged: true }) }),
    ).toMatchObject({ allowed: false });
  });

  it("blocks low confidence, absent postconditions and exhausted deadlines", () => {
    expect(
      evaluate({ proposal: proposal({ confidence: 0.89 }) }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({
        correctedPlan: plan({ postconditions: [] }),
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({
        firstPostcondition: { passed: false, checked: 0, failed: 0 },
      }),
    ).toMatchObject({ allowed: false });
    expect(
      evaluate({
        correctedPlan: plan({
          absoluteDeadline: new Date(Date.now() + 100).toISOString(),
        }),
      }),
    ).toMatchObject({ allowed: false });
  });
});
