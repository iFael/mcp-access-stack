import { describe, expect, it, jest } from "@jest/globals";
import type { GitHubCredentialProvider } from "../../../src/source-control/github-credential-provider.js";
import { GitHubHttpClient } from "../../../src/source-control/github-http-client.js";

const credentialProvider: GitHubCredentialProvider = {
  async getCredential() {
    return { token: "unit-test-token", source: "gh-cli-user" };
  },
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestOf(fetchImpl: ReturnType<typeof jest.fn>, index = 0): {
  url: string;
  init: RequestInit;
} {
  const [url, init] = fetchImpl.mock.calls[index]! as [string, RequestInit];
  return { url, init };
}

describe("GitHubHttpClient fixed transport", () => {
  it("builds only the fixed GitHub API endpoints, methods and headers", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ ok: true }));
    const client = new GitHubHttpClient({ credentialProvider, fetchImpl: fetchImpl as typeof fetch });

    await client.getCurrentUser();
    await client.getRepository("octo", "repo");
    await client.createUserRepository({ name: "repo", private: true });
    await client.createOrganizationRepository("octo-org", { name: "repo", private: false });
    await client.getPullRequest("octo", "repo", 7);
    await client.createPullRequest("octo", "repo", {
      title: "Title",
      head: "octo:feature/task5",
      base: "main",
      body: "body",
      draft: false,
    });
    await client.mergePullRequest("octo", "repo", 7, {
      sha: "a".repeat(40),
      merge_method: "squash",
    });
    await client.findPullRequests("octo", "repo", "octo:feature/task5", "main");

    const expected = [
      ["https://api.github.com/user", "GET"],
      ["https://api.github.com/repos/octo/repo", "GET"],
      ["https://api.github.com/user/repos", "POST"],
      ["https://api.github.com/orgs/octo-org/repos", "POST"],
      ["https://api.github.com/repos/octo/repo/pulls/7", "GET"],
      ["https://api.github.com/repos/octo/repo/pulls", "POST"],
      ["https://api.github.com/repos/octo/repo/pulls/7/merge", "PUT"],
      [
        "https://api.github.com/repos/octo/repo/pulls?state=open&head=octo%3Afeature%2Ftask5&base=main",
        "GET",
      ],
    ] as const;

    expect(fetchImpl).toHaveBeenCalledTimes(expected.length);
    expected.forEach(([url, method], index) => {
      const request = requestOf(fetchImpl, index);
      expect(request.url).toBe(url);
      expect(request.init.method).toBe(method);
      expect(request.init.headers).toMatchObject({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: "Bearer unit-test-token",
      });
    });
    expect("request" in client).toBe(false);
    expect("fetch" in client).toBe(false);
  });

  it("sends exact fixed JSON bodies for repository, PR and merge mutations", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ ok: true }));
    const client = new GitHubHttpClient({ credentialProvider, fetchImpl: fetchImpl as typeof fetch });

    await client.createUserRepository({
      name: "repo",
      private: true,
      description: "description",
    });
    await client.createPullRequest("octo", "repo", {
      title: "Title",
      head: "octo:feature/task5",
      base: "main",
      body: "body",
      draft: true,
    });
    await client.mergePullRequest("octo", "repo", 7, {
      sha: "b".repeat(40),
      merge_method: "merge",
    });

    expect(JSON.parse(String(requestOf(fetchImpl, 0).init.body))).toEqual({
      name: "repo",
      private: true,
      description: "description",
    });
    expect(JSON.parse(String(requestOf(fetchImpl, 1).init.body))).toEqual({
      title: "Title",
      head: "octo:feature/task5",
      base: "main",
      body: "body",
      draft: true,
    });
    expect(JSON.parse(String(requestOf(fetchImpl, 2).init.body))).toEqual({
      sha: "b".repeat(40),
      merge_method: "merge",
    });
  });

  it("classifies deterministic 4xx without retryable ambiguity and hides raw response bodies", async () => {
    const fetchImpl = jest.fn(async () =>
      new Response("raw validation body unit-test-token", { status: 422 }),
    );
    const client = new GitHubHttpClient({ credentialProvider, fetchImpl: fetchImpl as typeof fetch });

    let captured: unknown;
    try {
      await client.createPullRequest("octo", "repo", {
        title: "Title",
        head: "feature/task5",
        base: "main",
        draft: false,
      });
    } catch (error) {
      captured = error;
    }

    expect(captured).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect((captured as { details?: unknown }).details).toBeUndefined();
    expect(JSON.stringify(captured)).not.toContain("raw validation body");
    expect(JSON.stringify(captured)).not.toContain("unit-test-token");
  });

  it("marks transport/5xx mutation failures as ambiguous and hides raw causes/bodies", async () => {
    const thrownFetch = jest.fn(async () => {
      throw new Error("raw fetch failure unit-test-token");
    });
    const transportClient = new GitHubHttpClient({
      credentialProvider,
      fetchImpl: thrownFetch as typeof fetch,
    });

    await expect(
      transportClient.createUserRepository({ name: "repo", private: true }),
    ).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      details: { outcome: "unknown" },
    });

    const serverFetch = jest.fn(async () =>
      new Response("raw server body unit-test-token", { status: 503 }),
    );
    const serverClient = new GitHubHttpClient({
      credentialProvider,
      fetchImpl: serverFetch as typeof fetch,
    });
    let captured: unknown;
    try {
      await serverClient.mergePullRequest("octo", "repo", 7, {
        sha: "a".repeat(40),
        merge_method: "squash",
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({
      code: "AGENT_UNAVAILABLE",
      details: { outcome: "unknown" },
    });
    expect(JSON.stringify(captured)).not.toContain("raw server body");
    expect(JSON.stringify(captured)).not.toContain("unit-test-token");
    expect((captured as Error & { cause?: unknown }).cause).toBeUndefined();
  });
});
