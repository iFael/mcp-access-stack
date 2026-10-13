import {resolve} from "node:path";
import {readCredentialFromEnvironment} from "./oracle-channel-connector.js";
import {composeReleaseCapabilities, type ReleaseCapabilityComposition, type ReleaseCapabilityRegistry} from "./release-capability-registry.js";
import type {ReleaseRunSnapshot} from "./types.js";
import {OracleRemoteSourceReadPort} from "./oracle-remote-source-read-port.js";

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
  const read=()=>readCredentialFromEnvironment(environment,
    "UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE");
  const key=read();
  if(!/^[0-9a-f]{64}$/u.test(key))throw new Error("ORACLE_SOURCE_HOST_HMAC_INVALID");
  const configured=new OracleRemoteSourceReadPort({
    endpoint:url,
    key:async()=>{
      const current=read();
      if(!/^[0-9a-f]{64}$/u.test(current))throw new Error("ORACLE_SOURCE_HOST_HMAC_INVALID");
      return current;
    },
  });
  return configured;
}

/** Host-owned composition: source reads use the authenticated reverse bridge,
 * while every other step must be supplied as an independently authorized typed
 * port. No arbitrary `other` capabilities or implicit allow policy are accepted.
 * Incomplete composition remains NO-GO for the single Oracle writer. */
export interface OracleHostReleaseBindings
  extends Omit<ReleaseCapabilityComposition,"sourceControl"|"other"> {
  readonly authorizeRead?: (run:ReleaseRunSnapshot)=>Promise<boolean>;
}
export function composeOracleHostReleaseCapabilities(
  environment:Readonly<Record<string,string|undefined>>,
  bindings:OracleHostReleaseBindings,
):ReleaseCapabilityRegistry {
  const source=resolveOracleRemoteSourceReadPort(environment);
  if(source && typeof bindings.authorizeRead!=="function") {
    throw new Error("ORACLE_SOURCE_HOST_AUTH_REQUIRED");
  }
  return composeReleaseCapabilities({
    ...(source ? {sourceControl:{port:source,authorizeRead:bindings.authorizeRead!}} : {}),
    ...(bindings.cleanup ? {cleanup:bindings.cleanup} : {}),
    ...(bindings.tagBootstrap ? {tagBootstrap:bindings.tagBootstrap} : {}),
    ...(bindings.verifications ? {verifications:bindings.verifications} : {}),
    ...(bindings.effects ? {effects:bindings.effects} : {}),
    ...(bindings.publicDistribution ? {publicDistribution:bindings.publicDistribution} : {}),
  });
}
