import { z } from "zod";

const groupSchema = z.enum(["root", "system", "releases", "worktrees"]);
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
