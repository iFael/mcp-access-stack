import {readCredentialFromEnvironment} from "./oracle-channel-connector.js";
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
