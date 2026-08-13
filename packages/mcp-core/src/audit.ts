import type { PermissionProfile } from "./policy.js";

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
  resultSize?: number;
  durationMs: number;
  status: AuditStatus;
  reason?: string;
}
