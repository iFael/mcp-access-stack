import { z } from "zod";
import { backgroundTaskStateSchema } from "./background-task-contracts.js";
import { gitDiffModeSchema } from "./contracts.js";
import { errorCodes } from "./errors.js";

const workspaceIdSchema = z.string().trim().min(1);
const keySchema = z.string().trim().min(1).max(64);
const relativePathSchema = z.string().min(1);
const taskIdSchema = z.uuid();

export const inspectWorkspaceBatchOperationSchema = z.enum([
  "list_workspace_roots",
  "list_files",
  "read_file",
  "search_files",
  "inspect_workspace_git",
  "get_workspace_context",
  "get_background_task",
  "list_background_tasks",
  "get_release_state",
]);

export type InspectWorkspaceBatchOperation = z.infer<
  typeof inspectWorkspaceBatchOperationSchema
>;

const inspectWorkspaceBatchItemBaseSchema = z
  .object({
    key: keySchema,
    operation: inspectWorkspaceBatchOperationSchema,
    root: relativePathSchema.optional(),
    glob: z.string().min(1).optional(),
    path: relativePathSchema.optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    query: z.string().min(1).optional(),
    caseSensitive: z.boolean().optional(),
    diffMode: gitDiffModeSchema.optional(),
    paths: z.array(relativePathSchema).max(20).optional(),
    maxDiffBytes: z.number().int().positive().max(1_000_000).optional(),
    taskId: taskIdSchema.optional(),
    state: backgroundTaskStateSchema.optional(),
  })
  .strict();

const allowedFieldsByOperation: Record<
  InspectWorkspaceBatchOperation,
  ReadonlySet<string>
> = {
  list_workspace_roots: new Set(["key", "operation"]),
  list_files: new Set(["key", "operation", "root", "glob"]),
  read_file: new Set([
    "key",
    "operation",
    "path",
    "startLine",
    "endLine",
  ]),
  search_files: new Set([
    "key",
    "operation",
    "query",
    "root",
    "glob",
    "caseSensitive",
  ]),
  inspect_workspace_git: new Set([
    "key",
    "operation",
    "root",
    "diffMode",
    "paths",
    "maxDiffBytes",
  ]),
  get_workspace_context: new Set(["key", "operation", "root"]),
  get_background_task: new Set(["key", "operation", "taskId"]),
  list_background_tasks: new Set(["key", "operation", "state"]),
  get_release_state: new Set(["key", "operation"]),
};

export const inspectWorkspaceBatchItemSchema =
  inspectWorkspaceBatchItemBaseSchema.superRefine((item, ctx) => {
    const required =
      item.operation === "read_file"
        ? (["path"] as const)
        : item.operation === "search_files"
          ? (["query"] as const)
          : item.operation === "get_background_task"
            ? (["taskId"] as const)
            : ([] as const);

    for (const field of required) {
      if (item[field] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required for ${item.operation}.`,
        });
      }
    }

    if (
      item.endLine !== undefined &&
      (item.startLine === undefined || item.endLine < item.startLine)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endLine"],
        message:
          "endLine requires startLine and must be greater than or equal to it.",
      });
    }

    const allowed = allowedFieldsByOperation[item.operation];
    for (const [field, value] of Object.entries(item)) {
      if (value !== undefined && !allowed.has(field)) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is not valid for ${item.operation}.`,
        });
      }
    }
  });

export const inspectWorkspaceBatchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    items: z.array(inspectWorkspaceBatchItemSchema).min(1).max(12),
  })
  .strict()
  .superRefine(({ items }, ctx) => {
    const keys = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (keys.has(item.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "key"],
          message: "Batch item keys must be unique.",
        });
      }
      keys.add(item.key);
    }
  });

export type InspectWorkspaceBatchInput = z.infer<
  typeof inspectWorkspaceBatchInputSchema
>;

const batchErrorSchema = z
  .object({
    code: z.enum(errorCodes),
    message: z.string(),
  })
  .strict();

export const inspectWorkspaceBatchItemResultSchema = z
  .object({
    key: keySchema,
    operation: inspectWorkspaceBatchOperationSchema,
    status: z.enum(["ok", "error"]),
    result: z.record(z.string(), z.unknown()).optional(),
    error: batchErrorSchema.optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (item.status === "ok" && item.result === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["result"],
        message: "result is required when status=ok.",
      });
    }
    if (item.status === "error" && item.error === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "error is required when status=error.",
      });
    }
  });

export const inspectWorkspaceBatchResultSchema = z
  .object({
    items: z.array(inspectWorkspaceBatchItemResultSchema),
  })
  .strict();

export type InspectWorkspaceBatchResult = z.infer<
  typeof inspectWorkspaceBatchResultSchema
>;
