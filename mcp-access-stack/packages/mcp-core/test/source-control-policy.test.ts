import { describe, expect, test } from "@jest/globals";
import type { PermissionProfile } from "../src/policy.js";
import {
  assertSourceControlCapability,
  assertTypedGitBranchMutationAllowed,
  sourceControlPolicySchema,
  type SourceControlPolicy,
} from "../src/source-control-policy.js";

function policy(
  permissionProfile: PermissionProfile,
  sourceControl?: SourceControlPolicy,
) {
  return {
    permissionProfile,
    ...(sourceControl === undefined ? {} : { sourceControl }),
  };
}

function sourceControl(
  capabilities: SourceControlPolicy["capabilities"],
  overrides: Partial<SourceControlPolicy> = {},
): SourceControlPolicy {
  return sourceControlPolicySchema.parse({
    capabilities,
    accountOwners: overrides.accountOwners ?? [],
    additionalRepositories: overrides.additionalRepositories ?? [],
  });
}

describe("source-control policy", () => {
  test("defaults explicit source-control policy sets to empty", () => {
    expect(sourceControlPolicySchema.parse({})).toEqual({
      capabilities: [],
      accountOwners: [],
      additionalRepositories: [],
    });
  });

  test("requires the exact capability and never grants from full-repo-write alone", () => {
    expect(() => assertSourceControlCapability({
      policy: policy("full-repo-write"),
      capability: "git.commit.write",
      mutation: true,
    })).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));

    expect(() => assertSourceControlCapability({
      policy: policy("full-repo-write", sourceControl(["git.branch.write"])),
      capability: "git.commit.write",
      mutation: true,
    })).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));
  });

  test("requires full-repo-write for mutations even when capability is present", () => {
    expect(() => assertSourceControlCapability({
      policy: policy("full-repo-readonly", sourceControl(["git.commit.write"])),
      capability: "git.commit.write",
      mutation: true,
    })).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));

    expect(() => assertSourceControlCapability({
      policy: policy("full-repo-write", sourceControl(["git.commit.write"])),
      capability: "git.commit.write",
      mutation: true,
    })).not.toThrow();
  });

  test("allows source-control reads independently of shell permission when capability and target match", () => {
    expect(() => assertSourceControlCapability({
      policy: policy(
        "full-repo-readonly",
        sourceControl(["github.repository.read"]),
      ),
      capability: "github.repository.read",
      repository: "acme/app",
      canonicalRepository: "Acme/App",
      mutation: false,
    })).not.toThrow();
  });

  test("keeps stage and unstage on git.index.write while merge requires git.merge.write", () => {
    const indexPolicy = policy(
      "full-repo-write",
      sourceControl(["git.index.write", "git.branch.write"]),
    );

    expect(() => assertSourceControlCapability({
      policy: indexPolicy,
      capability: "git.index.write",
      mutation: true,
    })).not.toThrow();
    expect(() => assertSourceControlCapability({
      policy: indexPolicy,
      capability: "git.merge.write",
      mutation: true,
    })).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));
  });

  test("requires the typed GitHub target implied by the capability", () => {
    expect(() => assertSourceControlCapability({
      policy: policy(
        "full-repo-readonly",
        sourceControl(["github.repository.read"]),
      ),
      capability: "github.repository.read",
      mutation: false,
    })).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));

    expect(() => assertSourceControlCapability({
      policy: policy(
        "full-repo-write",
        sourceControl(["github.repository.create"], { accountOwners: ["acme"] }),
      ),
      capability: "github.repository.create",
      mutation: true,
    })).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));
  });

  test("authorizes repository targets only when canonical or explicitly additional", () => {
    const repositoryPolicy = policy(
      "full-repo-readonly",
      sourceControl(["github.repository.read"], {
        additionalRepositories: ["acme/extra"],
      }),
    );

    expect(() => assertSourceControlCapability({
      policy: repositoryPolicy,
      capability: "github.repository.read",
      repository: "ACME/APP",
      canonicalRepository: "acme/app",
      mutation: false,
    })).not.toThrow();
    expect(() => assertSourceControlCapability({
      policy: repositoryPolicy,
      capability: "github.repository.read",
      repository: "ACME/EXTRA",
      canonicalRepository: "acme/app",
      mutation: false,
    })).not.toThrow();
    expect(() => assertSourceControlCapability({
      policy: repositoryPolicy,
      capability: "github.repository.read",
      repository: "acme/other",
      canonicalRepository: "acme/app",
      mutation: false,
    })).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));
  });

  test("fails closed when canonical repository is unavailable unless target is explicitly additional", () => {
    const repositoryPolicy = policy(
      "full-repo-readonly",
      sourceControl(["github.pull_request.read"], {
        additionalRepositories: ["acme/explicit"],
      }),
    );

    expect(() => assertSourceControlCapability({
      policy: repositoryPolicy,
      capability: "github.pull_request.read",
      repository: "acme/unlisted",
      mutation: false,
    })).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));

    expect(() => assertSourceControlCapability({
      policy: repositoryPolicy,
      capability: "github.pull_request.read",
      repository: "ACME/EXPLICIT",
      mutation: false,
    })).not.toThrow();
  });

  test("authorizes repository creation only for explicitly allowed account owners", () => {
    const creationPolicy = policy(
      "full-repo-write",
      sourceControl(["github.repository.create"], {
        accountOwners: ["acme"],
      }),
    );

    expect(() => assertSourceControlCapability({
      policy: creationPolicy,
      capability: "github.repository.create",
      accountOwner: "ACME",
      mutation: true,
    })).not.toThrow();
    expect(() => assertSourceControlCapability({
      policy: creationPolicy,
      capability: "github.repository.create",
      accountOwner: "other",
      mutation: true,
    })).toThrow(expect.objectContaining({ code: "SOURCE_CONTROL_CAPABILITY_DENIED" }));
  });

  test("rejects duplicate source-control target entries case-insensitively", () => {
    expect(() => sourceControlPolicySchema.parse({
      capabilities: ["git.index.write", "git.index.write"],
    })).toThrow();
    expect(() => sourceControlPolicySchema.parse({
      accountOwners: ["Acme", "acme"],
    })).toThrow();
    expect(() => sourceControlPolicySchema.parse({
      additionalRepositories: ["Acme/App", "acme/app"],
    })).toThrow();
  });
});

