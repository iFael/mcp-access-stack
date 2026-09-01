import { z } from "zod";
import { errorCodes, errorDetailsSchema } from "./errors.js";
import { confirmationModeSchema, permissionProfileSchema, shellNameSchema, workspaceKindSchema } from "./policy.js";
import {
  commandAttemptSchema,
  commandAutoCorrectionModeSchema,
  commandCorrectionSchema,
  commandDiagnosisSchema,
  commandExecutionModeSchema,
  commandExpectedOutcomeSchema,
  commandPostconditionResultSchema,
  preferredCommandShellSchema,
} from "./qualified-command-contracts.js";
import {
  operationDeadlineSchema,
  operationLifecycleSchema,
  routableCommandTimeoutMsSchema,
  synchronousTimeoutMsSchema,
} from "./timeout-policy.js";
import {
  backgroundTaskListResultSchema,
  backgroundTaskLogsLookupResultSchema,
  backgroundTaskWaitResultSchema,
  backgroundTaskRecordSchema,
  backgroundTaskResultSchema,
  cancelBackgroundTaskInputSchema,
  getBackgroundTaskInputSchema,
  waitBackgroundTaskInputSchema,
  listBackgroundTasksInputSchema,
  readBackgroundTaskLogsInputSchema,
  startBackgroundTaskInputSchema,
} from "./background-task-contracts.js";

const workspaceIdSchema = z.string().trim().min(1);
const relativePathSchema = z.string().min(1);

export const listFilesInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: relativePathSchema.optional(),
    glob: z.string().min(1).optional(),
  })
  .strict();

export type ListFilesInput = z.infer<typeof listFilesInputSchema>;

export const listWorkspaceRootsInputSchema = z
  .object({ workspaceId: workspaceIdSchema })
  .strict();

export type ListWorkspaceRootsInput = z.infer<typeof listWorkspaceRootsInputSchema>;

export const readFileInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    path: relativePathSchema,
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    ({ startLine, endLine }) =>
      endLine === undefined || (startLine !== undefined && endLine >= startLine),
    { message: "endLine requires startLine and must be greater than or equal to it." },
  );

export type ReadFileInput = z.infer<typeof readFileInputSchema>;

export const readBinaryFileInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    path: relativePathSchema,
  })
  .strict();

export type ReadBinaryFileInput = z.infer<typeof readBinaryFileInputSchema>;

export const writeFileInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    path: relativePathSchema,
    content: z.string(),
  })
  .strict();

export type WriteFileInput = z.infer<typeof writeFileInputSchema>;

export const writeFileResultSchema = z
  .object({
    path: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    created: z.boolean(),
  })
  .strict();

export type WriteFileResult = z.infer<typeof writeFileResultSchema>;

export const textEncodingSchema = z.enum([
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-1252",
  "latin1",
]);

export type TextEncoding = z.infer<typeof textEncodingSchema>;

export const lineEndingSchema = z.enum(["lf", "crlf", "cr", "mixed", "none"]);

export type LineEnding = z.infer<typeof lineEndingSchema>;

export const patchReplacementSchema = z
  .object({
    oldText: z.string().min(1),
    newText: z.string(),
    expectedCount: z.number().int().positive().max(100).default(1),
  })
  .strict();

export const patchFileInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    path: relativePathSchema,
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    replacements: z.array(patchReplacementSchema).min(1).max(20),
    dryRun: z.boolean().default(false),
  })
  .strict();

export type PatchFileInput = z.input<typeof patchFileInputSchema>;

export const patchFileResultSchema = z
  .object({
    path: z.string(),
    sha256Before: z.string().regex(/^[a-f0-9]{64}$/),
    sha256After: z.string().regex(/^[a-f0-9]{64}$/),
    encoding: textEncodingSchema,
    lineEnding: lineEndingSchema,
    replacementsApplied: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    changed: z.boolean(),
    dryRun: z.boolean(),
  })
  .strict();

export type PatchFileResult = z.infer<typeof patchFileResultSchema>;

export const workspaceValidationNameSchema = z.enum([
  "diff-check",
  "legacy-format",
  "legacy-compat",
  "secret-scan",
]);

export type WorkspaceValidationName = z.infer<typeof workspaceValidationNameSchema>;

export const workspaceValidationScopeSchema = z.enum([
  "changes",
  "paths",
  "repository",
]);

