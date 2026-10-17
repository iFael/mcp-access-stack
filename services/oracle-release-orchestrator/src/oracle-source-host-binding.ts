import {resolve} from "node:path";
import {readCredentialFromEnvironment} from "./oracle-channel-connector.js";
import {composeReleaseCapabilities, type ReleaseCapabilityComposition, type ReleaseCapabilityRegistry} from "./release-capability-registry.js";
import type {ReleaseRunSnapshot} from "./types.js";
import {OracleRemoteSourceReadPort} from "./oracle-remote-source-read-port.js";
import {resolveOracleRemoteCandidatePort} from "./oracle-candidate-host-binding.js";
import {resolveOracleRemoteWorkflowPort} from "./oracle-workflow-host-binding.js";

/** Opt-in host-owned read capability. Never part of the Oracle GET-only API.
 * The release registry must still be fully populated and authorized before
 * any Oracle release run can be advanced. */
export function resolveOracleRemoteSourceReadPort(
  environment:Readonly<Record<string,string|undefined>>,
):OracleRemoteSourceReadPort|undefined {
  const enabled=environment.UPDATE_CONTROL_ORACLE_SOURCE_ENABLED;
  const url=environment.UPDATE_CONTROL_ORACLE_SOURCE_URL;
  const file=environment.UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE;
  if(enabled===undefined && url===undefined && file===undefined)return undefined;
  if(enabled!=="1" || !url?.trim() || !file?.trim())
    throw new Error("ORACLE_SOURCE_HOST_CONFIG_INCOMPLETE");
  // Source-read HMAC must never share a credential file with Oracle control
  // or its GET-only bearer, even when the two scopes are configured together.
  if(["UPDATE_CONTROL_ORACLE_CONTROL_TOKEN_FILE",
    "UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE"].some(name=>
    environment[name]?.trim() && resolve(environment[name]!)===resolve(file))) {
    throw new Error("ORACLE_SOURCE_HOST_CREDENTIAL_REUSED");
  }
  const readKey=()=>{
    const value=readCredentialFromEnvironment(environment,
      "UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE");
    if(!/^[0-9a-f]{64}$/u.test(value))throw new Error("ORACLE_SOURCE_HOST_HMAC_INVALID");
    return value;
  };
  readKey(); // Reject invalid enrollment immediately; revalidate on every request.
  return new OracleRemoteSourceReadPort({endpoint:url,key:async()=>readKey()});
}

/** Host-owned composition: source reads use the authenticated reverse bridge,
 * while every other step must be supplied as an independently authorized typed
 * port. No arbitrary `other` capabilities or implicit allow policy are accepted.
 * Incomplete composition remains NO-GO for the single Oracle writer. */
