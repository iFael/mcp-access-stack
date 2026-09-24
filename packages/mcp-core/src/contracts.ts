import { z } from "zod";
import { errorCodes, errorDetailsSchema } from "./errors.js";
import { confirmationModeSchema, permissionProfileSchema, shellNameSchema, workspaceKindSchema } from "./policy.js";
import {
  operationDeadlineSchema,
  operationLifecycleSchema,
  routableCommandTimeoutMsSchema,
  synchronousTimeoutMsSchema,
} from "./timeout-policy.js";
import {
  gitCommitInputSchema,
  gitCommitResultSchema,
  gitCreateBranchInputSchema,
  gitCreateBranchResultSchema,
  gitMergeBranchInputSchema,
  gitMergeBranchResultSchema,
  gitSyncBranchInputSchema,
  gitSyncBranchResultSchema,
  gitPushBranchInputSchema,
  gitPushBranchResultSchema,
  gitStagePathsInputSchema,
  gitStagePathsResultSchema,
  gitUnstagePathsInputSchema,
  gitUnstagePathsResultSchema,
  githubCreatePullRequestInputSchema,
  githubCreatePullRequestResultSchema,
  githubCreateRepositoryInputSchema,
  githubCreateRepositoryResultSchema,
  githubGetPullRequestInputSchema,
  githubGetRepositoryInputSchema,
  githubMergePullRequestInputSchema,
  githubMergePullRequestResultSchema,
  githubPullRequestResultSchema,
  githubRepositoryResultSchema,
} from "./source-control-contracts.js";
import {
  backgroundTaskListResultSchema,
  backgroundTaskLogsLookupResultSchema,
  backgroundTaskOutputResultSchema,
  backgroundTaskStdinResultSchema,
  backgroundTaskWaitResultSchema,
  backgroundTaskRecordSchema,
  backgroundTaskResultSchema,
  backgroundTaskStartedResultSchema,
  startBackgroundTaskResultSchema,
  cancelBackgroundTaskInputSchema,
  getBackgroundTaskInputSchema,
  waitBackgroundTaskInputSchema,
  listBackgroundTasksInputSchema,
  readBackgroundTaskLogsInputSchema,
  readBackgroundTaskOutputInputSchema,
  startBackgroundTaskInputSchema,
  writeBackgroundTaskStdinInputSchema,
} from "./background-task-contracts.js";
import { commandConfirmationRequiredResultSchema } from "./command-confirmation-contracts.js";
import {
  getReleaseStateInputSchema,
  getReleaseStateResultSchema,
  prepareReleaseInputSchema,
  prepareReleaseResultSchema,
  promoteReleaseInputSchema,
  promoteReleaseResultSchema,
} from "./release-lifecycle-contracts.js";

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

export const readFilesItemInputSchema = z
  .object({
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

export const readFilesInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    items: z.array(readFilesItemInputSchema).min(1).max(20),
  })
  .strict();

export type ReadFilesInput = z.infer<typeof readFilesInputSchema>;

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

export const patchFilesItemInputSchema = z
  .object({
    path: relativePathSchema,
    expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    replacements: z.array(patchReplacementSchema).min(1).max(20),
  })
  .strict();

export const patchFilesInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    items: z.array(patchFilesItemInputSchema).min(1).max(8),
    dryRun: z.boolean().default(false),
  })
  .strict()
  .superRefine(({ items }, context) => {
    const paths = new Set<string>();
    for (const [index, item] of items.entries()) {
      if (paths.has(item.path)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "path"],
          message: "Patch batch paths must be unique.",
        });
      }
      paths.add(item.path);
    }
  });

export type PatchFilesInput = z.input<typeof patchFilesInputSchema>;

const patchFilesErrorSchema = z
  .object({
    code: z.enum(errorCodes),
    message: z.string(),
  })
  .strict();

export const patchFilesItemResultSchema = z
  .object({
    path: relativePathSchema,
    status: z.enum([
      "preflight_ok",
      "preflight_error",
      "validated",
      "applied",
      "apply_error",
      "skipped_after_error",
    ]),
    result: patchFileResultSchema.optional(),
    error: patchFilesErrorSchema.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    const requiresResult = ["preflight_ok", "validated", "applied"].includes(item.status);
    const requiresError = ["preflight_error", "apply_error"].includes(item.status);
    if (requiresResult && item.result === undefined) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "result is required for successful patch batch items.",
      });
    }
    if (requiresError && item.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "error is required for failed patch batch items.",
      });
    }
  });

export const patchFilesResultSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    dryRun: z.boolean(),
    preflightPassed: z.boolean(),
    completed: z.boolean(),
    partial: z.boolean(),
    appliedCount: z.number().int().nonnegative().max(8),
    stoppedAtPath: relativePathSchema.optional(),
    items: z.array(patchFilesItemResultSchema).min(1).max(8),
  })
  .strict();

