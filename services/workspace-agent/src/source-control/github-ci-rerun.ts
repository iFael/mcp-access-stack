import { createHash } from "node:crypto";
import {
  AppError, githubRerunFailedJobsInputSchema,
  type GitHubRerunFailedJobsInput, type GitHubRerunFailedJobsResult,
  type MutationReceiptIdentity, type MutationReceiptStore, type OperationContext,
} from "@vs-code-gpt/shared";
import type { GitHubWorkflowApiClient, GitHubWorkflowRunDetail } from "./github-http-client.js";

// Scope is intentionally limited to this project's reviewed PR CI workflow.
// Do not infer safety from the name "CI" in an arbitrary repository.
const REPOSITORY = "ifael/mcp-access-stack";
const WORKFLOW = ".github/workflows/ci.yml";

export class GitHubCiRerun {
  constructor(private readonly client: GitHubWorkflowApiClient,
    private readonly receipts: MutationReceiptStore) {}

  async execute(input: GitHubRerunFailedJobsInput, context: OperationContext): Promise<GitHubRerunFailedJobsResult> {
    const parsed = githubRerunFailedJobsInputSchema.parse(input);
    const repository = (parsed.owner + "/" + parsed.repository).toLowerCase();
    if (repository !== REPOSITORY || !context.ownerScope) {
      throw new AppError("PERMISSION_DENIED", "Selective rerun is restricted to the authorized MCP V3 PR CI repository.");
    }
    if (!this.client.getWorkflowRun || !this.client.rerunFailedJobs) {
      throw new AppError("CAPABILITY_UNSUPPORTED", "Native GitHub selective rerun is unavailable.");
    }
    const targetResource = "github:" + repository + ":run/" + parsed.runId + ":attempt/1";
    const identity: MutationReceiptIdentity = {
      workspaceId: parsed.workspaceId,
      operation: "github_rerun_failed_jobs",
      targetResource,
      // Run/attempt key, not a caller-selected UUID, prevents a second request
      // while the GitHub API still reports the original attempt.
      idempotencyKey: createHash("sha256").update(targetResource).digest("hex"),
      canonicalArgumentsDigest: createHash("sha256").update(JSON.stringify({
        targetResource, headSha: parsed.expectedHeadSha, operationId: parsed.operationId,
        ownerScope: createHash("sha256").update(context.ownerScope).digest("hex"),
      })).digest("hex"),
    };
    const base = { operationId: parsed.operationId, runId: parsed.runId,
      headSha: parsed.expectedHeadSha, expectedAttempt: 1 as const };
    const unknown = { ...base, status: "outcome_unknown" as const };
    const submitted = { ...base, status: "submitted" as const };
    const read = async () => {
      const run = await this.client.getWorkflowRun!(parsed.owner, parsed.repository, parsed.runId, context);
      if (run.id !== parsed.runId || run.head_sha !== parsed.expectedHeadSha ||
          run.path !== WORKFLOW || run.event !== "pull_request" ||
          !Number.isSafeInteger(run.workflow_id) || run.workflow_id < 1 ||
          (run.run_attempt !== 1 && run.run_attempt !== 2)) {
        throw new AppError("INVALID_ARGUMENT", "GitHub run identity, workflow, event, SHA or attempt does not match the bounded CI rerun.");
      }
      return run;
    };
    const observe = (run: GitHubWorkflowRunDetail): GitHubRerunFailedJobsResult => {
      if (run.run_attempt !== 2) return unknown;
      const state = run.status;
      if (state !== "queued" && state !== "in_progress" && state !== "completed") return unknown;
      if (state === "completed" ? typeof run.conclusion !== "string" : run.conclusion !== null) return unknown;
      return { ...base, status: "observed", observedAttempt: 2, state, conclusion: run.conclusion };
    };
    const prior = await this.receipts.get(identity.idempotencyKey);
    if (prior) {
      // Validate ownership and the original operation ID, including on reconcile.
      await this.receipts.reserve(identity);
      const run = await read();
      if (run.run_attempt === 2) return observe(run);
      return prior.state === "completed" ? submitted : unknown;
    }
    if (parsed.mode === "reconcile") return observe(await read());
    const preflight = (run: GitHubWorkflowRunDetail) => {
      if (run.run_attempt !== 1 || run.status !== "completed" || run.conclusion !== "failure") {
        throw new AppError("INVALID_ARGUMENT", "Only a completed failed first attempt of PR CI can be rerun.");
      }
    };
    preflight(await read());
    const reservation = await this.receipts.reserve(identity);
    if (reservation.disposition !== "execute") {
      return reservation.disposition === "replay_completed" ? submitted : unknown;
    }
    try {
      // Recheck immediately before the one-shot POST. GitHub has no conditional
      // rerun endpoint: external concurrent UI reruns cannot be locked by MCP.
      preflight(await read());
      await this.receipts.markExecuting(identity);
      await this.client.rerunFailedJobs(parsed.owner, parsed.repository, parsed.runId, context);
      await this.receipts.markCompleted(identity, submitted);
      return submitted;
    } catch {
      const current = await this.receipts.get(identity.idempotencyKey);
      if (current?.state === "executing") await this.receipts.markReconciliationRequired(identity);
      return unknown;
    }
  }
}
