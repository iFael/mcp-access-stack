import {createHash} from "node:crypto";
import type {ReleaseRunSnapshot,StepIntent} from "./types.js";
import type {ReleaseStepCapability} from "./release-workflow-executor.js";

const DIGEST=/^[a-f0-9]{64}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ID=/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
export interface ExecutionNodePointerState {
  readonly active:{readonly releaseId:string;readonly manifestSha256:string}|null;
  readonly previous:{readonly releaseId:string;readonly manifestSha256:string}|null;
  readonly candidate:{readonly releaseId:string;readonly manifestSha256:string}|null;
}
export interface ReleasePointerReconciliationBinding {
  /** Independently authenticated, host-pinned typed get_release_state ports. */
  readonly oracle:{getState():Promise<ExecutionNodePointerState>};
  readonly windows:{getState():Promise<ExecutionNodePointerState>};
  readonly authorize:(run:ReleaseRunSnapshot)=>Promise<boolean>;
}
function valid(state:ExecutionNodePointerState,expected:string):boolean{
  return state.active?.releaseId===expected &&
    DIGEST.test(state.active.manifestSha256) &&
    state.candidate===null &&
    state.previous!==null &&
    ID.test(state.previous.releaseId) &&
    state.previous.releaseId!==expected &&
    DIGEST.test(state.previous.manifestSha256);
}
function bound(intent:StepIntent,run:ReleaseRunSnapshot):boolean{
  const actions=["verify_oracle_health","verify_windows_health"] as const;
  const own=run.steps.find(s=>s.stepId===intent.stepId);
  return intent.runId===run.runId && intent.action==="reconcile_final_pointers" &&
    intent.executionClass==="read_only" && UUID.test(intent.operationId) &&
    own?.action==="reconcile_final_pointers" &&
    own.operationId===intent.operationId &&
    (own.status==="in_progress" || own.status==="outcome_unknown") &&
    actions.every(action=>run.steps.some(s=>s.action===action &&
      s.status==="succeeded" && UUID.test(s.operationId??"")));
}
function identity(state:ExecutionNodePointerState):string{
  return JSON.stringify({
    active:{releaseId:state.active!.releaseId,sha256:state.active!.manifestSha256},
    previous:{releaseId:state.previous!.releaseId,sha256:state.previous!.manifestSha256},
    candidate:null,
  });
}
/** Only compares actual independently read pointers. An adapter must never
 * infer cutover from workflow success or a planned release version. */
export function bindReleasePointerReconciliation(
  options:ReleasePointerReconciliationBinding,
):ReleaseStepCapability{
  if(!options.oracle?.getState || !options.windows?.getState ||
    typeof options.authorize!=="function")
    throw new Error("ORACLE_POINTER_HOST_INVALID");
  async function check(intent:StepIntent,run:ReleaseRunSnapshot){
    if(!bound(intent,run) || !await options.authorize(run))return null;
    const expected=run.targetRelease.startsWith("v")?run.targetRelease.slice(1):"";
    if(!ID.test(expected) || expected.includes(".."))return null;
    try{
      const [oracle,windows]=await Promise.all([
        options.oracle.getState(),options.windows.getState(),
      ]);
      if(!valid(oracle,expected) || !valid(windows,expected))return null;
      const snapshot={oracle:identity(oracle),windows:identity(windows)};
      // Re-read both nodes to reject a cutover or rollback in the observation window.
      const [o2,w2]=await Promise.all([
        options.oracle.getState(),options.windows.getState(),
      ]);
      if(!valid(o2,expected) || !valid(w2,expected) ||
        identity(o2)!==snapshot.oracle || identity(w2)!==snapshot.windows ||
        !await options.authorize(run))return null;
      const digest=createHash("sha256").update(JSON.stringify({
        releaseTag:run.targetRelease,commit:run.sourceCommitSha,
        oracle:snapshot.oracle,windows:snapshot.windows,
        oracleOperationId:run.steps.find(s=>s.action==="promote_oracle")?.operationId,
        windowsOperationId:run.steps.find(s=>s.action==="promote_windows")?.operationId,
      })).digest("hex");
      return [{kind:"pointer_consistency_report",source:"mcp_v3_verified_oracle",
        sha256:digest,observedAt:new Date().toISOString()}];
    }catch{return null;}
  }
  return {
    action:"reconcile_final_pointers",executionClass:"read_only",
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
