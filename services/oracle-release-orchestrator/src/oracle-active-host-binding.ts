import {resolve} from "node:path";
import {readCredentialFromEnvironment} from "./oracle-channel-connector.js";
import {OracleRemoteActiveReadPort} from "./oracle-remote-active-read-port.js";

/** Independent opt-in Oracle ACTIVE read HMAC principal. This does not expose
 * a release mutation method and cannot reuse candidate or control secrets. */
export function resolveOracleRemoteActivePort(
  env:Readonly<Record<string,string|undefined>>,
):OracleRemoteActiveReadPort|undefined{
  const enabled=env.UPDATE_CONTROL_ORACLE_ACTIVE_ENABLED;
  const url=env.UPDATE_CONTROL_ORACLE_ACTIVE_URL;
  const file=env.UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE;
  if(enabled===undefined && url===undefined && file===undefined)return undefined;
  if(enabled!=="1" || !url?.trim() || !file?.trim())
    throw new Error("ORACLE_ACTIVE_HOST_INCOMPLETE");
  const forbidden=["UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE",
    "UPDATE_CONTROL_ORACLE_CONTROL_TOKEN_FILE",
    "UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE",
    "UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE",
    "UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE",
    "UPDATE_CONTROL_ORACLE_CONTROL_HMAC_FILE",
    "UPDATE_CONTROL_ADMIN_HMAC_FILE"];
  if(forbidden.some(name=>env[name]?.trim() && resolve(file)===resolve(env[name]!)))
    throw new Error("ORACLE_ACTIVE_HOST_CREDENTIAL_REUSED");
  const readKey=()=>{
    const value=readCredentialFromEnvironment(env,
      "UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE");
    if(!/^[a-f0-9]{64}$/u.test(value))
      throw new Error("ORACLE_ACTIVE_HOST_HMAC_INVALID");
    return value;
  };
  readKey();
  return new OracleRemoteActiveReadPort({endpoint:url,key:async()=>readKey()});
}
