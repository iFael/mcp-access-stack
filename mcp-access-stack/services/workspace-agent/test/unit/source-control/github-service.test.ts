import { describe, expect, it, jest } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import type { GitHubApiClient } from "../../../src/source-control/github-http-client.js";
import { GitHubService } from "../../../src/source-control/github-service.js";

const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const mergeSha = "c".repeat(40);

function repositoryRecord(overrides: Record<string, unknown> = {}) {
  return {
    owner: { login: "octo" },
    name: "repo",
    full_name: "octo/repo",
    default_branch: "main",
    visibility: "private",
    html_url: "https://github.com/octo/repo",
    ...overrides,
  };
}

function pullRequestRecord(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    state: "open",
    title: "Typed PR",
    html_url: "https://github.com/octo/repo/pull/7",
    head: { sha: headSha },
    base: { sha: baseSha },
    merged: false,
    merge_commit_sha: null,
    ...overrides,
  };
}

function ambiguousError(): AppError {
  return new AppError("AGENT_UNAVAILABLE", "GitHub mutation outcome is unknown.", {
    details: { outcome: "unknown" },
  });
}

function client(overrides: Partial<GitHubApiClient> = {}): GitHubApiClient {
  return {
    getCurrentUser: jest.fn(async () => ({ login: "octo" })),
    getRepository: jest.fn(async () => repositoryRecord()),
    createUserRepository: jest.fn(async () => repositoryRecord()),
    createOrganizationRepository: jest.fn(async () => repositoryRecord()),
    getPullRequest: jest.fn(async () => pullRequestRecord()),
    findPullRequests: jest.fn(async () => [pullRequestRecord()]),
    createPullRequest: jest.fn(async () => pullRequestRecord()),
    mergePullRequest: jest.fn(async () => ({ sha: mergeSha, merged: true, message: "merged" })),
    ...overrides,
  } as GitHubApiClient;
}

describe("GitHubService read mapping", () => {
  it("maps repository and pull-request reads into exact Task 1 result shapes", async () => {
    const api = client();
    const service = new GitHubService(api);

    await expect(
      service.getRepository({ workspaceId: "repo", owner: "octo", repository: "repo" }),
    ).resolves.toEqual({
      owner: "octo",
      name: "repo",
      fullName: "octo/repo",
      defaultBranch: "main",
      visibility: "private",
      url: "https://github.com/octo/repo",
    });
    await expect(
      service.getPullRequest({
        workspaceId: "repo",
        owner: "octo",
        repository: "repo",
        pullNumber: 7,
      }),
    ).resolves.toEqual({
      number: 7,
      state: "open",
      title: "Typed PR",
      url: "https://github.com/octo/repo/pull/7",
      headSha,
      baseSha,
      merged: false,
    });
  });
});

describe("GitHubService repository creation", () => {
  it("reconciles an ambiguous personal repository creation with repository lookup", async () => {
    const createUserRepository = jest.fn(async () => {
      throw ambiguousError();
    });
    const getRepository = jest.fn(async () => repositoryRecord());
    const api = client({ createUserRepository, getRepository });
    const service = new GitHubService(api);

    await expect(
      service.createRepository({
        workspaceId: "repo",
        owner: "octo",
        name: "repo",
        visibility: "private",
        description: "typed repo",
      }),
    ).resolves.toEqual({
      status: "completed",
      owner: "octo",
      name: "repo",
      fullName: "octo/repo",
      defaultBranch: "main",
      visibility: "private",
      url: "https://github.com/octo/repo",
    });
    expect(createUserRepository).toHaveBeenCalledWith({
      name: "repo",
      private: true,
      description: "typed repo",
      visibility: "private",
    }, expect.anything());
    expect(getRepository).toHaveBeenCalledWith("octo", "repo", expect.anything());
  });

  it("uses the fixed organization repository path when owner differs from current user", async () => {
    const createOrganizationRepository = jest.fn(async () =>
      repositoryRecord({ owner: { login: "octo-org" }, full_name: "octo-org/repo" }),
    );
    const createUserRepository = jest.fn();
    const api = client({
      getCurrentUser: jest.fn(async () => ({ login: "octo" })),
      createOrganizationRepository,
      createUserRepository,
    });
    const service = new GitHubService(api);

    const result = await service.createRepository({
      workspaceId: "repo",
      owner: "octo-org",
      name: "repo",
      visibility: "public",
    });

    expect(result).toMatchObject({ status: "completed", owner: "octo-org", visibility: "private" });
    expect(createUserRepository).not.toHaveBeenCalled();
    expect(createOrganizationRepository).toHaveBeenCalledWith(
      "octo-org",
      expect.objectContaining({ name: "repo", private: false, visibility: "public" }),
      expect.anything(),
    );
  });
});

