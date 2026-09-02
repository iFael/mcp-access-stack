import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  assertTypedGitBranchMutationAllowed,
  gitCommitInputSchema,
  gitCreateBranchInputSchema,
  gitMergeBranchInputSchema,
  gitPushBranchInputSchema,
  gitStagePathsInputSchema,
  gitUnstagePathsInputSchema,
  type GitCommitInput,
  type GitCommitResult,
  type GitCreateBranchInput,
  type GitCreateBranchResult,
  type GitMergeBranchInput,
  type GitMergeBranchResult,
  type GitPushBranchInput,
  type GitPushBranchResult,
  type GitRepositoryExecutor,
  type GitStagePathsInput,
  type GitStagePathsResult,
  type GitUnstagePathsInput,
  type GitUnstagePathsResult,
  type OperationContext,
} from "@vs-code-gpt/shared";
import { authorizeGitMutationPath, authorizeGitOperationalRoot } from "../git/operational-root.js";
import { PathSecurity } from "../path-security.js";
import type { ResolvedWorkspace } from "../internal-types.js";
import { WorkspaceRegistry } from "../workspace-registry.js";
import {
  HardenedGitProcessRunner,
  type GitProcessExecutor,
} from "./git-process-runner.js";

interface MutationRepositoryContext {
  workspace: ResolvedWorkspace;
  security: PathSecurity;
  logicalRoot: string;
  repositoryRoot: string;
}

