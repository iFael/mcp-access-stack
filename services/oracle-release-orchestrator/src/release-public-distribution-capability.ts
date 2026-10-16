import { createHash } from "node:crypto";
import type { EvidenceInput, ReleaseRunSnapshot, StepIntent } from "./types.js";
import type { ReleaseStepCapability } from "./release-workflow-executor.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

type PublicAction = "build_and_sign_release" | "publish_signed_release";
export interface PublicWorkflowRequest {
  readonly workspaceId: string;
  readonly owner: string;
  readonly repository: string;
  readonly workflow: "release.yml";
  readonly mode: "dispatch" | "reconcile";
  readonly tag: string;
  readonly expectedMainSha: string;
  readonly operationId: string;
  readonly bootstrapOperationId: string;
}
export type PublicWorkflowObservation =
  | { readonly status: "submitted" | "outcome_unknown"; readonly operationId: string }
  | { readonly status: "observed"; readonly operationId: string;
      readonly runId: number; readonly state: "queued" | "in_progress" | "completed";
      readonly conclusion: string | null };

/** The host must perform authenticated GitHub reads and independently check
 * artifact manifests, SHA-256 digests, release tag/commit and release state.
 * A workflow success alone cannot establish published, checksum-verified assets.
 */
export interface PublicDistributionProof {
  readonly sourceCommitSha: string;
  readonly releaseTag: string;
  readonly workflowRunId: number;
  readonly integrityVerified: boolean;
  readonly releasePublished: boolean;
  /** Digest of the exact authenticated GitHub asset/checksum inventory. */
  readonly assetInventorySha256: string;
  readonly verifiedAssetCount: number;
}
export interface TypedPublicDistributionPort {
  workflowOperation(input:PublicWorkflowRequest):Promise<PublicWorkflowObservation>;
  inspectDistribution(runId:number,tag:string,commitSha:string):Promise<PublicDistributionProof>;
}
export interface PublicDistributionBinding {
  readonly workspaceId: string;
  readonly owner: string;
  readonly repository: string;
  readonly port: TypedPublicDistributionPort;
  readonly authorized: (action:PublicAction,run:ReleaseRunSnapshot)=>Promise<boolean>;
}
function originalOperation(run:ReleaseRunSnapshot,action:string):string|null {
  const step=run.steps.find(s=>s.action===action);
  return step?.status==="succeeded" && UUID.test(step.operationId??"")
    ? step.operationId! : null;
}
function currentIntent(intent:StepIntent,run:ReleaseRunSnapshot,action:PublicAction):boolean {
  return intent.runId===run.runId && intent.executionClass==="external_effect" &&
    intent.action===action && UUID.test(intent.operationId) &&
    run.steps.some(s=>s.action===action && s.stepId===intent.stepId &&
      s.operationId===intent.operationId);
}
function workflowRequest(input:PublicDistributionBinding,
  run:ReleaseRunSnapshot,operationId:string,bootstrapOperationId:string,
  mode:"dispatch"|"reconcile"):PublicWorkflowRequest {
  return {workspaceId:input.workspaceId,owner:input.owner,repository:input.repository,
    workflow:"release.yml",mode,tag:run.targetRelease,
    expectedMainSha:run.sourceCommitSha,operationId,bootstrapOperationId};
}
function proofIsValid(p:PublicDistributionProof,run:ReleaseRunSnapshot,runId:number):boolean {
  return p.sourceCommitSha===run.sourceCommitSha &&
    p.releaseTag===run.targetRelease && p.workflowRunId===runId &&
    p.integrityVerified===true &&
    p.verifiedAssetCount===5 && DIGEST.test(p.assetInventorySha256);
}
function evidence(action:PublicAction,run:ReleaseRunSnapshot,runId:number,
  p:PublicDistributionProof):EvidenceInput {
  const body={action,runId,tag:run.targetRelease,sha:run.sourceCommitSha,
    assetInventorySha256:p.assetInventorySha256,verifiedAssetCount:p.verifiedAssetCount};
  return {kind:action==="build_and_sign_release"?"signed_build_receipt":"release_publication_receipt",
    source:"mcp_v3_verified_github_release",
    sha256:createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    observedAt:new Date().toISOString()};
}

/** One GitHub workflow dispatch, two Oracle steps. The second step merely
 * reconciles actual publication; it never posts a second GitHub workflow.
 * Both use the bootstrap operation persisted in the SAME Oracle ledger.
 */
export function bindReleasePublicDistribution(
  binding:PublicDistributionBinding,
): ReadonlyMap<PublicAction,ReleaseStepCapability> {
  if(!binding.workspaceId.trim() || !binding.owner.trim() || !binding.repository.trim()) {
    throw new Error("RELEASE_DISTRIBUTION_HOST_INVALID");
  }
  const common=async(action:PublicAction,intent:StepIntent,run:ReleaseRunSnapshot)=>{
    const bootstrap=originalOperation(run,"publish_release_tag");
    if(!currentIntent(intent,run,action) || !bootstrap || !SHA.test(run.sourceCommitSha) ||
      !await binding.authorized(action,run)) return null;
    const publicationOp=action==="build_and_sign_release"
      ? intent.operationId : originalOperation(run,"build_and_sign_release");
    if(!publicationOp) return null;
    return workflowRequest(binding,run,publicationOp,bootstrap,"reconcile");
  };
  // Dispatch is performed once. Both ledger steps reconcile the SAME run,
  // with publication requiring the additional GitHub Release postcondition.
  const reconcilePublication=async(action:PublicAction,intent:StepIntent,
    run:ReleaseRunSnapshot)=>{
    const request=await common(action,intent,run);
    if(!request)return {outcome:"still_unknown" as const};
    try {
      const observation=await binding.port.workflowOperation(request);
      if(observation.operationId!==request.operationId || observation.status!=="observed" ||
        observation.state!=="completed" || observation.conclusion!=="success" ||
        !Number.isSafeInteger(observation.runId) || observation.runId<1)
        return {outcome:"still_unknown" as const};
      const proof=await binding.port.inspectDistribution(
        observation.runId,run.targetRelease,run.sourceCommitSha);
      if(!proofIsValid(proof,run,observation.runId) ||
        (action==="publish_signed_release" && !proof.releasePublished))
        return {outcome:"still_unknown" as const};
      return {outcome:"applied" as const,
        evidence:[evidence(action,run,observation.runId,proof)]};
    } catch {return {outcome:"still_unknown" as const};}
  };
  const signing:ReleaseStepCapability={
    action:"build_and_sign_release",executionClass:"external_effect",
    authorize:async(_step,run)=>originalOperation(run,"publish_release_tag")!==null &&
      await binding.authorized("build_and_sign_release",run),
    execute:async(intent,run)=>{
      const request=await common("build_and_sign_release",intent,run);
      if(!request)return {state:"outcome_unknown"};
      try {
        await binding.port.workflowOperation({...request,mode:"dispatch"});
      } catch {/* Only reconcile: a lost POST may already have succeeded. */}
      return {state:"outcome_unknown"};
    },
    reconcile:(intent,run)=>reconcilePublication("build_and_sign_release",intent,run),
  };
  const publishing:ReleaseStepCapability={
    action:"publish_signed_release",executionClass:"external_effect",
    authorize:async(_step,run)=>originalOperation(run,"build_and_sign_release")!==null &&
      await binding.authorized("publish_signed_release",run),
    execute:async()=>({state:"outcome_unknown"}),
    reconcile:(intent,run)=>reconcilePublication("publish_signed_release",intent,run),
  };
  return new Map([["build_and_sign_release",signing],["publish_signed_release",publishing]]);
}