export type WorkspaceValidationScope = z.infer<typeof workspaceValidationScopeSchema>;

export const runWorkspaceValidationInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: relativePathSchema.default("."),
    validation: workspaceValidationNameSchema,
    scope: workspaceValidationScopeSchema.default("changes"),
    paths: z.array(relativePathSchema).max(20).default([]),
    maxFindings: z.number().int().positive().max(200).default(100),
    timeoutMs: synchronousTimeoutMsSchema,
  })
  .strict()
  .superRefine(({ scope, paths }, context) => {
    if (scope === "paths" && paths.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["paths"],
        message: "paths must contain at least one item when scope is paths.",
      });
    }
  });

export type RunWorkspaceValidationInput = z.input<typeof runWorkspaceValidationInputSchema>;

export const workspaceValidationFindingSchema = z
  .object({
    ruleId: z.string().min(1),
    severity: z.enum(["info", "warning", "error"]),
    message: z.string().min(1),
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    source: z.enum(["git", "format", "ast-grep", "gitleaks"]),
    fingerprint: z.string().min(1).optional(),
  })
  .strict();

export type WorkspaceValidationFinding = z.infer<typeof workspaceValidationFindingSchema>;

export const workspaceValidationToolSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1).optional(),
    available: z.boolean(),
  })
  .strict();

export const runWorkspaceValidationResultSchema = z
  .object({
    workspaceId: z.string().min(1),
    root: z.string().min(1),
    validation: workspaceValidationNameSchema,
    scope: workspaceValidationScopeSchema,
    executed: z.boolean(),
    passed: z.boolean(),
    tool: workspaceValidationToolSchema,
    filesScanned: z.number().int().nonnegative(),
    findings: z.array(workspaceValidationFindingSchema),
    findingsCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    issues: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();

export type RunWorkspaceValidationResult = z.infer<typeof runWorkspaceValidationResultSchema>;

const commandExecutionCommonSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    cwd: relativePathSchema.optional(),
    timeoutMs: routableCommandTimeoutMsSchema,
    confirmationId: z.string().min(1).max(128).optional(),
  })
  .strict();

export const directRunCommandInputSchema = commandExecutionCommonSchema
  .extend({
    command: z.string().min(1).max(32_000),
    shell: shellNameSchema,
    executionMode: z.literal("direct").optional(),
  })
  .strict();

export type DirectRunCommandInput = z.infer<
  typeof directRunCommandInputSchema
>;

export const qualifiedRunCommandInputSchema = commandExecutionCommonSchema
  .extend({
    command: z.string().min(1).max(32_000).optional(),
    objective: z.string().min(1).max(4_000).optional(),
    executionMode: z.literal("qualified").optional(),
    autoCorrection: commandAutoCorrectionModeSchema.optional(),
    preferredShell: preferredCommandShellSchema.optional(),
    shell: shellNameSchema.optional(),
    expectedOutcome: z.array(commandExpectedOutcomeSchema).max(20).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.executionMode !== "qualified" && input.objective === undefined) {
      context.addIssue({
        code: "custom",
        path: ["executionMode"],
        message:
          "Qualified mode requires objective or executionMode=qualified.",
      });
    }
    if (input.command === undefined && input.objective === undefined) {
      context.addIssue({
        code: "custom",
        path: ["objective"],
        message: "Qualified mode requires command or objective.",
      });
    }
  });

export type QualifiedRunCommandInput = z.infer<
  typeof qualifiedRunCommandInputSchema
>;

export const runCommandInputSchema = z.union([
  directRunCommandInputSchema,
  qualifiedRunCommandInputSchema,
]);

export type RunCommandInput = z.infer<typeof runCommandInputSchema>;

/**
 * Object-shaped schema published through MCP tools/list. The SDK only emits
 * JSON Schema for top-level objects, so the canonical union is revalidated
 * through superRefine while all supported fields remain discoverable.
 */
export const runCommandToolInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    cwd: relativePathSchema.optional(),
    timeoutMs: routableCommandTimeoutMsSchema,
    confirmationId: z.string().min(1).max(128).optional(),
    command: z.string().min(1).max(32_000).optional(),
    objective: z.string().min(1).max(4_000).optional(),
    executionMode: commandExecutionModeSchema.optional(),
    autoCorrection: commandAutoCorrectionModeSchema.optional(),
    preferredShell: preferredCommandShellSchema.optional(),
    shell: shellNameSchema.optional(),
    expectedOutcome: z.array(commandExpectedOutcomeSchema).max(20).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (runCommandInputSchema.safeParse(input).success) return;
    context.addIssue({
      code: "custom",
      message: "run_command arguments must match direct or qualified execution mode.",
    });
  });

