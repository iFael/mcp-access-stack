import type {LocalAgent} from "../local-agent.js";
import type {OracleCandidateHostConfig} from "./oracle-candidate-host-port.js";
import type {OracleCandidateReadResult} from "./oracle-candidate-read.js";

const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const SCOPE=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
/** Pinned, audited active-artifact host. Not the candidate-read principal. */
export function createOracleActiveReadPort(
  host:Pick<LocalAgent,"oracleInspectActive">,
  config:OracleCandidateHostConfig,
){
  if(config.workspaceId!=="mcp-access-stack" || !SCOPE.test(config.ownerScope) ||
    typeof host.oracleInspectActive!=="function")
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
  };
}
