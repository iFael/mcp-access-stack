import type {ReleaseRunSnapshot,StepIntent} from "./types.js";
import type {ReleaseStepCapability} from "./release-workflow-executor.js";
import type {ExecutionNodePointerState} from "./release-pointer-reconciliation-capability.js";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
export interface WindowsCandidateReceipt {
  readonly platform:"windows";
  readonly releaseTag:string;
  readonly sourceCommitSha:string;
  readonly runId:string;
  readonly operationId:string;
  readonly prepareOperationId:string;
  readonly manifestSha256:string;
  readonly verifiedArtifactCount:number;
}
export interface WindowsCandidateBinding {
  /** A separately authenticated Windows source; never user-supplied paths. */
  readonly port:{
    inspectCandidate(tag:string,commitSha:string,runId:string,
      operationId:string,prepareOperationId:string):Promise<WindowsCandidateReceipt>;
    getState():Promise<ExecutionNodePointerState>;
  };
  readonly authorize:(run:ReleaseRunSnapshot)=>Promise<boolean>;
}
function bound(intent:StepIntent,run:ReleaseRunSnapshot):boolean{
  const own=run.steps.find(s=>s.stepId===intent.stepId);
  const prepare=run.steps.find(s=>s.action==="prepare_windows");
  return intent.action==="validate_windows_candidate" &&
    intent.executionClass==="read_only" &&
    intent.runId===run.runId && UUID.test(intent.operationId) &&
    own?.action==="validate_windows_candidate" &&
    own.operationId===intent.operationId &&
    (own.status==="in_progress" || own.status==="outcome_unknown") &&
    prepare?.status==="succeeded" &&
    UUID.test(prepare.operationId??"") &&
    TAG.test(run.targetRelease) && !run.targetRelease.includes("..") &&
    SHA.test(run.sourceCommitSha);
}
function verify(receipt:WindowsCandidateReceipt,
  state:ExecutionNodePointerState,run:ReleaseRunSnapshot,
  intent:StepIntent,prepareOperationId:string):boolean{
  const expected=run.targetRelease.slice(1);
  return receipt.platform==="windows" &&
    receipt.releaseTag===run.targetRelease &&
    receipt.sourceCommitSha===run.sourceCommitSha &&
    receipt.runId===run.runId &&
    receipt.operationId===intent.operationId &&
    receipt.prepareOperationId===prepareOperationId &&
    DIGEST.test(receipt.manifestSha256) &&
    Number.isSafeInteger(receipt.verifiedArtifactCount) &&
    receipt.verifiedArtifactCount>0 && receipt.verifiedArtifactCount<=64 &&
    state.candidate?.releaseId===expected &&
    state.candidate.manifestSha256===receipt.manifestSha256 &&
    (state.active===null ||
      (state.active.releaseId!==expected &&
        DIGEST.test(state.active.manifestSha256))) &&
    (state.previous===null ||
      (state.previous.releaseId!==expected &&
        DIGEST.test(state.previous.manifestSha256)));
}
/** Attests Windows candidate bytes and pointer state twice; no deploy or
 * promotion is inferred from a queued workflow or a nominal version. */
export function bindWindowsCandidate(
  options:WindowsCandidateBinding,
):ReleaseStepCapability{
  if(typeof options.port?.inspectCandidate!=="function" ||
    typeof options.port?.getState!=="function" ||
    typeof options.authorize!=="function")
    throw new Error("WINDOWS_CANDIDATE_HOST_INVALID");
  const check=async(intent:StepIntent,run:ReleaseRunSnapshot)=>{
    if(!bound(intent,run) || !await options.authorize(run))return null;
    const prepareOperationId=run.steps.find(s=>s.action==="prepare_windows")!.operationId!;
    try{
      let fingerprint:string|null=null,digest:string|null=null;
      for(let i=0;i<2;i++){
        const [receipt,state]=await Promise.all([
          options.port.inspectCandidate(run.targetRelease,
            run.sourceCommitSha,run.runId,intent.operationId,prepareOperationId),
          options.port.getState(),
        ]);
        if(!verify(receipt,state,run,intent,prepareOperationId))return null;
        const observed=JSON.stringify({
          releaseTag:receipt.releaseTag,commit:receipt.sourceCommitSha,
          manifestSha256:receipt.manifestSha256,
          prepareOperationId:receipt.prepareOperationId,
          artifactCount:receipt.verifiedArtifactCount,
          active:state.active,previous:state.previous,candidate:state.candidate,
        });
        if(fingerprint!==null && observed!==fingerprint)return null;
        fingerprint=observed;digest=receipt.manifestSha256;
      }
      if(!digest || !await options.authorize(run))return null;
      return [{kind:"windows_candidate_manifest",source:"mcp_v3_verified_windows",
        sha256:digest,observedAt:new Date().toISOString()}];
    }catch{return null;}
  };
  return {
    action:"validate_windows_candidate",executionClass:"read_only",
    authorize:(_step,run)=>options.authorize(run),
    execute:async(intent,run)=>{
      const evidence=await check(intent,run);
      return evidence?{state:"succeeded",evidence}:{state:"outcome_unknown"};
    },
    reconcile:async(intent,run)=>{
      const evidence=await check(intent,run);
      return evidence?{outcome:"applied",evidence}:{outcome:"still_unknown"};
    },
  };
}
