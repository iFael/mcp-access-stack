import type {LocalAgent} from "../local-agent.js";
import type {OracleCandidateReadResult} from "./oracle-candidate-read.js";

const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const SCOPE=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
/** Host-provisioned identity. The Oracle release input never selects scope or path. */
export interface OracleCandidateHostConfig {
  readonly workspaceId:"mcp-access-stack";
  readonly ownerScope:string;
}
export function createOracleCandidateReadPort(
  host:Pick<LocalAgent,"oracleInspectCandidate">,
  config:OracleCandidateHostConfig,
){
  if(config.workspaceId!=="mcp-access-stack" ||
    !SCOPE.test(config.ownerScope) ||
    typeof host.oracleInspectCandidate!=="function")
    throw new Error("ORACLE_CANDIDATE_HOST_INVALID");
  return {
    async readCandidate(tag:string,commitSha:string):Promise<OracleCandidateReadResult>{
      if(!TAG.test(tag) || tag.includes("..") || !SHA.test(commitSha))
        throw new Error("ORACLE_CANDIDATE_REQUEST_INVALID");
      const receipt=await host.oracleInspectCandidate(
        {workspaceId:config.workspaceId,tag,commitSha},
        {ownerScope:config.ownerScope});
      if(receipt.releaseTag!==tag || receipt.sourceCommitSha!==commitSha ||
        !/^[a-f0-9]{64}$/u.test(receipt.manifestSha256) ||
        !Number.isSafeInteger(receipt.verifiedArtifactCount) ||
        receipt.verifiedArtifactCount<1 || receipt.verifiedArtifactCount>64)
        throw new Error("ORACLE_CANDIDATE_RECEIPT_INVALID");
      return receipt;
    },
  };
}