export type PatchFilesResult = z.infer<typeof patchFilesResultSchema>;

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

export const runWorkspaceValidationsInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: relativePathSchema.default("."),
    validations: z.array(workspaceValidationNameSchema).min(1).max(4),
    scope: workspaceValidationScopeSchema.default("changes"),
    paths: z.array(relativePathSchema).max(20).default([]),
    maxFindings: z.number().int().positive().max(200).default(100),
    timeoutMs: synchronousTimeoutMsSchema,
    stopOnFailure: z.boolean().default(false),
  })
  .strict()
  .superRefine(({ validations, scope, paths }, context) => {
    if (scope === "paths" && paths.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["paths"],
        message: "paths must contain at least one item when scope is paths.",
      });
    }

    const unique = new Set<WorkspaceValidationName>();
    for (const [index, validation] of validations.entries()) {
      if (unique.has(validation)) {
        context.addIssue({
          code: "custom",
          path: ["validations", index],
          message: "Validation names must be unique within a suite.",
        });
      }
      unique.add(validation);
    }
  });

export type RunWorkspaceValidationsInput = z.input<
  typeof runWorkspaceValidationsInputSchema
>;

const workspaceValidationSuiteErrorSchema = z
  .object({
    code: z.enum(errorCodes),
    message: z.string(),
  })
  .strict();

export const runWorkspaceValidationsItemResultSchema = z
  .object({
    validation: workspaceValidationNameSchema,
    status: z.enum(["passed", "failed", "error", "skipped_after_failure"]),
    result: runWorkspaceValidationResultSchema.optional(),
    error: workspaceValidationSuiteErrorSchema.optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (
      ["passed", "failed"].includes(item.status) &&
      item.result === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "result is required when validation execution completed.",
      });
    }
    if (item.status === "error" && item.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "error is required when validation execution errors.",
      });
    }
  });

export const runWorkspaceValidationsResultSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: relativePathSchema,
    scope: workspaceValidationScopeSchema,
    stopOnFailure: z.boolean(),
    completed: z.boolean(),
    passed: z.boolean(),
    attemptedCount: z.number().int().nonnegative().max(4),
    skippedCount: z.number().int().nonnegative().max(4),
    items: z.array(runWorkspaceValidationsItemResultSchema).min(1).max(4),
  })
  .strict();

export type RunWorkspaceValidationsResult = z.infer<
  typeof runWorkspaceValidationsResultSchema
>;

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
  })
  .strict();

export type DirectRunCommandInput = z.infer<
  typeof directRunCommandInputSchema
>;

export const runCommandInputSchema = directRunCommandInputSchema;

export type RunCommandInput = z.infer<typeof runCommandInputSchema>;

/** Canonical object-shaped schema published through MCP tools/list. */
export const runCommandToolInputSchema = runCommandInputSchema;

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
  })
  .strict();

export const commandBackgroundTaskResultSchema = backgroundTaskStartedResultSchema;

export const runCommandResultSchema = z.discriminatedUnion("status", [
  commandExecutedResultSchema,
  commandConfirmationRequiredResultSchema,
  commandBackgroundTaskResultSchema,
]);

export type RunCommandResult = z.infer<typeof runCommandResultSchema>;

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
  })
  .strict();

export const runCommandMcpResultSchema = commandMcpOutputSchema;

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

export const searchFilesBatchItemInputSchema = z
  .object({
    query: z.string().min(1),
    root: relativePathSchema.optional(),
    glob: z.string().min(1).optional(),
    caseSensitive: z.boolean().default(false),
  })
  .strict();

export const searchFilesBatchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    items: z.array(searchFilesBatchItemInputSchema).min(1).max(8),
  })
  .strict();

export type SearchFilesBatchInput = z.infer<typeof searchFilesBatchInputSchema>;

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

export const readFilesItemResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      requestedPath: z.string(),
      result: readFileResultSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      requestedPath: z.string(),
      error: z
        .object({
          code: z.enum(errorCodes),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

export const readFilesResultSchema = z
  .object({
    items: z.array(readFilesItemResultSchema),
  })
  .strict();

export type ReadFilesResult = z.infer<typeof readFilesResultSchema>;

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

export const searchFilesBatchItemResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("ok"),
      query: z.string(),
      result: searchFilesResultSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      query: z.string(),
      error: z
        .object({
          code: z.enum(errorCodes),
          message: z.string(),
        })
        .strict(),
    })
    .strict(),
]);

export const searchFilesBatchResultSchema = z
  .object({
    items: z.array(searchFilesBatchItemResultSchema),
  })
  .strict();

export type SearchFilesBatchResult = z.infer<typeof searchFilesBatchResultSchema>;

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

export const relayOperationContextSchema = operationContextSchema.pick({
  correlationId: true,
  invocationId: true,
  idempotencyKey: true,
  ownerScope: true,
});

