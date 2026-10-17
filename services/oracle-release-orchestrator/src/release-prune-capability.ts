import { createHash } from "node:crypto";
import type { ReleaseStepCapability } from "./release-workflow-executor.js";
import type { EvidenceInput, ReleaseRunSnapshot, StepIntent } from "./types.js";

export interface TypedReleasePrunePort {
  pruneReleases(input: {
    workspaceId: string;
    operationId: string;
    dryRun: boolean;
    selection?: "eligible";
    reconcile?: true;
    expectedStateSha256?: string;
    expectedPlanSha256?: string;
  }): Promise<{
    operationId: string;
    status: "planned" | "completed";
    stateSha256: string;
    planSha256?: string;
    items: readonly {kind: "release" | "staging"; name: string; status: string}[];
  }>;
}

export interface ReleaseCleanupBinding {
  readonly workspaceId: string;
  readonly prune: TypedReleasePrunePort;
  /** Trusted host gate; NEVER accept an untrusted string or a persisted flag as authorization. */
  readonly authorized: (run: ReleaseRunSnapshot) => Promise<boolean>;
}

const SHA = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_BATCHES = 20;
type PruneReceipt = Awaited<ReturnType<TypedReleasePrunePort["pruneReleases"]>>;
function batchOperationId(original: string, index: number): string {
  const bytes = createHash("sha256").update(original + ":" + index).digest();
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return [h.slice(0, 8),h.slice(8, 12),h.slice(12, 16),h.slice(16, 20),h.slice(20, 32)].join("-");
}
function verifiedReceipt(receipt: PruneReceipt, operationId: string): boolean {
  return receipt.status === "completed" && receipt.operationId === operationId &&
    SHA.test(receipt.stateSha256) && !!receipt.planSha256 &&
    SHA.test(receipt.planSha256) && receipt.items.length <= 5 &&
    receipt.items.every(item => item.status === "deleted");
}
function receiptEvidence(receipts: readonly PruneReceipt[]): EvidenceInput {
  return {kind:"cleanup_receipt",source:"mcp_v3_prune_releases",
    sha256:createHash("sha256").update(JSON.stringify(receipts)).digest("hex"),
    observedAt:new Date().toISOString()};
}

/**
 * Bind the pre-existing typed prune operation to the existing Oracle release
 * ledger. Never supplies a path, a shell, or a direct filesystem delete.
 */
export function bindReleasePruneCleanup(options: ReleaseCleanupBinding): ReleaseStepCapability {
  if (!options.workspaceId.trim()) throw new Error("RELEASE_CLEANUP_WORKSPACE_INVALID");
  const authorized = async (run:ReleaseRunSnapshot,reconcile=false):Promise<boolean> =>
    (run.status === "running" || (reconcile && run.status === "paused_outcome_unknown")) &&
    run.steps.filter(step => step.action !== "cleanup_known_temporary_residue")
      .every(step => step.status === "succeeded") &&
    run.gates.length > 0 && run.gates.every(gate => gate.status === "passed") &&
    await options.authorized(run);
  const bound = (intent:StepIntent,run:ReleaseRunSnapshot):boolean =>
    intent.action === "cleanup_known_temporary_residue" &&
    intent.executionClass === "external_effect" && intent.runId === run.runId &&
    UUID.test(intent.operationId) &&
    run.steps.some(step =>
      step.action === intent.action && step.stepId === intent.stepId &&
      step.operationId === intent.operationId &&
      (step.status === "in_progress" || step.status === "outcome_unknown"));
  return {
    action: "cleanup_known_temporary_residue", executionClass: "external_effect",
    authorize: async (_step, run) => authorized(run),
    execute: async (intent: StepIntent, run) => {
      if (!bound(intent,run) || !await authorized(run)) {
        return {state:"outcome_unknown"};
      }
      const receipts: PruneReceipt[] = [];
      for (let index = 0; index < MAX_BATCHES; index++) {
        // Host permission can be revoked between independently destructive batches.
        if (!await authorized(run)) return {state:"outcome_unknown"};
        const operationId = batchOperationId(intent.operationId, index);
        const preview = await options.prune.pruneReleases({
          workspaceId:options.workspaceId, operationId, dryRun:true,selection:"eligible",
        });
        if (preview.status !== "planned" || !SHA.test(preview.stateSha256) ||
            !preview.planSha256 || !SHA.test(preview.planSha256) ||
            preview.items.length > 5 || preview.items.some(item => item.status !== "eligible")) {
          return {state:"outcome_unknown"};
        }
        // Re-check after the preview: revocation must prevent a DELETE.
        if (!await authorized(run)) return {state:"outcome_unknown"};
        const done = await options.prune.pruneReleases({
          workspaceId:options.workspaceId,operationId,
          dryRun:false,selection:"eligible",expectedStateSha256:preview.stateSha256,
          expectedPlanSha256:preview.planSha256,
        });
        if (!verifiedReceipt(done, operationId) ||
            done.stateSha256 !== preview.stateSha256 ||
            done.planSha256 !== preview.planSha256 ||
            done.items.length !== preview.items.length) return {state:"outcome_unknown"};
        receipts.push(done);
        // A final empty receipt is the durable proof that cleanup is finished.
        if (done.items.length === 0) {
          return {state:"succeeded",evidence:[receiptEvidence(receipts)]};
        }
      }
      return {state:"outcome_unknown"};
    },
    reconcile: async (intent,run) => {
      if (!bound(intent,run) || !await authorized(run,true)) return {outcome:"still_unknown"};
      const receipts: PruneReceipt[] = [];
      for (let index = 0; index < MAX_BATCHES; index++) {
        const operationId = batchOperationId(intent.operationId, index);
        try {
          const receipt = await options.prune.pruneReleases({
            workspaceId:options.workspaceId,operationId,dryRun:true,reconcile:true,
          });
          if (!verifiedReceipt(receipt, operationId)) return {outcome:"still_unknown"};
          receipts.push(receipt);
          if (receipt.items.length === 0) {
            return {outcome:"applied",evidence:[receiptEvidence(receipts)]};
          }
        } catch {
          return {outcome:"still_unknown"};
        }
      }
      return {outcome:"still_unknown"};
    },
  };
}
