import { z } from "zod";
import { errorCodes } from "./errors.js";

const workspaceIdSchema = z.string().trim().min(1);
const rootSchema = z.string().trim().min(1).max(4_096);
const confirmationIdSchema = z.string().min(1).max(128);

export const gitShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/iu)
  .transform((value) => value.toLowerCase());

export const gitBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .superRefine((value, context) => {
    if (value.trim().length === 0) {
      context.addIssue({ code: "custom", message: "Git branch cannot be blank." });
    }
    if (value.startsWith("-")) {
      context.addIssue({ code: "custom", message: "Git branch cannot start with '-'." });
    }
    if (/\s|[\u0000-\u001f\u007f]/u.test(value)) {
      context.addIssue({ code: "custom", message: "Git branch cannot contain whitespace or control characters." });
    }
    if (
      value === "@" ||
      value.startsWith("/") ||
      value.split("/").some((segment) => segment.startsWith(".")) ||
      value.includes("..") ||
      value.includes("@{") ||
      value.includes("\\") ||
      /[~^:?*[\]]/u.test(value) ||
      value.includes("//") ||
      value.endsWith(".") ||
      value.endsWith("/") ||
      value.split("/").some((segment) => segment.toLowerCase().endsWith(".lock"))
    ) {
      context.addIssue({ code: "custom", message: "Invalid Git branch name." });
    }
  });

export const gitPathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .superRefine((value, context) => {
    const normalized = normalizeGitPath(value);
    const segments = normalized.split("/");
    if (
      normalized.length === 0 ||
      normalized === "." ||
      normalized.startsWith("/") ||
      /^\/?[a-z]:\//iu.test(normalized) ||
      normalized.startsWith("//") ||
      normalized.endsWith("/") ||
      normalized.includes("//") ||
      segments.some((segment) => segment === "..") ||
      segments.some((segment) => segment.toLowerCase() === ".git")
    ) {
      context.addIssue({ code: "custom", message: "Invalid Git workspace-relative path." });
    }
    if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
      context.addIssue({ code: "custom", message: "Git path cannot contain control characters." });
    }
  })
  .transform(normalizeGitPath);

const gitPathListSchema = z
  .array(gitPathSchema)
  .min(1)
  .max(200)
  .superRefine((paths, context) => {
    const seen = new Set<string>();
    for (const [index, candidate] of paths.entries()) {
      const key = candidate;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Git paths must be unique.",
          path: [index],
        });
      }
      seen.add(key);
    }
  });

const commitMessageSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .refine((value) => !value.includes("\0"), "Commit message cannot contain NUL.");

const gitRemoteSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u)
  .refine((value) => !value.includes("..") && !value.startsWith("-"), "Invalid Git remote name.");

export const githubOwnerSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?$/u);

export const githubRepositoryNameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z0-9._-]+$/u)
  .refine((value) => value !== "." && value !== "..", "Invalid GitHub repository name.");

export const githubRepositoryFullNameSchema = z
  .string()
  .min(3)
  .max(201)
  .superRefine((value, context) => {
    const parts = value.split("/");
    if (parts.length !== 2) {
      context.addIssue({ code: "custom", message: "GitHub repository must be owner/name." });
      return;
    }
    const [owner, repository] = parts;
    if (!githubOwnerSchema.safeParse(owner).success || !githubRepositoryNameSchema.safeParse(repository).success) {
      context.addIssue({ code: "custom", message: "Invalid GitHub repository full name." });
    }
  });

const githubPullRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f\s]/u.test(value), "Invalid GitHub pull-request ref.");

const githubUrlSchema = z.string().url();
const githubVisibilitySchema = z.enum(["private", "public", "internal"]);
const githubPullRequestStateSchema = z.enum(["open", "closed"]);
const githubMergeMethodSchema = z.enum(["merge", "squash"]);
const githubCheckStatusSchema = z.enum(["queued", "in_progress", "completed", "unknown"]);
const githubCheckConclusionSchema = z.enum([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
  "unknown",
]).nullable();

export const sourceControlCapabilities = [
  "git.branch.write",
  "git.index.write",
  "git.commit.write",
  "git.merge.write",
  "git.remote.push",
  "github.repository.read",
  "github.repository.create",
  "github.pull_request.read",
  "github.pull_request.create",
  "github.pull_request.merge",
] as const;

export const sourceControlCapabilitySchema = z.enum(sourceControlCapabilities);
export type SourceControlCapability = z.infer<typeof sourceControlCapabilitySchema>;

