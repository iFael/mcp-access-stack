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

export interface GitHubCheckRunRecord {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GitHubCheckRunsRecord {
  total_count: number;
  check_runs: GitHubCheckRunRecord[];
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

export interface GitHubWorkflowRunRecord {
  id: number;
  workflow_id: number;
  name: string;
  display_title: string;
  head_sha: string;
  head_branch?: string | null;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
}
export interface GitHubWorkflowRunsRecord {
  total_count: number;
  workflow_runs: GitHubWorkflowRunRecord[];
}
export interface GitHubPublicReleaseAssetRecord {
  id:number;
  name:string;
  size:number;
  digest:string|null;
  state:string;
}
export interface GitHubPublicReleaseRecord {
  tag_name:string;
  draft:boolean;
  published_at:string|null;
  assets:GitHubPublicReleaseAssetRecord[];
}
export interface GitHubWorkflowRunDetail extends GitHubWorkflowRunRecord {
  path:string;
  head_branch:string|null;
}
export interface GitHubRefRecord {
  ref: string;
  object: { sha: string; type: string };
}

/** Workflow dispatch uses the existing authenticated GitHub client without
 * changing the established repository/PR adapter interface. */
export interface GitHubWorkflowApiClient {
  getMainRef(owner: string, repository: string, context?: OperationContext): Promise<GitHubRefRecord>;
  getTagRef?(owner: string, repository: string, tag: string, context?: OperationContext): Promise<GitHubRefRecord>;
  getWorkflowRuns(owner: string, repository: string, workflow: string,
    headSha: string, context?: OperationContext): Promise<GitHubWorkflowRunsRecord>;
  getTagPushRuns?(owner: string, repository: string, headSha: string,
    context?: OperationContext): Promise<GitHubWorkflowRunsRecord>;
  getWorkflowRun?(owner:string,repository:string,runId:number,
    context?:OperationContext):Promise<GitHubWorkflowRunDetail>;
  getReleaseByTag?(owner:string,repository:string,tag:string,
    context?:OperationContext):Promise<GitHubPublicReleaseRecord>;
  getReleaseAssetChecksum?(owner:string,repository:string,assetId:number,
    context?:OperationContext):Promise<string>;
  getReleaseAssetBytes?(owner:string,repository:string,assetId:number,
    maxBytes:number,context?:OperationContext):Promise<Uint8Array>;
  dispatchWorkflow(owner: string, repository: string, workflow: string,
    expectedSha: string, inputs: Record<string, string>,
    context?: OperationContext): Promise<void>;
}

export interface GitHubApiClient {
  getCurrentUser(context?: OperationContext): Promise<GitHubCurrentUserRecord>;
  getRepository(
    owner: string,
    repository: string,
    context?: OperationContext,
  ): Promise<GitHubRepositoryRecord>;
  getCommitCheckRuns(
    owner: string,
    repository: string,
    commitSha: string,
    context?: OperationContext,
  ): Promise<GitHubCheckRunsRecord>;
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
  closePullRequest(
    owner: string,
    repository: string,
    pullNumber: number,
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

  getCommitCheckRuns(
    owner: string,
    repository: string,
    commitSha: string,
    context?: OperationContext,
  ): Promise<GitHubCheckRunsRecord> {
    return performGitHubRequest<GitHubCheckRunsRecord>(
      this.#credentialProvider,
      this.#fetchImpl,
      {
        method: "GET",
        path: `/repos/${segment(owner)}/${segment(repository)}/commits/${segment(commitSha)}/check-runs?per_page=100`,
        mutation: false,
      },
      context,
    );
  }

  getMainRef(owner: string, repository: string, context?: OperationContext): Promise<GitHubRefRecord> {
    return performGitHubRequest<GitHubRefRecord>(this.#credentialProvider, this.#fetchImpl, {
      method: "GET", path: `/repos/${segment(owner)}/${segment(repository)}/git/ref/heads/main`,
      mutation: false,
    }, context);
  }

  getTagRef(owner:string,repository:string,tag:string,context?:OperationContext):Promise<GitHubRefRecord>{
    return performGitHubRequest<GitHubRefRecord>(this.#credentialProvider,this.#fetchImpl,{
      method:"GET",path:`/repos/${segment(owner)}/${segment(repository)}/git/ref/tags/${segment(tag)}`,
      mutation:false,
    },context);
  }

