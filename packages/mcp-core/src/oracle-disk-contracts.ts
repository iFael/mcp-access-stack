import { z } from "zod";

const groupSchema = z.enum(["root", "system", "releases", "worktrees", "var", "varlib", "varmcp", "srv", "srvmcp", "usr"]);
const nonnegative = z.number().int().min(0).max(10_000);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const oracleDiskAuditInputSchema = z.object({
  workspaceId: z.literal("mcp-access-stack"),
  group: groupSchema.default("root"),
  start: nonnegative.default(0),
  limit: z.number().int().min(1).max(3).default(1),
}).strict().refine(
  input => (input.group !== "system" && input.group !== "root") || input.limit === 1,
  "System/root audit reads exactly one target per request.",
);
export type OracleDiskAuditInput = z.infer<typeof oracleDiskAuditInputSchema>;

const targetSchema = z.object({
  path: z.string().startsWith("/").max(4096),
  status: z.enum([
    "measured", "permission_denied", "timed_out", "missing",
    "failed", "invalid_output", "not_physical_directory",
  ]),
  allocatedBytes: bytes.optional(),
}).strict().superRefine((target, context) => {
  if ((target.status === "measured") !== (target.allocatedBytes !== undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom, message: "Only complete measurements may include bytes.",
    });
  }
});

export const oracleDiskAuditResultSchema = z.object({
  status: z.enum(["ready", "permission_required", "unavailable"]),
  privileged: z.boolean(),
  group: groupSchema,
  start: nonnegative,
  count: nonnegative,
  nextStart: nonnegative.nullable(),
  complete: z.boolean(),
  filesystem: z.object({
    totalBytes: bytes, usedBytes: bytes, availableBytes: bytes,
  }).strict().nullable(),
  targets: z.array(targetSchema).max(3),
  measuredBytes: bytes,
  diagnostic: z.enum(["helper_missing", "sudo_permission_required", "execution_failed", "invalid_response"]).optional(),
  warning: z.string().max(250),
}).strict();
export type OracleDiskAuditResult = z.infer<typeof oracleDiskAuditResultSchema>;
/** Root-owned bootstrap pins this exact, previously published audit module. */
export const ORACLE_DISK_AUDIT_PINNED_SHA256 =
  "c922695d1e2c02521619e4e472c3e4fc696f51c4f6c01f78164a564ad9fd8aa3" as const;

export const oracleDiskAuditProvisionInputSchema = z.discriminatedUnion("action", [
  z.object({
    workspaceId: z.literal("mcp-access-stack"),
    action: z.literal("inspect"),
  }).strict(),
  z.object({
    workspaceId: z.literal("mcp-access-stack"),
    action: z.literal("install"),
    operationId: z.uuid(),
    expectedSourceSha256: z.literal(ORACLE_DISK_AUDIT_PINNED_SHA256),
  }).strict(),
]);
export type OracleDiskAuditProvisionInput = z.infer<typeof oracleDiskAuditProvisionInputSchema>;

export const oracleDiskAuditProvisionResultSchema = z.object({
  status: z.enum([
    "bootstrap_required", "ready", "installed", "already_installed",
    "permission_required", "unavailable", "outcome_unknown",
  ]),
  bootstrapPresent: z.boolean(),
  auditPresent: z.boolean(),
  pinnedSourceSha256: z.literal(ORACLE_DISK_AUDIT_PINNED_SHA256),
  operationId: z.uuid().optional(),
  diagnostic: z.enum([
    "linux_only", "host_root_bootstrap_required", "source_hash_mismatch",
    "invalid_install_receipt", "installed_files_unverified", "root_policy_denied",
    "inspect_before_retry",
  ]).optional(),
}).strict();
export type OracleDiskAuditProvisionResult = z.infer<typeof oracleDiskAuditProvisionResultSchema>;