export interface OracleHostReleaseBindings
  extends Omit<ReleaseCapabilityComposition,"sourceControl"|"other"> {
  readonly authorizeRead?: (run:ReleaseRunSnapshot)=>Promise<boolean>;
  readonly authorizeCandidateRead?: (run:ReleaseRunSnapshot)=>Promise<boolean>;
  /** Independently authorizes real GitHub asset reads, not workflow dispatch. */
  readonly authorizeAssetVerification?: (run:ReleaseRunSnapshot)=>Promise<boolean>;
  readonly authorizeWorkflow?: (run:ReleaseRunSnapshot)=>Promise<boolean>;
  /** Separate host release policy, re-evaluated per signing/publication step. */
  readonly authorizePublicDistribution?: (action:"build_and_sign_release"|"publish_signed_release",run:ReleaseRunSnapshot)=>Promise<boolean>;
}
export function composeOracleHostReleaseCapabilities(
  environment:Readonly<Record<string,string|undefined>>,
  bindings:OracleHostReleaseBindings,
):ReleaseCapabilityRegistry {
  const source=resolveOracleRemoteSourceReadPort(environment);
  if(source && typeof bindings.authorizeRead!=="function") {
    throw new Error("ORACLE_SOURCE_HOST_AUTH_REQUIRED");
  }
  const workflow=resolveOracleRemoteWorkflowPort(environment);
  const candidate=resolveOracleRemoteCandidatePort(environment);
  if(candidate && typeof bindings.authorizeCandidateRead!=="function")
    throw new Error("ORACLE_CANDIDATE_HOST_AUTH_REQUIRED");
  if(candidate && (bindings.oracleCandidate || bindings.remoteCandidate))
    throw new Error("ORACLE_CANDIDATE_DUPLICATE_HOST");
  if(workflow && typeof bindings.authorizeWorkflow!=="function") {
    throw new Error("ORACLE_WORKFLOW_HOST_AUTH_REQUIRED");
  }
  if(workflow && typeof bindings.authorizePublicDistribution!=="function") {
    throw new Error("ORACLE_DISTRIBUTION_HOST_AUTH_REQUIRED");
  }
  if(bindings.authorizeAssetVerification && (!source || !workflow))
    throw new Error("ORACLE_ASSET_PROOF_HOST_INCOMPLETE");
  if(workflow && bindings.assetVerification)
    throw new Error("ORACLE_WORKFLOW_HOST_DUPLICATE_ASSET_PROOF");
  if(workflow && bindings.publicDistribution) {
    throw new Error("ORACLE_WORKFLOW_HOST_DUPLICATE_DISTRIBUTION");
  }
  if(workflow && bindings.tagBootstrap) {
    throw new Error("ORACLE_WORKFLOW_HOST_DUPLICATE_BOOTSTRAP");
  }
  return composeReleaseCapabilities({
    ...(source ? {sourceControl:{port:source,authorizeRead:bindings.authorizeRead!}} : {}),
    ...(bindings.cleanup ? {cleanup:bindings.cleanup} : {}),
    ...(source && workflow && bindings.authorizeAssetVerification ?
      {assetVerification:{workspaceId:workflow.workspaceId,
        owner:workflow.owner,repository:workflow.repository,
        workflow,source,authorize:bindings.authorizeAssetVerification}} :
      bindings.assetVerification ? {assetVerification:bindings.assetVerification} : {}),
    ...(workflow ? {tagBootstrap:{workspaceId:workflow.workspaceId,
      owner:workflow.owner,repository:workflow.repository,port:workflow,
      authorized:bindings.authorizeWorkflow!}} :
      bindings.tagBootstrap ? {tagBootstrap:bindings.tagBootstrap} : {}),
    ...(bindings.verifications ? {verifications:bindings.verifications} : {}),
    ...(candidate ? {remoteCandidate:{port:candidate,
      authorize:bindings.authorizeCandidateRead!}} :
      bindings.remoteCandidate ? {remoteCandidate:bindings.remoteCandidate} :
      bindings.oracleCandidate ? {oracleCandidate:bindings.oracleCandidate} : {}),
    ...(bindings.edgeHealth ? {edgeHealth:bindings.edgeHealth} : {}),
    ...(bindings.pointerReconciliation ? {pointerReconciliation:bindings.pointerReconciliation} : {}),
    ...(bindings.catalogSmoke ? {catalogSmoke:bindings.catalogSmoke} : {}),
    ...(bindings.oracleActiveHealth ? {oracleActiveHealth:bindings.oracleActiveHealth} : {}),
    ...(bindings.windowsActiveHealth ? {windowsActiveHealth:bindings.windowsActiveHealth} : {}),
    ...(bindings.windowsCandidate ? {windowsCandidate:bindings.windowsCandidate} : {}),
    ...(bindings.effects ? {effects:bindings.effects} : {}),
    ...(workflow && bindings.authorizeWorkflow ? {publicDistribution:{
      workspaceId:workflow.workspaceId,owner:workflow.owner,repository:workflow.repository,
      port:workflow,authorized:async(action,run)=>bindings.authorizePublicDistribution!(action,run),
    }} : bindings.publicDistribution ? {publicDistribution:bindings.publicDistribution} : {}),
  });
}
