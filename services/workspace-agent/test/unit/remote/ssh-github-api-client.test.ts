import { describe, expect, it, jest } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import {
  SshGitHubApiClient,
  type SshGitHubApiTransport,
} from "../../../src/remote/ssh-github-api-client.js";
import type {
  RemoteGitHubApiRequest,
  RemoteGitHubApiResult,
} from "../../../src/remote/ssh-windows-transport.js";

function ok(value: unknown): RemoteGitHubApiResult {
  return {
    statusCode: 200,
    body: JSON.stringify(value),
    authenticationFailed: false,
  };
}

class FakeGitHubTransport implements SshGitHubApiTransport {
  readonly calls: Array<{
    rootPath: string;
    request: RemoteGitHubApiRequest;
  }> = [];
  readonly results: Array<RemoteGitHubApiResult | Error> = [];

  async githubApi(
    rootPath: string,
    request: RemoteGitHubApiRequest,
  ): Promise<RemoteGitHubApiResult> {
    this.calls.push({ rootPath, request });
    const next = this.results.shift();
    if (next instanceof Error) throw next;
    return next ?? ok({});
  }
}

describe("SshGitHubApiClient", () => {
  it("uses only fixed typed GitHub endpoints and JSON bodies", async () => {
    const transport = new FakeGitHubTransport();
    transport.results.push(
      ok({ login: "octo" }),
      ok({}),
      ok({}),
      ok({ total_count: 0, check_runs: [] }),
      ok({}),
      ok({}),
      ok([]),
      ok({}),
      ok({}),
    );
    const client = new SshGitHubApiClient({
      transport,
      rootPath: "C:\\workspace",
    });

    await client.getCurrentUser();
    await client.getRepository("octo", "repo");
    await client.getCommitCheckRuns("octo", "repo", "a".repeat(40));
    await client.createUserRepository({
      name: "repo",
      private: true,
      visibility: "private",
      description: "typed",
    });
    await client.createOrganizationRepository("octo-org", {
      name: "repo",
      private: false,
      visibility: "public",
    });
    await client.getPullRequest("octo", "repo", 7);
    await client.findPullRequests(
      "octo",
      "repo",
      "octo:feature/task",
      "main",
    );
    await client.createPullRequest("octo", "repo", {
      title: "Feature",
      head: "octo:feature/task",
      base: "main",
      body: "body",
      draft: true,
    });
    await client.mergePullRequest("octo", "repo", 7, {
      sha: "a".repeat(40),
      merge_method: "squash",
    });

    expect(transport.calls.map((entry) => entry.request)).toEqual([
      { method: "GET", path: "/user" },
      { method: "GET", path: "/repos/octo/repo" },
      { method: "GET", path: `/repos/octo/repo/commits/${"a".repeat(40)}/check-runs?per_page=100` },
      {
        method: "POST",
        path: "/user/repos",
        bodyJson: JSON.stringify({
          name: "repo",
          private: true,
          visibility: "private",
          description: "typed",
        }),
      },
      {
        method: "POST",
        path: "/orgs/octo-org/repos",
        bodyJson: JSON.stringify({
          name: "repo",
          private: false,
          visibility: "public",
        }),
      },
      { method: "GET", path: "/repos/octo/repo/pulls/7" },
      {
        method: "GET",
        path:
          "/repos/octo/repo/pulls?state=open&head=octo%3Afeature%2Ftask&base=main",
      },
      {
        method: "POST",
        path: "/repos/octo/repo/pulls",
        bodyJson: JSON.stringify({
          title: "Feature",
          head: "octo:feature/task",
          base: "main",
          body: "body",
          draft: true,
        }),
      },
      {
        method: "PUT",
        path: "/repos/octo/repo/pulls/7/merge",
        bodyJson: JSON.stringify({
          sha: "a".repeat(40),
          merge_method: "squash",
        }),
      },
    ]);
    expect(transport.calls.every((entry) => entry.rootPath === "C:\\workspace")).toBe(true);
  });

  it("maps remote authentication and deterministic validation failures", async () => {
    const transport = new FakeGitHubTransport();
    transport.results.push(
      { statusCode: 0, body: "", authenticationFailed: true },
      { statusCode: 422, body: "", authenticationFailed: false },
    );
    const client = new SshGitHubApiClient({
      transport,
      rootPath: "C:\\workspace",
    });

    await expect(client.getCurrentUser()).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
    });
    await expect(
      client.createUserRepository({ name: "repo", private: true }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("marks transport and 5xx mutation failures as ambiguous without leaking causes", async () => {
    const transport = new FakeGitHubTransport();
    transport.results.push(
      new Error("remote secret diagnostic"),
      { statusCode: 503, body: "", authenticationFailed: false },
    );
    const client = new SshGitHubApiClient({
      transport,
      rootPath: "C:\\workspace",
    });

    let first: unknown;
    try {
      await client.createUserRepository({ name: "repo", private: true });
    } catch (error) {
      first = error;
    }
    expect(first).toMatchObject({
      code: "AGENT_UNAVAILABLE",
      details: { outcome: "unknown" },
    });
    expect(JSON.stringify(first)).not.toContain("remote secret diagnostic");

    await expect(
      client.mergePullRequest("octo", "repo", 7, {
        sha: "a".repeat(40),
        merge_method: "merge",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      details: { outcome: "unknown" },
    });
  });

  it("marks read transport failures retryable and preserves cancellation", async () => {
    const transport = new FakeGitHubTransport();
    transport.results.push(
      new Error("network"),
      new AppError("OPERATION_CANCELLED", "cancelled"),
    );
    const client = new SshGitHubApiClient({
      transport,
      rootPath: "C:\\workspace",
    });

    await expect(client.getRepository("octo", "repo")).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      details: { retryable: true, outcome: "not_started" },
    });
    await expect(client.getRepository("octo", "repo")).rejects.toMatchObject({
      code: "OPERATION_CANCELLED",
    });
  });

  it("rejects invalid successful JSON without exposing the raw body", async () => {
    const transport = new FakeGitHubTransport();
    transport.results.push({
      statusCode: 200,
      body: "{not-json secret-value",
      authenticationFailed: false,
    });
    const client = new SshGitHubApiClient({
      transport,
      rootPath: "C:\\workspace",
    });

    let captured: unknown;
    try {
      await client.getRepository("octo", "repo");
    } catch (error) {
      captured = error;
    }
    expect(captured).toMatchObject({ code: "INTERNAL_ERROR" });
    expect(JSON.stringify(captured)).not.toContain("secret-value");
  });
});