export class GitRepositoryService implements GitRepositoryExecutor {
  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly runner: GitProcessExecutor,
  ) {}

  static async create(registry: WorkspaceRegistry): Promise<GitRepositoryService> {
    return new GitRepositoryService(registry, await HardenedGitProcessRunner.create());
  }

  async createBranch(
    input: GitCreateBranchInput,
    context?: OperationContext,
  ): Promise<GitCreateBranchResult> {
    const parsed = gitCreateBranchInputSchema.parse(input);
    const repository = await this.resolveRepository(parsed.workspaceId, parsed.root ?? ".", context?.signal);
    const actualHead = await this.runner.headSha(repository.repositoryRoot, context?.signal);
    assertSha("GIT_HEAD_MISMATCH", parsed.expectedHeadSha, actualHead, "Git HEAD changed before branch creation.");
    if ((await this.runner.branchSha(repository.repositoryRoot, parsed.branch, context?.signal)) !== undefined) {
      throw new AppError("GIT_BRANCH_CONFLICT", "Git branch already exists.");
    }
    await this.runner.createBranch(
      repository.repositoryRoot,
      parsed.branch,
      parsed.expectedHeadSha,
      context?.signal,
    );
    const headSha = await this.runner.headSha(repository.repositoryRoot, context?.signal);
    assertSha("GIT_HEAD_MISMATCH", parsed.expectedHeadSha, headSha, "Git branch creation produced an unexpected HEAD.");
    return { root: repository.logicalRoot, branch: parsed.branch, headSha };
  }

  async stagePaths(
    input: GitStagePathsInput,
    context?: OperationContext,
  ): Promise<GitStagePathsResult> {
    const parsed = gitStagePathsInputSchema.parse(input);
    const repository = await this.resolveRepository(parsed.workspaceId, parsed.root ?? ".", context?.signal);
    const paths = await this.authorizePaths(repository, parsed.paths);
    await this.runner.stagePaths(repository.repositoryRoot, paths, context?.signal);
    return {
      root: repository.logicalRoot,
      headSha: await this.runner.headSha(repository.repositoryRoot, context?.signal),
      indexTreeSha: await this.runner.writeTree(repository.repositoryRoot, context?.signal),
      paths,
    };
  }

  async unstagePaths(
    input: GitUnstagePathsInput,
    context?: OperationContext,
  ): Promise<GitUnstagePathsResult> {
    const parsed = gitUnstagePathsInputSchema.parse(input);
    const repository = await this.resolveRepository(parsed.workspaceId, parsed.root ?? ".", context?.signal);
    const actualHead = await this.runner.headSha(repository.repositoryRoot, context?.signal);
    assertSha("GIT_HEAD_MISMATCH", parsed.expectedHeadSha, actualHead, "Git HEAD changed before unstage.");
    const actualIndex = await this.runner.writeTree(repository.repositoryRoot, context?.signal);
    assertSha("GIT_INDEX_CHANGED", parsed.expectedIndexTreeSha, actualIndex, "Git index changed before unstage.");
    const paths = await this.authorizePaths(repository, parsed.paths);
    await this.runner.unstagePaths(repository.repositoryRoot, paths, context?.signal);
    return {
      root: repository.logicalRoot,
      headSha: await this.runner.headSha(repository.repositoryRoot, context?.signal),
      indexTreeSha: await this.runner.writeTree(repository.repositoryRoot, context?.signal),
      paths,
    };
  }

  async commit(input: GitCommitInput, context?: OperationContext): Promise<GitCommitResult> {
    const parsed = gitCommitInputSchema.parse(input);
    const repository = await this.resolveRepository(parsed.workspaceId, parsed.root ?? ".", context?.signal);
    const branch = await this.runner.currentBranch(repository.repositoryRoot, context?.signal);
    assertTypedGitBranchMutationAllowed({ operation: "git_commit", currentBranch: branch });
    const actualHead = await this.runner.headSha(repository.repositoryRoot, context?.signal);
    assertSha("GIT_HEAD_MISMATCH", parsed.expectedHeadSha, actualHead, "Git HEAD changed before commit.");
    const actualIndex = await this.runner.writeTree(repository.repositoryRoot, context?.signal);
    assertSha("GIT_INDEX_CHANGED", parsed.expectedIndexTreeSha, actualIndex, "Git index changed before commit.");
    await this.runner.commit(repository.repositoryRoot, parsed.message, context?.signal);
    return {
      root: repository.logicalRoot,
      branch,
      commitSha: await this.runner.headSha(repository.repositoryRoot, context?.signal),
    };
  }

  async mergeBranch(
    input: GitMergeBranchInput,
    context?: OperationContext,
  ): Promise<GitMergeBranchResult> {
    const parsed = gitMergeBranchInputSchema.parse(input);
    const repository = await this.resolveRepository(parsed.workspaceId, parsed.root ?? ".", context?.signal);
    const branch = await this.runner.currentBranch(repository.repositoryRoot, context?.signal);
    assertTypedGitBranchMutationAllowed({ operation: "git_merge_branch", currentBranch: branch });
    const targetHead = await this.runner.headSha(repository.repositoryRoot, context?.signal);
    assertSha(
      "GIT_HEAD_MISMATCH",
      parsed.expectedTargetHeadSha,
      targetHead,
      "Git target HEAD changed before merge.",
    );
    const sourceHead = await this.runner.branchSha(
      repository.repositoryRoot,
      parsed.sourceBranch,
      context?.signal,
    );
    if (sourceHead === undefined || sourceHead !== parsed.expectedSourceHeadSha) {
      throw new AppError("GIT_HEAD_MISMATCH", "Git source branch changed before merge.");
    }
    if (
      !(await this.runner.indexIsClean(repository.repositoryRoot, context?.signal)) ||
      !(await this.runner.worktreeIsClean(repository.repositoryRoot, context?.signal))
    ) {
      throw new AppError(
        "GIT_MERGE_NOT_FAST_FORWARD",
        "Git repository must have a clean index and worktree before merge.",
      );
    }
    if (
      !(await this.runner.mergeBaseIsAncestor(
        repository.repositoryRoot,
        targetHead,
        sourceHead,
        context?.signal,
      ))
    ) {
      throw new AppError(
        "GIT_MERGE_NOT_FAST_FORWARD",
        "Git source branch cannot fast-forward the current branch.",
      );
    }
    await this.runner.mergeFastForward(repository.repositoryRoot, sourceHead, context?.signal);
    const headSha = await this.runner.headSha(repository.repositoryRoot, context?.signal);
    if (headSha !== sourceHead) {
      throw new AppError(
        "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
        "Git merge completed with an unexpected repository state.",
      );
    }
    return {
      root: repository.logicalRoot,
      branch,
      previousHeadSha: targetHead,
      headSha,
      sourceHeadSha: sourceHead,
      fastForwarded: true,
    };
  }

  async pushBranch(
    input: GitPushBranchInput,
    context?: OperationContext,
  ): Promise<GitPushBranchResult> {
    const parsed = gitPushBranchInputSchema.parse(input);
    assertTypedGitBranchMutationAllowed({ operation: "git_push_branch", branch: parsed.branch });
    const repository = await this.resolveRepository(parsed.workspaceId, parsed.root ?? ".", context?.signal);
    const localSha = await this.runner.branchSha(
      repository.repositoryRoot,
      parsed.branch,
      context?.signal,
    );
    if (localSha === undefined || localSha !== parsed.expectedLocalSha) {
      throw new AppError("GIT_HEAD_MISMATCH", "Git branch changed before push.");
    }
    const remoteSha = await this.runner.remoteBranchSha(
      repository.repositoryRoot,
      parsed.remote,
      parsed.branch,
      context?.signal,
    );
    if (parsed.expectedRemoteSha !== undefined && remoteSha !== parsed.expectedRemoteSha) {
      throw new AppError("GIT_REMOTE_CHANGED", "Git remote branch changed before push.");
    }

    try {
      await this.runner.pushBranch(
        repository.repositoryRoot,
        parsed.remote,
        parsed.branch,
        localSha,
        context?.signal,
      );
    } catch (error) {
      if (!isAmbiguousGitMutation(error)) throw error;
      return this.reconcilePush(repository, parsed.remote, parsed.branch, localSha, context?.signal);
    }
    return this.reconcilePush(repository, parsed.remote, parsed.branch, localSha, context?.signal);
  }

  async canonicalOriginUrl(
    workspaceId: string,
    root = ".",
    signal?: AbortSignal,
  ): Promise<string> {
    const repository = await this.resolveRepository(workspaceId, root, signal);
    return this.runner.remoteUrl(repository.repositoryRoot, signal);
  }

  private async reconcilePush(
    repository: MutationRepositoryContext,
    remote: string,
    branch: string,
    localSha: string,
    signal?: AbortSignal,
  ): Promise<GitPushBranchResult> {
    const reconciledRemoteSha = await this.runner.remoteBranchSha(
      repository.repositoryRoot,
      remote,
      branch,
      signal,
    );
    if (reconciledRemoteSha !== localSha) {
      throw new AppError(
        "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
        "Git push outcome requires reconciliation.",
      );
    }
    return {
      status: "completed",
      root: repository.logicalRoot,
      remote,
      branch,
      localSha,
      remoteSha: reconciledRemoteSha,
    };
  }

  private async resolveRepository(
    workspaceId: string,
    root: string,
    signal?: AbortSignal,
  ): Promise<MutationRepositoryContext> {
    const workspace = this.registry.get(workspaceId);
    const security = new PathSecurity(workspace);
    const authorizedRoot = await authorizeGitOperationalRoot(workspace, security, root);
    if (!(await this.runner.isInsideWorkTree(authorizedRoot.canonicalPath, signal))) {
      throw new AppError("NOT_GIT_REPOSITORY", "The selected workspace root is not inside a Git worktree.");
    }
    let canonicalTopLevel: string;
    try {
      canonicalTopLevel = await realpath(
        await this.runner.showTopLevel(authorizedRoot.canonicalPath, signal),
      );
    } catch (error) {
      if (error instanceof AppError && error.code !== "GIT_ERROR") throw error;
      throw new AppError("NOT_GIT_REPOSITORY", "Unable to resolve the selected Git repository.");
    }
    if (!samePath(canonicalTopLevel, authorizedRoot.canonicalPath)) {
      throw new AppError(
        "NOT_GIT_REPOSITORY",
        "Git mutations require the selected authorized root to be the repository top-level.",
      );
    }
    return {
      workspace,
      security,
      logicalRoot: authorizedRoot.logicalPath,
      repositoryRoot: canonicalTopLevel,
    };
  }

  private async authorizePaths(
    repository: MutationRepositoryContext,
    paths: readonly string[],
  ): Promise<string[]> {
    return Promise.all(
      paths.map((candidate) =>
        authorizeGitMutationPath(repository.security, repository.logicalRoot, candidate),
      ),
    );
  }
}

function assertSha(
  code: "GIT_HEAD_MISMATCH" | "GIT_INDEX_CHANGED",
  expected: string,
  actual: string,
  message: string,
): void {
  if (expected !== actual) throw new AppError(code, message);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function isAmbiguousGitMutation(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "GIT_ERROR" &&
    error.details?.outcome === "unknown"
  );
}
