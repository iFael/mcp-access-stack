export const RELEASE_RUN_STATUSES = [
  "planned",
  "running",
  "paused_outcome_unknown",
  "failed",
  "succeeded",
] as const;
export type ReleaseRunStatus = (typeof RELEASE_RUN_STATUSES)[number];

export const RELEASE_STEP_STATUSES = [
  "pending",
  "in_progress",
  "outcome_unknown",
  "failed",
  "succeeded",
] as const;
export type ReleaseStepStatus = (typeof RELEASE_STEP_STATUSES)[number];

export const RELEASE_ATTEMPT_STATUSES = [
  "intent_recorded",
  "outcome_unknown",
  "resolved_not_applied",
  "failed",
  "succeeded",
] as const;
export type ReleaseAttemptStatus = (typeof RELEASE_ATTEMPT_STATUSES)[number];

export const HEALTH_GATE_STATUSES = [
  "pending",
  "passed",
  "failed",
  "outcome_unknown",
] as const;
export type HealthGateStatus = (typeof HEALTH_GATE_STATUSES)[number];

export const RELEASE_STAGES = [
  "build_release",
  "deployment",
  "homologation",
] as const;
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

export const RELEASE_ACTIONS = [
  "resolve_main_commit",
  "verify_canonical_ci",
  "publish_release_tag",
  "build_and_sign_release",
  "publish_signed_release",
  "verify_release_assets",
  "deploy_edge",
  "verify_edge_health",
  "prepare_oracle",
  "prepare_windows",
  "validate_oracle_candidate",
  "validate_windows_candidate",
  "promote_oracle",
  "verify_oracle_health",
  "promote_windows",
  "verify_windows_health",
  "reconcile_final_pointers",
  "smoke_catalog",
  "cleanup_known_temporary_residue",
] as const;
export type ReleaseAction = (typeof RELEASE_ACTIONS)[number];

export type StepExecutionClass = "read_only" | "external_effect";

export interface StepDefinition {
  readonly id: string;
  readonly stage: ReleaseStage;
  readonly action: ReleaseAction;
  readonly executionClass: StepExecutionClass;
  readonly dependsOn: readonly string[];
  readonly requiredGates: readonly string[];
  readonly healthGateId?: string;
}

export interface HealthGateDefinition {
  readonly id: string;
  readonly stage: ReleaseStage;
  readonly requiredEvidenceKinds: readonly string[];
}

export interface ReleaseWorkflowBlueprint {
  readonly id: string;
  readonly version: number;
  readonly name: string;
  readonly historicalReference: string;
  readonly stages: readonly ReleaseStage[];
  readonly gates: readonly HealthGateDefinition[];
  readonly steps: readonly StepDefinition[];
}

export interface ReleaseRunRequest {
  readonly blueprintId: string;
  readonly blueprintVersion: number;
  readonly targetRelease: string;
  readonly sourceCommitSha: string;
  readonly idempotencyKey: string;
  readonly actorId: string;
}

export interface EvidenceInput {
  readonly kind: string;
  readonly source: string;
  readonly sha256: string;
  readonly observedAt: string;
}

export interface EvidenceRecord extends EvidenceInput {
  readonly evidenceId: string;
  readonly runId: string;
  readonly stepId: string | null;
  readonly recordedAt: string;
}

export interface ReleaseRunCursor {
  readonly createdAt: string;
  readonly runId: string;
}

export interface ReleaseRunPage {
  readonly runs: readonly ReleaseRunSnapshot[];
  readonly nextCursor: ReleaseRunCursor | null;
}

export interface EvidenceCursor {
  readonly recordedAt: string;
  readonly evidenceId: string;
}

export interface EvidencePage {
  readonly records: readonly EvidenceRecord[];
  readonly nextCursor: EvidenceCursor | null;
}

export interface ReleaseStepSnapshot {
  readonly stepId: string;
  readonly stage: ReleaseStage;
  readonly action: ReleaseAction;
  readonly executionClass: StepExecutionClass;
  readonly status: ReleaseStepStatus;
  readonly attemptCount: number;
  readonly operationId: string | null;
  readonly idempotencyKey: string | null;
}

export interface HealthGateSnapshot {
  readonly gateId: string;
  readonly stage: ReleaseStage;
  readonly status: HealthGateStatus;
  readonly requiredEvidenceKinds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface ReleaseRunSnapshot {
  readonly runId: string;
  readonly blueprintId: string;
  readonly blueprintVersion: number;
  readonly blueprintSha256: string;
  readonly targetRelease: string;
  readonly sourceCommitSha: string;
  readonly status: ReleaseRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSeq: number;
  readonly steps: readonly ReleaseStepSnapshot[];
  readonly gates: readonly HealthGateSnapshot[];
}

export interface ReleaseRunEvent {
  readonly runId: string;
  readonly seq: number;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface ReleaseAuditEntry {
  readonly auditId: string;
  readonly runId: string;
  readonly eventSeq: number;
  readonly actorId: string;
  readonly action: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface StepIntent {
  readonly kind: "intent";
  readonly runId: string;
  readonly stepId: string;
  readonly action: ReleaseAction;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly attemptNumber: number;
  readonly executionClass: StepExecutionClass;
}

export interface StepAlreadyCompleted {
  readonly kind: "already_completed";
  readonly runId: string;
  readonly stepId: string;
  readonly operationId: string;
}

export type BeginStepResult = StepIntent | StepAlreadyCompleted;

export type ReconciliationOutcome = "applied" | "not_applied" | "still_unknown";
export type StepOutcome = "succeeded" | "failed";
