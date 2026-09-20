import {
  abortSignalError,
  AppError,
  type OperationContext,
} from "@vs-code-gpt/shared";
import type {
  GitHubApiClient,
  GitHubCreatePullRequestRequest,
  GitHubCreateRepositoryRequest,
  GitHubCurrentUserRecord,
  GitHubMergePullRequestRequest,
  GitHubMergeRecord,
  GitHubPullRequestRecord,
  GitHubRepositoryRecord,
} from "../source-control/github-http-client.js";
import type {
  RemoteGitHubApiRequest,
  RemoteGitHubApiResult,
} from "./ssh-windows-transport.js";

export interface SshGitHubApiTransport {
  githubApi(
    rootPath: string,
    request: RemoteGitHubApiRequest,
    signal?: AbortSignal,
  ): Promise<RemoteGitHubApiResult>;
}

export interface SshGitHubApiClientOptions {
  transport: SshGitHubApiTransport;
  rootPath: string;
}

export class SshGitHubApiClient implements GitHubApiClient {
  readonly #transport: SshGitHubApiTransport;
  readonly #rootPath: string;

  constructor(options: SshGitHubApiClientOptions) {
    this.#transport = options.transport;
    this.#rootPath = options.rootPath;
  }

  getCurrentUser(context?: OperationContext): Promise<GitHubCurrentUserRecord> {
    return this.request<GitHubCurrentUserRecord>(
      { method: "GET", path: "/user" },
      false,
      context,
    );
  }

  getRepository(
    owner: string,
    repository: string,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord> {
    return this.request<GitHubRepositoryRecord>(
      {
        method: "GET",
        path: `/repos/${segment(owner)}/${segment(repository)}`,
      },
      false,
      context,
    );
  }

  createUserRepository(
    request: GitHubCreateRepositoryRequest,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord> {
    return this.request<GitHubRepositoryRecord>(
      {
        method: "POST",
        path: "/user/repos",
        bodyJson: JSON.stringify(request),
      },
      true,
      context,
    );
  }

  createOrganizationRepository(
    owner: string,
    request: GitHubCreateRepositoryRequest,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord> {
    return this.request<GitHubRepositoryRecord>(
      {
        method: "POST",
        path: `/orgs/${segment(owner)}/repos`,
        bodyJson: JSON.stringify(request),
      },
      true,
      context,
    );
  }

  getPullRequest(
    owner: string,
    repository: string,
    pullNumber: number,
    context?: OperationContext,
  ): Promise<GitHubPullRequestRecord> {
    return this.request<GitHubPullRequestRecord>(
      {
        method: "GET",
        path: `/repos/${segment(owner)}/${segment(repository)}/pulls/${positiveInteger(pullNumber)}`,
      },
      false,
      context,
    );
  }

  findPullRequests(
    owner: string,
    repository: string,
    head: string,
    base: string,
    context?: OperationContext,
  ): Promise<GitHubPullRequestRecord[]> {
    const query = new URLSearchParams([
      ["state", "open"],
      ["head", head],
      ["base", base],
    ]);
    return this.request<GitHubPullRequestRecord[]>(
      {
        method: "GET",
        path:
          `/repos/${segment(owner)}/${segment(repository)}/pulls?${query.toString()}`,
      },
      false,
      context,
    );
  }

  createPullRequest(
    owner: string,
    repository: string,
    request: GitHubCreatePullRequestRequest,
    context?: OperationContext,
  ): Promise<GitHubPullRequestRecord> {
    return this.request<GitHubPullRequestRecord>(
      {
        method: "POST",
        path: `/repos/${segment(owner)}/${segment(repository)}/pulls`,
        bodyJson: JSON.stringify(request),
      },
      true,
      context,
    );
  }

  mergePullRequest(
    owner: string,
    repository: string,
    pullNumber: number,
    request: GitHubMergePullRequestRequest,
    context?: OperationContext,
  ): Promise<GitHubMergeRecord> {
    return this.request<GitHubMergeRecord>(
      {
        method: "PUT",
        path:
          `/repos/${segment(owner)}/${segment(repository)}/pulls/${positiveInteger(pullNumber)}/merge`,
        bodyJson: JSON.stringify(request),
      },
      true,
      context,
    );
  }

  private async request<T>(
    request: RemoteGitHubApiRequest,
    mutation: boolean,
    context?: OperationContext,
  ): Promise<T> {
    const signal = context?.signal;
    if (signal?.aborted) {
      throw abortSignalError(signal, "GitHub request was cancelled.");
    }

    let response: RemoteGitHubApiResult;
    try {
      response = await this.#transport.githubApi(
        this.#rootPath,
        request,
        signal,
      );
    } catch (error) {
      if (signal?.aborted) {
        throw abortSignalError(signal, "GitHub request was cancelled.");
      }
      if (error instanceof AppError && error.code === "OPERATION_CANCELLED") {
        throw error;
      }
      throw unavailableError(mutation);
    }

    if (response.authenticationFailed) {
      throw new AppError(
        "AUTHENTICATION_FAILED",
        "GitHub authentication failed on the SSH host.",
      );
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      if (response.statusCode === 401 || response.statusCode === 403) {
        throw new AppError(
          "AUTHENTICATION_FAILED",
          "GitHub authentication failed on the SSH host.",
        );
      }
      if (response.statusCode >= 400 && response.statusCode < 500) {
        throw new AppError(
          "INVALID_ARGUMENT",
          "GitHub rejected the typed request.",
        );
      }
      throw unavailableError(mutation);
    }

    if (response.body.length === 0) return {} as T;
    try {
      return JSON.parse(response.body) as T;
    } catch {
      throw new AppError("INTERNAL_ERROR", "GitHub returned an invalid response.");
    }
  }
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function positiveInteger(value: number): string {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError("INVALID_ARGUMENT", "GitHub numeric identifier is invalid.");
  }
  return String(value);
}

function unavailableError(mutation: boolean): AppError {
  return new AppError("AGENT_UNAVAILABLE", "GitHub API is unavailable.", {
    details: mutation
      ? { outcome: "unknown" }
      : { retryable: true, outcome: "not_started" },
  });
}
