import { createHash } from "node:crypto";
import {
  AppError, type MutationReceiptIdentity, type MutationReceiptStore, type OperationContext,
} from "@vs-code-gpt/shared";
import type { GitHubWorkflowApiClient, GitHubWorkflowRunRecord } from "./github-http-client.js";

const SHA = /^[a-f0-9]{40}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const F09_WORKFLOW = "edge-f09-guarded-rollout.yml" as const;
const TAG_BOOTSTRAP = "release-tag-bootstrap.yml" as const;
const PUBLIC_RELEASE = "release.yml" as const;
const PUBLIC_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u;

export interface GitHubReleaseWorkflowInput {
  workspaceId: string;
  owner: string;
  repository: string;
  workflow: typeof F09_WORKFLOW | typeof TAG_BOOTSTRAP | typeof PUBLIC_RELEASE;
  tag?: string | undefined;
  expectedMainSha: string;
  operationId: string;
}
export type GitHubReleaseWorkflowObservation =
  | { status: "submitted" | "outcome_unknown"; operationId: string }
  | { status: "observed"; operationId: string; runId: number;
      state: "queued" | "in_progress" | "completed"; conclusion: string | null };

export interface GitHubReleaseWorkflowOptions {
  client: GitHubWorkflowApiClient;
  receipts: MutationReceiptStore;
  authorize: (input: GitHubReleaseWorkflowInput, context: OperationContext) => Promise<boolean>;
}

/**
 * INTERNAL, fixed-workflow typed adapter. The existing source-control receipt
 * is the sole dispatch authority: a 204 response is only "submitted" and
 * never mistaken for a successful deployment. An uncertain POST is never retried.
 */
export class GitHubReleaseWorkflowOperation {
  constructor(private readonly options: GitHubReleaseWorkflowOptions) {}

  async dispatch(input: GitHubReleaseWorkflowInput, context: OperationContext): Promise<GitHubReleaseWorkflowObservation> {
    const identity = this.identity(input, context);
    if (!await this.options.authorize(input, context)) {
      throw new AppError("CAPABILITY_UNSUPPORTED", "Workflow dispatch gate not authorized.");
    }
    const unknown = {status:"outcome_unknown" as const,operationId:input.operationId};
    const previous = await this.options.receipts.get(identity.idempotencyKey);
    if (previous !== undefined) {
      const replay = await this.options.receipts.reserve(identity);
      return replay.disposition === "replay_completed"
        ? {status:"submitted",operationId:input.operationId} : unknown;
    }
    // Validate remote provenance BEFORE reserving an intent: temporary missing
    // bootstrap/CI evidence must never consume the one-shot dispatch receipt.
    if (input.workflow === PUBLIC_RELEASE && !await this.preflightPublicRelease(input,context)) return unknown;
    const reservation = await this.options.receipts.reserve(identity);
    if (reservation.disposition === "replay_completed") return {status:"submitted",operationId:input.operationId};
    if (reservation.disposition !== "execute") return unknown;
    try {
      const ref = await this.options.client.getMainRef(input.owner,input.repository,context);
      if (ref.ref !== "refs/heads/main" || ref.object.type !== "commit" ||
          ref.object.sha !== input.expectedMainSha) throw new Error("RELEASE_MAIN_SHA_MISMATCH");
      if (input.workflow === PUBLIC_RELEASE && !await this.preflightPublicRelease(input,context)) {
        throw new Error("PUBLIC_RELEASE_PRECONDITION_CHANGED");
      }
      const prior = await this.matchingRuns(input,context);
      if (prior !== null) throw new Error("RELEASE_WORKFLOW_ALREADY_EXISTS");
      await this.options.receipts.markExecuting(identity);
      await this.options.client.dispatchWorkflow(input.owner,input.repository,input.workflow,
        input.expectedMainSha,{operation_id:input.operationId,
          ...(input.tag===undefined?{}:{tag:input.tag})},context);
      await this.options.receipts.markCompleted(identity,{status:"submitted",operationId:input.operationId});
      return {status:"submitted",operationId:input.operationId};
    } catch {
      const persisted = await this.options.receipts.get(identity.idempotencyKey);
      if (persisted?.state === "executing") {
        await this.options.receipts.markReconciliationRequired(identity);
      }
      // The remote POST may already have happened; never retry this identity.
      return unknown;
    }
  }

