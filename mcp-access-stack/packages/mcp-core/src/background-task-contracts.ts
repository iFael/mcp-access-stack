import { z } from "zod";
import { shellNameSchema } from "./policy.js";
import {
  MAX_BACKGROUND_OPERATION_TIMEOUT_MS,
  operationLifecycleSchema,
} from "./timeout-policy.js";

const workspaceIdSchema = z.string().trim().min(1);
const taskIdSchema = z.uuid();

export const BACKGROUND_TASK_STATES = [
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export const backgroundTaskStateSchema = z.enum(BACKGROUND_TASK_STATES);
export type BackgroundTaskState = z.infer<typeof backgroundTaskStateSchema>;

export const backgroundTaskRunResultSchema = z
  .object({
    status: z.literal("executed"),
    shell: shellNameSchema,
    cwd: z.string(),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
    lifecycle: operationLifecycleSchema.optional(),
  })
  .strict();

export const backgroundTaskRecordSchema = z
  .object({
    version: z.literal(1),
    id: taskIdSchema,
    workspaceId: workspaceIdSchema,
    operation: z.string().trim().min(1).max(128),
    commandHash: z.string().regex(/^[a-f0-9]{64}$/u),
    command: z.string().min(1).max(32_000),
    shell: shellNameSchema,
    cwd: z.string().min(1),
    state: backgroundTaskStateSchema,
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    timeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(MAX_BACKGROUND_OPERATION_TIMEOUT_MS),
    pid: z.number().int().positive().optional(),
    result: backgroundTaskRunResultSchema.optional(),
    error: z.string().optional(),
    lifecycle: operationLifecycleSchema.optional(),
  })
  .strict();

export type BackgroundTaskRecord = z.infer<typeof backgroundTaskRecordSchema>;

export const startBackgroundTaskInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    operation: z.string().trim().min(1).max(128),
    command: z
      .string()
      .min(1)
      .max(32_000)
      .refine((value) => value.trim().length > 0, {
        message: "command must contain a non-whitespace character.",
      }),
    shell: shellNameSchema,
    cwd: z.string().trim().min(1).optional(),
    timeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(MAX_BACKGROUND_OPERATION_TIMEOUT_MS)
      .default(120_000),
  })
  .strict();

export type StartBackgroundTaskInput = z.input<
  typeof startBackgroundTaskInputSchema
>;
export type ParsedStartBackgroundTaskInput = z.output<
  typeof startBackgroundTaskInputSchema
>;

export const getBackgroundTaskInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    id: taskIdSchema,
  })
  .strict();
export type GetBackgroundTaskInput = z.infer<typeof getBackgroundTaskInputSchema>;

export const listBackgroundTasksInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    state: backgroundTaskStateSchema.optional(),
  })
  .strict();
export type ListBackgroundTasksInput = z.infer<
  typeof listBackgroundTasksInputSchema
>;

export const cancelBackgroundTaskInputSchema = getBackgroundTaskInputSchema;
export type CancelBackgroundTaskInput = GetBackgroundTaskInput;

export const readBackgroundTaskLogsInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    id: taskIdSchema,
    maxBytes: z.number().int().positive().max(1_000_000).default(100_000),
  })
  .strict();
export type ReadBackgroundTaskLogsInput = z.input<
  typeof readBackgroundTaskLogsInputSchema
>;
export type ParsedReadBackgroundTaskLogsInput = z.output<
  typeof readBackgroundTaskLogsInputSchema
>;

export const backgroundTaskResultSchema = z
  .object({ task: backgroundTaskRecordSchema.nullable() })
  .strict();
export type BackgroundTaskResult = z.infer<typeof backgroundTaskResultSchema>;

export const backgroundTaskListResultSchema = z
  .object({ tasks: z.array(backgroundTaskRecordSchema) })
  .strict();
export type BackgroundTaskListResult = z.infer<
  typeof backgroundTaskListResultSchema
>;

export const backgroundTaskLogsResultSchema = z
  .object({
    id: taskIdSchema,
    stdout: z.string(),
    stderr: z.string(),
    stdoutBytes: z.number().int().nonnegative(),
    stderrBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();
export type BackgroundTaskLogsResult = z.infer<
  typeof backgroundTaskLogsResultSchema
>;

export const backgroundTaskLogsLookupResultSchema = z
  .object({ logs: backgroundTaskLogsResultSchema.nullable() })
  .strict();
export type BackgroundTaskLogsLookupResult = z.infer<
  typeof backgroundTaskLogsLookupResultSchema
>;
