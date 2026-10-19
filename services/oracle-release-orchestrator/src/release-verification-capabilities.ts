import type { ReleaseAction, ReleaseRunSnapshot, StepIntent, EvidenceInput } from "./types.js";
import type { ReleaseStepCapability } from "./release-workflow-executor.js";

/**
 * These ports must be injected by an authenticated host. They are NOT fake
 * production adapters: each observation must come from independently verified
 * live remote receipts (signed manifests, job results and active-state probes).
 * No shell command, credential, URL or generic tool name comes from the ledger.
 */
export type VerificationAction =
  | "verify_release_assets" | "verify_edge_health"
  | "validate_oracle_candidate" | "validate_windows_candidate"
  | "verify_oracle_health" | "verify_windows_health"
  | "reconcile_final_pointers" | "smoke_catalog";

const REQUIRED_KINDS: Readonly<Record<VerificationAction, readonly string[]>> = {
  verify_release_assets: ["canonical_ci_run","signed_manifest","release_asset_digest"],
  verify_edge_health: ["edge_health_report"],
  validate_oracle_candidate: ["oracle_candidate_manifest"],
  validate_windows_candidate: ["windows_candidate_manifest"],
  verify_oracle_health: ["oracle_active_manifest","oracle_health_report"],
  verify_windows_health: ["windows_active_manifest","windows_health_report"],
  reconcile_final_pointers: ["pointer_consistency_report"],
  smoke_catalog: ["catalog_smoke_report"],
};

export interface ReleaseVerificationReceipt {
  readonly action: VerificationAction;
  readonly sourceCommitSha: string;
  readonly releaseTag: string;
  readonly status: "verified" | "pending" | "rejected";
  readonly evidence: readonly EvidenceInput[];
}

export interface TypedReleaseVerificationPort {
  inspect(action: VerificationAction, run: ReleaseRunSnapshot): Promise<ReleaseVerificationReceipt>;
}
export interface ReleaseVerificationBinding {
  readonly port: TypedReleaseVerificationPort;
  readonly authorize: (action: VerificationAction, run: ReleaseRunSnapshot) => Promise<boolean>;
}
const DIGEST = /^[a-f0-9]{64}$/u;
const SOURCES = new Set([
  "mcp_v3_verified_github_release", "mcp_v3_verified_edge_health",
  "mcp_v3_verified_oracle", "mcp_v3_verified_windows",
  "mcp_v3_verified_catalog",
]);
function validReceipt(
  action: VerificationAction,run: ReleaseRunSnapshot,receipt: ReleaseVerificationReceipt,
): boolean {
  if(receipt.action!==action || receipt.sourceCommitSha!==run.sourceCommitSha ||
      receipt.releaseTag!==run.targetRelease || receipt.status!=="verified") return false;
  const required=REQUIRED_KINDS[action];
  const kinds=receipt.evidence.map(e=>e.kind);
  return receipt.evidence.length===required.length &&
    required.every(kind=>kinds.includes(kind)) &&
    new Set(kinds).size===kinds.length &&
    receipt.evidence.every(e=>DIGEST.test(e.sha256) && SOURCES.has(e.source) &&
      Number.isFinite(Date.parse(e.observedAt)) && !e.observedAt.includes("\n"));
}
function bound(action:VerificationAction,intent:StepIntent,run:ReleaseRunSnapshot):boolean {
  return intent.runId===run.runId && intent.action===action && intent.executionClass==="read_only" &&
    run.steps.some(step=>step.action===action && step.stepId===intent.stepId &&
      step.operationId===intent.operationId);
}
/** Eight fixed read-only verifier bindings. They never infer health from a CI
 * check or a workflow 204, and refuse incomplete, ambiguous or stale receipts. */
export function bindReleaseVerificationReads(
  binding:ReleaseVerificationBinding,
): ReadonlyMap<VerificationAction,ReleaseStepCapability> {
  const entries=(Object.keys(REQUIRED_KINDS) as VerificationAction[]).map(action => {
    async function inspect(run:ReleaseRunSnapshot) {
      const result=await binding.port.inspect(action,run);
      return validReceipt(action,run,result) ? result.evidence : null;
    }
    const capability:ReleaseStepCapability={
      action, executionClass:"read_only",
      authorize:(_step,run)=>binding.authorize(action,run),
      execute:async(intent,run)=>{
        if(!bound(action,intent,run) || !await binding.authorize(action,run)) {
          return {state:"outcome_unknown"};
        }
        try {
          const evidence=await inspect(run);
          return evidence ? {state:"succeeded",evidence} : {state:"outcome_unknown"};
        } catch { return {state:"outcome_unknown"}; }
      },
      reconcile:async(intent,run)=>{
        if(!bound(action,intent,run) || !await binding.authorize(action,run)) {
          return {outcome:"still_unknown"};
        }
        try {
          const evidence=await inspect(run);
          return evidence ? {outcome:"applied",evidence} : {outcome:"still_unknown"};
        } catch { return {outcome:"still_unknown"}; }
      },
    };
    return [action,capability] as const;
  });
  return new Map(entries);
}