export const sourceControlOperationNameSchema = z.enum([
  "git_create_branch",
  "git_stage_paths",
  "git_unstage_paths",
  "git_commit",
  "git_merge_branch",
  "git_sync_branch",
  "git_push_branch",
  "github_get_repository",
  "github_get_commit_checks",
  "github_start_commit_checks_watch",
  "github_get_commit_checks_watches",
  "github_wait_commit_checks_watch",
  "github_create_repository",
  "github_get_pull_request",
  "github_create_pull_request",
  "github_merge_pull_request",
]);
export type SourceControlOperationName = z.infer<typeof sourceControlOperationNameSchema>;

export const confirmableSourceControlOperationNameSchema = z.enum([
  "git_push_branch",
  "github_create_repository",
  "github_create_pull_request",
  "github_merge_pull_request",
]);
export type ConfirmableSourceControlOperationName = z.infer<
  typeof confirmableSourceControlOperationNameSchema
>;

export const sourceControlConfirmationRequiredSchema = z
  .object({
    status: z.literal("confirmation_required"),
    confirmationId: confirmationIdSchema,
    expiresAt: z.string().datetime(),
    operation: confirmableSourceControlOperationNameSchema,
    targetResource: z.string().min(1).max(512),
  })
  .strict();
export type SourceControlConfirmationRequired = z.infer<
  typeof sourceControlConfirmationRequiredSchema
>;

export const gitCreateBranchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    branch: gitBranchSchema,
    expectedHeadSha: gitShaSchema,
  })
  .strict();
export type GitCreateBranchInput = z.input<typeof gitCreateBranchInputSchema>;

export const gitCreateBranchResultSchema = z
  .object({
    root: rootSchema,
    branch: gitBranchSchema,
    headSha: gitShaSchema,
  })
  .strict();
export type GitCreateBranchResult = z.infer<typeof gitCreateBranchResultSchema>;

export const gitStagePathsInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    paths: gitPathListSchema,
    expectedHeadSha: gitShaSchema.optional(),
    requireCleanIndex: z.boolean().optional(),
  })
  .strict();
export type GitStagePathsInput = z.input<typeof gitStagePathsInputSchema>;

export const gitStagePathsResultSchema = z
  .object({
    root: rootSchema,
    headSha: gitShaSchema,
    indexTreeSha: gitShaSchema,
    paths: gitPathListSchema,
  })
  .strict();
export type GitStagePathsResult = z.infer<typeof gitStagePathsResultSchema>;

export const gitUnstagePathsInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    paths: gitPathListSchema,
    expectedHeadSha: gitShaSchema,
    expectedIndexTreeSha: gitShaSchema,
  })
  .strict();
export type GitUnstagePathsInput = z.input<typeof gitUnstagePathsInputSchema>;

export const gitUnstagePathsResultSchema = z
  .object({
    root: rootSchema,
    headSha: gitShaSchema,
    indexTreeSha: gitShaSchema,
    paths: gitPathListSchema,
  })
  .strict();
export type GitUnstagePathsResult = z.infer<typeof gitUnstagePathsResultSchema>;

export const gitCommitInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    message: commitMessageSchema,
    expectedHeadSha: gitShaSchema,
    expectedIndexTreeSha: gitShaSchema,
  })
  .strict();
export type GitCommitInput = z.input<typeof gitCommitInputSchema>;

export const gitCommitResultSchema = z
  .object({
    root: rootSchema,
    branch: gitBranchSchema,
    commitSha: gitShaSchema,
  })
  .strict();
export type GitCommitResult = z.infer<typeof gitCommitResultSchema>;

export const gitCommitPathsInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    paths: gitPathListSchema,
    message: commitMessageSchema,
    expectedHeadSha: gitShaSchema,
  })
  .strict();
export type GitCommitPathsInput = z.input<typeof gitCommitPathsInputSchema>;

const gitCommitPathsErrorSchema = z
  .object({
    code: z.enum(errorCodes),
    message: z.string().min(1),
  })
  .strict();

const gitCommitPathsCompletedResultSchema = z
  .object({
    status: z.literal("completed"),
    root: rootSchema,
    branch: gitBranchSchema,
    previousHeadSha: gitShaSchema,
    stagedIndexTreeSha: gitShaSchema,
    commitSha: gitShaSchema,
    paths: gitPathListSchema,
  })
  .strict();

