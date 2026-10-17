import type {LocalAgent} from "../local-agent.js";
import type {OracleCandidateHostConfig} from "./oracle-candidate-host-port.js";
import type {OracleCandidateReadResult} from "./oracle-candidate-read.js";

const DIGEST=/^[a-f0-9]{64}$/u;
const RELEASE_ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
type ActiveHost=Pick<LocalAgent,"oracleInspectActive"|"getReleaseState">;
function validSlot(value:unknown):boolean{
  if(value===null)return true;
  if(!value || typeof value!=="object" || Array.isArray(value))return false;
  const slot=value as Record<string,unknown>;
  return typeof slot.releaseId==="string" && RELEASE_ID.test(slot.releaseId) &&
    typeof slot.manifestSha256==="string" && DIGEST.test(slot.manifestSha256);
}

const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const SCOPE=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
/** Pinned, audited active-artifact host. Not the candidate-read principal. */
export function createOracleActiveReadPort(
  host:ActiveHost,
  config:OracleCandidateHostConfig,
){
  if(config.workspaceId!=="mcp-access-stack" || !SCOPE.test(config.ownerScope) ||
    typeof host.oracleInspectActive!=="function" ||
    typeof host.getReleaseState!=="function")
    throw new Error("ORACLE_ACTIVE_HOST_INVALID");
  return {
    async inspectActive(tag:string,commitSha:string):Promise<OracleCandidateReadResult>{
      if(!TAG.test(tag) || tag.includes("..") || !SHA.test(commitSha))
        throw new Error("ORACLE_ACTIVE_REQUEST_INVALID");
      const result=await host.oracleInspectActive(
        {workspaceId:config.workspaceId,tag,commitSha},
        {ownerScope:config.ownerScope});
      if(result.releaseTag!==tag || result.sourceCommitSha!==commitSha ||
        !/^[a-f0-9]{64}$/u.test(result.manifestSha256) ||
        !Number.isSafeInteger(result.verifiedArtifactCount) ||
        result.verifiedArtifactCount<1 || result.verifiedArtifactCount>64)
        throw new Error("ORACLE_ACTIVE_RECEIPT_INVALID");
      return result;
    },
    /** Typed native pointer read, pinned to the same audited owner scope.
     * The caller does not select the host, workspace, path or release slot. */
    async getState(){
      const result=await host.getReleaseState(
        {workspaceId:config.workspaceId},{ownerScope:config.ownerScope});
      const state=result.state;
      if(state?.version!==1 || !validSlot(state.active) ||
        !validSlot(state.previous) || !validSlot(state.candidate))
        throw new Error("ORACLE_ACTIVE_STATE_INVALID");
      return {active:state.active,previous:state.previous,
        candidate:state.candidate};
    },
  };
}
