import { describe, expect, it, jest } from "@jest/globals";
import { InMemoryMutationReceiptStore, githubRerunFailedJobsInputSchema, type GitHubRerunFailedJobsInput } from "@vs-code-gpt/shared";
import { GitHubCiRerun } from "../../../src/source-control/github-ci-rerun.js";
import type { GitHubWorkflowApiClient, GitHubWorkflowRunDetail } from "../../../src/source-control/github-http-client.js";

const input: GitHubRerunFailedJobsInput = {
  workspaceId: "test", owner: "iFael", repository: "mcp-access-stack", runId: 123,
  expectedHeadSha: "a".repeat(40), expectedAttempt: 1,
  operationId: "11111111-2222-4333-8444-555555555555", mode: "rerun",
};
const context = { ownerScope: "trusted:test" };
function setup() {
  const run: GitHubWorkflowRunDetail = {
    id: 123, workflow_id: 99, name: "CI", display_title: "test",
    path: ".github/workflows/ci.yml", event: "pull_request", head_sha: input.expectedHeadSha,
    head_branch: "feature/test", status: "completed", conclusion: "failure", run_attempt: 1,
  };
  const receipts = new InMemoryMutationReceiptStore();
  const post = jest.fn<NonNullable<GitHubWorkflowApiClient["rerunFailedJobs"]>>(async () => {});
  const get = jest.fn(async () => ({ ...run }));
  const client: GitHubWorkflowApiClient = {
    getMainRef: async () => { throw new Error("unexpected main lookup"); },
    getWorkflowRuns: async () => { throw new Error("unexpected dispatch lookup"); },
    dispatchWorkflow: async () => { throw new Error("unexpected dispatch"); },
    getWorkflowRun: get, rerunFailedJobs: post,
  };
  return { run, post, get, receipts, client, service: new GitHubCiRerun(client, receipts) };
}

describe("bounded PR CI failed-job rerun", () => {
  it("submits once, persists identity across instances, then observes the exact second attempt", async () => {
    const { run, post, receipts, client, service } = setup();
    expect(await service.execute(input, context)).toMatchObject({ status: "submitted", runId: 123, expectedAttempt: 1 });
    const restarted = new GitHubCiRerun(client, receipts);
    expect((await restarted.execute(input, context)).status).toBe("submitted");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(input.owner, input.repository, 123, context);
    await expect(restarted.execute({ ...input, operationId: "22222222-2222-4333-8444-555555555555" }, context))
      .rejects.toMatchObject({ code: "SOURCE_CONTROL_IDEMPOTENCY_CONFLICT" });
    await expect(restarted.execute({ ...input, mode: "reconcile" }, { ownerScope: "other" }))
      .rejects.toMatchObject({ code: "SOURCE_CONTROL_IDEMPOTENCY_CONFLICT" });
    Object.assign(run, { run_attempt: 2, status: "in_progress", conclusion: null });
    expect(await restarted.execute({ ...input, mode: "reconcile" }, context))
      .toMatchObject({ status: "observed", observedAttempt: 2, state: "in_progress", conclusion: null });
    Object.assign(run, { status: "completed", conclusion: "success" });
    expect(await restarted.execute({ ...input, mode: "reconcile" }, context))
      .toMatchObject({ status: "observed", observedAttempt: 2, state: "completed", conclusion: "success" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("never repeats an uncertain POST, including after process restart", async () => {
    const { post, run, receipts, client, service } = setup();
    post.mockRejectedValueOnce(new Error("connection lost"));
    expect((await service.execute(input, context)).status).toBe("outcome_unknown");
    const restarted = new GitHubCiRerun(client, receipts);
    expect((await restarted.execute(input, context)).status).toBe("outcome_unknown");
    expect((await restarted.execute({ ...input, mode: "reconcile" }, context)).status).toBe("outcome_unknown");
    Object.assign(run, { run_attempt: 2, status: "completed", conclusion: "failure" });
    expect(await restarted.execute({ ...input, mode: "reconcile" }, context))
      .toMatchObject({ status: "observed", observedAttempt: 2, conclusion: "failure" });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("reserves only one POST during competing requests", async () => {
    const { post, service } = setup();
    const results = await Promise.all([service.execute(input, context), service.execute(input, context)]);
    expect(results.map(x => x.status)).toContain("submitted");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    { path: ".github/workflows/release.yml" }, { path: ".github/workflows/deploy.yml" },
    { event: "push" }, { event: "workflow_dispatch" }, { event: "pull_request_target" },
    { id: 456 }, { head_sha: "b".repeat(40) }, { workflow_id: 0 },
    { status: "in_progress", conclusion: null }, { conclusion: "success" },
    { conclusion: "cancelled" }, { run_attempt: 2 }, { run_attempt: 3 },
  ])("refuses invalid run metadata %j without a POST", async (change) => {
    const { run, post, service } = setup();
    Object.assign(run, change);
    await expect(service.execute(input, context)).rejects.toThrow();
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects other repositories, missing owner scope, arbitrary input and attempt >1", async () => {
    const { post, get, service } = setup();
    await expect(service.execute({ ...input, repository: "other" }, context)).rejects.toMatchObject({code:"PERMISSION_DENIED"});
    await expect(service.execute(input, {})).rejects.toMatchObject({code:"PERMISSION_DENIED"});
    expect(githubRerunFailedJobsInputSchema.safeParse({ ...input, expectedAttempt: 2 }).success).toBe(false);
    expect(githubRerunFailedJobsInputSchema.safeParse({ ...input, workflow: "release.yml" }).success).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("rechecks before POST and never submits when the remote attempt changed", async () => {
    const { run, get, post, service } = setup();
    get.mockResolvedValueOnce({ ...run }).mockResolvedValueOnce({ ...run, run_attempt: 2 });
    expect((await service.execute(input, context)).status).toBe("outcome_unknown");
    expect(post).not.toHaveBeenCalled();
  });

  it("read-only reconciliation never initiates a rerun", async () => {
    const { run, post, service } = setup();
    expect((await service.execute({ ...input, mode: "reconcile" }, context)).status).toBe("outcome_unknown");
    Object.assign(run, { run_attempt: 2, status: "completed", conclusion: "success" });
    expect((await service.execute({ ...input, mode: "reconcile" }, context)).status).toBe("observed");
    expect(post).not.toHaveBeenCalled();
  });
});
