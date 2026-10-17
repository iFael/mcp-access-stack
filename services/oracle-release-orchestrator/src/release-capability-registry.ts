import { RELEASE_ACTIONS, type ReleaseAction } from "./types.js";
import { beta80ReleaseBlueprint } from "./workflows/beta80-sequence.v1.js";
import { ReleaseWorkflowExecutor, type ReleaseStepCapability } from "./release-workflow-executor.js";
import { bindReleasePruneCleanup, type ReleaseCleanupBinding } from "./release-prune-capability.js";
import { bindReleaseTagBootstrap, type ReleaseTagBootstrapBinding } from "./release-tag-bootstrap-capability.js";
import { bindReleaseVerificationReads, type ReleaseVerificationBinding } from "./release-verification-capabilities.js";
import { bindReleaseEffects, type ReleaseEffectBinding } from "./release-effect-capabilities.js";
import { bindReleasePublicDistribution, type PublicDistributionBinding } from "./release-public-distribution-capability.js";
import { bindReleaseSourceControlReads, type ReleaseSourceControlReadBinding } from "./release-source-control-read-capabilities.js";
import {bindReleaseAssetsVerification,type ReleaseAssetVerificationBinding} from "./release-assets-verification-capability.js";
import {bindOracleLocalCandidate,type OracleLocalCandidateBinding} from "./oracle-local-candidate-capability.js";
import {bindReleaseRemoteCandidate,type ReleaseRemoteCandidateBinding} from "./release-remote-candidate-capability.js";
import {bindEdgeHealth,type EdgeHealthBinding} from "./release-edge-health-capability.js";
import {bindReleasePointerReconciliation,type ReleasePointerReconciliationBinding} from "./release-pointer-reconciliation-capability.js";
import {bindCatalogSmoke,type CatalogSmokeBinding} from "./release-catalog-smoke-capability.js";
import {bindReleaseNodeActiveHealth,type ReleaseNodeActiveHealthBinding} from "./release-node-active-health-capability.js";
import type { ReleaseOrchestrator } from "./engine/release-orchestrator.js";

/**
 * One internal capability registry for the existing Oracle release ledger.
 * It reuses typed MCP V3 ports; does not introduce a second scheduler, ledger
 * or arbitrary dynamic tool invocation. Missing bindings are explicit NO-GO.
 */
export interface ReleaseCapabilityComposition {
  readonly sourceControl?: ReleaseSourceControlReadBinding;
  readonly cleanup?: ReleaseCleanupBinding;
  readonly tagBootstrap?: ReleaseTagBootstrapBinding;
  readonly verifications?: ReleaseVerificationBinding;
  readonly effects?: ReleaseEffectBinding;
  readonly publicDistribution?: PublicDistributionBinding;
  readonly assetVerification?: ReleaseAssetVerificationBinding;
  readonly oracleCandidate?: OracleLocalCandidateBinding;
  readonly remoteCandidate?: ReleaseRemoteCandidateBinding;
  readonly edgeHealth?: EdgeHealthBinding;
  readonly pointerReconciliation?: ReleasePointerReconciliationBinding;
  readonly catalogSmoke?: CatalogSmokeBinding;
  readonly oracleActiveHealth?: Omit<ReleaseNodeActiveHealthBinding,"platform">;
  readonly windowsActiveHealth?: Omit<ReleaseNodeActiveHealthBinding,"platform">;
  readonly other?: readonly ReleaseStepCapability[];
}

export interface ReleaseCapabilityRegistry {
  readonly capabilities: ReadonlyMap<ReleaseAction, ReleaseStepCapability>;
  readonly missingActions: readonly ReleaseAction[];
  readonly ready: boolean;
  createExecutor(orchestrator: ReleaseOrchestrator): ReleaseWorkflowExecutor;
}

export function composeReleaseCapabilities(input: ReleaseCapabilityComposition): ReleaseCapabilityRegistry {
  const known = new Set<string>(RELEASE_ACTIONS);
  const definitions = new Map(beta80ReleaseBlueprint.steps.map(step =>
    [step.action, step] as const));
  const installed = new Map<ReleaseAction, ReleaseStepCapability>();
  function install(binding: ReleaseStepCapability) {
    if (!known.has(binding.action)) throw new Error("RELEASE_CAPABILITY_UNRECOGNIZED");
    const step = definitions.get(binding.action);
    if (!step || step.executionClass !== binding.executionClass) {
      throw new Error("RELEASE_CAPABILITY_CLASS_MISMATCH");
    }
    if (installed.has(binding.action)) throw new Error("RELEASE_CAPABILITY_DUPLICATE");
    installed.set(binding.action, binding);
  }

  if (input.sourceControl) {
    for (const binding of bindReleaseSourceControlReads(input.sourceControl).values()) {
      install(binding);
    }
  }
  if (input.cleanup) install(bindReleasePruneCleanup(input.cleanup));
  if (input.assetVerification) install(bindReleaseAssetsVerification(input.assetVerification));
  if (input.oracleCandidate) install(bindOracleLocalCandidate(input.oracleCandidate));
  if (input.remoteCandidate) install(bindReleaseRemoteCandidate(input.remoteCandidate));
  if (input.edgeHealth) install(bindEdgeHealth(input.edgeHealth));
  if (input.pointerReconciliation) install(bindReleasePointerReconciliation(input.pointerReconciliation));
  if (input.catalogSmoke) install(bindCatalogSmoke(input.catalogSmoke));
  if (input.oracleActiveHealth) install(bindReleaseNodeActiveHealth({...input.oracleActiveHealth,platform:"oracle"}));
  if (input.windowsActiveHealth) install(bindReleaseNodeActiveHealth({...input.windowsActiveHealth,platform:"windows"}));
  if (input.tagBootstrap) install(bindReleaseTagBootstrap(input.tagBootstrap));
  if (input.verifications) for (const binding of bindReleaseVerificationReads(input.verifications).values()) install(binding);
  if (input.effects) for (const binding of bindReleaseEffects(input.effects).values()) install(binding);
  if (input.publicDistribution) for (const binding of bindReleasePublicDistribution(input.publicDistribution).values()) install(binding);
  for (const binding of input.other ?? []) install(binding);
  const missingActions = beta80ReleaseBlueprint.steps
    .filter(step => !installed.has(step.action)).map(step => step.action);
  return {
    capabilities: installed,
    missingActions,
    ready: missingActions.length === 0,
    createExecutor: orchestrator => {
      // Never start even the first side effect of a release whose later
      // necessary typed capability is absent from the trusted host.
      if (missingActions.length > 0) throw new Error("RELEASE_CAPABILITY_INCOMPLETE");
      return new ReleaseWorkflowExecutor(orchestrator, installed);
    },
  };
}
