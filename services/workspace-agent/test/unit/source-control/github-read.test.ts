import { describe, expect, it, jest } from "@jest/globals";
import { GitHubHttpClient, type GitHubApiClient } from "../../../src/source-control/github-http-client.js";
import type { GitHubCredentialProvider } from "../../../src/source-control/github-credential-provider.js";
import { readGitHub, writeGitHubIssue } from "../../../src/source-control/github-read.js";

const credentialProvider: GitHubCredentialProvider = {
  getCredential: async () => ({ token: "test-github-token", source: "gh-cli-user" }),
};
const base = { workspaceId: "ws", owner: "octo", repository: "repo" };

function fakeClient(responses: Record<string, unknown>) {
  const reads: Array<{ resource: readonly (string | number)[]; query: Record<string, string> }> = [];
  const posts: Array<{ resource: readonly (string | number)[]; body: object }> = [];
  const client = {
    readRepositoryResource: async (_o: string, _r: string, resource: readonly (string | number)[], query: Record<string, string>) => {
      reads.push({ resource, query });
      return responses[resource.join("/")];
    },
    createRepositoryResource: async (_o: string, _r: string, resource: readonly (string | number)[], body: object) => {
      posts.push({ resource, body });
      return responses[`POST ${resource.join("/")}`];
    },
  } as unknown as GitHubApiClient;
  return { client, reads, posts };
}

describe("github_read projections", () => {
  it("reads a release by tag or the latest one with its assets", async () => {
    const release = { id: 1, tag_name: "v1.1.0-beta.94", name: "beta.94", draft: false, prerelease: true,
      target_commitish: "main", published_at: "2026-10-24T00:00:00Z", html_url: "https://github.com/octo/repo/releases/1",
      assets: [{ id: 7, name: "oracle.tar.gz", size: 42 }], body: "not projected" };
    const { client, reads } = fakeClient({ "releases/tags/v1.1.0-beta.94": release, "releases/latest": release });
    const byTag = await readGitHub(client, { ...base, kind: "release", tag: "v1.1.0-beta.94" });
    expect(byTag.items).toEqual([expect.objectContaining({ tag: "v1.1.0-beta.94", assets: ["oracle.tar.gz (42 bytes, id 7)"] })]);
    expect(byTag.items[0]).not.toHaveProperty("body");
    expect(byTag.nextPage).toBeUndefined();
    await readGitHub(client, { ...base, kind: "release" });
    expect(reads.map((read) => read.resource.join("/"))).toEqual(["releases/tags/v1.1.0-beta.94", "releases/latest"]);
  });

  it("filters workflow runs by workflow file and pages them", async () => {
    const runs = Array.from({ length: 2 }, (_, index) => ({ id: index + 1, name: "Release", path: ".github/workflows/release.yml",
      event: "workflow_dispatch", status: "completed", conclusion: "success", head_branch: "main", head_sha: "a".repeat(40),
      run_number: 9, run_attempt: 1, created_at: "c", updated_at: "u", html_url: "https://github.com/x" }));
    const { client, reads } = fakeClient({ "actions/workflows/release.yml/runs": { workflow_runs: runs } });
    const result = await readGitHub(client, { ...base, kind: "workflow_runs", workflow: "release.yml",
      headSha: "A".repeat(40), status: "completed", perPage: 2 });
    expect(reads[0]!.query).toEqual({ page: "1", per_page: "2", head_sha: "a".repeat(40), status: "completed" });
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ id: 1, conclusion: "success", workflowPath: ".github/workflows/release.yml" });
    expect(result.nextPage).toBe(2);
  });

  it("lists failed steps of run jobs and pages refs locally", async () => {
    const { client } = fakeClient({
      "actions/runs/5/jobs": { jobs: [{ id: 9, name: "build", status: "completed", conclusion: "failure",
        steps: [{ name: "test", conclusion: "failure" }, { name: "setup", conclusion: "success" }] }] },
      "git/matching-refs/tags/v1.1": [1, 2, 3].map((n) => ({ ref: `refs/tags/v1.1.${n}`, object: { sha: "b".repeat(40), type: "commit" } })),
    });
    const jobs = await readGitHub(client, { ...base, kind: "run_jobs", runId: 5 });
    expect(jobs.items[0]).toMatchObject({ id: 9, conclusion: "failure", failedSteps: ["test"] });
    const refs = await readGitHub(client, { ...base, kind: "refs", prefix: "v1.1", perPage: 2 });
    expect(refs.items.map((item) => item.ref)).toEqual(["refs/tags/v1.1.1", "refs/tags/v1.1.2"]);
    expect(refs.nextPage).toBe(2);
    const second = await readGitHub(client, { ...base, kind: "refs", prefix: "v1.1", perPage: 2, page: 2 });
    expect(second.items.map((item) => item.ref)).toEqual(["refs/tags/v1.1.3"]);
    expect(second.nextPage).toBeUndefined();
  });

  it("reads issues, comments and reviews with clipped bodies", async () => {
    const { client, reads } = fakeClient({
      issues: [{ number: 3, title: "Bug", state: "open", user: { login: "rafa" }, labels: [{ name: "bug" }],
        comments: 1, pull_request: { url: "x" }, body: "x".repeat(5_000) }],
      "pulls/3/reviews": [{ id: 4, user: { login: "rev" }, state: "APPROVED", commit_id: "c", body: "ok" }],
    });
    const issues = await readGitHub(client, { ...base, kind: "issues", labels: ["bug", "p1"] });
    expect(reads[0]!.query).toMatchObject({ state: "open", labels: "bug,p1" });
    expect(issues.items[0]).toMatchObject({ number: 3, author: "rafa", labels: ["bug"], isPullRequest: true });
    expect(String(issues.items[0]!.body).length).toBeLessThan(2_100);
    const reviews = await readGitHub(client, { ...base, kind: "pull_request_reviews", number: 3 });
    expect(reviews.items[0]).toMatchObject({ id: 4, author: "rev", state: "APPROVED" });
  });

  it("refuses kinds without their required identifiers", async () => {
    const { client } = fakeClient({});
    await expect(readGitHub(client, { ...base, kind: "job_logs" })).rejects.toThrow();
    await expect(readGitHub(client, { ...base, kind: "issue_comments" })).rejects.toThrow();
    await expect(readGitHub(client, { ...base, kind: "issues", tailBytes: 2_048 })).rejects.toThrow();
  });
});

