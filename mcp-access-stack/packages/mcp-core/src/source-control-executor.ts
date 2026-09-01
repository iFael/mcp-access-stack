import type { OperationContext } from "./contracts.js";
import type {
  GitCommitInput,
  GitCommitResult,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitHubCreatePullRequestInput,
  GitHubCreatePullRequestResult,
  GitHubCreateRepositoryInput,
  GitHubCreateRepositoryResult,
  GitHubGetPullRequestInput,
  GitHubGetRepositoryInput,
  GitHubMergePullRequestInput,
  GitHubMergePullRequestResult,
  GitHubPullRequestResult,
  GitHubRepositoryResult,
  GitMergeBranchInput,
  GitMergeBranchResult,
  GitPushBranchInput,
  GitPushBranchResult,
  GitStagePathsInput,
  GitStagePathsResult,
  GitUnstagePathsInput,
  GitUnstagePathsResult,
} from "./source-control-contracts.js";

export interface GitRepositoryExecutor {
  createBranch(
    input: GitCreateBranchInput,
    context?: OperationContext,
  ): Promise<GitCreateBranchResult>;
  stagePaths(
    input: GitStagePathsInput,
    context?: OperationContext,
  ): Promise<GitStagePathsResult>;
  unstagePaths(
    input: GitUnstagePathsInput,
    context?: OperationContext,
  ): Promise<GitUnstagePathsResult>;
  commit(
    input: GitCommitInput,
    context?: OperationContext,
  ): Promise<GitCommitResult>;
  mergeBranch(
    input: GitMergeBranchInput,
    context?: OperationContext,
  ): Promise<GitMergeBranchResult>;
  pushBranch(
    input: GitPushBranchInput,
    context?: OperationContext,
  ): Promise<GitPushBranchResult>;
}

export interface GitHubExecutor {
  getRepository(
    input: GitHubGetRepositoryInput,
    context?: OperationContext,
  ): Promise<GitHubRepositoryResult>;
  createRepository(
    input: GitHubCreateRepositoryInput,
    context?: OperationContext,
  ): Promise<GitHubCreateRepositoryResult>;
  getPullRequest(
    input: GitHubGetPullRequestInput,
    context?: OperationContext,
  ): Promise<GitHubPullRequestResult>;
  createPullRequest(
    input: GitHubCreatePullRequestInput,
    context?: OperationContext,
  ): Promise<GitHubCreatePullRequestResult>;
  mergePullRequest(
    input: GitHubMergePullRequestInput,
    context?: OperationContext,
  ): Promise<GitHubMergePullRequestResult>;
}
