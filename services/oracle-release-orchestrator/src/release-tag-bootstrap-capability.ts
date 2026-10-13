import { createHash } from "node:crypto";
import type { ReleaseStepCapability } from "./release-workflow-executor.js";
import type { EvidenceInput, ReleaseRunSnapshot, StepIntent } from "./types.js";

export interface TypedTagBootstrapPort {
  workflowOperation(input: {
    workspaceId: string;
    owner: string;
    repository: string;
    workflow: "release-tag-bootstrap.yml";
    mode: "dispatch" | "reconcile";
    tag: string;
    expectedMainSha: string;
    operationId: string;
  }): Promise<
    | { status: "submitted" | "outcome_unknown"; operationId: string }
    | { status: "observed"; operationId: string; runId: number;
        state: "queued" | "in_progress" | "completed"; conclusion: string | null }
  >;
  /** Authorized typed GitHub tag-ref GET: must reject annotated or drifted refs. */
  verifyLightweightTag(tag: string, commitSha: string): Promise<boolean>;
}

export interface ReleaseTagBootstrapBinding {
  workspaceId: string;
  owner: string;
  repository: string;
  port: TypedTagBootstrapPort;
  authorized: (run: ReleaseRunSnapshot) => Promise<boolean>;
}

const SEMVER = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u;
const SHA = /^[a-f0-9]{40}$/u;
function bound(intent: StepIntent,run: ReleaseRunSnapshot):boolean {
  return intent.runId===run.runId && intent.action==="publish_release_tag" &&
    intent.executionClass==="external_effect" &&
    run.steps.some(step=>step.action==="publish_release_tag" &&
      step.stepId===intent.stepId && step.operationId===intent.operationId);
}
function receipt(input:{tag:string;sha:string;operationId:string;runId:number}):EvidenceInput {
  return {
    kind:"release_tag_bootstrap",
    source:"mcp_v3_github_workflow_operation",
    sha256:createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    observedAt:new Date().toISOString(),
  };
}

/** A single Oracle-ledger intent drives the existing MCP V3 typed tag bootstrap.
 * A 204/submitted acknowledgement is NOT success. The same operationId is
 * reconciled until a terminal-success run AND exact lightweight tag ref exist.
 * No independent task, timer, receipt store, retry or GitHub client is added. */
export function bindReleaseTagBootstrap(options:ReleaseTagBootstrapBinding):ReleaseStepCapability {
  if(!options.workspaceId.trim() || !options.owner.trim() || !options.repository.trim()) {
    throw new Error("RELEASE_TAG_BINDING_INVALID");
  }
  const valid=(run:ReleaseRunSnapshot)=>
    SHA.test(run.sourceCommitSha) && SEMVER.test(run.targetRelease) &&
    !run.targetRelease.includes("-oracle.") && !run.targetRelease.includes("-companion.");
  const operation=(intent:StepIntent,run:ReleaseRunSnapshot,mode:"dispatch"|"reconcile")=>({
    workspaceId:options.workspaceId,owner:options.owner,repository:options.repository,
    workflow:"release-tag-bootstrap.yml" as const,mode,
    expectedMainSha:run.sourceCommitSha,tag:run.targetRelease,operationId:intent.operationId,
  });
  return {
    action:"publish_release_tag",
    executionClass:"external_effect",
    authorize:async(_step,run)=>run.status==="running" && valid(run) && await options.authorized(run),
    execute:async(intent,run)=>{
      if(!bound(intent,run) || !valid(run) || !await options.authorized(run)) {
        return {state:"outcome_unknown"};
      }
      try {
        // Even if GitHub returned a runId here, the orchestrator must first
        // reconcile the signed postcondition using this same persisted intent.
        await options.port.workflowOperation(operation(intent,run,"dispatch"));
      } catch { /* An uncertain GitHub POST never grants a retry. */ }
      return {state:"outcome_unknown"};
    },
    reconcile:async(intent,run)=>{
      if(!bound(intent,run) || !valid(run) || !await options.authorized(run)) {
        return {outcome:"still_unknown"};
      }
      try {
        const result=await options.port.workflowOperation(operation(intent,run,"reconcile"));
        if(result.operationId!==intent.operationId || result.status!=="observed" ||
            result.state!=="completed" || result.conclusion!=="success" ||
            !Number.isSafeInteger(result.runId) || result.runId<1) {
          return {outcome:"still_unknown"};
        }
        if(!await options.port.verifyLightweightTag(run.targetRelease,run.sourceCommitSha)) {
          return {outcome:"still_unknown"};
        }
        return {outcome:"applied",evidence:[receipt({
          tag:run.targetRelease,sha:run.sourceCommitSha,
          operationId:intent.operationId,runId:result.runId,
        })]};
      } catch { return {outcome:"still_unknown"}; }
    },
  };
}