export const runPowerShellInputSchema = commandExecutionCommonSchema
  .extend({
    command: z.string().min(1).max(32_000),
  })
  .strict();

export type RunPowerShellInput = z.infer<typeof runPowerShellInputSchema>;

const commandQualifiedResultFields = {
  executionMode: commandExecutionModeSchema.optional(),
  corrected: z.boolean().optional(),
  attemptCount: z.number().int().min(1).max(2).optional(),
  diagnosis: commandDiagnosisSchema.optional(),
  correction: commandCorrectionSchema.optional(),
  postcondition: commandPostconditionResultSchema.optional(),
  attempts: z.array(commandAttemptSchema).max(2).optional(),
};

export const commandExecutedResultSchema = z
  .object({
    status: z.literal("executed"),
    shell: shellNameSchema,
    cwd: z.string(),
    exitCode: z.number().int().nullable(),
    stdout: z.string(),
    stderr: z.string(),
    timedOut: z.boolean(),
    lifecycle: operationLifecycleSchema.optional(),
    ...commandQualifiedResultFields,
  })
  .strict();

export const commandConfirmationRequiredResultSchema = z
  .object({
    status: z.literal("confirmation_required"),
    shell: shellNameSchema,
    cwd: z.string(),
    confirmationId: z.string(),
    expiresAt: z.iso.datetime(),
    reasons: z.array(z.string().min(1)).min(1),
    ...commandQualifiedResultFields,
  })
  .strict();

export const commandBackgroundTaskResultSchema = z
  .object({
    status: z.literal("background_task_started"),
    task: backgroundTaskRecordSchema,
    ...commandQualifiedResultFields,
  })
  .strict();

export const runCommandResultSchema = z.discriminatedUnion("status", [
  commandExecutedResultSchema,
  commandConfirmationRequiredResultSchema,
  commandBackgroundTaskResultSchema,
]);

export type RunCommandResult = z.infer<typeof runCommandResultSchema>;

export const runPowerShellResultSchema = runCommandResultSchema;

export type RunPowerShellResult = z.infer<typeof runPowerShellResultSchema>;

export const commandMcpOutputSchema = z
  .object({
    status: z.enum([
      "executed",
      "confirmation_required",
      "background_task_started",
    ]),
    shell: shellNameSchema.optional(),
    cwd: z.string().optional(),
    exitCode: z.number().int().nullable().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    timedOut: z.boolean().optional(),
    lifecycle: operationLifecycleSchema.optional(),
    confirmationId: z.string().optional(),
    expiresAt: z.iso.datetime().optional(),
    reasons: z.array(z.string().min(1)).optional(),
    task: backgroundTaskRecordSchema.optional(),
    ...commandQualifiedResultFields,
  })
  .strict();

export const runCommandMcpResultSchema = commandMcpOutputSchema;

export const runPowerShellMcpResultSchema = commandMcpOutputSchema;

export const searchFilesInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    query: z.string().min(1),
    root: relativePathSchema.optional(),
    glob: z.string().min(1).optional(),
    caseSensitive: z.boolean().default(false),
  })
  .strict();

export type SearchFilesInput = z.input<typeof searchFilesInputSchema>;

export const gitDiffModeSchema = z.enum(["none", "summary", "full"]);

export type GitDiffMode = z.infer<typeof gitDiffModeSchema>;

export const inspectGitInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: relativePathSchema.default("."),
    diffMode: gitDiffModeSchema.default("summary"),
    paths: z.array(relativePathSchema).max(20).default([]),
    maxDiffBytes: z.number().int().positive().max(1_000_000).default(40_000),
    timeoutMs: synchronousTimeoutMsSchema,
  })
  .strict();

export type InspectGitInput = z.input<typeof inspectGitInputSchema>;

export const getWorkspaceContextInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: relativePathSchema.optional(),
  })
  .strict();

export type GetWorkspaceContextInput = z.infer<typeof getWorkspaceContextInputSchema>;

