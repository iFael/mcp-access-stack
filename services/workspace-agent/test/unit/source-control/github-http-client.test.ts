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
  it("looks up one immutable lightweight tag through the fixed GitHub tag-ref endpoint",async()=>{
    const fetchImpl=jest.fn(async()=>jsonResponse({
      ref:"refs/tags/v1.1.0-beta.90",object:{sha:"a".repeat(40),type:"commit"},
    }));
    const client=new GitHubHttpClient({credentialProvider,fetchImpl:fetchImpl as typeof fetch});
    const observed=await client.getTagRef("octo","repo","v1.1.0-beta.90");
    expect(observed.object.sha).toBe("a".repeat(40));
    expect(requestOf(fetchImpl).url).toBe(
      "https://api.github.com/repos/octo/repo/git/ref/tags/v1.1.0-beta.90");
  });

  it("queries tag-push release runs without an implicit dispatch",async()=>{
    const fetchImpl=jest.fn(async()=>jsonResponse({total_count:0,workflow_runs:[]}));
    const client=new GitHubHttpClient({credentialProvider,fetchImpl:fetchImpl as typeof fetch});
    const observed=await client.getTagPushRuns("octo","repo","a".repeat(40));
    expect(observed.total_count).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(requestOf(fetchImpl).url).toBe(
      `https://api.github.com/repos/octo/repo/actions/workflows/release.yml/runs?event=push&head_sha=${"a".repeat(40)}&per_page=100`);
    expect(requestOf(fetchImpl).init.method).toBe("GET");
  });

  it("dispatches the existing release-tag bootstrap with only tag, expected_sha and operation_id",async()=>{
    const fetchImpl=jest.fn(async()=>new Response(null,{status:204}));
    const client=new GitHubHttpClient({credentialProvider,fetchImpl:fetchImpl as typeof fetch});
    await client.dispatchWorkflow("octo","repo","release-tag-bootstrap.yml","a".repeat(40),{
      operation_id:"11111111-2222-4333-8444-555555555555",
      tag:"v1.1.0-beta.90",
      unrelated:"must-not-forward",
    });
    expect(requestOf(fetchImpl).url).toBe(
      "https://api.github.com/repos/octo/repo/actions/workflows/release-tag-bootstrap.yml/dispatches");
    expect(JSON.parse(String(requestOf(fetchImpl).init.body))).toEqual({
      ref:"main",inputs:{operation_id:"11111111-2222-4333-8444-555555555555",
        tag:"v1.1.0-beta.90",expected_sha:"a".repeat(40)},
    });
    await client.dispatchWorkflow("octo","repo","release.yml","a".repeat(40),{
      operation_id:"11111111-2222-4333-8444-555555555555",
      tag:"v1.1.0-beta.90",unrelated:"must-not-forward",
    });
    expect(requestOf(fetchImpl,1).url).toBe(
      "https://api.github.com/repos/octo/repo/actions/workflows/release.yml/dispatches");
    expect(JSON.parse(String(requestOf(fetchImpl,1).init.body))).toEqual({
      ref:"main",inputs:{operation_id:"11111111-2222-4333-8444-555555555555",
        tag:"v1.1.0-beta.90",expected_main_sha:"a".repeat(40),release_mode:"build_publish"},
    });
    await expect(client.dispatchWorkflow("octo","repo","unsafe-workflow.yml","a".repeat(40),{}))
      .rejects.toThrow("not allowlisted");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses fixed workflow endpoints and sends only pinned main/operation inputs", async () => {
    const fetchImpl=jest.fn(async (_url:string, init:RequestInit) =>
      init.method==="POST" ? new Response(null,{status:204})
        : jsonResponse({ref:"refs/heads/main",object:{sha:"a".repeat(40),type:"commit"}}));
    const client=new GitHubHttpClient({credentialProvider,fetchImpl:fetchImpl as typeof fetch});
    await client.getMainRef("octo","app");
    await client.getWorkflowRuns("octo","app","edge-f09-guarded-rollout.yml","a".repeat(40));
    await client.dispatchWorkflow("octo","app","edge-f09-guarded-rollout.yml",
      "a".repeat(40),{operation_id:"11111111-2222-4333-8444-555555555555"});
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(requestOf(fetchImpl,0).url).toBe("https://api.github.com/repos/octo/app/git/ref/heads/main");
    expect(requestOf(fetchImpl,1).url).toBe(
      `https://api.github.com/repos/octo/app/actions/workflows/edge-f09-guarded-rollout.yml/runs?event=workflow_dispatch&branch=main&head_sha=${"a".repeat(40)}&per_page=100`);
    expect(requestOf(fetchImpl,2).url).toBe(
      "https://api.github.com/repos/octo/app/actions/workflows/edge-f09-guarded-rollout.yml/dispatches");
    expect(JSON.parse(String(requestOf(fetchImpl,2).init.body))).toEqual({
      ref:"main",inputs:{operation_id:"11111111-2222-4333-8444-555555555555",
        expected_main_sha:"a".repeat(40)},
    });
  });

  it("dispatches the Edge catalog workflows with only main, operation and stage run inputs", async () => {
    const fetchImpl=jest.fn(async()=>new Response(null,{status:204}));
    const client=new GitHubHttpClient({credentialProvider,fetchImpl:fetchImpl as typeof fetch});
    const op="11111111-2222-4333-8444-555555555555";
    await client.dispatchWorkflow("octo","app","edge-cas-candidate-stage.yml","a".repeat(40),
      {operation_id:op,stage_run_id:"123",expected_active_deployment_id:"must-not-forward"});
    await client.dispatchWorkflow("octo","app","edge-catalog-activate.yml","a".repeat(40),
      {operation_id:op,stage_run_id:"40033066092",expected_active_version_id:"must-not-forward"});
    await client.dispatchWorkflow("octo","app","edge-catalog-recover-prepare.yml","a".repeat(40),{operation_id:op});
    expect(requestOf(fetchImpl,0).url).toBe(
      "https://api.github.com/repos/octo/app/actions/workflows/edge-cas-candidate-stage.yml/dispatches");
    expect(JSON.parse(String(requestOf(fetchImpl,0).init.body)).inputs).toEqual({
      operation_id:op,expected_main_sha:"a".repeat(40)});
    expect(JSON.parse(String(requestOf(fetchImpl,1).init.body)).inputs).toEqual({
      operation_id:op,expected_main_sha:"a".repeat(40),stage_run_id:"40033066092"});
    expect(JSON.parse(String(requestOf(fetchImpl,2).init.body)).inputs).toEqual({
      operation_id:op,expected_main_sha:"a".repeat(40)});
  });

  it("builds only the fixed GitHub API endpoints, methods and headers", async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ ok: true }));
    const client = new GitHubHttpClient({ credentialProvider, fetchImpl: fetchImpl as typeof fetch });

    await client.getCurrentUser();
    await client.getRepository("octo", "repo");
    await client.getCommitCheckRuns("octo", "repo", "a".repeat(40));
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
    await client.closePullRequest("octo", "repo", 7);
    await client.mergePullRequest("octo", "repo", 7, {
      sha: "a".repeat(40),
      merge_method: "squash",
    });
    await client.findPullRequests("octo", "repo", "octo:feature/task5", "main");

    const expected = [
      ["https://api.github.com/user", "GET"],
      ["https://api.github.com/repos/octo/repo", "GET"],
      [`https://api.github.com/repos/octo/repo/commits/${"a".repeat(40)}/check-runs?per_page=100`, "GET"],
      ["https://api.github.com/user/repos", "POST"],
      ["https://api.github.com/orgs/octo-org/repos", "POST"],
      ["https://api.github.com/repos/octo/repo/pulls/7", "GET"],
      ["https://api.github.com/repos/octo/repo/pulls", "POST"],
      ["https://api.github.com/repos/octo/repo/pulls/7", "PATCH"],
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

  it("sends exact fixed JSON bodies for repository, PR close and merge mutations", async () => {
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
    await client.closePullRequest("octo", "repo", 7);
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
    expect(JSON.parse(String(requestOf(fetchImpl, 2).init.body))).toEqual({ state: "closed" });
    expect(JSON.parse(String(requestOf(fetchImpl, 3).init.body))).toEqual({
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
    expect((captured as Error).message).toContain("HTTP 422");
    expect((captured as Error).message).toContain("validation_failed");
    expect(JSON.stringify(captured)).not.toContain("raw validation body");
    expect(JSON.stringify(captured)).not.toContain("unit-test-token");
  });

  it.each([
    [400, "bad_request", "INVALID_ARGUMENT"],
    [401, "unauthorized", "AUTHENTICATION_FAILED"],
    [403, "forbidden", "AUTHENTICATION_FAILED"],
    [404, "not_found", "INVALID_ARGUMENT"],
    [405, "method_not_allowed", "INVALID_ARGUMENT"],
    [409, "conflict", "INVALID_ARGUMENT"],
    [422, "validation_failed", "INVALID_ARGUMENT"],
    [429, "rate_limited", "INVALID_ARGUMENT"],
    [418, "other_client_error", "INVALID_ARGUMENT"],
  ] as const)("reports only bounded HTTP %i category %s", async (status, category, code) => {
    const fetchImpl = jest.fn(async () => new Response("secret raw body unit-test-token", {
      status,
      headers: { "x-github-request-id": "AB12:CD34:EF56:1234" },
    }));
    const client = new GitHubHttpClient({ credentialProvider, fetchImpl: fetchImpl as typeof fetch });
    let captured: unknown;
    try { await client.mergePullRequest("octo", "repo", 7, {
      sha: "a".repeat(40), merge_method: "merge",
    }); } catch (error) { captured = error; }
    expect(captured).toMatchObject({ code });
    const diagnostic = JSON.stringify(captured);
    expect(diagnostic).toContain(`HTTP ${status}`);
    expect(diagnostic).toContain(category);
    expect(diagnostic).toContain("AB12:CD34:EF56:1234");
    expect(diagnostic).not.toContain("unit-test-token");
    expect(diagnostic).not.toContain("secret raw body");
    expect(diagnostic).not.toContain("Bearer");
    expect((captured as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it.each([
    "Bearer unit-test-token",
    "AB12:CD34:SECRET-BEARER",
    "AB12:CD34\\r\\nInjected:unit-test-token",
    "AB12:CD34:EF56:1234".repeat(8),
  ])("omits malformed or suspicious GitHub request identifiers", async requestId => {
    const fetchImpl = jest.fn(async () => new Response("hidden unit-test-token", {
      status: 422,
      headers: { "x-github-request-id": requestId },
    }));
    const client = new GitHubHttpClient({ credentialProvider, fetchImpl: fetchImpl as typeof fetch });
    let captured: unknown;
    try { await client.getRepository("octo", "repo"); } catch (error) { captured = error; }
    const diagnostic = JSON.stringify(captured);
    expect(diagnostic).toContain("HTTP 422");
    expect(diagnostic).not.toContain("requestId=");
    expect(diagnostic).not.toContain("unit-test-token");
    expect(diagnostic).not.toContain("hidden");
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
