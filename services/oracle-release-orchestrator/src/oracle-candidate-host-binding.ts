import {resolve} from "node:path";
import {readCredentialFromEnvironment} from "./oracle-channel-connector.js";
import {OracleRemoteCandidateReadPort} from "./oracle-remote-candidate-read-port.js";

/** A dedicated read HMAC, independently provisioned from publication,
 * cleanup, admin or control. The Oracle ledger owns neither filesystem paths
 * nor execution-node credentials. No default enrollment. */
export function resolveOracleRemoteCandidatePort(
  env:Readonly<Record<string,string|undefined>>,
):OracleRemoteCandidateReadPort|undefined{
  const enabled=env.UPDATE_CONTROL_ORACLE_CANDIDATE_ENABLED;
  const url=env.UPDATE_CONTROL_ORACLE_CANDIDATE_URL;
  const file=env.UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE;
  if(enabled===undefined && url===undefined && file===undefined)return undefined;
  if(enabled!=="1" || !url?.trim() || !file?.trim())
    throw new Error("ORACLE_CANDIDATE_HOST_INCOMPLETE");
  const forbidden=["UPDATE_CONTROL_ORACLE_CONTROL_TOKEN_FILE",
    "UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE",
    "UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE",
    "UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE",
    "UPDATE_CONTROL_ADMIN_HMAC_FILE"];
  if(forbidden.some(name=>env[name]?.trim() && resolve(file)===resolve(env[name]!)))
    throw new Error("ORACLE_CANDIDATE_HOST_CREDENTIAL_REUSED");
  const readKey=()=>{
    const value=readCredentialFromEnvironment(env,
      "UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE");
    if(!/^[a-f0-9]{64}$/u.test(value))
      throw new Error("ORACLE_CANDIDATE_HOST_HMAC_INVALID");
    return value;
  };
  readKey();
  return new OracleRemoteCandidateReadPort({
    endpoint:url,key:async()=>readKey(),
  });
}