  getWorkflowRuns(owner: string, repository: string, workflow: string,
    headSha: string, context?: OperationContext): Promise<GitHubWorkflowRunsRecord> {
    return performGitHubRequest<GitHubWorkflowRunsRecord>(this.#credentialProvider, this.#fetchImpl, {
      method: "GET",
      path: `/repos/${segment(owner)}/${segment(repository)}/actions/workflows/${segment(workflow)}/runs?event=workflow_dispatch&branch=main&head_sha=${segment(headSha)}&per_page=100`,
      mutation: false,
    }, context);
  }

  getTagPushRuns(owner:string,repository:string,headSha:string,
    context?:OperationContext):Promise<GitHubWorkflowRunsRecord> {
    return performGitHubRequest<GitHubWorkflowRunsRecord>(this.#credentialProvider,this.#fetchImpl,{
      method:"GET",
      path:`/repos/${segment(owner)}/${segment(repository)}/actions/workflows/release.yml/runs?event=push&head_sha=${segment(headSha)}&per_page=100`,
      mutation:false,
    },context);
  }

  getWorkflowRun(owner:string,repository:string,runId:number,
    context?:OperationContext):Promise<GitHubWorkflowRunDetail>{
    return performGitHubRequest<GitHubWorkflowRunDetail>(this.#credentialProvider,this.#fetchImpl,{
      method:"GET",
      path:`/repos/${segment(owner)}/${segment(repository)}/actions/runs/${positiveInteger(runId)}`,
      mutation:false,
    },context);
  }

  getReleaseByTag(owner:string,repository:string,tag:string,
    context?:OperationContext):Promise<GitHubPublicReleaseRecord>{
    if(!/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u.test(tag) || tag.length>128)
      throw new AppError("INVALID_ARGUMENT","Invalid release tag.");
    return performGitHubRequest<GitHubPublicReleaseRecord>(
      this.#credentialProvider,this.#fetchImpl,{
        method:"GET",path:`/repos/${segment(owner)}/${segment(repository)}/releases/tags/${segment(tag)}`,
        mutation:false,
      },context);
  }

  async getReleaseAssetChecksum(owner:string,repository:string,assetId:number,
    context?:OperationContext):Promise<string>{
    const data=await this.getReleaseAssetBytes(owner,repository,assetId,512,context);
    return new TextDecoder("utf8",{fatal:true}).decode(data);
  }

  /** Restricted read of a single existing GitHub Release asset; redirects
   * only to GitHub's fixed CDN origin, always dropping Authorization. */
  async getReleaseAssetBytes(owner:string,repository:string,assetId:number,
    maxBytes:number,context?:OperationContext):Promise<Uint8Array>{
    if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8192)
      throw new AppError("INVALID_ARGUMENT","Release proof size limit is invalid.");
    const signal=context?.signal;
    if(signal?.aborted)throw abortSignalError(signal,"GitHub request was cancelled.");
    const credential=await this.#credentialProvider.getCredential(context);
    if(signal?.aborted)throw abortSignalError(signal,"GitHub request was cancelled.");
    const path=`/repos/${segment(owner)}/${segment(repository)}/releases/assets/${positiveInteger(assetId)}`;
    let response:Response;
    try{
      response=await this.#fetchImpl(GITHUB_API_BASE_URL+path,{
        method:"GET",redirect:"manual",cache:"no-store",
        headers:{Accept:"application/octet-stream",
          "X-GitHub-Api-Version":GITHUB_API_VERSION,
          Authorization:`Bearer ${credential.token}`},
        ...(signal===undefined?{}:{signal}),
      });
      if(response.status===302){
        const location=response.headers.get("location");
        await discardBody(response);
        if(!location || location.length>8192)throw new Error("untrusted asset redirect");
        const url=new URL(location);
        if(url.protocol!=="https:" || url.hostname!=="release-assets.githubusercontent.com" ||
          url.username || url.password || (url.port!==""&&url.port!=="443") || url.hash)
          throw new Error("untrusted asset redirect");
        // Signed GitHub asset URLs require NO Authorization header.
        // Never forward the GitHub bearer token across origins.
        response=await this.#fetchImpl(url.href,{method:"GET",
          redirect:"error",cache:"no-store",
          ...(signal===undefined?{}:{signal})});
      }
      if(response.status!==200){
        await discardBody(response);
        throw new Error("asset unavailable");
      }
      if(response.headers.get("content-length") &&
        Number(response.headers.get("content-length"))>maxBytes)
        throw new Error("asset too large");
      if(!response.body)throw new Error("asset response empty");
      const reader=response.body.getReader();let total=0;
      const chunks:Uint8Array[]=[];
      try{
        while(true){
          const chunk=await reader.read();
          if(chunk.done)break;
          total+=chunk.value.byteLength;
          if(total>maxBytes){await reader.cancel();throw new Error("asset too large");}
          chunks.push(chunk.value);
        }
      }finally{reader.releaseLock();}
      const all=new Uint8Array(total);let offset=0;
      for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}
      if(total<1)throw new Error("asset empty");
      return all;
    }catch{
      if(signal?.aborted)throw abortSignalError(signal,"GitHub request was cancelled.");
      throw unavailableError(false);
    }
  }

  async dispatchWorkflow(owner: string, repository: string, workflow: string,
    expectedSha: string, inputs: Record<string, string>, context?: OperationContext): Promise<void> {
    if (!["edge-f09-guarded-rollout.yml","release-tag-bootstrap.yml","release.yml"].includes(workflow)) {
      throw new AppError("INVALID_ARGUMENT", "Workflow dispatch is not allowlisted.");
    }
    const requestInputs = workflow === "release-tag-bootstrap.yml"
      ? {operation_id: inputs.operation_id ?? "",tag: inputs.tag ?? "",expected_sha: expectedSha}
      : workflow === "release.yml"
        ? {operation_id: inputs.operation_id ?? "",tag: inputs.tag ?? "",expected_main_sha: expectedSha,release_mode: "build_publish"}
        : {operation_id: inputs.operation_id ?? "",expected_main_sha: expectedSha};
    await performGitHubRequest<unknown>(this.#credentialProvider, this.#fetchImpl, {
      method: "POST",
      path: `/repos/${segment(owner)}/${segment(repository)}/actions/workflows/${segment(workflow)}/dispatches`,
      body: { ref: "main", inputs: requestInputs },
      mutation: true,
    }, context);
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

  closePullRequest(
    owner: string,
    repository: string,
    pullNumber: number,
    context?: OperationContext,
  ): Promise<GitHubPullRequestRecord> {
    return performGitHubRequest<GitHubPullRequestRecord>(
      this.#credentialProvider,
      this.#fetchImpl,
      {
        method: "PATCH",
        path: `/repos/${segment(owner)}/${segment(repository)}/pulls/${positiveInteger(pullNumber)}`,
        body: { state: "closed" },
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
  method: "GET" | "POST" | "PUT" | "PATCH";
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
    // Never read or reflect a GitHub error body. Only numeric HTTP status and a
    // strictly validated, non-sensitive request correlation ID can be surfaced.
    await discardBody(response);
    if (response.status === 401 || response.status === 403) {
      throw new AppError("AUTHENTICATION_FAILED",
        "GitHub authentication failed " + safeClientErrorDiagnostic(response));
    }
    if (response.status >= 400 && response.status < 500) {
      throw new AppError("INVALID_ARGUMENT",
        "GitHub rejected the typed request " + safeClientErrorDiagnostic(response));
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

function safeClientErrorDiagnostic(response: Response): string {
  const status = response.status;
  // Classification is derived solely from HTTP status, never untrusted text.
  const category = status === 400 ? "bad_request"
    : status === 401 ? "unauthorized"
    : status === 403 ? "forbidden"
    : status === 404 ? "not_found"
    : status === 405 ? "method_not_allowed"
    : status === 409 ? "conflict"
    : status === 422 ? "validation_failed"
    : status === 429 ? "rate_limited"
    : "other_client_error";
  const rawRequestId = response.headers.get("x-github-request-id");
  // GitHub correlation IDs are hexadecimal colon-separated groups. Reject
  // unexpected formats instead of sanitizing and echoing hostile headers.
  const requestId = rawRequestId !== null && rawRequestId.length <= 64 &&
    /^[A-F0-9]{2,12}(?::[A-F0-9]{2,12}){1,5}$/u.test(rawRequestId)
    ? rawRequestId : undefined;
  return `(HTTP ${status}; category=${category}${requestId ? `; requestId=${requestId}` : ""}).`;
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
