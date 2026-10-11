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
  targets: z.array(pruneReleaseTargetSchema).min(1).max(5),
}).strict().superRefine((input, ctx) => {
  if (!input.dryRun && !input.expectedStateSha256) {
    ctx.addIssue({ code: "custom", message: "Execution requires the lifecycle SHA from a prior dry run." });
  }
  const names = new Set(input.targets.map((t) => t.kind + ":" + t.name));
  if (names.size !== input.targets.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate prune targets are prohibited." });
  }
});
export type PruneReleasesInput = z.infer<typeof pruneReleasesInputSchema>;

export const pruneReleasesResultSchema = z.object({
  operationId: z.uuid(),
  status: z.enum(["planned", "completed"]),
  stateSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  items: z.array(z.object({
    kind: z.enum(["release", "staging"]),
    name: nameSchema,
    status: z.enum(["eligible", "deleted", "absent"]),
  }).strict()).min(1).max(5),
}).strict();
export type PruneReleasesResult = z.infer<typeof pruneReleasesResultSchema>;