  async reconcile(input: GitHubReleaseWorkflowInput, context: OperationContext): Promise<GitHubReleaseWorkflowObservation> {
    const identity = this.identity(input,context);
    const receipt = await this.options.receipts.get(identity.idempotencyKey);
    if (receipt !== undefined) await this.options.receipts.reserve(identity);
    try {
      const observed = await this.matchingRuns(input,context);
      if (observed !== null) {
        if (receipt?.state === "executing") {
          await this.options.receipts.markReconciliationRequired(identity);
          await this.options.receipts.markCompleted(identity,{status:"submitted",operationId:input.operationId});
        } else if (receipt?.state === "reconciliation_required") {
          await this.options.receipts.markCompleted(identity,{status:"submitted",operationId:input.operationId});
        } else if (receipt?.state === "reserved") {
          // A typed run identity proves the POST happened even if the
          // executing receipt write was interrupted.
          await this.options.receipts.markExecuting(identity);
          await this.options.receipts.markCompleted(identity,{status:"submitted",operationId:input.operationId});
        }
        return {status:"observed",operationId:input.operationId,runId:observed.id,
          state:observed.status as "queued"|"in_progress"|"completed",conclusion:observed.conclusion};
      }
    } catch {
      if (input.workflow !== PUBLIC_RELEASE) return {status:"outcome_unknown",operationId:input.operationId};
    }
    if (input.workflow === PUBLIC_RELEASE) return this.observeTagPush(input,context);
    return {status:"outcome_unknown",operationId:input.operationId};
  }

  /** Public release is already dispatched by Git's tag push. Observe it read-only;
   * no receipt from an additional workflow_dispatch is allowed or required. */
  private async observeTagPush(input: GitHubReleaseWorkflowInput,
    context: OperationContext):Promise<GitHubReleaseWorkflowObservation> {
    const unknown = {status:"outcome_unknown" as const,operationId:input.operationId};
    try {
      if (!this.options.client.getTagRef || !this.options.client.getTagPushRuns) return unknown;
      const ref = await this.options.client.getTagRef(input.owner,input.repository,input.tag!,context);
      if (ref.ref !== "refs/tags/"+input.tag || ref.object.type !== "commit" ||
          ref.object.sha !== input.expectedMainSha) return unknown;
      const response = await this.options.client.getTagPushRuns(input.owner,input.repository,input.expectedMainSha,context);
      if (!Number.isSafeInteger(response.total_count) || response.total_count < 0 ||
          response.total_count >= 100 || !Array.isArray(response.workflow_runs) ||
          response.workflow_runs.length > response.total_count || response.workflow_runs.length > 100) return unknown;
      const matches = response.workflow_runs.filter(run=>
        run.event === "push" && run.head_branch === input.tag);
      if (matches.length !== 1) return unknown;
      const run = matches[0]!;
      if (!Number.isSafeInteger(run.id) || run.id <= 0 ||
          !Number.isSafeInteger(run.workflow_id) || run.workflow_id <= 0 ||
          run.head_sha !== input.expectedMainSha || run.run_attempt !== 1 ||
          !["queued","in_progress","completed"].includes(run.status) ||
          (run.status === "completed" ? !run.conclusion : run.conclusion !== null)) return unknown;
      return {status:"observed",operationId:input.operationId,runId:run.id,
        state:run.status as "queued"|"in_progress"|"completed",conclusion:run.conclusion};
    } catch { return unknown; }
  }

  /** A GITHUB_TOKEN-created tag does NOT trigger the public workflow push.
   * Dispatch it explicitly only after this SAME operation's bootstrap succeeds,
   * its tag ref is immutable, and no existing release run could be duplicated. */
  private async preflightPublicRelease(input: GitHubReleaseWorkflowInput,
    context: OperationContext):Promise<boolean> {
    if (!this.options.client.getTagRef || !this.options.client.getTagPushRuns) return false;
    try {
      const bootstrap = await this.matchingRuns({...input,workflow:TAG_BOOTSTRAP},context);
      if (bootstrap?.status !== "completed" || bootstrap.conclusion !== "success") return false;
      const tagRef = await this.options.client.getTagRef(input.owner,input.repository,input.tag!,context);
      if (tagRef.ref !== "refs/tags/"+input.tag || tagRef.object.type !== "commit" ||
          tagRef.object.sha !== input.expectedMainSha) return false;
      const pushes = await this.options.client.getTagPushRuns(input.owner,input.repository,input.expectedMainSha,context);
      if (!Number.isSafeInteger(pushes.total_count) || pushes.total_count < 0 ||
          pushes.total_count >= 100 || !Array.isArray(pushes.workflow_runs) ||
          pushes.workflow_runs.length > pushes.total_count ||
          pushes.workflow_runs.some(run => run.event === "push" && run.head_branch === input.tag)) return false;
      const dispatched = await this.options.client.getWorkflowRuns(input.owner,input.repository,
        PUBLIC_RELEASE,input.expectedMainSha,context);
      if (!Number.isSafeInteger(dispatched.total_count) || dispatched.total_count < 0 ||
          dispatched.total_count >= 100 || !Array.isArray(dispatched.workflow_runs) ||
          dispatched.workflow_runs.length !== 0 || dispatched.total_count !== 0) return false;
      return true;
    } catch { return false; }
  }