export type RelayOperationContext = z.infer<typeof relayOperationContextSchema>;

export const sourceControlRelayOperations = [
  "gitCreateBranch",
  "gitStagePaths",
  "gitUnstagePaths",
  "gitCommit",
  "gitMergeBranch",
  "gitSyncBranch",
  "gitPushBranch",
  "githubGetRepository",
  "githubCreateRepository",
  "githubGetPullRequest",
  "githubCreatePullRequest",
  "githubMergePullRequest",
] as const;
export type SourceControlRelayOperation = (typeof sourceControlRelayOperations)[number];

export const relayOperations = [
  "listWorkspaces",
  "listWorkspaceRoots",
  "listFiles",
  "readFile",
  "readBinaryFile",
  "writeFile",
  "patchFile",
  "getReleaseState",
  "prepareRelease",
  "promoteRelease",
  "runValidation",
  "runCommand",
  "searchFiles",
  "inspectGit",
  "getWorkspaceContext",
  "startBackgroundTask",
  "getBackgroundTask",
  "waitBackgroundTask",
  "listBackgroundTasks",
  "cancelBackgroundTask",
  "readBackgroundTaskLogs",
  "writeBackgroundTaskStdin",
  "readBackgroundTaskOutput",
  ...sourceControlRelayOperations,
] as const;

export const relayOperationSchema = z.enum(relayOperations);

export type RelayOperation = z.infer<typeof relayOperationSchema>;

const relayRequestBase = {
  version: z.literal(1),
  type: z.literal("request"),
  requestId: z.uuid(),
  deadline: operationDeadlineSchema,
  context: relayOperationContextSchema.optional(),
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
    operation: z.literal("getReleaseState"),
    input: getReleaseStateInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("prepareRelease"),
    input: prepareReleaseInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("promoteRelease"),
    input: promoteReleaseInputSchema,
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
  z.object({
    ...relayRequestBase,
    operation: z.literal("writeBackgroundTaskStdin"),
    input: writeBackgroundTaskStdinInputSchema,
  }).strict(),
  z.object({
    ...relayRequestBase,
    operation: z.literal("readBackgroundTaskOutput"),
    input: readBackgroundTaskOutputInputSchema,
  }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("gitCreateBranch"), input: gitCreateBranchInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("gitStagePaths"), input: gitStagePathsInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("gitUnstagePaths"), input: gitUnstagePathsInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("gitCommit"), input: gitCommitInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("gitMergeBranch"), input: gitMergeBranchInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("gitSyncBranch"), input: gitSyncBranchInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("gitPushBranch"), input: gitPushBranchInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("githubGetRepository"), input: githubGetRepositoryInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("githubCreateRepository"), input: githubCreateRepositoryInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("githubGetPullRequest"), input: githubGetPullRequestInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("githubCreatePullRequest"), input: githubCreatePullRequestInputSchema }).strict(),
  z.object({ ...relayRequestBase, operation: z.literal("githubMergePullRequest"), input: githubMergePullRequestInputSchema }).strict(),
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
  getReleaseState: getReleaseStateResultSchema,
  prepareRelease: prepareReleaseResultSchema,
  promoteRelease: promoteReleaseResultSchema,
  runValidation: runWorkspaceValidationResultSchema,
  runCommand: runCommandResultSchema,
  searchFiles: searchFilesResultSchema,
  inspectGit: inspectGitResultSchema,
  getWorkspaceContext: getWorkspaceContextResultSchema,
  startBackgroundTask: startBackgroundTaskResultSchema,
  getBackgroundTask: backgroundTaskResultSchema,
  waitBackgroundTask: backgroundTaskWaitResultSchema,
  listBackgroundTasks: backgroundTaskListResultSchema,
  cancelBackgroundTask: backgroundTaskResultSchema,
  readBackgroundTaskLogs: backgroundTaskLogsLookupResultSchema,
  writeBackgroundTaskStdin: backgroundTaskStdinResultSchema,
  readBackgroundTaskOutput: backgroundTaskOutputResultSchema,
  gitCreateBranch: gitCreateBranchResultSchema,
  gitStagePaths: gitStagePathsResultSchema,
  gitUnstagePaths: gitUnstagePathsResultSchema,
  gitCommit: gitCommitResultSchema,
  gitMergeBranch: gitMergeBranchResultSchema,
  gitSyncBranch: gitSyncBranchResultSchema,
  gitPushBranch: gitPushBranchResultSchema,
  githubGetRepository: githubRepositoryResultSchema,
  githubCreateRepository: githubCreateRepositoryResultSchema,
  githubGetPullRequest: githubPullRequestResultSchema,
  githubCreatePullRequest: githubCreatePullRequestResultSchema,
  githubMergePullRequest: githubMergePullRequestResultSchema,
} as const;
