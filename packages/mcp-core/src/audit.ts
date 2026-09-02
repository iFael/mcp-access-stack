import type { PermissionProfile } from "./policy.js";
import type { SourceControlCapability } from "./source-control-contracts.js";

export type AuditStatus = "allowed" | "denied" | "error";

export interface AuditEntry {
  timestamp: string;
  operation: string;
  workspaceId: string;
  correlationId?: string;
  permissionProfile?: PermissionProfile;
  path?: string;
  queryHash?: string;
  queryLength?: number;
  sourceControlCapability?: SourceControlCapability;
  targetResource?: string;
  expectedSha?: string;
  resultSha?: string;
  idempotencyOutcome?: "executed" | "completed_replay" | "confirmation_required";
  resultSize?: number;
  durationMs: number;
  status: AuditStatus;
  reason?: string;
}
