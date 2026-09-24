import { z } from "zod";
import { shellNameSchema } from "./policy.js";
import { errorCodes } from "./errors.js";
import { commandConfirmationRequiredResultSchema } from "./command-confirmation-contracts.js";
import {
  MAX_BACKGROUND_OPERATION_TIMEOUT_MS,
  operationLifecycleSchema,
  synchronousTimeoutMsSchema,
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
    interactive: z.literal(true).optional(),
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
    confirmationId: z.string().trim().min(1).max(128).optional(),
    interactive: z.boolean().default(false),
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

export const backgroundTaskStartedResultSchema = z
  .object({
    status: z.literal("background_task_started"),
    task: backgroundTaskRecordSchema,
  })
  .strict();

export const startBackgroundTaskResultSchema = z.discriminatedUnion("status", [
  backgroundTaskStartedResultSchema,
  commandConfirmationRequiredResultSchema,
]);
export type StartBackgroundTaskResult = z.infer<typeof startBackgroundTaskResultSchema>;

/** Object-shaped projection used only at the MCP SDK output-validation boundary. */
export const startBackgroundTaskMcpResultSchema = z
  .object({
    status: z.enum(["background_task_started", "confirmation_required"]),
    task: backgroundTaskRecordSchema.optional(),
    shell: shellNameSchema.optional(),
    cwd: z.string().optional(),
    confirmationId: z.string().optional(),
    expiresAt: z.iso.datetime().optional(),
    reasons: z.array(z.string().min(1)).optional(),
  })
  .strict();

export const getBackgroundTaskInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    id: taskIdSchema,
  })
  .strict();
export type GetBackgroundTaskInput = z.infer<typeof getBackgroundTaskInputSchema>;

export const getBackgroundTasksInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    ids: z.array(taskIdSchema).min(1).max(20),
  })
  .strict();
export type GetBackgroundTasksInput = z.infer<typeof getBackgroundTasksInputSchema>;

export const waitBackgroundTaskInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    id: taskIdSchema,
    timeoutMs: synchronousTimeoutMsSchema,
    maxBytes: z.number().int().positive().max(1_000_000).default(100_000),
  })
  .strict();
export type WaitBackgroundTaskInput = z.input<typeof waitBackgroundTaskInputSchema>;
export type ParsedWaitBackgroundTaskInput = z.output<typeof waitBackgroundTaskInputSchema>;

export const waitBackgroundTaskToolInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    id: taskIdSchema,
    timeoutMs: z.number().int().positive().max(30_000).default(15_000),
    maxBytes: z.number().int().positive().max(1_000_000).default(100_000),
  })
  .strict();
export type WaitBackgroundTaskToolInput = z.input<
  typeof waitBackgroundTaskToolInputSchema
>;
export type ParsedWaitBackgroundTaskToolInput = z.output<
  typeof waitBackgroundTaskToolInputSchema
>;

export const waitBackgroundTasksToolInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    ids: z.array(taskIdSchema).min(1).max(8),
    timeoutMs: z.number().int().positive().max(30_000).default(15_000),
    maxBytes: z.number().int().positive().max(1_000_000).default(100_000),
  })
  .strict()
  .superRefine(({ ids }, context) => {
    const unique = new Set<string>();
    for (const [index, id] of ids.entries()) {
      if (unique.has(id)) {
        context.addIssue({
          code: "custom",
          path: ["ids", index],
          message: "Background task ids must be unique.",
        });
      }
      unique.add(id);
    }
  });
export type WaitBackgroundTasksToolInput = z.input<
  typeof waitBackgroundTasksToolInputSchema
>;
export type ParsedWaitBackgroundTasksToolInput = z.output<
  typeof waitBackgroundTasksToolInputSchema
>;

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

export const backgroundTasksResultSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: taskIdSchema,
          task: backgroundTaskRecordSchema.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type BackgroundTasksResult = z.infer<typeof backgroundTasksResultSchema>;

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

export const writeBackgroundTaskStdinInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    id: taskIdSchema,
    input: z.string().max(64_000).default(""),
    close: z.boolean().default(false),
  })
  .strict()
  .refine(({ input, close }) => input.length > 0 || close, {
    message: "input must not be empty unless close=true.",
  });
export type WriteBackgroundTaskStdinInput = z.input<
  typeof writeBackgroundTaskStdinInputSchema
>;
export type ParsedWriteBackgroundTaskStdinInput = z.output<
  typeof writeBackgroundTaskStdinInputSchema
>;

export const backgroundTaskStdinResultSchema = z
  .object({
    task: backgroundTaskRecordSchema.nullable(),
    bytesWritten: z.number().int().nonnegative(),
    stdinClosed: z.boolean(),
  })
  .strict();
export type BackgroundTaskStdinResult = z.infer<
  typeof backgroundTaskStdinResultSchema
>;

export const readBackgroundTaskOutputInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    id: taskIdSchema,
    stdoutOffset: z.number().int().nonnegative().default(0),
    stderrOffset: z.number().int().nonnegative().default(0),
    maxBytes: z.number().int().min(4).max(1_000_000).default(256_000),
  })
  .strict();
export type ReadBackgroundTaskOutputInput = z.input<
  typeof readBackgroundTaskOutputInputSchema
>;
export type ParsedReadBackgroundTaskOutputInput = z.output<
  typeof readBackgroundTaskOutputInputSchema
>;

export const backgroundTaskOutputChunkSchema = z
  .object({
    content: z.string(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    eof: z.boolean(),
  })
  .strict();

export const backgroundTaskOutputResultSchema = z
  .object({
    task: backgroundTaskRecordSchema.nullable(),
    stdout: backgroundTaskOutputChunkSchema.nullable(),
    stderr: backgroundTaskOutputChunkSchema.nullable(),
  })
  .strict();
export type BackgroundTaskOutputResult = z.infer<
  typeof backgroundTaskOutputResultSchema
>;

export const backgroundTaskWaitResultSchema = z
  .object({
    task: backgroundTaskRecordSchema.nullable(),
    logs: backgroundTaskLogsResultSchema.nullable(),
    timedOut: z.boolean(),
    elapsedMs: z.number().int().nonnegative(),
  })
  .strict();
export type BackgroundTaskWaitResult = z.infer<
  typeof backgroundTaskWaitResultSchema
>;

const backgroundTaskWaitBatchErrorSchema = z
  .object({
    code: z.enum(errorCodes),
    message: z.string(),
  })
  .strict();

export const backgroundTaskWaitBatchItemResultSchema = z
  .object({
    id: taskIdSchema,
    status: z.enum(["ok", "error"]),
    result: backgroundTaskWaitResultSchema.optional(),
    error: backgroundTaskWaitBatchErrorSchema.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.status === "ok" && item.result === undefined) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "result is required when status=ok.",
      });
    }
    if (item.status === "error" && item.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "error is required when status=error.",
      });
    }
  });

export const backgroundTasksWaitResultSchema = z
  .object({
    items: z.array(backgroundTaskWaitBatchItemResultSchema).min(1).max(8),
    timedOutCount: z.number().int().nonnegative().max(8),
    errorCount: z.number().int().nonnegative().max(8),
  })
  .strict();

export type BackgroundTasksWaitResult = z.infer<
  typeof backgroundTasksWaitResultSchema
>;
