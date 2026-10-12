import type { ReleaseAction, ReleaseRunSnapshot, StepIntent, EvidenceInput } from "./types.js";
import type { ReleaseStepCapability } from "./release-workflow-executor.js";

/** Mutation operations are fixed to the canonical blueprint. These bindings
 * forward one immutable intent to existing typed host facilities; they do
 * not allocate any other task, receipt store, HTTP endpoint or scheduler. */
export type EffectAction =
  | "build_and_sign_release" | "publish_signed_release" | "deploy_edge"
  | "prepare_oracle" | "prepare_windows" | "promote_oracle" | "promote_windows";
const RECEIPTS: Readonly<Record<EffectAction,string>> = {
  build_and_sign_release:"signed_build_receipt",
  publish_signed_release:"release_publication_receipt",
  deploy_edge:"edge_deployment_receipt",
  prepare_oracle:"oracle_prepare_receipt",
  prepare_windows:"windows_prepare_receipt",
  promote_oracle:"oracle_cutover_receipt",
  promote_windows:"windows_cutover_receipt",
};
export interface ReleaseEffectRequest {
  readonly action: EffectAction;
  readonly runId: string;
  readonly operationId: string;
  readonly releaseTag: string;
  readonly sourceCommitSha: string;
}
export interface ReleaseEffectReceipt extends ReleaseEffectRequest {
  readonly status: "completed" | "pending" | "failed" | "outcome_unknown";
  /** Verified by a trusted host from the EXACT operation, not a run title. */
  readonly evidence: readonly EvidenceInput[];
}
export interface TypedReleaseEffectPort {
  /** A 204/queued result never proves the effect; do not attempt retries. */
  start(input:ReleaseEffectRequest):Promise<void>;
  /** Must reconcile an original operationId, including after restart. */
  inspect(input:ReleaseEffectRequest):Promise<ReleaseEffectReceipt>;
}
export interface ReleaseEffectBinding {
  readonly port: TypedReleaseEffectPort;
  readonly authorize: (action: EffectAction,run:ReleaseRunSnapshot)=>Promise<boolean>;
  /** Explicit subset when signed distribution is owned by the specialized binding. */
  readonly actions?: readonly EffectAction[];
}

const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const SOURCES=new Set([
  "mcp_v3_verified_github_release","mcp_v3_verified_edge",
  "mcp_v3_verified_oracle","mcp_v3_verified_windows",
]);

function receiptValid(input:ReleaseEffectRequest,value:ReleaseEffectReceipt):boolean {
  if(value.action!==input.action || value.runId!==input.runId ||
      value.operationId!==input.operationId || value.releaseTag!==input.releaseTag ||
      value.sourceCommitSha!==input.sourceCommitSha ||
      value.status!=="completed" || value.evidence.length!==1) return false;
  const evidence=value.evidence[0]!;
  return evidence.kind===RECEIPTS[input.action] && DIGEST.test(evidence.sha256) &&
    SOURCES.has(evidence.source) && Number.isFinite(Date.parse(evidence.observedAt));
}
function request(intent:StepIntent,run:ReleaseRunSnapshot,action:EffectAction):ReleaseEffectRequest|null {
  if(intent.action!==action || intent.executionClass!=="external_effect" ||
     intent.runId!==run.runId || !SHA.test(run.sourceCommitSha) ||
     !run.steps.some(s=>s.stepId===intent.stepId && s.action===action &&
       s.operationId===intent.operationId)) return null;
  return {action,runId:run.runId,operationId:intent.operationId,
    releaseTag:run.targetRelease,sourceCommitSha:run.sourceCommitSha};
}

/**
 * An external_effect cannot be assumed successful just because a host accepted
 * a dispatch or started a task. Every action reconciles the original intent
 * against a matching, terminal receipt. No replay after transport ambiguity.
 *
 * WARNING: the legacy release.yml deploys Edge before asset publication.
 * A host MUST implement genuinely phase-isolated typed operations; directly
 * mapping all seven actions to the monolithic release.yml is forbidden.
 */
export function bindReleaseEffects(
  binding:ReleaseEffectBinding,
): ReadonlyMap<EffectAction,ReleaseStepCapability> {
  const actions=binding.actions??(Object.keys(RECEIPTS) as EffectAction[]);
  if(actions.length<1 || new Set(actions).size!==actions.length ||
    actions.some(action=>!Object.hasOwn(RECEIPTS,action))) {
    throw new Error("RELEASE_EFFECT_ACTION_SET_INVALID");
  }
  return new Map(actions.map(action=>{
    const capability:ReleaseStepCapability={
      action,executionClass:"external_effect",
      authorize:(_step,run)=>binding.authorize(action,run),
      execute:async(intent,run)=>{
        const input=request(intent,run,action);
        if(!input || !await binding.authorize(action,run))return {state:"outcome_unknown"};
        try { await binding.port.start(input); } catch { /* Never retry. */ }
        return {state:"outcome_unknown"};
      },
      reconcile:async(intent,run)=>{
        const input=request(intent,run,action);
        if(!input || !await binding.authorize(action,run))return {outcome:"still_unknown"};
        try {
          const observation=await binding.port.inspect(input);
          return receiptValid(input,observation)
            ? {outcome:"applied",evidence:[...observation.evidence]}
            : {outcome:"still_unknown"};
        } catch {return {outcome:"still_unknown"};}
      },
    };
    return [action,capability] as const;
  }));
}