  private async matchingRuns(input: GitHubReleaseWorkflowInput,context: OperationContext):Promise<GitHubWorkflowRunRecord|null> {
    const response=await this.options.client.getWorkflowRuns(input.owner,input.repository,input.workflow,input.expectedMainSha,context);
    if (!Number.isSafeInteger(response.total_count) || response.total_count<0 ||
        response.total_count>=100 || !Array.isArray(response.workflow_runs) ||
        response.workflow_runs.length>100 || response.workflow_runs.length>response.total_count) {
      throw new Error("RELEASE_WORKFLOW_RUNS_NOT_EXHAUSTIVE");
    }
    const title="mcp-release-"+input.operationId;
    const matches=response.workflow_runs.filter(run=>run.display_title===title);
    if(matches.length>1)throw new Error("RELEASE_WORKFLOW_IDENTITY_AMBIGUOUS");
    const run=matches[0];
    if(!run)return null;
    if(!Number.isSafeInteger(run.id)||run.id<1||
        !Number.isSafeInteger(run.workflow_id)||run.workflow_id<1||
        run.head_sha!==input.expectedMainSha || run.event!=="workflow_dispatch" ||
        run.run_attempt!==1 || !["queued","in_progress","completed"].includes(run.status) ||
        (run.status==="completed" ? !run.conclusion : run.conclusion!==null)) {
      throw new Error("RELEASE_WORKFLOW_IDENTITY_MISMATCH");
    }
    return run;
  }

  private identity(input:GitHubReleaseWorkflowInput,context:OperationContext):MutationReceiptIdentity {
    if(!input.workspaceId || !/^[a-zA-Z0-9-]{1,100}$/.test(input.owner) ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(input.repository) ||
      ![F09_WORKFLOW,TAG_BOOTSTRAP,PUBLIC_RELEASE].includes(input.workflow) ||
      (input.workflow===PUBLIC_RELEASE || input.workflow===TAG_BOOTSTRAP
        ? !input.tag || !PUBLIC_TAG.test(input.tag) || input.tag.includes("-oracle.") ||
          input.tag.includes("-companion.") : input.tag!==undefined) ||
      !SHA.test(input.expectedMainSha) ||
      !UUID.test(input.operationId) || !context.ownerScope) {
      throw new AppError("INVALID_ARGUMENT","Invalid pinned release workflow operation identity.");
    }
    const targetResource=`github:${input.owner}/${input.repository}:workflow/${input.workflow}:operation/${input.operationId}`;
    const canonicalArgumentsDigest=createHash("sha256").update(JSON.stringify({
      workspaceId:input.workspaceId,owner:input.owner,repository:input.repository,
      workflow:input.workflow,tag:input.tag??null,expectedMainSha:input.expectedMainSha,
      operationId:input.operationId,
      ownerScopeDigest:createHash("sha256").update(context.ownerScope).digest("hex"),
    })).digest("hex");
    return {workspaceId:input.workspaceId,operation:"github_workflow_operation",
      targetResource,canonicalArgumentsDigest,
      // Reuse the original f09 identity; tag bootstrap is operation scoped.
      // The public release is tag scoped so a different UUID cannot dispatch
      // the SAME immutable tag again, even while GitHub runs are eventually consistent.
      idempotencyKey: input.workflow === F09_WORKFLOW
        ? `release-workflow:${input.workspaceId}:${input.operationId}`
        : input.workflow === TAG_BOOTSTRAP
          ? `release-workflow:${input.workspaceId}:tag-bootstrap:${input.operationId}`
          : `release-workflow:${input.workspaceId}:public:${input.owner.toLowerCase()}/${input.repository.toLowerCase()}:${input.tag}`};
  }
}