const gitCommitPathsReconciliationResultSchema = z
  .object({
    status: z.literal("reconciliation_required"),
    root: rootSchema,
    headSha: gitShaSchema,
    indexTreeSha: gitShaSchema,
    paths: gitPathListSchema,
    phase: z.enum(["post_stage_head_mismatch", "commit"]),
    error: gitCommitPathsErrorSchema,
  })
  .strict();

export const gitCommitPathsResultSchema = z.discriminatedUnion("status", [
  gitCommitPathsCompletedResultSchema,
  gitCommitPathsReconciliationResultSchema,
]);
export type GitCommitPathsResult = z.infer<typeof gitCommitPathsResultSchema>;

export const gitMergeBranchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    sourceBranch: gitBranchSchema,
    expectedTargetHeadSha: gitShaSchema,
    expectedSourceHeadSha: gitShaSchema,
  })
  .strict();
export type GitMergeBranchInput = z.input<typeof gitMergeBranchInputSchema>;

export const gitMergeBranchResultSchema = z
  .object({
    root: rootSchema,
    branch: gitBranchSchema,
    previousHeadSha: gitShaSchema,
    headSha: gitShaSchema,
    sourceHeadSha: gitShaSchema,
    fastForwarded: z.literal(true),
  })
  .strict();
export type GitMergeBranchResult = z.infer<typeof gitMergeBranchResultSchema>;

export const gitSyncBranchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    branch: gitBranchSchema,
    remote: gitRemoteSchema,
    expectedRemoteSha: gitShaSchema,
  })
  .strict();
export type GitSyncBranchInput = z.input<typeof gitSyncBranchInputSchema>;

export const gitSyncBranchResultSchema = z
  .object({
    root: rootSchema,
    remote: gitRemoteSchema,
    branch: gitBranchSchema,
    previousBranch: gitBranchSchema,
    previousHeadSha: gitShaSchema,
    previousTargetHeadSha: gitShaSchema,
    remoteSha: gitShaSchema,
    headSha: gitShaSchema,
    switched: z.boolean(),
    fastForwarded: z.boolean(),
    alreadyUpToDate: z.boolean(),
  })
  .strict()
  .refine(
    (value) => value.fastForwarded !== value.alreadyUpToDate,
    "Exactly one of fastForwarded/alreadyUpToDate must be true.",
  );
export type GitSyncBranchResult = z.infer<typeof gitSyncBranchResultSchema>;

export const gitPushBranchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    branch: gitBranchSchema,
    expectedLocalSha: gitShaSchema,
    remote: gitRemoteSchema.default("origin"),
    expectedRemoteSha: gitShaSchema.optional(),
    confirmationId: confirmationIdSchema.optional(),
  })
  .strict();
export type GitPushBranchInput = z.input<typeof gitPushBranchInputSchema>;

const gitPushConfirmationRequiredSchema = sourceControlConfirmationRequiredSchema.extend({
  operation: z.literal("git_push_branch"),
});
export const gitPushBranchCompletedResultSchema = z
  .object({
    status: z.literal("completed"),
    root: rootSchema,
    remote: gitRemoteSchema,
    branch: gitBranchSchema,
    localSha: gitShaSchema,
    remoteSha: gitShaSchema,
  })
  .strict();
export const gitPushBranchResultSchema = z.discriminatedUnion("status", [
  gitPushConfirmationRequiredSchema,
  gitPushBranchCompletedResultSchema,
]);
export type GitPushBranchResult = z.infer<typeof gitPushBranchResultSchema>;

export const githubGetRepositoryInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
  })
  .strict();
export type GitHubGetRepositoryInput = z.input<typeof githubGetRepositoryInputSchema>;

export const githubRepositoryResultSchema = z
  .object({
    owner: githubOwnerSchema,
    name: githubRepositoryNameSchema,
    fullName: githubRepositoryFullNameSchema,
    defaultBranch: gitBranchSchema,
    visibility: githubVisibilitySchema,
    url: githubUrlSchema,
  })
  .strict();
export type GitHubRepositoryResult = z.infer<typeof githubRepositoryResultSchema>;

export const githubGetCommitChecksInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    commitSha: gitShaSchema,
  })
  .strict();
export type GitHubGetCommitChecksInput = z.input<
  typeof githubGetCommitChecksInputSchema
>;