describe("github_issue_write", () => {
  it("creates issues and comments through fixed resources", async () => {
    const { client, posts } = fakeClient({
      "POST issues": { number: 12, html_url: "https://github.com/octo/repo/issues/12" },
      "POST issues/12/comments": { id: 99, html_url: "https://github.com/octo/repo/issues/12#issuecomment-99" },
    });
    await expect(writeGitHubIssue(client, { ...base, action: "create_issue", title: "Bug", body: "Steps", labels: ["bug"] }))
      .resolves.toEqual({ status: "completed", action: "create_issue", number: 12, url: "https://github.com/octo/repo/issues/12" });
    await expect(writeGitHubIssue(client, { ...base, action: "comment", number: 12, body: "Thanks" }))
      .resolves.toMatchObject({ action: "comment", number: 12, commentId: 99 });
    expect(posts).toEqual([
      { resource: ["issues"], body: { title: "Bug", body: "Steps", labels: ["bug"] } },
      { resource: ["issues", 12, "comments"], body: { body: "Thanks" } },
    ]);
    await expect(writeGitHubIssue(client, { ...base, action: "comment", body: "no number" })).rejects.toThrow();
  });
});

describe("GitHubHttpClient typed resources and job logs", () => {
  it("encodes resource segments and never accepts traversal", async () => {
    const seen: string[] = [];
    const client = new GitHubHttpClient({ credentialProvider,
      fetchImpl: (async (url: string) => { seen.push(url); return new Response("[]", { status: 200 }); }) as typeof fetch });
    await client.readRepositoryResource("octo", "repo", ["git", "matching-refs", "tags", "v1/../x"], { page: "1" });
    expect(seen[0]).toBe("https://api.github.com/repos/octo/repo/git/matching-refs/tags/v1%2F..%2Fx?page=1");
    await expect(client.readRepositoryResource("octo", "repo", [".."], {})).rejects.toThrow();
    await expect(client.readRepositoryResource("octo", "repo", ["issues", 0], {})).rejects.toThrow();
  });

  it("follows the log redirect without the token and keeps only the tail", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const log = "line\n".repeat(1_000) + "FINAL ERROR\n";
    const fetchImpl = jest.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (seen.length === 1) return new Response(null, { status: 302, headers: {
        location: "https://productionresultssa1.blob.core.windows.net/actions-results/x?sig=opaque" } });
      return new Response(log, { status: 200 });
    });
    const client = new GitHubHttpClient({ credentialProvider, fetchImpl: fetchImpl as typeof fetch });
    const tail = await client.getJobLogTail("octo", "repo", 77, 1_024);
    expect(tail.truncated).toBe(true);
    expect(tail.text.endsWith("FINAL ERROR\n")).toBe(true);
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(1_024);
    expect(seen[0]!.url).toBe("https://api.github.com/repos/octo/repo/actions/jobs/77/logs");
    expect((seen[1]!.init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it("refuses log redirects to other hosts", async () => {
    const fetchImpl = jest.fn(async () => new Response(null, { status: 302, headers: { location: "https://attacker.example/log" } }));
    const client = new GitHubHttpClient({ credentialProvider, fetchImpl: fetchImpl as typeof fetch });
    await expect(client.getJobLogTail("octo", "repo", 77, 1_024)).rejects.toThrow("untrusted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
