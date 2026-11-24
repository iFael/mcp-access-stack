import { z } from "zod";

const operation = z.enum(["repair_oracle_kernel_dependencies", "install_browser_dependencies"]);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const packageName = z.string().regex(/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?$/u).max(150);
const packageVersion = z.string().regex(/^[0-9][a-zA-Z0-9.+:~\-]*$/u).max(150);
export const oracleAptMaintenanceInputSchema = z.discriminatedUnion("action", [
  z.object({ workspaceId: z.literal("mcp-access-stack"), action: z.literal("plan"), operation }).strict(),
  z.object({ workspaceId: z.literal("mcp-access-stack"), action: z.literal("apply"),
    operation, operationId: z.uuid(), expectedPlanSha256: sha256 }).strict(),
  z.object({ workspaceId: z.literal("mcp-access-stack"), action: z.literal("status"), operationId: z.uuid() }).strict(),
]);
export type OracleAptMaintenanceInput = z.infer<typeof oracleAptMaintenanceInputSchema>;

export const oracleAptMaintenanceResultSchema = z.object({
  status: z.enum(["ready", "healthy", "blocked", "running", "succeeded", "failed",
    "outcome_unknown", "permission_required", "unavailable", "not_found", "plan_changed", "operation_conflict"]),
  operation: operation.optional(),
  operationId: z.uuid().optional(),
  planSha256: sha256.optional(),
  changes: z.array(z.object({ action: z.enum(["install", "configure"]),
    package: packageName, version: packageVersion }).strict()).max(100).optional(),
  diagnostic: z.enum(["helper_missing", "root_policy_denied", "invalid_response", "linux_only",
    "execution_failed", "apt_busy", "apt_simulation_failed", "unsafe_plan", "apt_unhealthy",
    "plan_changed", "another_operation_active", "operation_conflict", "dispatch_unverified",
    "worker_unverified", "apt_apply_failed", "postcheck_failed"]).optional(),
}).strict();
export type OracleAptMaintenanceResult = z.infer<typeof oracleAptMaintenanceResultSchema>;