describe("GitHubService pull request creation", () => {
  it("reconciles ambiguous PR creation by exact head/base query", async () => {
    const createPullRequest = jest.fn(async () => {
      throw ambiguousError();
    });
    const findPullRequests = jest.fn(async () => [pullRequestRecord()]);
    const api = client({ createPullRequest, findPullRequests });
    const service = new GitHubService(api);

    const result = await service.createPullRequest({
      workspaceId: "repo",
      owner: "octo",
      repository: "repo",
      title: "Typed PR",
      head: "octo:feature/task5",
      base: "main",
      body: "body",
      draft: false,
    });

    expect(result).toMatchObject({ status: "completed", number: 7, headSha, baseSha });
    expect(findPullRequests).toHaveBeenCalledWith(
      "octo",
      "repo",
      "octo:feature/task5",
      "main",
      expect.anything(),
    );
  });

  it("does not reconcile deterministic validation failures", async () => {
    const createPullRequest = jest.fn(async () => {
      throw new AppError("INVALID_ARGUMENT", "GitHub rejected the request.");
    });
    const findPullRequests = jest.fn();
    const service = new GitHubService(client({ createPullRequest, findPullRequests }));

    await expect(
      service.createPullRequest({
        workspaceId: "repo",
        owner: "octo",
        repository: "repo",
        title: "Typed PR",
        head: "feature/task5",
        base: "main",
      }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(findPullRequests).not.toHaveBeenCalled();
  });
});

describe("GitHubService pull request merge", () => {
  it("re-reads PR head before mutation and sends exact expected sha + merge_method", async () => {
    const mergePullRequest = jest.fn(async () => ({ sha: mergeSha, merged: true, message: "merged" }));
    const api = client({ mergePullRequest });
    const service = new GitHubService(api);

    const result = await service.mergePullRequest({
      workspaceId: "repo",
      owner: "octo",
      repository: "repo",
      pullNumber: 7,
      expectedPullRequestHeadSha: headSha,
      mergeMethod: "squash",
    });

    expect(result).toEqual({ status: "completed", number: 7, merged: true, mergeSha });
    expect(mergePullRequest).toHaveBeenCalledWith(
      "octo",
      "repo",
      7,
      { sha: headSha, merge_method: "squash" },
      expect.anything(),
    );
  });

  it("fails before merge when the PR head changed", async () => {
    const mergePullRequest = jest.fn();
    const api = client({
      getPullRequest: jest.fn(async () =>
        pullRequestRecord({ head: { sha: "d".repeat(40) } }),
      ),
      mergePullRequest,
    });
    const service = new GitHubService(api);

    await expect(
      service.mergePullRequest({
        workspaceId: "repo",
        owner: "octo",
        repository: "repo",
        pullNumber: 7,
        expectedPullRequestHeadSha: headSha,
        mergeMethod: "merge",
      }),
    ).rejects.toMatchObject({ code: "GIT_HEAD_MISMATCH" });
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("reconciles ambiguous merge by re-reading merged PR state and merge SHA", async () => {
    const getPullRequest = jest
      .fn()
      .mockResolvedValueOnce(pullRequestRecord())
      .mockResolvedValueOnce(
        pullRequestRecord({
          state: "closed",
          merged: true,
          merge_commit_sha: mergeSha,
        }),
      );
    const mergePullRequest = jest.fn(async () => {
      throw ambiguousError();
    });
    const service = new GitHubService(client({ getPullRequest, mergePullRequest }));

    await expect(
      service.mergePullRequest({
        workspaceId: "repo",
        owner: "octo",
        repository: "repo",
        pullNumber: 7,
        expectedPullRequestHeadSha: headSha,
        mergeMethod: "merge",
      }),
    ).resolves.toEqual({ status: "completed", number: 7, merged: true, mergeSha });
    expect(getPullRequest).toHaveBeenCalledTimes(2);
  });
});
