import { z } from "zod";
import { shellNameSchema } from "./policy.js";

export const commandConfirmationRequiredResultSchema = z
  .object({
    status: z.literal("confirmation_required"),
    shell: shellNameSchema,
    cwd: z.string(),
    confirmationId: z.string(),
    expiresAt: z.iso.datetime(),
    reasons: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type CommandConfirmationRequiredResult = z.infer<
  typeof commandConfirmationRequiredResultSchema
>;