export const githubCommitCheckSchema = z
  .object({
    id: z.number().int().positive(),
    name: z.string().trim().min(1).max(256),
    status: githubCheckStatusSchema,
    conclusion: githubCheckConclusionSchema,
    detailsUrl: githubUrlSchema.nullable(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  })
  .strict();

export const githubCommitChecksResultSchema = z
  .object({
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    commitSha: gitShaSchema,
    totalCount: z.number().int().nonnegative(),
    returnedCount: z.number().int().nonnegative().max(100),
    pendingCount: z.number().int().nonnegative().max(100),
    successfulCount: z.number().int().nonnegative().max(100),
    failingCount: z.number().int().nonnegative().max(100),
    truncated: z.boolean(),
    allCompleted: z.boolean(),
    passed: z.boolean(),
    checks: z.array(githubCommitCheckSchema).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.returnedCount !== value.checks.length) {
      context.addIssue({
        code: "custom",
        path: ["returnedCount"],
        message: "returnedCount must equal checks.length.",
      });
    }
    if (
      value.pendingCount + value.successfulCount + value.failingCount !==
      value.returnedCount
    ) {
      context.addIssue({
        code: "custom",
        message: "check counters must sum to returnedCount.",
      });
    }
    const expectedCompleted =
      value.totalCount > 0 && !value.truncated && value.pendingCount === 0;
    if (value.allCompleted !== expectedCompleted) {
      context.addIssue({
        code: "custom",
        path: ["allCompleted"],
        message: "allCompleted does not match aggregate check state.",
      });
    }
    if (
      value.passed !==
      (value.allCompleted && value.failingCount === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["passed"],
        message: "passed does not match aggregate check state.",
      });
    }
  });
export type GitHubCommitChecksResult = z.infer<
  typeof githubCommitChecksResultSchema
>;

export const githubCommitChecksWatchStateSchema = z.enum([
  "watching",
  "passed",
  "failed",
  "timed_out",
  "error",
]);
export type GitHubCommitChecksWatchState = z.infer<
  typeof githubCommitChecksWatchStateSchema
>;

const githubCommitChecksWatchErrorSchema = z
  .object({
    code: z.enum(errorCodes),
    message: z.string().min(1).max(2_000),
  })
  .strict();

export const githubCommitChecksWatchRecordSchema = z
  .object({
    id: z.uuid(),
    workspaceId: workspaceIdSchema,
    root: rootSchema,
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    commitSha: gitShaSchema,
    state: githubCommitChecksWatchStateSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    deadlineAt: z.iso.datetime(),
    completedAt: z.iso.datetime().optional(),
    pollCount: z.number().int().nonnegative(),
    lastChecks: githubCommitChecksResultSchema.optional(),
    lastError: githubCommitChecksWatchErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const terminal = value.state !== "watching";
    if (terminal !== (value.completedAt !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message:
          "completedAt must be present exactly when the watch is terminal.",
      });
    }
    if (
      value.lastChecks !== undefined &&
      (value.lastChecks.owner !== value.owner ||
        value.lastChecks.repository !== value.repository ||
        value.lastChecks.commitSha !== value.commitSha)
    ) {
      context.addIssue({
        code: "custom",
        path: ["lastChecks"],
        message: "lastChecks target must match the watch target.",
      });
    }
    if (value.state === "error" && value.lastError === undefined) {
      context.addIssue({
        code: "custom",
        path: ["lastError"],
        message: "lastError is required when the watch state is error.",
      });
    }
  });
export type GitHubCommitChecksWatchRecord = z.infer<
  typeof githubCommitChecksWatchRecordSchema
>;

export const githubStartCommitChecksWatchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    commitSha: gitShaSchema,
    timeoutMs: z
      .number()
      .int()
      .min(30_000)
      .max(1_800_000)
      .default(900_000),
  })
  .strict();
export type GitHubStartCommitChecksWatchInput = z.input<
  typeof githubStartCommitChecksWatchInputSchema
>;

export const githubStartCommitChecksWatchResultSchema = z
  .object({
    status: z.enum(["started", "existing"]),
    watch: githubCommitChecksWatchRecordSchema,
  })
  .strict();
export type GitHubStartCommitChecksWatchResult = z.infer<
  typeof githubStartCommitChecksWatchResultSchema
>;

export const githubGetCommitChecksWatchesInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    ids: z.array(z.uuid()).min(1).max(20).optional(),
    state: githubCommitChecksWatchStateSchema.optional(),
  })
  .strict();
export type GitHubGetCommitChecksWatchesInput = z.infer<
  typeof githubGetCommitChecksWatchesInputSchema
>;

export const githubGetCommitChecksWatchesResultSchema = z
  .object({
    watches: z.array(githubCommitChecksWatchRecordSchema).max(50),
    truncated: z.boolean(),
  })
  .strict();
export type GitHubGetCommitChecksWatchesResult = z.infer<
  typeof githubGetCommitChecksWatchesResultSchema
