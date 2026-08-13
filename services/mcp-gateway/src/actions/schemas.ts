import {
  commandAutoCorrectionModeSchema,
  commandExecutionModeSchema,
  commandExpectedOutcomeSchema,
  getWorkspaceContextInputSchema,
  inspectGitInputSchema,
  inspectGitResultSchema,
  listFilesInputSchema,
  patchFileInputSchema,
  readFileInputSchema,
  runWorkspaceValidationInputSchema,
  runCommandInputSchema,
  runPowerShellInputSchema,
  preferredCommandShellSchema,
  shellNameSchema,
  MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
  QUICK_OPERATION_TIMEOUT_MS,
  searchFilesInputSchema,
  synchronousTimeoutMsSchema,
  writeFileInputSchema,
} from "@vs-code-gpt/shared";
import { z } from "zod";
import {
  consoleApprovalKindValues,
  consoleApprovalStateValues,
  consoleFileStateValues,
  consoleOutcomeValues,
  consoleStageValues,
  consoleValidationStateValues,
} from "./console/service.js";

const actionWorkspaceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const actionSynchronousTimeoutMsSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS, {
    message:
      "HTTP synchronous commands are limited to 300000 ms. Use the MCP BackgroundTaskManager for longer operations.",
  })
  .default(QUICK_OPERATION_TIMEOUT_MS);
const consoleRunIdSchema = z
  .string()
  .regex(/^MT-\d{8}-[A-F0-9]{16}$/u, "Invalid conversational console run id.");
const consoleRunReferenceShape = {
  runId: consoleRunIdSchema.optional(),
};
const consoleRelativePathSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => {
    const normalized = value.replaceAll("\\", "/");
    return (
      !normalized.startsWith("/") &&
      !/^[A-Za-z]:\//u.test(normalized) &&
      !normalized.split("/").includes("..")
    );
  }, "Console paths must be relative and must not contain parent traversal.");
export const startConsoleRunInputSchema = z
  .object({
    workspaceId: actionWorkspaceIdSchema,
    root: consoleRelativePathSchema.default("."),
    objective: z.string().min(1).max(500),
    expectedBranch: z.string().min(1).max(200).optional(),
  })
  .strict();
export const updateConsoleRunInputSchema = z
  .object({
    runId: consoleRunIdSchema,
    stage: z.enum(consoleStageValues).optional(),
    status: z.enum(["running", "waiting_confirmation"]).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    summary: z.string().min(1).max(500).optional(),
    branch: z.string().min(1).max(200).optional(),
    files: z
      .array(
        z
          .object({
            path: consoleRelativePathSchema,
            state: z.enum(consoleFileStateValues),
            additions: z.number().int().nonnegative().optional(),
            deletions: z.number().int().nonnegative().optional(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    validations: z
      .array(
        z
          .object({
            name: z.string().min(1).max(100),
            state: z.enum(consoleValidationStateValues),
            summary: z.string().min(1).max(300).optional(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    approval: z
      .object({
        kind: z.enum(consoleApprovalKindValues),
        state: z.enum(consoleApprovalStateValues),
        label: z.string().min(1).max(300),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.stage !== undefined ||
      input.status !== undefined ||
      input.progress !== undefined ||
      input.summary !== undefined ||
      input.branch !== undefined ||
      (input.files?.length ?? 0) > 0 ||
      (input.validations?.length ?? 0) > 0 ||
      input.approval !== undefined,
    { message: "Provide at least one console update." },
  );
export const getConsoleRunInputSchema = z
  .object({ runId: consoleRunIdSchema })
  .strict();
export const listConsoleEventsInputSchema = z
  .object({
    runId: consoleRunIdSchema,
    afterSequence: z.number().int().nonnegative().default(0),
  })
  .strict();
export const finishConsoleRunInputSchema = z
  .object({
    runId: consoleRunIdSchema,
    outcome: z.enum(consoleOutcomeValues),
    summary: z.string().min(1).max(500).optional(),
  })
  .strict();
export const listFilesActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    root: listFilesInputSchema.shape.root,
    glob: listFilesInputSchema.shape.glob,
  })
  .strict();
export const readFileActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    path: readFileInputSchema.shape.path,
    startLine: readFileInputSchema.shape.startLine,
    endLine: readFileInputSchema.shape.endLine,
  })
  .strict()
  .refine(
    ({ startLine, endLine }) =>
      endLine === undefined || (startLine !== undefined && endLine >= startLine),
    { message: "endLine requires startLine and must be greater than or equal to it." },
  );
export const readFilesActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    files: z
      .array(
        z
          .object({
            path: readFileInputSchema.shape.path,
            startLine: readFileInputSchema.shape.startLine,
            endLine: readFileInputSchema.shape.endLine,
          })
          .strict()
          .refine(
            ({ startLine, endLine }) =>
              endLine === undefined || (startLine !== undefined && endLine >= startLine),
            { message: "endLine requires startLine and must be greater than or equal to it." },
          ),
      )
      .min(1)
      .max(10),
    maxTotalBytes: z.number().int().positive().max(1_000_000).default(500_000),
  })
  .strict();
export const searchFilesActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    query: searchFilesInputSchema.shape.query,
    root: searchFilesInputSchema.shape.root,
    glob: searchFilesInputSchema.shape.glob,
    caseSensitive: searchFilesInputSchema.shape.caseSensitive,
  })
  .strict();
export const workspaceContextActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    root: getWorkspaceContextInputSchema.shape.root,
  })
  .strict();
export const patchFileActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    path: patchFileInputSchema.shape.path,
    expectedSha256: patchFileInputSchema.shape.expectedSha256,
    replacements: patchFileInputSchema.shape.replacements,
    dryRun: patchFileInputSchema.shape.dryRun,
  })
  .strict();
export const prepareWorkspaceTaskInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    root: consoleRelativePathSchema.default("."),
    targetPaths: z.array(z.string().min(1)).max(20).default([]),
    intent: z.enum(["inspect", "change"]).default("inspect"),
    includeDocumentContents: z.boolean().default(true),
    maxDocumentBytes: z.number().int().positive().max(500_000).default(200_000),
    timeoutMs: synchronousTimeoutMsSchema,
  })
  .strict();
export const validateWorkspaceChangesInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    root: consoleRelativePathSchema.default("."),
    paths: z.array(z.string().min(1)).max(20).optional(),
    allowedPathPrefixes: z.array(z.string().min(1)).max(20).optional(),
    forbiddenPathPrefixes: z.array(z.string().min(1)).max(20).default([]),
    expectedBranch: z.string().min(1).optional(),
    maxDiffBytes: z.number().int().positive().max(80_000).default(60_000),
    timeoutMs: synchronousTimeoutMsSchema,
  })
  .strict();
export const writeFileActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    path: writeFileInputSchema.shape.path,
    content: writeFileInputSchema.shape.content,
  })
  .strict();
export const runWorkspaceValidationActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    root: runWorkspaceValidationInputSchema.shape.root,
    validation: runWorkspaceValidationInputSchema.shape.validation,
    scope: runWorkspaceValidationInputSchema.shape.scope,
    paths: runWorkspaceValidationInputSchema.shape.paths,
    maxFindings: runWorkspaceValidationInputSchema.shape.maxFindings,
    timeoutMs: runWorkspaceValidationInputSchema.shape.timeoutMs,
  })
  .strict()
  .superRefine(({ scope, paths }, context) => {
    if (scope === "paths" && (paths?.length ?? 0) === 0) {
      context.addIssue({
        code: "custom",
        path: ["paths"],
        message: "paths must contain at least one item when scope is paths.",
      });
    }
  });
export const runCommandActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    command: z.string().min(1).max(32_000).optional(),
    objective: z.string().min(1).max(4_000).optional(),
    executionMode: commandExecutionModeSchema.optional(),
    autoCorrection: commandAutoCorrectionModeSchema.optional(),
    preferredShell: preferredCommandShellSchema.optional(),
    expectedOutcome: z.array(commandExpectedOutcomeSchema).max(20).optional(),
    cwd: z.string().min(1).optional(),
    timeoutMs: actionSynchronousTimeoutMsSchema,
    confirmationId: z.string().min(1).max(128).optional(),
    shell: shellNameSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const { runId: _runId, ...operationInput } = input;
    const parsed = runCommandInputSchema.safeParse(operationInput);
    if (parsed.success) return;
    for (const issue of parsed.error.issues) {
      context.addIssue({
        code: "custom",
        path: issue.path,
        message: issue.message,
      });
    }
  });
export const runPowerShellActionInputSchema = z
  .object({
    ...consoleRunReferenceShape,
    workspaceId: actionWorkspaceIdSchema,
    command: runPowerShellInputSchema.shape.command,
    cwd: runPowerShellInputSchema.shape.cwd,
    timeoutMs: actionSynchronousTimeoutMsSchema,
    confirmationId: runPowerShellInputSchema.shape.confirmationId,
  })
  .strict();
export const workspaceGitInputSchema = inspectGitInputSchema
  .extend({
    workspaceId: actionWorkspaceIdSchema,
    runId: consoleRunIdSchema.optional(),
  })
  .strict();
export const workspaceGitResultSchema = inspectGitResultSchema
  .extend({ workspaceId: actionWorkspaceIdSchema })
  .strict();
