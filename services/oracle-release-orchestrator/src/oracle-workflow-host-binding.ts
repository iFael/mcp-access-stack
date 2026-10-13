import {resolve} from "node:path";
import {readCredentialFromEnvironment} from "./oracle-channel-connector.js";
import {OracleRemoteWorkflowPort} from "./oracle-remote-workflow-port.js";

const KEY=/^[a-f0-9]{64}$/u;
const COMPETING_CREDENTIALS=[
  "UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE",
  "UPDATE_CONTROL_ORACLE_CONTROL_TOKEN_FILE",
  "UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE",
  "UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN_FILE",
] as const;

/** Host opt-in, independent of source-read and control credentials.
 * The Oracle owns a fixed GitHub repository identity and never transports
 * owner, workspace or host scope as request arguments. */
export function resolveOracleRemoteWorkflowPort(
  environment:Readonly<Record<string,string|undefined>>,
):OracleRemoteWorkflowPort|undefined {
  const prefix="UPDATE_CONTROL_ORACLE_WORKFLOW_";
  const vars=["ENABLED","URL","HMAC_FILE","OWNER","REPOSITORY"] as const;
  if(!vars.some(v=>environment[prefix+v]!==undefined))return undefined;
  const enabled=environment[prefix+"ENABLED"];
  const endpoint=environment[prefix+"URL"];
  const file=environment[prefix+"HMAC_FILE"];
  const owner=environment[prefix+"OWNER"];
  const repository=environment[prefix+"REPOSITORY"];
  if(enabled!=="1" || !endpoint?.trim() || !file?.trim() ||
     !owner?.trim() || !repository?.trim())
    throw new Error("ORACLE_WORKFLOW_HOST_CONFIG_INCOMPLETE");
  const read=():string=>{
    const key=readCredentialFromEnvironment(environment,
      "UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE");
    if(!KEY.test(key))throw new Error("ORACLE_WORKFLOW_HOST_HMAC_INVALID");
    for(const name of COMPETING_CREDENTIALS){
      const competing=environment[name]?.trim();
      if(!competing)continue;
      if(resolve(competing)===resolve(file))
        throw new Error("ORACLE_WORKFLOW_HOST_CREDENTIAL_REUSED");
      // Two separate paths containing the same HMAC must not erase domain
      // isolation. Existing protected-reader constraints still apply.
      const other=readCredentialFromEnvironment(environment,name);
      if(key===other)throw new Error("ORACLE_WORKFLOW_HOST_CREDENTIAL_REUSED");
    }
    return key;
  };
  read();
  return new OracleRemoteWorkflowPort({
    endpoint,key:async()=>read(),workspaceId:"mcp-access-stack",owner,repository,
  });
}
