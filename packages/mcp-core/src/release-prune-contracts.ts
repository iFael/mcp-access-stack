import { z } from "zod";

const nameSchema = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
  .refine((s) => !s.includes("..") && s !== "." && s !== "..");
export const pruneReleaseTargetSchema = z.object({
  kind: z.enum(["release", "staging"]),
  name: nameSchema,
}).strict();

export const pruneReleasesInputSchema = z.object({
  workspaceId: z.string().trim().min(1),
  operationId: z.uuid(),
  dryRun: z.boolean(),
  expectedStateSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  selection: z.enum(["eligible"]).optional(),
  targets: z.array(pruneReleaseTargetSchema).min(1).max(5).optional(),
  expectedPlanSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
}).strict().superRefine((input, ctx) => {
  if (!input.dryRun && !input.expectedStateSha256) {
    ctx.addIssue({ code: "custom", message: "Execution requires the lifecycle SHA from a prior dry run." });
  }
  if (input.selection === "eligible") {
    if (input.targets !== undefined) {
      ctx.addIssue({ code: "custom", message: "Automatic selection cannot include explicit targets." });
    }
    if (!input.dryRun && !input.expectedPlanSha256) {
      ctx.addIssue({ code: "custom", message: "Automatic execution requires the exact dry-run plan SHA." });
    }
  } else {
    if (!input.targets) {
      ctx.addIssue({ code: "custom", message: "Explicit pruning requires targets." });
    }
    if (input.expectedPlanSha256 !== undefined) {
      ctx.addIssue({ code: "custom", message: "Plan SHA applies only to automatic selection." });
    }
  }
  const names = new Set((input.targets ?? []).map((t) => t.kind + ":" + t.name));
  if (names.size !== (input.targets ?? []).length) {
    ctx.addIssue({ code: "custom", message: "Duplicate prune targets are prohibited." });
  }
});
export type PruneReleasesInput = z.infer<typeof pruneReleasesInputSchema>;

export const pruneReleasesResultSchema = z.object({
  operationId: z.uuid(),
  status: z.enum(["planned", "completed"]),
  stateSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  planSha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  items: z.array(z.object({
    kind: z.enum(["release", "staging"]),
    name: nameSchema,
    status: z.enum(["eligible", "deleted", "absent"]),
  }).strict()).max(5),
}).strict();
export type PruneReleasesResult = z.infer<typeof pruneReleasesResultSchema>;
