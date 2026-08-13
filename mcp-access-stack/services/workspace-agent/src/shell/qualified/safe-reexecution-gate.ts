import {
  type CommandDiagnosis,
  type CommandPlan,
  type CommandPostconditionResult,
  type RunCommandResult,
} from "@vs-code-gpt/shared";
import type { DeterministicRepairProposal } from "./deterministic-repair.js";

const MINIMUM_REEXECUTION_BUDGET_MS = 250;
const MINIMUM_REPAIR_CONFIDENCE = 0.9;
const SAFE_EFFECTS = new Set<CommandPlan["effectClass"]>([
  "pure_read",
  "repeatable_local",
]);
const FORBIDDEN_DIAGNOSES = new Set<CommandDiagnosis["category"]>([
  "authentication_failed",
  "authorization_failed",
  "permission_denied",
  "timeout",
  "cancelled",
  "partial_completion_possible",
  "outcome_unknown",
  "confirmation_required",
]);

export type SafeReexecutionDecision =
  | {
      allowed: true;
      requiresFreshConfirmation: boolean;
    }
  | {
      allowed: false;
      reason: string;
    };

export interface SafeReexecutionGateInput {
  originalPlan: CommandPlan;
  correctedPlan: CommandPlan;
  firstResult: Extract<RunCommandResult, { status: "executed" }>;
  firstPostcondition: CommandPostconditionResult;
  diagnosis: CommandDiagnosis;
  proposal: DeterministicRepairProposal;
  nowMs: number;
  signal?: AbortSignal;
}

export function evaluateSafeReexecution(
  input: SafeReexecutionGateInput,
): SafeReexecutionDecision {
  if (input.signal?.aborted) {
    return blocked("The invocation was cancelled before safe reexecution.");
  }
  if (input.firstResult.timedOut || input.firstResult.exitCode === null) {
    return blocked("The first attempt does not have a known terminal outcome.");
  }
  if (FORBIDDEN_DIAGNOSES.has(input.diagnosis.category)) {
    return blocked(
      `Diagnosis ${input.diagnosis.category} is never eligible for automatic reexecution.`,
    );
  }
  if (hasPartialCompletionEvidence(input.firstResult)) {
    return blocked("Command output indicates possible partial completion.");
  }
  if (!SAFE_EFFECTS.has(input.originalPlan.effectClass)) {
    return blocked(
      `Original effect ${input.originalPlan.effectClass} is not eligible for automatic reexecution.`,
    );
  }
  if (!SAFE_EFFECTS.has(input.correctedPlan.effectClass)) {
    return blocked(
      `Corrected effect ${input.correctedPlan.effectClass} is not eligible for automatic reexecution.`,
    );
  }
  if (
    input.correctedPlan.riskClass === "forbidden" ||
    input.correctedPlan.riskClass === "unknown"
  ) {
    return blocked(
      `Corrected risk ${input.correctedPlan.riskClass} cannot pass the reexecution gate.`,
    );
  }
  if (input.proposal.confidence < MINIMUM_REPAIR_CONFIDENCE) {
    return blocked("The deterministic repair confidence is below the safe threshold.");
  }
  if (
    input.originalPlan.invocationId !== input.correctedPlan.invocationId ||
    input.originalPlan.absoluteDeadline !== input.correctedPlan.absoluteDeadline
  ) {
    return blocked("The corrected plan changed the invocation or absolute deadline binding.");
  }
  if (
    input.proposal.bindingChanged ===
    (input.originalPlan.fingerprint === input.correctedPlan.fingerprint)
  ) {
    return blocked("The corrected plan fingerprint does not match the declared binding change.");
  }
  if (
    input.correctedPlan.postconditions.length === 0 ||
    input.firstPostcondition.checked === 0
  ) {
    return blocked("No deterministic postcondition can distinguish successful reexecution.");
  }
  if (
    Date.parse(input.correctedPlan.absoluteDeadline) - input.nowMs <
    MINIMUM_REEXECUTION_BUDGET_MS
  ) {
    return blocked("Insufficient absolute deadline remains for a second attempt.");
  }

  return {
    allowed: true,
    requiresFreshConfirmation:
      input.correctedPlan.riskClass === "confirmation_required",
  };
}

function hasPartialCompletionEvidence(
  result: Extract<RunCommandResult, { status: "executed" }>,
): boolean {
  const output = `${result.stderr}\n${result.stdout}`.slice(0, 200_000);
  return /\b(partial(?:ly)? completed|completed \d+ of \d+|changes? applied before failure|some operations? succeeded)\b/iu.test(
    output,
  );
}

function blocked(reason: string): SafeReexecutionDecision {
  return { allowed: false, reason };
}
