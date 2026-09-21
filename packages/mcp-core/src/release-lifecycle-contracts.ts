import { z } from "zod";
import { backgroundTaskRecordSchema } from "./background-task-contracts.js";
import { windowsExecutionNodeStateSchema } from "./windows-execution-node-contracts.js";

const workspaceIdSchema = z.string().trim().min(1);
const confirmationIdSchema = z.string().trim().min(1).max(128);
const expiresAtSchema = z.iso.datetime();
const releaseIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const releaseTagSchema = z
  .string()
  .trim()
  .regex(/^v[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);

export const getReleaseStateInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
  })
  .strict();

export type GetReleaseStateInput = z.infer<typeof getReleaseStateInputSchema>;

export const getReleaseStateResultSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    installationRoot: z.string().min(1),
    state: windowsExecutionNodeStateSchema,
    activeBootstrap: z
      .object({
        updateScriptPresent: z.boolean(),
        cutoverScriptPresent: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type GetReleaseStateResult = z.infer<typeof getReleaseStateResultSchema>;

export const prepareReleaseInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    tag: releaseTagSchema,
    confirmationId: confirmationIdSchema.optional(),
  })
  .strict();

export type PrepareReleaseInput = z.infer<typeof prepareReleaseInputSchema>;

const releaseConfirmationFields = {
  confirmationId: confirmationIdSchema,
  expiresAt: expiresAtSchema,
  reasons: z.array(z.string().min(1)).min(1),
};

const prepareReleaseResultValueSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("confirmation_required"),
      tag: releaseTagSchema,
      ...releaseConfirmationFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("background_task_started"),
      tag: releaseTagSchema,
      task: backgroundTaskRecordSchema,
    })
    .strict(),
]);

export type PrepareReleaseResult = z.infer<typeof prepareReleaseResultValueSchema>;

export const prepareReleaseResultSchema = z
  .object({
    status: z.enum(["confirmation_required", "background_task_started"]),
    tag: releaseTagSchema,
    confirmationId: confirmationIdSchema.optional(),
    expiresAt: expiresAtSchema.optional(),
    reasons: z.array(z.string().min(1)).min(1).optional(),
    task: backgroundTaskRecordSchema.optional(),
  })
  .strict()
  .refine((value) => prepareReleaseResultValueSchema.safeParse(value).success, {
    message: "Invalid prepare_release MCP result.",
  }) as z.ZodType<PrepareReleaseResult>;

export const promoteReleaseInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    releaseId: releaseIdSchema,
    confirmationId: confirmationIdSchema.optional(),
  })
  .strict();

export type PromoteReleaseInput = z.infer<typeof promoteReleaseInputSchema>;

const promoteReleaseResultValueSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("confirmation_required"),
      releaseId: releaseIdSchema,
      ...releaseConfirmationFields,
    })
    .strict(),
  z
    .object({
      status: z.literal("handover_started"),
      releaseId: releaseIdSchema,
      requestId: z.uuid(),
      brokerTaskName: z.string().min(1),
      resultPath: z.string().min(1),
      installationRoot: z.string().min(1),
      projectRoot: z.string().min(1),
    })
    .strict(),
]);

export type PromoteReleaseResult = z.infer<typeof promoteReleaseResultValueSchema>;

export const promoteReleaseResultSchema = z
  .object({
    status: z.enum(["confirmation_required", "handover_started"]),
    releaseId: releaseIdSchema,
    confirmationId: confirmationIdSchema.optional(),
    expiresAt: expiresAtSchema.optional(),
    reasons: z.array(z.string().min(1)).min(1).optional(),
    requestId: z.uuid().optional(),
    brokerTaskName: z.string().min(1).optional(),
    resultPath: z.string().min(1).optional(),
    installationRoot: z.string().min(1).optional(),
    projectRoot: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => promoteReleaseResultValueSchema.safeParse(value).success, {
    message: "Invalid promote_release MCP result.",
  }) as z.ZodType<PromoteReleaseResult>;