export const instructionFileSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    exists: z.literal(true),
  })
  .strict();

export const skillSummarySchema = z
  .object({
    name: z.string(),
    /** Path relative to the workspace root. */
    skillFilePath: z.string(),
    source: z.enum(["project-cursor", "project-pi"]),
  })
  .strict();

export type SkillSummary = z.infer<typeof skillSummarySchema>;

export const gitWorktreeHintSchema = z
  .object({
    isGitRepository: z.boolean(),
    currentBranch: z.string().optional(),
    isDirty: z.boolean().optional(),
    suggestedWorktreeRoot: z.string().optional(),
  })
  .strict();

export const getWorkspaceContextResultSchema = z
  .object({
    workspaceId: z.string(),
    rootPath: z.string(),
    instructionFiles: z.array(instructionFileSchema),
    availableInstructionFiles: z.array(z.string()),
    skills: z.array(skillSummarySchema),
    git: gitWorktreeHintSchema,
  })
  .strict();

export type GetWorkspaceContextResult = z.infer<typeof getWorkspaceContextResultSchema>;

export const workspaceSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    workspaceKind: workspaceKindSchema.optional(),
    enabled: z.literal(true),
    permissionProfile: permissionProfileSchema,
    confirmationMode: confirmationModeSchema,
    writesEnabled: z.boolean(),
    shellsEnabled: z.boolean(),
    allowedShells: z.array(shellNameSchema),
  })
  .strict();

export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;

export const listWorkspacesResultSchema = z.array(workspaceSummarySchema);

export const listFilesResultSchema = z
  .object({
    files: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();

export type ListFilesResult = z.infer<typeof listFilesResultSchema>;

export const listWorkspaceRootsResultSchema = z
  .object({
    roots: z.array(z.string()),
    truncated: z.boolean(),
  })
  .strict();

export type ListWorkspaceRootsResult = z.infer<typeof listWorkspaceRootsResultSchema>;

export const readFileResultSchema = z
  .object({
    path: z.string(),
    content: z.string(),
    startLine: z.number().int(),
    endLine: z.number().int(),
    totalLines: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    encoding: textEncodingSchema,
    lineEnding: lineEndingSchema,
  })
  .strict();

export type ReadFileResult = z.infer<typeof readFileResultSchema>;

export const readBinaryFileResultSchema = z
  .object({
    path: z.string(),
    contentBase64: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type ReadBinaryFileResult = z.infer<typeof readBinaryFileResultSchema>;

export const searchMatchSchema = z
  .object({
    path: z.string(),
    line: z.number().int().positive(),
    column: z.number().int().positive(),
    snippet: z.string(),
  })
  .strict();

export type SearchMatch = z.infer<typeof searchMatchSchema>;

export const searchFilesResultSchema = z
  .object({
    matches: z.array(searchMatchSchema),
    truncated: z.boolean(),
    skippedFiles: z.number().int().nonnegative(),
  })
  .strict();

export type SearchFilesResult = z.infer<typeof searchFilesResultSchema>;

export const gitStatusEntrySchema = z
  .object({
    path: z.string(),
    indexStatus: z.string(),
    workTreeStatus: z.string(),
    originalPath: z.string().optional(),
  })
  .strict();

export type GitStatusEntry = z.infer<typeof gitStatusEntrySchema>;

export const inspectGitResultSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: z.string().min(1),
    branch: z.string().min(1),
    diffMode: gitDiffModeSchema,
    status: z.array(gitStatusEntrySchema),
    staged: z.string(),
    unstaged: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export type InspectGitResult = z.infer<typeof inspectGitResultSchema>;

export const operationContextSchema = z
  .object({
    correlationId: z.string().min(1).max(128).optional(),
    invocationId: z.string().min(1).max(128).optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
    ownerScope: z.string().min(1).max(256).optional(),
    deadline: operationDeadlineSchema.optional(),
  })
  .strict();

export type OperationContext = z.infer<typeof operationContextSchema> & {
  signal?: AbortSignal;
};

export const relayOperationSchema = z.enum([
  "listWorkspaces",
  "listWorkspaceRoots",
  "listFiles",
  "readFile",
  "readBinaryFile",
  "writeFile",
  "patchFile",
  "runValidation",
  "runCommand",
  "runPowerShell",
  "searchFiles",
  "inspectGit",
  "getWorkspaceContext",
  "startBackgroundTask",
  "getBackgroundTask",
  "waitBackgroundTask",
  "listBackgroundTasks",
  "cancelBackgroundTask",
  "readBackgroundTaskLogs",
]);

export type RelayOperation = z.infer<typeof relayOperationSchema>;

const relayRequestBase = {
  version: z.literal(1),
  type: z.literal("request"),
  requestId: z.uuid(),
  deadline: operationDeadlineSchema,
};

export const relayRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    ...relayRequestBase,
    operation: z.literal("listWorkspaces"),
    input: z.object({}).strict(),
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("listWorkspaceRoots"),
    input: listWorkspaceRootsInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("listFiles"),
    input: listFilesInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("readFile"),
    input: readFileInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("readBinaryFile"),
    input: readBinaryFileInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("writeFile"),
    input: writeFileInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("patchFile"),
    input: patchFileInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("runValidation"),
    input: runWorkspaceValidationInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("runCommand"),
    input: runCommandInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("runPowerShell"),
    input: runPowerShellInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("searchFiles"),
    input: searchFilesInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("inspectGit"),
    input: inspectGitInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("getWorkspaceContext"),
    input: getWorkspaceContextInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("startBackgroundTask"),
    input: startBackgroundTaskInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("getBackgroundTask"),
    input: getBackgroundTaskInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("waitBackgroundTask"),
    input: waitBackgroundTaskInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("listBackgroundTasks"),
    input: listBackgroundTasksInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("cancelBackgroundTask"),
    input: cancelBackgroundTaskInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("readBackgroundTaskLogs"),
    input: readBackgroundTaskLogsInputSchema,
  }).strict(),
]);

