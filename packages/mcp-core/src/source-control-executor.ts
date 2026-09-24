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
  GitHubCommitChecksResult,
  GitHubGetCommitChecksWatchesInput,
  GitHubGetCommitChecksWatchesResult,
  GitHubGetCommitChecksInput,
  GitHubGetPullRequestInput,
  GitHubGetRepositoryInput,
  GitHubMergePullRequestInput,
  GitHubMergePullRequestResult,
  GitHubPullRequestResult,
  GitHubStartCommitChecksWatchInput,
  GitHubStartCommitChecksWatchResult,
  GitHubWaitCommitChecksWatchInput,
  GitHubWaitCommitChecksWatchResult,
  GitHubRepositoryResult,
  GitMergeBranchInput,
  GitMergeBranchResult,
  GitSyncBranchInput,
  GitSyncBranchResult,
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
  syncBranch(
    input: GitSyncBranchInput,
    context?: OperationContext,
  ): Promise<GitSyncBranchResult>;
  pushBranch(
    input: GitPushBranchInput,
    context?: OperationContext,
  ): Promise<GitPushBranchResult>;
}

export interface GitHubChecksWatchExecutor {
  startCommitChecksWatch(
    input: GitHubStartCommitChecksWatchInput,
    context?: OperationContext,
  ): Promise<GitHubStartCommitChecksWatchResult>;
  getCommitChecksWatches(
    input: GitHubGetCommitChecksWatchesInput,
    context?: OperationContext,
  ): Promise<GitHubGetCommitChecksWatchesResult>;
  waitCommitChecksWatch(
    input: GitHubWaitCommitChecksWatchInput,
    context?: OperationContext,
  ): Promise<GitHubWaitCommitChecksWatchResult>;
}

export interface GitHubExecutor {
  getRepository(
    input: GitHubGetRepositoryInput,
    context?: OperationContext,
  ): Promise<GitHubRepositoryResult>;
  getCommitChecks(
    input: GitHubGetCommitChecksInput,
    context?: OperationContext,
  ): Promise<GitHubCommitChecksResult>;
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
