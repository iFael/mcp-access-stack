import {createHash} from "node:crypto";
import type {ReleaseRunSnapshot,StepIntent,EvidenceInput} from "./types.js";
import type {ReleaseStepCapability} from "./release-workflow-executor.js";
import type {TypedPublicDistributionPort,PublicDistributionProof,PublicWorkflowRequest}
  from "./release-public-distribution-capability.js";
import type {ReleaseSourceControlReadPort} from "./release-source-control-read-capabilities.js";

const SHA=/^[a-f0-9]{40}$/u, DIGEST=/^[a-f0-9]{64}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface ReleaseAssetVerificationBinding {
  readonly workspaceId:string;
  readonly owner:string;
  readonly repository:string;
  readonly workflow:TypedPublicDistributionPort;
  readonly source:Pick<ReleaseSourceControlReadPort,"readMainHead"|"readCommitChecks">;
  readonly authorize:(run:ReleaseRunSnapshot)=>Promise<boolean>;
}
function originalOperation(run:ReleaseRunSnapshot,action:string):string|null {
  const entry=run.steps.find(s=>s.action===action);
  return entry?.status==="succeeded" && UUID.test(entry.operationId??"")
    ? entry.operationId!:null;
}
function hashed(kind:string,body:unknown):EvidenceInput {
  return {kind,source:"mcp_v3_verified_github_release",
    sha256:createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    observedAt:new Date().toISOString()};
}
/** Independent post-publication read, using the same GitHub-authorized host and
 * original operation IDs. It verifies the actual five package byte digests,
 * not merely a release status, a second dispatch, or a CI banner.
 * signed_manifest is a legacy ledger evidence label: no publisher signature
 * is asserted (signing requirements were retired by the canonical policy).
 */
export function bindReleaseAssetsVerification(
  binding:ReleaseAssetVerificationBinding,
):ReleaseStepCapability {
  if(!binding.workspaceId || !binding.owner || !binding.repository ||
    typeof binding.authorize!=="function" ||
    typeof binding.workflow.inspectDistribution!=="function" ||
    typeof binding.workflow.workflowOperation!=="function")
    throw new Error("RELEASE_ASSET_READER_INVALID");
  async function inspect(run:ReleaseRunSnapshot):Promise<readonly EvidenceInput[]|null> {
    const bootstrap=originalOperation(run,"publish_release_tag");
    const publication=originalOperation(run,"build_and_sign_release");
    const published=originalOperation(run,"publish_signed_release");
    if(!bootstrap || !publication || !published || !SHA.test(run.sourceCommitSha))
      return null;
    const before=await binding.source.readMainHead();
    if(before!==run.sourceCommitSha)return null;
    const checks=await binding.source.readCommitChecks(before);
    if(checks.commitSha!==before || checks.totalCount===0 ||
      checks.totalCount>100 || checks.truncated || !checks.allCompleted ||
      !checks.passed || checks.returnedCount!==checks.totalCount ||
      checks.returnedCount!==checks.checks.length || checks.pendingCount!==0 ||
      checks.failingCount!==0 || checks.successfulCount!==checks.totalCount ||
      checks.checks.some(c=>!Number.isSafeInteger(c.id) || c.id<1 ||
        !c.name.trim() || c.status!=="completed" ||
        !["success","neutral","skipped"].includes(c.conclusion??"")) ||
      new Set(checks.checks.map(c=>c.id)).size!==checks.checks.length)
      return null;
    const request:PublicWorkflowRequest={
      workspaceId:binding.workspaceId,owner:binding.owner,repository:binding.repository,
      workflow:"release.yml",mode:"reconcile",tag:run.targetRelease,
      expectedMainSha:run.sourceCommitSha,operationId:publication,
      bootstrapOperationId:bootstrap};
    const observation=await binding.workflow.workflowOperation(request);
    if(observation.status!=="observed" || observation.operationId!==publication ||
      observation.state!=="completed" || observation.conclusion!=="success" ||
      !Number.isSafeInteger(observation.runId) || observation.runId<=0)return null;
    const proof:PublicDistributionProof=await binding.workflow.inspectDistribution(
      observation.runId,run.targetRelease,run.sourceCommitSha);
    if(proof.workflowRunId!==observation.runId ||
      proof.sourceCommitSha!==run.sourceCommitSha || proof.releaseTag!==run.targetRelease ||
      !proof.integrityVerified || !proof.releasePublished ||
      proof.verifiedAssetCount!==5 || !DIGEST.test(proof.assetInventorySha256))
      return null;
    if(await binding.source.readMainHead()!==before)return null;
    const origin={sha:before,checks:checks.checks.map(c=>({
      id:c.id,name:c.name,conclusion:c.conclusion})).sort((a,b)=>a.id-b.id)};
    const provenance={tag:run.targetRelease,sourceCommitSha:before,runId:observation.runId,
      bootstrapOperationId:bootstrap,publicationOperationId:publication,
      publishedOperationId:published,assetInventorySha256:proof.assetInventorySha256};
    return [hashed("canonical_ci_run",origin),
      hashed("signed_manifest",provenance),
      {kind:"release_asset_digest",source:"mcp_v3_verified_github_release",
        sha256:proof.assetInventorySha256,observedAt:new Date().toISOString()}];
  }
  function bound(intent:StepIntent,run:ReleaseRunSnapshot):boolean {
    return intent.runId===run.runId && intent.action==="verify_release_assets" &&
      intent.executionClass==="read_only" && UUID.test(intent.operationId) &&
      run.steps.some(s=>s.stepId===intent.stepId &&
        s.action==="verify_release_assets" && s.operationId===intent.operationId);
  }
  return {
    action:"verify_release_assets",executionClass:"read_only",
    authorize:async(_step,run)=>binding.authorize(run),
    execute:async(intent,run)=>{
      if(!bound(intent,run) || !await binding.authorize(run))
        return {state:"outcome_unknown"};
      try {
        const evidence=await inspect(run);
        return evidence?{state:"succeeded",evidence:[...evidence]}:{state:"outcome_unknown"};
      }catch{return {state:"outcome_unknown"};}
    },
    reconcile:async(intent,run)=>{
      if(!bound(intent,run) || !await binding.authorize(run))
        return {outcome:"still_unknown"};
      try {
        const evidence=await inspect(run);
        return evidence?{outcome:"applied",evidence:[...evidence]}:{outcome:"still_unknown"};
      }catch{return {outcome:"still_unknown"};}
    },
  };
}