export type RelayRequest = z.infer<typeof relayRequestSchema>;

export const relayCancellationSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("cancel"),
    requestId: z.uuid(),
    reason: z.enum(["cancelled", "client_disconnected", "upstream_timeout"]),
  })
  .strict();
export type RelayCancellation = z.infer<typeof relayCancellationSchema>;

export const relayAgentMessageSchema = z.union([
  relayRequestSchema,
  relayCancellationSchema,
]);
export type RelayAgentMessage = z.infer<typeof relayAgentMessageSchema>;

export const serializedErrorSchema = z
  .object({
    code: z.enum(errorCodes),
    message: z.string(),
    lifecycle: operationLifecycleSchema.optional(),
    details: errorDetailsSchema.optional(),
  })
  .strict();

export const relayResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      version: z.literal(1),
      type: z.literal("response"),
      requestId: z.uuid(),
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      type: z.literal("response"),
      requestId: z.uuid(),
      ok: z.literal(false),
      error: serializedErrorSchema,
    })
    .strict(),
]);

export type RelayResponse = z.infer<typeof relayResponseSchema>;

export const agentHelloSchema = z
  .object({
    version: z.literal(1),
    type: z.literal("hello"),
    agentId: z.string().min(1).max(128),
    // Aceita operacoes futuras no hello; o gateway filtra pelo relayResultSchemas local.
    capabilities: z.array(z.string().min(1).max(64)).min(1),
  })
  .strict();

export type AgentHello = z.infer<typeof agentHelloSchema>;

export const relayResultSchemas = {
  listWorkspaces: listWorkspacesResultSchema,
  listWorkspaceRoots: listWorkspaceRootsResultSchema,
  listFiles: listFilesResultSchema,
  readFile: readFileResultSchema,
  readBinaryFile: readBinaryFileResultSchema,
  writeFile: writeFileResultSchema,
  patchFile: patchFileResultSchema,
  runValidation: runWorkspaceValidationResultSchema,
  runCommand: runCommandResultSchema,
  runPowerShell: runPowerShellResultSchema,
  searchFiles: searchFilesResultSchema,
  inspectGit: inspectGitResultSchema,
  getWorkspaceContext: getWorkspaceContextResultSchema,
  startBackgroundTask: backgroundTaskResultSchema,
  getBackgroundTask: backgroundTaskResultSchema,
  waitBackgroundTask: backgroundTaskWaitResultSchema,
  listBackgroundTasks: backgroundTaskListResultSchema,
  cancelBackgroundTask: backgroundTaskResultSchema,
  readBackgroundTaskLogs: backgroundTaskLogsLookupResultSchema,
} as const;
