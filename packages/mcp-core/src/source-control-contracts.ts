import { z } from "zod";
import { errorCodes } from "./errors.js";

const workspaceIdSchema = z.string().trim().min(1);
const rootSchema = z.string().trim().min(1).max(4_096);
const confirmationIdSchema = z.string().min(1).max(128);

// Explicit, shell-safe SemVer release tag; arbitrary Git refs are not accepted.
export const gitReleaseTagSchema = z.string().min(2).max(64)
  .regex(/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u);
export type GitReleaseTag = z.infer<typeof gitReleaseTagSchema>;

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
  "github.artifact.materialize",
  "github.workflow.dispatch",
  "github.workflow.bootstrap",
  "github.workflow.public_release",
  "github.repository.create",
  "github.pull_request.read",
  "github.pull_request.create",
  "github.pull_request.close",
  "github.pull_request.merge",
  "github.issue.write",
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
  "git_publish_tag",
  "github_get_repository",
  "github_get_commit_checks",
  "github_materialize_actions_artifact",
  "github_start_commit_checks_watch",
  "github_get_commit_checks_watches",
  "github_wait_commit_checks_watch",
  "github_workflow_operation",
  "github_create_repository",
  "github_get_pull_request",
  "github_create_pull_request",
  "github_close_pull_request",
  "github_merge_pull_request",
  "github_read",
  "github_issue_write",
]);
export type SourceControlOperationName = z.infer<typeof sourceControlOperationNameSchema>;

export const confirmableSourceControlOperationNameSchema = z.enum([
  "git_push_branch",
  "git_publish_tag",
  "github_create_repository",
  "github_create_pull_request",
  "github_close_pull_request",
  "github_merge_pull_request",
  "github_issue_write",
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

export const gitPublishTagInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  root: rootSchema.optional(),
  tag: gitReleaseTagSchema,
  expectedCommitSha: gitShaSchema,
  remote: z.literal("origin").default("origin"),
  confirmationId: confirmationIdSchema.optional(),
}).strict();
export type GitPublishTagInput = z.input<typeof gitPublishTagInputSchema>;

const gitPublishTagConfirmationRequiredSchema = sourceControlConfirmationRequiredSchema.extend({
  operation: z.literal("git_publish_tag"),
});
export const gitPublishTagCompletedResultSchema = z.object({
  status: z.literal("completed"),
  root: rootSchema,
  remote: gitRemoteSchema,
  tag: gitReleaseTagSchema,
  commitSha: gitShaSchema,
  remoteSha: gitShaSchema,
  alreadyPublished: z.boolean(),
}).strict().refine((value) => value.commitSha === value.remoteSha, {
  message: "Published tag must match the expected commit SHA.",
});
export const gitPublishTagResultSchema = z.discriminatedUnion("status", [
  gitPublishTagConfirmationRequiredSchema,
  gitPublishTagCompletedResultSchema,
]);
export type GitPublishTagResult = z.infer<typeof gitPublishTagResultSchema>;

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

const actionsArtifactNameSchema = z.string().regex(/^windows-companion-[0-9]+\.[0-9]+\.[0-9]+-companion\.[0-9]+-[a-f0-9]{40}$/u);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const githubMaterializeActionsArtifactInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  root: rootSchema.optional(),
  owner: githubOwnerSchema,
  repository: githubRepositoryNameSchema,
  runId: z.number().int().positive().safe(),
  artifactName: actionsArtifactNameSchema,
  expectedCommitSha: gitShaSchema,
  expectedArtifactSha256: sha256DigestSchema,
}).strict().refine(value => value.artifactName.endsWith("-" + value.expectedCommitSha), {
  message: "Artifact name must bind to the expected exact commit SHA.",
});

export type GitHubMaterializeActionsArtifactInput = z.infer<typeof githubMaterializeActionsArtifactInputSchema>;

export const githubMaterializeActionsArtifactResultSchema = z.object({
  status: z.enum(["materialized", "already_materialized"]),
  runId: z.number().int().positive(),
  commitSha: gitShaSchema,
  artifactName: actionsArtifactNameSchema,
  archivePath: z.string().min(1).max(4096),
  archiveSha256: sha256DigestSchema,
  sizeBytes: z.number().int().nonnegative().max(300_000_000),
  validation: z.literal("actions_archive_sha256_verified"),
}).strict();

export type GitHubMaterializeActionsArtifactResult = z.infer<typeof githubMaterializeActionsArtifactResultSchema>;

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

/** Fixed workflows github_workflow_operation may dispatch and reconcile. */
export const GITHUB_OPERATION_WORKFLOWS = [
  "edge-f09-guarded-rollout.yml",
  "release-tag-bootstrap.yml",
  "release.yml",
  "edge-cas-candidate-stage.yml",
  "edge-catalog-activate.yml",
  "edge-catalog-recover-prepare.yml",
  "companion-only-distribution.yml",
] as const;
export type GitHubOperationWorkflow = (typeof GITHUB_OPERATION_WORKFLOWS)[number];

