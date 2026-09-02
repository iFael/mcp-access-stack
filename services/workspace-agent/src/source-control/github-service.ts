import {
  AppError,
  githubCreatePullRequestInputSchema,
  githubCreatePullRequestResultSchema,
  githubCreateRepositoryInputSchema,
  githubCreateRepositoryResultSchema,
  githubGetPullRequestInputSchema,
  githubGetRepositoryInputSchema,
  githubMergePullRequestInputSchema,
  githubMergePullRequestResultSchema,
  githubPullRequestResultSchema,
  githubRepositoryResultSchema,
  type GitHubCreatePullRequestInput,
  type GitHubCreatePullRequestResult,
  type GitHubCreateRepositoryInput,
  type GitHubCreateRepositoryResult,
  type GitHubExecutor,
  type GitHubGetPullRequestInput,
  type GitHubGetRepositoryInput,
  type GitHubMergePullRequestInput,
  type GitHubMergePullRequestResult,
  type GitHubPullRequestResult,
  type GitHubRepositoryResult,
  type OperationContext,
} from "@vs-code-gpt/shared";
import type {
  GitHubApiClient,
  GitHubCreatePullRequestRequest,
  GitHubCreateRepositoryRequest,
  GitHubMergePullRequestRequest,
} from "./github-http-client.js";

export class GitHubService implements GitHubExecutor {
  constructor(private readonly client: GitHubApiClient) {}

  async getRepository(
    input: GitHubGetRepositoryInput,
    context?: OperationContext,
  ): Promise<GitHubRepositoryResult> {
    const parsed = githubGetRepositoryInputSchema.parse(input);
    const operationContext = context ?? {};
    const raw = await this.client.getRepository(
      parsed.owner,
      parsed.repository,
      operationContext,
    );
    return mapRepository(raw);
  }

  async createRepository(
    input: GitHubCreateRepositoryInput,
    context?: OperationContext,
  ): Promise<GitHubCreateRepositoryResult> {
    const parsed = githubCreateRepositoryInputSchema.parse(input);
    const operationContext = context ?? {};
    const currentUser = await this.client.getCurrentUser(operationContext);
    const currentLogin = readStringField(currentUser, "login");
    const request: GitHubCreateRepositoryRequest = {
      name: parsed.name,
      private: parsed.visibility === "private",
      visibility: parsed.visibility,
      ...(parsed.description === undefined ? {} : { description: parsed.description }),
    };

    try {
      const raw = sameName(currentLogin, parsed.owner)
        ? await this.client.createUserRepository(request, operationContext)
        : await this.client.createOrganizationRepository(
            parsed.owner,
            request,
            operationContext,
          );
      return mapCreatedRepository(raw);
    } catch (error) {
      if (!isAmbiguousMutation(error)) throw error;
      return this.reconcileRepositoryCreation(
        parsed.owner,
        parsed.name,
        parsed.visibility,
        operationContext,
      );
    }
  }

  async getPullRequest(
    input: GitHubGetPullRequestInput,
    context?: OperationContext,
  ): Promise<GitHubPullRequestResult> {
    const parsed = githubGetPullRequestInputSchema.parse(input);
    const operationContext = context ?? {};
    const raw = await this.client.getPullRequest(
      parsed.owner,
      parsed.repository,
      parsed.pullNumber,
      operationContext,
    );
    return mapPullRequest(raw);
  }

  async createPullRequest(
    input: GitHubCreatePullRequestInput,
    context?: OperationContext,
  ): Promise<GitHubCreatePullRequestResult> {
    const parsed = githubCreatePullRequestInputSchema.parse(input);
    const operationContext = context ?? {};
    const request: GitHubCreatePullRequestRequest = {
      title: parsed.title,
      head: parsed.head,
      base: parsed.base,
      ...(parsed.body === undefined ? {} : { body: parsed.body }),
      draft: parsed.draft,
    };
    try {
      const raw = await this.client.createPullRequest(
        parsed.owner,
        parsed.repository,
        request,
        operationContext,
      );
      return mapCreatedPullRequest(raw);
    } catch (error) {
      if (!isAmbiguousMutation(error)) throw error;
      return this.reconcilePullRequestCreation(
        parsed.owner,
        parsed.repository,
        parsed.head,
        parsed.base,
        operationContext,
      );
    }
  }

  async mergePullRequest(
    input: GitHubMergePullRequestInput,
    context?: OperationContext,
  ): Promise<GitHubMergePullRequestResult> {
    const parsed = githubMergePullRequestInputSchema.parse(input);
    const operationContext = context ?? {};
    const beforeRaw = await this.client.getPullRequest(
      parsed.owner,
      parsed.repository,
      parsed.pullNumber,
      operationContext,
    );
    const before = mapPullRequest(beforeRaw);
    if (before.headSha !== parsed.expectedPullRequestHeadSha) {
      throw new AppError(
        "GIT_HEAD_MISMATCH",
        "GitHub pull-request head changed before merge.",
      );
    }
    const request: GitHubMergePullRequestRequest = {
      sha: parsed.expectedPullRequestHeadSha,
      merge_method: parsed.mergeMethod,
    };
    try {
      const raw = await this.client.mergePullRequest(
        parsed.owner,
        parsed.repository,
        parsed.pullNumber,
        request,
        operationContext,
      );
      return mapMergeResult(parsed.pullNumber, raw);
    } catch (error) {
      if (!isAmbiguousMutation(error)) throw error;
      return this.reconcileMerge(
        parsed.owner,
        parsed.repository,
        parsed.pullNumber,
        operationContext,
      );
    }
  }

