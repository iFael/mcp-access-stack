import { z } from "zod";

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

export const sourceControlOperationNameSchema = z.enum([
  "git_create_branch",
  "git_stage_paths",
  "git_unstage_paths",
  "git_commit",
  "git_merge_branch",
  "git_push_branch",
  "github_get_repository",
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