export const githubWorkflowOperationInputSchema = z.object({
  workspaceId: workspaceIdSchema,
  root: rootSchema.optional(),
  owner: githubOwnerSchema,
  repository: githubRepositoryNameSchema,
  workflow: z.enum(GITHUB_OPERATION_WORKFLOWS),
  tag: z.string().regex(/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u).optional(),
  mode: z.enum(["dispatch", "reconcile"]),
  expectedMainSha: gitShaSchema,
  operationId: z.uuid(),
  bootstrapOperationId: z.uuid().optional(),
  stageRunId: z.number().int().positive().optional(),
  ciRunId: z.number().int().positive().optional(),
}).strict().superRefine((input,ctx)=>{
  const isPublic=input.workflow==="release.yml";
  const needsTag=isPublic || input.workflow==="release-tag-bootstrap.yml";
  if((needsTag && (!input.tag || input.tag.includes("-oracle.") || input.tag.includes("-companion."))) ||
      (!needsTag && input.tag!==undefined) ||
      (isPublic && input.mode==="dispatch" && !input.bootstrapOperationId) ||
      (!isPublic && input.bootstrapOperationId!==undefined)){
    ctx.addIssue({code:"custom",message:"Public release dispatch needs an exact bootstrapOperationId; other workflows forbid that field."});
  }
  const isActivation=input.workflow==="edge-catalog-activate.yml";
  if((isActivation && input.mode==="dispatch" && input.stageRunId===undefined) ||
      (!isActivation && input.stageRunId!==undefined)){
    ctx.addIssue({code:"custom",message:"Edge catalog activation dispatch needs stageRunId; other workflows forbid that field."});
  }
  const isCompanion=input.workflow==="companion-only-distribution.yml";
  if((isCompanion && input.mode==="dispatch" && input.ciRunId===undefined) ||
      (!isCompanion && input.ciRunId!==undefined)){
    ctx.addIssue({code:"custom",message:"Companion publication dispatch needs ciRunId; other workflows forbid that field."});
  }
});
export type GitHubWorkflowOperationInput = z.infer<typeof githubWorkflowOperationInputSchema>;

export const githubWorkflowOperationResultSchema = z.discriminatedUnion("status",[
  z.object({status:z.literal("submitted"),operationId:z.uuid()}).strict(),
  z.object({status:z.literal("outcome_unknown"),operationId:z.uuid()}).strict(),
  z.object({status:z.literal("observed"),operationId:z.uuid(),runId:z.number().int().positive(),
    state:z.enum(["queued","in_progress","completed"]),conclusion:z.string().nullable()}).strict(),
]);
export type GitHubWorkflowOperationResult = z.infer<typeof githubWorkflowOperationResultSchema>;

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

