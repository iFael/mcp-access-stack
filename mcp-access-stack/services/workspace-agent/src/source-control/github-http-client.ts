import {
  abortSignalError,
  AppError,
  type OperationContext,
} from "@vs-code-gpt/shared";
import type { GitHubCredentialProvider } from "./github-credential-provider.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_ACCEPT = "application/vnd.github+json";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface GitHubCurrentUserRecord {
  login: string;
}

export interface GitHubRepositoryRecord {
  owner: { login: string };
  name: string;
  full_name: string;
  default_branch: string;
  visibility: string;
  html_url: string;
}

export interface GitHubPullRequestRecord {
  number: number;
  state: string;
  title: string;
  html_url: string;
  head: { sha: string };
  base: { sha: string };
  merged: boolean;
  merge_commit_sha?: string | null;
}

export interface GitHubMergeRecord {
  sha: string;
  merged: boolean;
  message: string;
}

export interface GitHubCreateRepositoryRequest {
  name: string;
  private: boolean;
  visibility?: "private" | "public" | "internal";
  description?: string;
}

export interface GitHubCreatePullRequestRequest {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft: boolean;
}

export interface GitHubMergePullRequestRequest {
  sha: string;
  merge_method: "merge" | "squash";
}

export interface GitHubApiClient {
  getCurrentUser(context?: OperationContext): Promise<GitHubCurrentUserRecord>;
  getRepository(
    owner: string,
    repository: string,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord>;
  createUserRepository(
    request: GitHubCreateRepositoryRequest,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord>;
  createOrganizationRepository(
    owner: string,
    request: GitHubCreateRepositoryRequest,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord>;
  getPullRequest(
    owner: string,
    repository: string,
    pullNumber: number,
    context?: OperationContext,
  ): Promise<GitHubPullRequestRecord>;
  findPullRequests(
    owner: string,
    repository: string,
    head: string,
    base: string,
    context?: OperationContext,
  ): Promise<GitHubPullRequestRecord[]>;
  createPullRequest(
    owner: string,
    repository: string,
    request: GitHubCreatePullRequestRequest,
    context?: OperationContext,
  ): Promise<GitHubPullRequestRecord>;
  mergePullRequest(
    owner: string,
    repository: string,
    pullNumber: number,
    request: GitHubMergePullRequestRequest,
    context?: OperationContext,
  ): Promise<GitHubMergeRecord>;
}

export interface GitHubHttpClientOptions {
  credentialProvider: GitHubCredentialProvider;
  fetchImpl?: typeof fetch;
}

export class GitHubHttpClient implements GitHubApiClient {
  readonly #credentialProvider: GitHubCredentialProvider;
  readonly #fetchImpl: typeof fetch;

  constructor(options: GitHubHttpClientOptions) {
    this.#credentialProvider = options.credentialProvider;
    this.#fetchImpl = options.fetchImpl ?? fetch;
  }

  getCurrentUser(context?: OperationContext): Promise<GitHubCurrentUserRecord> {
    return performGitHubRequest<GitHubCurrentUserRecord>(
      this.#credentialProvider,
      this.#fetchImpl,
      { method: "GET", path: "/user", mutation: false },
      context,
    );
  }

  getRepository(
    owner: string,
    repository: string,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord> {
    return performGitHubRequest<GitHubRepositoryRecord>(
      this.#credentialProvider,
      this.#fetchImpl,
      {
        method: "GET",
        path: `/repos/${segment(owner)}/${segment(repository)}`,
        mutation: false,
      },
      context,
    );
  }

  createUserRepository(
    request: GitHubCreateRepositoryRequest,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord> {
    return performGitHubRequest<GitHubRepositoryRecord>(
      this.#credentialProvider,
      this.#fetchImpl,
      { method: "POST", path: "/user/repos", body: request, mutation: true },
      context,
    );
  }

  createOrganizationRepository(
    owner: string,
    request: GitHubCreateRepositoryRequest,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord> {
    return performGitHubRequest<GitHubRepositoryRecord>(
      this.#credentialProvider,
      this.#fetchImpl,
      {
        method: "POST",
        path: `/orgs/${segment(owner)}/repos`,
        body: request,
        mutation: true,
      },
      context,
    );
  }

  getPullRequest(
    owner: string,
    repository: string,
    pullNumber: number,
    context?: OperationContext,
  ): Promise<GitHubPullRequestRecord> {
    return performGitHubRequest<GitHubPullRequestRecord>(
      this.#credentialProvider,
      this.#fetchImpl,
      {
        method: "GET",
        path: `/repos/${segment(owner)}/${segment(repository)}/pulls/${positiveInteger(pullNumber)}`,
        mutation: false,
      },
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
    return performGitHubRequest<GitHubPullRequestRecord[]>(
      this.#credentialProvider,
      this.#fetchImpl,
      {
        method: "GET",
        path: `/repos/${segment(owner)}/${segment(repository)}/pulls?${query.toString()}`,
        mutation: false,
      },
      context,
    );
  }

  createPullRequest(
    owner: string,
    repository: string,
    request: GitHubCreatePullRequestRequest,
    context?: OperationContext,
  ): Promise<GitHubPullRequestRecord> {
    return performGitHubRequest<GitHubPullRequestRecord>(
      this.#credentialProvider,
      this.#fetchImpl,
      {
        method: "POST",
        path: `/repos/${segment(owner)}/${segment(repository)}/pulls`,
        body: request,
        mutation: true,
      },
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
    return performGitHubRequest<GitHubMergeRecord>(
      this.#credentialProvider,
      this.#fetchImpl,
      {
        method: "PUT",
        path: `/repos/${segment(owner)}/${segment(repository)}/pulls/${positiveInteger(pullNumber)}/merge`,
        body: request,
        mutation: true,
      },
      context,
    );
  }
}

interface FixedRequest {
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: object;
  mutation: boolean;
}

async function performGitHubRequest<T>(
  credentialProvider: GitHubCredentialProvider,
  fetchImpl: typeof fetch,
  request: FixedRequest,
  context?: OperationContext,
): Promise<T> {
  const signal = context?.signal;
  if (signal?.aborted) {
    throw abortSignalError(signal, "GitHub request was cancelled.");
  }
  const credential = await credentialProvider.getCredential(context);
  if (signal?.aborted) {
    throw abortSignalError(signal, "GitHub request was cancelled.");
  }

  const headers: Record<string, string> = {
    Accept: GITHUB_ACCEPT,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    Authorization: `Bearer ${credential.token}`,
  };
  const init: RequestInit = {
    method: request.method,
    headers,
    ...(signal === undefined ? {} : { signal }),
  };
  if (request.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }

  let response: Response;
  try {
    response = await fetchImpl(`${GITHUB_API_BASE_URL}${request.path}`, init);
  } catch {
    if (signal?.aborted && !request.mutation) {
      throw abortSignalError(signal, "GitHub request was cancelled.");
    }
    throw unavailableError(request.mutation);
  }

  if (!response.ok) {
    await discardBody(response);
    if (response.status === 401 || response.status === 403) {
      throw new AppError("AUTHENTICATION_FAILED", "GitHub authentication failed.");
    }
    if (response.status >= 400 && response.status < 500) {
      throw new AppError("INVALID_ARGUMENT", "GitHub rejected the typed request.");
    }
    throw unavailableError(request.mutation);
  }

  const text = await readResponseTextBounded(response);
  if (text.length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError("INTERNAL_ERROR", "GitHub returned an invalid response.");
  }
}

function unavailableError(mutation: boolean): AppError {
  return new AppError("AGENT_UNAVAILABLE", "GitHub API is unavailable.", {
    details: mutation
      ? { outcome: "unknown" }
      : { retryable: true, outcome: "not_started" },
  });
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

async function readResponseTextBounded(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AppError("LIMIT_EXCEEDED", "GitHub response exceeded the configured limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function positiveInteger(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AppError("INVALID_ARGUMENT", "GitHub pull-request number must be positive.");
  }
  return String(value);
}
