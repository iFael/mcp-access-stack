import {AppError} from "@vs-code-gpt/shared";
import type {LocalAgentOptions,OracleCandidateHostConfig}
  from "@vs-code-gpt/local-agent";

const PREFIX="MCP_V3_ORACLE_CANDIDATE_READ_";
const SCOPE=/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
export interface OracleCandidateReadEnrollment {
  readonly host:OracleCandidateHostConfig;
  readonly policy:NonNullable<LocalAgentOptions["oracleCandidateRead"]>;
}
/** Enrolls the private LocalAgent read capability on the execution node only.
 * Enrollment is NOT a remote transport; a dedicated authenticated bridge
 * must be provisioned separately before any Oracle ledger can use it. */
export function loadOracleCandidateReadEnrollment(
  env:Readonly<Record<string,string|undefined>>,
):OracleCandidateReadEnrollment|undefined{
  const enabled=env[PREFIX+"ENABLED"],scope=env[PREFIX+"OWNER_SCOPE"];
  if(enabled===undefined && scope===undefined)return undefined;
  if(process.platform!=="linux" || enabled!=="1" || !scope ||
    !SCOPE.test(scope) ||
    [env.MCP_V3_ORACLE_SOURCE_PROVIDER_OWNER_SCOPE,
      env.MCP_V3_ORACLE_WORKFLOW_PROVIDER_OWNER_SCOPE,
      env.MCP_V3_ORACLE_CONTROL_OWNER_SCOPE].some(other=>other===scope))
    throw new AppError("CAPABILITY_UNSUPPORTED",
      "Oracle candidate reader host policy invalid or missing.");
  const host:OracleCandidateHostConfig={
    workspaceId:"mcp-access-stack",ownerScope:scope,
  };
  return {host,policy:{
    authorize:async(tag,commitSha,ownerScope)=>
      env[PREFIX+"ENABLED"]==="1" && ownerScope===host.ownerScope &&
      TAG.test(tag) && !tag.includes("..") && SHA.test(commitSha),
  }};
}