>;

export const githubWaitCommitChecksWatchInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    id: z.uuid(),
    timeoutMs: z.number().int().positive().max(30_000).default(15_000),
  })
  .strict();
export type GitHubWaitCommitChecksWatchInput = z.input<
  typeof githubWaitCommitChecksWatchInputSchema
>;

export const githubWaitCommitChecksWatchResultSchema = z
  .object({
    watch: githubCommitChecksWatchRecordSchema,
    timedOut: z.boolean(),
  })
  .strict();
export type GitHubWaitCommitChecksWatchResult = z.infer<
  typeof githubWaitCommitChecksWatchResultSchema
>;

export const githubCreateRepositoryInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    owner: githubOwnerSchema,
    name: githubRepositoryNameSchema,
    visibility: githubVisibilitySchema,
    description: z.string().max(350).optional(),
    confirmationId: confirmationIdSchema.optional(),
  })
  .strict();
export type GitHubCreateRepositoryInput = z.input<typeof githubCreateRepositoryInputSchema>;

const githubCreateRepositoryConfirmationRequiredSchema = sourceControlConfirmationRequiredSchema.extend({
  operation: z.literal("github_create_repository"),
});
const githubCreateRepositoryCompletedResultSchema = githubRepositoryResultSchema.extend({
  status: z.literal("completed"),
});
export const githubCreateRepositoryResultSchema = z.discriminatedUnion("status", [
  githubCreateRepositoryConfirmationRequiredSchema,
  githubCreateRepositoryCompletedResultSchema,
]);
export type GitHubCreateRepositoryResult = z.infer<
  typeof githubCreateRepositoryResultSchema
>;

export const githubGetPullRequestInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    pullNumber: z.number().int().positive(),
  })
  .strict();
export type GitHubGetPullRequestInput = z.input<typeof githubGetPullRequestInputSchema>;

export const githubPullRequestResultSchema = z
  .object({
    number: z.number().int().positive(),
    state: githubPullRequestStateSchema,
    title: z.string().min(1).max(256),
    url: githubUrlSchema,
    headSha: gitShaSchema,
    baseSha: gitShaSchema,
    merged: z.boolean(),
  })
  .strict();
export type GitHubPullRequestResult = z.infer<typeof githubPullRequestResultSchema>;

export const githubCreatePullRequestInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    title: z.string().trim().min(1).max(256),
    head: githubPullRefSchema,
    base: githubPullRefSchema,
    body: z.string().max(65_536).optional(),
    draft: z.boolean().default(false),
    confirmationId: confirmationIdSchema.optional(),
  })
  .strict();
export type GitHubCreatePullRequestInput = z.input<typeof githubCreatePullRequestInputSchema>;

const githubCreatePullRequestConfirmationRequiredSchema = sourceControlConfirmationRequiredSchema.extend({
  operation: z.literal("github_create_pull_request"),
});
const githubCreatePullRequestCompletedResultSchema = githubPullRequestResultSchema.extend({
  status: z.literal("completed"),
});
export const githubCreatePullRequestResultSchema = z.discriminatedUnion("status", [
  githubCreatePullRequestConfirmationRequiredSchema,
  githubCreatePullRequestCompletedResultSchema,
]);
export type GitHubCreatePullRequestResult = z.infer<
  typeof githubCreatePullRequestResultSchema
>;

export const githubMergePullRequestInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    pullNumber: z.number().int().positive(),
    expectedPullRequestHeadSha: gitShaSchema,
    mergeMethod: githubMergeMethodSchema,
    confirmationId: confirmationIdSchema.optional(),
  })
  .strict();
export type GitHubMergePullRequestInput = z.input<typeof githubMergePullRequestInputSchema>;

const githubMergePullRequestConfirmationRequiredSchema = sourceControlConfirmationRequiredSchema.extend({
  operation: z.literal("github_merge_pull_request"),
});
export const githubMergePullRequestCompletedResultSchema = z
  .object({
    status: z.literal("completed"),
    number: z.number().int().positive(),
    merged: z.boolean(),
    mergeSha: gitShaSchema,
  })
  .strict();
export const githubMergePullRequestResultSchema = z.discriminatedUnion("status", [
  githubMergePullRequestConfirmationRequiredSchema,
  githubMergePullRequestCompletedResultSchema,
]);
export type GitHubMergePullRequestResult = z.infer<
  typeof githubMergePullRequestResultSchema
>;

function normalizeGitPath(value: string): string {
  return value
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
}
