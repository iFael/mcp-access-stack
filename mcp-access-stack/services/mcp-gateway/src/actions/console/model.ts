export const consoleStageValues = [
  "preparation",
  "investigation",
  "implementation",
  "validation",
  "git",
  "completed",
] as const;
export type ConsoleStage = (typeof consoleStageValues)[number];

export const consoleRunStatusValues = [
  "running",
  "waiting_confirmation",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ConsoleRunStatus = (typeof consoleRunStatusValues)[number];

export const consoleFileStateValues = [
  "read",
  "modified",
  "created",
  "deleted",
] as const;
export type ConsoleFileState = (typeof consoleFileStateValues)[number];

export const consoleValidationStateValues = [
  "pending",
  "running",
  "passed",
  "failed",
  "skipped",
] as const;
export type ConsoleValidationState =
  (typeof consoleValidationStateValues)[number];

export const consoleApprovalKindValues = [
  "commit",
  "push",
  "command",
  "deploy",
  "other",
] as const;
export type ConsoleApprovalKind = (typeof consoleApprovalKindValues)[number];

export const consoleApprovalStateValues = [
  "required",
  "approved",
  "rejected",
] as const;
export type ConsoleApprovalState =
  (typeof consoleApprovalStateValues)[number];

export const consoleOutcomeValues = ["completed", "failed", "cancelled"] as const;
export type ConsoleOutcome = (typeof consoleOutcomeValues)[number];

export interface StartConsoleRunInput {
  workspaceId: string;
  root: string;
  objective: string;
  expectedBranch?: string | undefined;
}

export interface UpdateConsoleRunInput {
  runId: string;
  stage?: ConsoleStage | undefined;
  status?: "running" | "waiting_confirmation" | undefined;
  progress?: number | undefined;
  summary?: string | undefined;
  branch?: string | undefined;
  files?: ConsoleFileUpdate[] | undefined;
  validations?: ConsoleValidationUpdate[] | undefined;
  approval?: ConsoleApprovalUpdate | undefined;
}

export interface FinishConsoleRunInput {
  runId: string;
  outcome: ConsoleOutcome;
  summary?: string | undefined;
}

export interface ConsoleFileUpdate {
  path: string;
  state: ConsoleFileState;
  additions?: number | undefined;
  deletions?: number | undefined;
}

export interface ConsoleValidationUpdate {
  name: string;
  state: ConsoleValidationState;
  summary?: string | undefined;
}

export interface ConsoleApprovalUpdate {
  kind: ConsoleApprovalKind;
  state: ConsoleApprovalState;
  label: string;
}

export interface ConsoleEvent {
  sequence: number;
  timestamp: string;
  kind:
    | "run_started"
    | "stage_updated"
    | "operation_started"
    | "operation_completed"
    | "operation_failed"
    | "file_updated"
    | "validation_updated"
    | "approval_updated"
    | "run_finished";
  stage: ConsoleStage;
  status: "running" | "completed" | "failed" | "waiting_confirmation";
  operation?: string | undefined;
  label: string;
}

export interface ConsoleFileSnapshot extends ConsoleFileUpdate {
  updatedAt: string;
}

export interface ConsoleValidationSnapshot extends ConsoleValidationUpdate {
  updatedAt: string;
}

export interface ConsoleApprovalSnapshot extends ConsoleApprovalUpdate {
  updatedAt: string;
}

export interface ConsoleRunSnapshot {
  runId: string;
  workspaceId: string;
  root: string;
  objective: string;
  expectedBranch?: string | undefined;
  branch?: string | undefined;
  status: ConsoleRunStatus;
  stage: ConsoleStage;
  progress: number;
  summary?: string | undefined;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  files: ConsoleFileSnapshot[];
  validations: ConsoleValidationSnapshot[];
  approvals: ConsoleApprovalSnapshot[];
  events: ConsoleEvent[];
  consoleMarkdown: string;
}

export interface ConsoleEventsResult {
  runId: string;
  afterSequence: number;
  nextSequence: number;
  truncated: boolean;
  events: ConsoleEvent[];
  consoleMarkdown: string;
}

export interface MutableConsoleRun {
  runId: string;
  workspaceId: string;
  root: string;
  objective: string;
  expectedBranch?: string | undefined;
  branch?: string | undefined;
  status: ConsoleRunStatus;
  stage: ConsoleStage;
  progress: number;
  summary?: string | undefined;
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  nextSequence: number;
  files: Map<string, ConsoleFileSnapshot>;
  validations: Map<string, ConsoleValidationSnapshot>;
  approvals: Map<ConsoleApprovalKind, ConsoleApprovalSnapshot>;
  events: ConsoleEvent[];
}
