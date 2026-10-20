import type {ReleaseRunSnapshot,StepIntent} from "./types.js";
import type {ReleaseStepCapability} from "./release-workflow-executor.js";
import type {OracleRemoteCandidateReadPort} from "./oracle-remote-candidate-read-port.js";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
export interface ReleaseRemoteCandidateBinding{
  readonly port:Pick<OracleRemoteCandidateReadPort,"inspect">;
  readonly authorize:(run:ReleaseRunSnapshot)=>Promise<boolean>;
}
function match(intent:StepIntent,run:ReleaseRunSnapshot):boolean{
  const step=run.steps.find(s=>s.stepId===intent.stepId);
  return intent.runId===run.runId && intent.action==="validate_oracle_candidate" &&
    intent.executionClass==="read_only" && UUID.test(intent.operationId) &&
    step?.action==="validate_oracle_candidate" &&
    step.operationId===intent.operationId &&
    (step.status==="in_progress" || step.status==="outcome_unknown");
}
export function bindReleaseRemoteCandidate(
  binding:ReleaseRemoteCandidateBinding,
):ReleaseStepCapability{
  if(typeof binding.port?.inspect!=="function" ||
    typeof binding.authorize!=="function")
    throw new Error("ORACLE_REMOTE_CANDIDATE_BINDING_INVALID");
  const inspect=async(intent:StepIntent,run:ReleaseRunSnapshot)=>{
    if(!match(intent,run) || !await binding.authorize(run))return null;
    try{
      const result=await binding.port.inspect(run.targetRelease,
        run.sourceCommitSha,run.runId,intent.operationId);
      if(result.releaseTag!==run.targetRelease ||
        result.sourceCommitSha!==run.sourceCommitSha ||
        result.runId!==run.runId || result.operationId!==intent.operationId ||
        !DIGEST.test(result.manifestSha256) ||
        !Number.isSafeInteger(result.verifiedArtifactCount) ||
        result.verifiedArtifactCount<1 || result.verifiedArtifactCount>64 ||
        !await binding.authorize(run))return null;
      return [{kind:"oracle_candidate_manifest",source:"mcp_v3_verified_oracle",
        sha256:result.manifestSha256,observedAt:new Date().toISOString()}];
    }catch{return null;}
  };
  return {
    action:"validate_oracle_candidate",executionClass:"read_only",
    authorize:(_step,run)=>binding.authorize(run),
    execute:async(intent,run)=>{
      const evidence=await inspect(intent,run);
      return evidence?{state:"succeeded",evidence}:{state:"outcome_unknown"};
    },
    reconcile:async(intent,run)=>{
      const evidence=await inspect(intent,run);
      return evidence?{outcome:"applied",evidence}:{outcome:"still_unknown"};
    },
  };
}