// What the pull request card in the chat shows: branches, size, files and CI.
export const githubPullRequestOverviewSchema = z
  .object({
    headRef: z.string().min(1).max(255),
    baseRef: z.string().min(1).max(255),
    draft: z.boolean(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    changedFiles: z.number().int().nonnegative(),
    files: z.array(z.object({
      path: z.string().min(1).max(1_024),
      status: z.string().min(1).max(32),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
    }).strict()).max(100).optional(),
    checks: z.object({
      pending: z.number().int().nonnegative(),
      passed: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failing: z.array(z.string().min(1).max(256)).max(20),
    }).strict().optional(),
  })
  .strict();
export type GitHubPullRequestOverview = z.infer<typeof githubPullRequestOverviewSchema>;

export const githubPullRequestResultSchema = z
  .object({
    number: z.number().int().positive(),
    state: githubPullRequestStateSchema,
    title: z.string().min(1).max(256),
    url: githubUrlSchema,
    headSha: gitShaSchema,
    baseSha: gitShaSchema,
    merged: z.boolean(),
    overview: githubPullRequestOverviewSchema.optional(),
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

export const githubClosePullRequestInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    pullNumber: z.number().int().positive(),
    expectedPullRequestHeadSha: gitShaSchema,
    confirmationId: confirmationIdSchema.optional(),
  })
  .strict();
export type GitHubClosePullRequestInput = z.input<typeof githubClosePullRequestInputSchema>;

const githubClosePullRequestConfirmationRequiredSchema = sourceControlConfirmationRequiredSchema.extend({
  operation: z.literal("github_close_pull_request"),
});
const githubClosePullRequestCompletedResultSchema = githubPullRequestResultSchema.extend({
  status: z.literal("completed"),
  state: z.literal("closed"),
  merged: z.literal(false),
});
export const githubClosePullRequestResultSchema = z.discriminatedUnion("status", [
  githubClosePullRequestConfirmationRequiredSchema,
  githubClosePullRequestCompletedResultSchema,
]);
export type GitHubClosePullRequestResult = z.infer<
  typeof githubClosePullRequestResultSchema
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

/** Read-only GitHub views that github_read projects to a few typed fields. */
export const GITHUB_READ_KINDS = [
  "release",
  "releases",
  "refs",
  "workflow_runs",
  "run_jobs",
  "job_logs",
  "issues",
  "issue",
  "issue_comments",
  "pull_request_reviews",
  "pull_request_review_comments",
] as const;
export type GitHubReadKind = (typeof GITHUB_READ_KINDS)[number];

const githubReadFilterSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Invalid GitHub filter value.");

export const githubReadInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    kind: z.enum(GITHUB_READ_KINDS),
    tag: githubReadFilterSchema.optional(),
    refType: z.enum(["tags", "heads"]).optional(),
    prefix: githubReadFilterSchema.optional(),
    workflow: z.string().regex(/^[A-Za-z0-9._-]{1,128}\.ya?ml$/u).optional(),
    branch: githubPullRefSchema.optional(),
    headSha: gitShaSchema.optional(),
    status: z.enum(["queued", "in_progress", "completed", "success", "failure", "cancelled"]).optional(),
    event: z.enum(["push", "pull_request", "workflow_dispatch", "schedule", "release"]).optional(),
    runId: z.number().int().positive().optional(),
    jobId: z.number().int().positive().optional(),
    number: z.number().int().positive().optional(),
    state: z.enum(["open", "closed", "all"]).optional(),
    labels: z.array(githubReadFilterSchema).max(10).optional(),
    tailBytes: z.number().int().min(1_024).max(400_000).optional(),
    page: z.number().int().min(1).max(100).default(1),
    perPage: z.number().int().min(1).max(100).default(30),
  })
  .strict()
  .superRefine((input, ctx) => {
    const required: Partial<Record<GitHubReadKind, keyof typeof input>> = {
      run_jobs: "runId",
      job_logs: "jobId",
      issue: "number",
      issue_comments: "number",
      pull_request_reviews: "number",
      pull_request_review_comments: "number",
    };
    const field = required[input.kind];
    if (field !== undefined && input[field] === undefined) {
      ctx.addIssue({ code: "custom", message: `github_read kind=${input.kind} needs ${field}.`, path: [field] });
    }
    if (input.tailBytes !== undefined && input.kind !== "job_logs") {
      ctx.addIssue({ code: "custom", message: "tailBytes applies only to kind=job_logs.", path: ["tailBytes"] });
    }
  });
export type GitHubReadInput = z.input<typeof githubReadInputSchema>;

const githubReadFieldValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

export const githubReadResultSchema = z
  .object({
    kind: z.enum(GITHUB_READ_KINDS),
    items: z.array(z.record(z.string(), githubReadFieldValueSchema)).max(100),
    text: z.string().optional(),
    truncated: z.boolean().optional(),
    page: z.number().int().positive(),
    nextPage: z.number().int().positive().optional(),
  })
  .strict();
export type GitHubReadResult = z.infer<typeof githubReadResultSchema>;

export const githubIssueWriteInputSchema = z
  .object({
    workspaceId: workspaceIdSchema,
    root: rootSchema.optional(),
    owner: githubOwnerSchema,
    repository: githubRepositoryNameSchema,
    action: z.enum(["create_issue", "comment"]),
    number: z.number().int().positive().optional(),
    title: z.string().trim().min(1).max(256).optional(),
    body: z.string().min(1).max(65_536),
    labels: z.array(githubReadFilterSchema).max(10).optional(),
    confirmationId: confirmationIdSchema.optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.action === "create_issue" && (input.title === undefined || input.number !== undefined)) {
      ctx.addIssue({ code: "custom", message: "create_issue needs title and no number." });
    }
    if (input.action === "comment" && (input.number === undefined || input.title !== undefined || input.labels !== undefined)) {
      ctx.addIssue({ code: "custom", message: "comment needs the issue or pull-request number, without title or labels." });
    }
  });
export type GitHubIssueWriteInput = z.input<typeof githubIssueWriteInputSchema>;

const githubIssueWriteConfirmationRequiredSchema = sourceControlConfirmationRequiredSchema.extend({
  operation: z.literal("github_issue_write"),
});
export const githubIssueWriteResultSchema = z.discriminatedUnion("status", [
  githubIssueWriteConfirmationRequiredSchema,
  z.object({
    status: z.literal("completed"),
    action: z.enum(["create_issue", "comment"]),
    number: z.number().int().positive(),
    url: githubUrlSchema,
    commentId: z.number().int().positive().optional(),
  }).strict(),
]);
export type GitHubIssueWriteResult = z.infer<typeof githubIssueWriteResultSchema>;

function normalizeGitPath(value: string): string {
  return value
    .replace(/\\/gu, "/")
    .split("/")
    .filter((segment) => segment !== ".")
    .join("/");
}
