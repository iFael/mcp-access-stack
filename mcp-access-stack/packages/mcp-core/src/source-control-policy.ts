import { z } from "zod";
import { AppError } from "./errors.js";
import type { PermissionProfile } from "./policy.js";
import {
  githubOwnerSchema,
  githubRepositoryFullNameSchema,
  sourceControlCapabilitySchema,
  type SourceControlCapability,
} from "./source-control-contracts.js";

export const sourceControlPolicySchema = z
  .object({
    capabilities: z.array(sourceControlCapabilitySchema).default([]),
    accountOwners: z.array(githubOwnerSchema).default([]),
    additionalRepositories: z.array(githubRepositoryFullNameSchema).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    addUniqueIssues(value.capabilities, "capabilities", context);
    addUniqueIssues(value.accountOwners, "accountOwners", context);
    addUniqueIssues(value.additionalRepositories, "additionalRepositories", context);
  });

export type SourceControlPolicy = z.output<typeof sourceControlPolicySchema>;

export interface AssertSourceControlCapabilityInput {
  policy: {
    permissionProfile: PermissionProfile;
    sourceControl?: SourceControlPolicy;
  };
  capability: SourceControlCapability;
  repository?: string;
  canonicalRepository?: string;
  accountOwner?: string;
  mutation: boolean;
}

export function assertSourceControlCapability(
  input: AssertSourceControlCapabilityInput,
): void {
  const configured = input.policy.sourceControl;
  if (!configured || !configured.capabilities.includes(input.capability)) {
    denySourceControl("Source-control capability is not authorized for this workspace.");
  }

  if (input.mutation && input.policy.permissionProfile !== "full-repo-write") {
    denySourceControl("Workspace policy does not allow source-control mutation.");
  }

  if (input.capability === "github.repository.create" && input.accountOwner === undefined) {
    denySourceControl("GitHub account owner is required for repository creation authorization.");
  }

  if (
    input.capability.startsWith("github.") &&
    input.capability !== "github.repository.create" &&
    input.repository === undefined
  ) {
    denySourceControl("GitHub repository target is required for source-control authorization.");
  }

  if (input.repository !== undefined) {
    const requested = normalizeTarget(input.repository);
    const canonical =
      input.canonicalRepository === undefined
        ? undefined
        : normalizeTarget(input.canonicalRepository);
    const additional = configured.additionalRepositories.map(normalizeTarget);
    if (requested !== canonical && !additional.includes(requested)) {
      denySourceControl("Source-control repository target is not authorized.");
    }
  }

  if (input.accountOwner !== undefined) {
    const requestedOwner = normalizeTarget(input.accountOwner);
    const allowedOwners = configured.accountOwners.map(normalizeTarget);
    if (!allowedOwners.includes(requestedOwner)) {
      denySourceControl("GitHub account owner is not authorized for repository creation.");
    }
  }
}

export type TypedGitBranchMutationOperation =
  | "git_create_branch"
  | "git_stage_paths"
  | "git_unstage_paths"
  | "git_commit"
  | "git_merge_branch"
  | "git_push_branch";

export function assertTypedGitBranchMutationAllowed(input: {
  operation: TypedGitBranchMutationOperation;
  currentBranch?: string;
  branch?: string;
}): void {
  const currentIsMain = isProtectedMain(input.currentBranch);
  const explicitIsMain = isProtectedMain(input.branch);

  if (
    (input.operation === "git_commit" && currentIsMain) ||
    (input.operation === "git_merge_branch" && currentIsMain) ||
    (input.operation === "git_push_branch" && explicitIsMain)
  ) {
    throw new AppError(
      "GIT_PROTECTED_BRANCH",
      "The protected main branch cannot be mutated by this typed Git operation.",
    );
  }
}

function addUniqueIssues(
  values: readonly string[],
  field: "capabilities" | "accountOwners" | "additionalRepositories",
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const key = normalizeTarget(value);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        message: `${field} entries must be unique.`,
        path: [field, index],
      });
    }
    seen.add(key);
  }
}

function normalizeTarget(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function isProtectedMain(value: string | undefined): boolean {
  return value?.toLocaleLowerCase("en-US") === "main";
}

function denySourceControl(message: string): never {
  throw new AppError("SOURCE_CONTROL_CAPABILITY_DENIED", message);
}