  private async reconcileRepositoryCreation(
    owner: string,
    repository: string,
    visibility: "private" | "public" | "internal",
    context: OperationContext,
  ): Promise<GitHubCreateRepositoryResult> {
    try {
      const raw = await this.client.getRepository(owner, repository, context);
      const mapped = mapRepository(raw);
      if (mapped.visibility !== visibility) throw reconciliationRequired();
      return parseCreateRepositoryResult({ status: "completed", ...mapped });
    } catch (error) {
      if (error instanceof AppError && error.code === "SOURCE_CONTROL_RECONCILIATION_REQUIRED") {
        throw error;
      }
      throw reconciliationRequired();
    }
  }

  private async reconcilePullRequestCreation(
    owner: string,
    repository: string,
    head: string,
    base: string,
    context: OperationContext,
  ): Promise<GitHubCreatePullRequestResult> {
    let matches: unknown[];
    try {
      matches = await this.client.findPullRequests(
        owner,
        repository,
        head,
        base,
        context,
      );
    } catch {
      throw reconciliationRequired();
    }
    if (matches.length !== 1) throw reconciliationRequired();
    return mapCreatedPullRequest(matches[0]);
  }

  private async reconcileMerge(
    owner: string,
    repository: string,
    pullNumber: number,
    context: OperationContext,
  ): Promise<GitHubMergePullRequestResult> {
    let raw: unknown;
    try {
      raw = await this.client.getPullRequest(owner, repository, pullNumber, context);
    } catch {
      throw reconciliationRequired();
    }
    const record = readObject(raw);
    if (record.merged !== true) throw reconciliationRequired();
    const mergeSha = record.merge_commit_sha;
    if (typeof mergeSha !== "string") throw reconciliationRequired();
    return parseMergeResult({
      status: "completed",
      number: pullNumber,
      merged: true,
      mergeSha,
    });
  }
}

function mapRepository(raw: unknown): GitHubRepositoryResult {
  const record = readObject(raw);
  const owner = readObject(record.owner);
  const candidate = {
    owner: readStringField(owner, "login"),
    name: readStringField(record, "name"),
    fullName: readStringField(record, "full_name"),
    defaultBranch: readStringField(record, "default_branch"),
    visibility: readStringField(record, "visibility"),
    url: readStringField(record, "html_url"),
  };
  const parsed = githubRepositoryResultSchema.safeParse(candidate);
  if (!parsed.success) throw invalidGitHubResponse();
  return parsed.data;
}

function mapCreatedRepository(raw: unknown): GitHubCreateRepositoryResult {
  return parseCreateRepositoryResult({ status: "completed", ...mapRepository(raw) });
}

function parseCreateRepositoryResult(value: unknown): GitHubCreateRepositoryResult {
  const parsed = githubCreateRepositoryResultSchema.safeParse(value);
  if (!parsed.success) throw invalidGitHubResponse();
  return parsed.data;
}

function mapPullRequest(raw: unknown): GitHubPullRequestResult {
  const record = readObject(raw);
  const head = readObject(record.head);
  const base = readObject(record.base);
  const candidate = {
    number: record.number,
    state: record.state,
    title: record.title,
    url: record.html_url,
    headSha: head.sha,
    baseSha: base.sha,
    merged: record.merged,
  };
  const parsed = githubPullRequestResultSchema.safeParse(candidate);
  if (!parsed.success) throw invalidGitHubResponse();
  return parsed.data;
}

function mapCreatedPullRequest(raw: unknown): GitHubCreatePullRequestResult {
  const parsed = githubCreatePullRequestResultSchema.safeParse({
    status: "completed",
    ...mapPullRequest(raw),
  });
  if (!parsed.success) throw invalidGitHubResponse();
  return parsed.data;
}

function mapMergeResult(
  pullNumber: number,
  raw: unknown,
): GitHubMergePullRequestResult {
  const record = readObject(raw);
  return parseMergeResult({
    status: "completed",
    number: pullNumber,
    merged: record.merged,
    mergeSha: record.sha,
  });
}

function parseMergeResult(value: unknown): GitHubMergePullRequestResult {
  const parsed = githubMergePullRequestResultSchema.safeParse(value);
  if (!parsed.success) throw invalidGitHubResponse();
  return parsed.data;
}

function readObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidGitHubResponse();
  }
  return value as Record<string, unknown>;
}

function readStringField(record: unknown, field: string): string {
  const value = readObject(record)[field];
  if (typeof value !== "string") throw invalidGitHubResponse();
  return value;
}

function sameName(left: string, right: string): boolean {
  return left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function isAmbiguousMutation(error: unknown): boolean {
  return error instanceof AppError && error.details?.outcome === "unknown";
}

function reconciliationRequired(): AppError {
  return new AppError(
    "SOURCE_CONTROL_RECONCILIATION_REQUIRED",
    "GitHub mutation outcome requires reconciliation.",
  );
}

function invalidGitHubResponse(): AppError {
  return new AppError("INTERNAL_ERROR", "GitHub returned an invalid response.");
}