describe("typed protected-main policy", () => {
  test("blocks direct commit on main", () => {
    expect(() => assertTypedGitBranchMutationAllowed({
      operation: "git_commit",
      currentBranch: "main",
    })).toThrow(expect.objectContaining({ code: "GIT_PROTECTED_BRANCH" }));
  });

  test("blocks local merge when current target is main", () => {
    expect(() => assertTypedGitBranchMutationAllowed({
      operation: "git_merge_branch",
      currentBranch: "MAIN",
    })).toThrow(expect.objectContaining({ code: "GIT_PROTECTED_BRANCH" }));
  });

  test("blocks push whose explicit source/destination branch is main", () => {
    expect(() => assertTypedGitBranchMutationAllowed({
      operation: "git_push_branch",
      currentBranch: "feature/x",
      branch: "main",
    })).toThrow(expect.objectContaining({ code: "GIT_PROTECTED_BRANCH" }));
  });

  test("allows feature-branch creation from main and index-only changes on main", () => {
    expect(() => assertTypedGitBranchMutationAllowed({
      operation: "git_create_branch",
      currentBranch: "main",
      branch: "feature/x",
    })).not.toThrow();
    expect(() => assertTypedGitBranchMutationAllowed({
      operation: "git_stage_paths",
      currentBranch: "main",
    })).not.toThrow();
    expect(() => assertTypedGitBranchMutationAllowed({
      operation: "git_unstage_paths",
      currentBranch: "main",
    })).not.toThrow();
  });

  test("allows pushing an explicit feature branch even when another branch is checked out", () => {
    expect(() => assertTypedGitBranchMutationAllowed({
      operation: "git_push_branch",
      currentBranch: "main",
      branch: "feature/x",
    })).not.toThrow();
  });
});
