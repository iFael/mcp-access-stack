import {createHash} from "node:crypto";
import type {ReleaseRunSnapshot,StepIntent} from "./types.js";
import type {ReleaseStepCapability} from "./release-workflow-executor.js";
import type {ExecutionNodePointerState} from "./release-pointer-reconciliation-capability.js";

const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const AGE_MS=120_000;
export type NodeHealthPlatform="oracle"|"windows";
export interface VerifiedActiveManifest {
  readonly releaseTag:string;
  readonly sourceCommitSha:string;
  readonly manifestSha256:string;
  readonly verifiedArtifactCount:number;
}
export interface NodeRuntimeHealth {
  readonly status:"healthy"|"unhealthy";
  readonly releaseId:string;
  readonly manifestSha256:string;
  readonly processId:number;
  readonly observedAt:string;
}
export interface ReleaseNodeActiveHealthBinding {
  readonly platform:NodeHealthPlatform;
  /** Authenticated, host-owned typed readers. Never accept caller paths or commands. */
  readonly port:{
    inspectActive(releaseTag:string,sourceCommitSha:string):Promise<VerifiedActiveManifest>;
    getState():Promise<ExecutionNodePointerState>;
    getHealth():Promise<NodeRuntimeHealth>;
  };
  readonly authorize:(run:ReleaseRunSnapshot)=>Promise<boolean>;
  /** Only for deterministic tests; production uses local monotonic wall clock. */
  readonly now?:()=>number;
}
function snapshotIdentity(manifest:VerifiedActiveManifest,
  state:ExecutionNodePointerState,health:NodeRuntimeHealth):string{
  return JSON.stringify({
    manifest,active:state.active,previous:state.previous,candidate:state.candidate,
    health:{status:health.status,releaseId:health.releaseId,
      manifestSha256:health.manifestSha256,processId:health.processId},
  });
}
function valid(manifest:VerifiedActiveManifest,
  state:ExecutionNodePointerState,health:NodeRuntimeHealth,
  run:ReleaseRunSnapshot,now:number):boolean{
  const releaseId=run.targetRelease.slice(1);
  const observed=Date.parse(health.observedAt);
  return manifest.releaseTag===run.targetRelease &&
    manifest.sourceCommitSha===run.sourceCommitSha &&
    DIGEST.test(manifest.manifestSha256) &&
    Number.isSafeInteger(manifest.verifiedArtifactCount) &&
    manifest.verifiedArtifactCount>=1 && manifest.verifiedArtifactCount<=64 &&
    state.active?.releaseId===releaseId &&
    state.active.manifestSha256===manifest.manifestSha256 &&
    state.candidate===null &&
    !!state.previous && state.previous.releaseId!==releaseId &&
    DIGEST.test(state.previous.manifestSha256) &&
    health.status==="healthy" && health.releaseId===releaseId &&
    health.manifestSha256===manifest.manifestSha256 &&
    Number.isSafeInteger(health.processId) && health.processId>0 &&
    Number.isFinite(observed) && observed<=now+5_000 &&
    observed>=now-AGE_MS;
}
function bound(platform:NodeHealthPlatform,intent:StepIntent,
  run:ReleaseRunSnapshot):string|null{
  const action=platform==="oracle"?"verify_oracle_health":"verify_windows_health";
  const promotion=platform==="oracle"?"promote_oracle":"promote_windows";
  const own=run.steps.find(s=>s.stepId===intent.stepId);
  const promote=run.steps.find(s=>s.action===promotion);
  if(intent.runId!==run.runId || intent.action!==action ||
    intent.executionClass!=="read_only" || !UUID.test(intent.operationId) ||
    own?.action!==action || own.operationId!==intent.operationId ||
    (own.status!=="in_progress" && own.status!=="outcome_unknown") ||
    promote?.status!=="succeeded" || !UUID.test(promote.operationId??"") ||
    !TAG.test(run.targetRelease) || run.targetRelease.includes("..") ||
    !SHA.test(run.sourceCommitSha))return null;
  return promote.operationId;
}
/** Attests actual active bytes, matching runtime health and rollback pointers
 * twice, after a terminal promotion. Never equates workflow dispatch with GO. */
export function bindReleaseNodeActiveHealth(
  options:ReleaseNodeActiveHealthBinding,
):ReleaseStepCapability{
  if(!["oracle","windows"].includes(options.platform) ||
    typeof options.port?.inspectActive!=="function" ||
    typeof options.port?.getState!=="function" ||
    typeof options.port?.getHealth!=="function" ||
    typeof options.authorize!=="function")
    throw new Error("RELEASE_NODE_HEALTH_HOST_INVALID");
  const platform=options.platform;
  const action=platform==="oracle"?"verify_oracle_health":"verify_windows_health";
  const source=platform==="oracle"?"mcp_v3_verified_oracle":"mcp_v3_verified_windows";
  async function inspect(intent:StepIntent,run:ReleaseRunSnapshot){
    const promotionId=bound(platform,intent,run);
    if(!promotionId || !await options.authorize(run))return null;
    try{
      let initial:string|null=null,verified:VerifiedActiveManifest|null=null;
      for(let i=0;i<2;i++){
        const [manifest,state,health]=await Promise.all([
          options.port.inspectActive(run.targetRelease,run.sourceCommitSha),
          options.port.getState(),options.port.getHealth(),
        ]);
        if(!valid(manifest,state,health,run,(options.now??Date.now)()))return null;
        const identity=snapshotIdentity(manifest,state,health);
        if(initial!==null && initial!==identity)return null;
        initial=identity;verified=manifest;
      }
      if(!verified || !await options.authorize(run))return null;
      const evidenceBase={platform,releaseTag:run.targetRelease,
        sourceCommitSha:run.sourceCommitSha,runId:run.runId,
        healthOperationId:intent.operationId,promotionOperationId:promotionId,
        state:initial};
      const manifestDigest=createHash("sha256")
        .update(JSON.stringify({...evidenceBase,kind:"active_manifest"}))
        .digest("hex");
      const healthDigest=createHash("sha256")
        .update(JSON.stringify({...evidenceBase,kind:"runtime_health"}))
        .digest("hex");
      const observedAt=new Date((options.now??Date.now)()).toISOString();
      return [{kind:platform+"_active_manifest",source,sha256:manifestDigest,observedAt},
        {kind:platform+"_health_report",source,sha256:healthDigest,observedAt}];
    }catch{return null;}
  }
  return {
    action,executionClass:"read_only",
    authorize:(_step,run)=>options.authorize(run),
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
