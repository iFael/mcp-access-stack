import {lstatSync,readFileSync,realpathSync} from "node:fs";
import {dirname,isAbsolute,resolve} from "node:path";
import {WindowsRemoteReadPort} from "./windows-remote-read-port.js";

const NAMES=["UPDATE_CONTROL_WINDOWS_READ_ENABLED",
  "UPDATE_CONTROL_WINDOWS_READ_URL","UPDATE_CONTROL_WINDOWS_READ_HMAC_FILE"] as const;
const OTHER=["UPDATE_CONTROL_ORACLE_CONTROL_TOKEN_FILE",
  "UPDATE_CONTROL_ORACLE_SOURCE_HMAC_FILE",
  "UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_FILE",
  "UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_FILE",
  "UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_FILE",
  "UPDATE_CONTROL_ORCHESTRATOR_TOKEN_FILE",
  "UPDATE_CONTROL_ADMIN_HMAC_FILE",
  "UPDATE_CONTROL_WINDOWS_PREPARE_HMAC_FILE"] as const;
/** This only creates an isolated prospective reader. No Worker route or
 * trustedExecution capability is registered by this function. */
export function resolveWindowsRemoteReadPort(
  env:Readonly<Record<string,string|undefined>>,
  fetchImpl?:typeof fetch,
):WindowsRemoteReadPort|undefined{
  if(NAMES.every(k=>env[k]===undefined))return undefined;
  const filename=env.UPDATE_CONTROL_WINDOWS_READ_HMAC_FILE?.trim();
  const endpoint=env.UPDATE_CONTROL_WINDOWS_READ_URL?.trim();
  if(env.UPDATE_CONTROL_WINDOWS_READ_ENABLED!=="1" ||
    !filename || !endpoint || !isAbsolute(filename))
    throw new Error("WINDOWS_READ_HOST_INCOMPLETE");
  if(OTHER.some(k=>env[k]?.trim() &&
    resolve(env[k]!)===resolve(filename)))
    throw new Error("WINDOWS_READ_HOST_CREDENTIAL_REUSED");
  const key=()=>{
    try{
      const before=lstatSync(filename);
      if(!before.isFile() || before.isSymbolicLink() ||
        before.size<64 || before.size>66)throw new Error("file");
      const mode=before.mode&0o777;
      const sysd=mode===0o440 && !!env.CREDENTIALS_DIRECTORY &&
        isAbsolute(env.CREDENTIALS_DIRECTORY) &&
        realpathSync(dirname(filename))===realpathSync(env.CREDENTIALS_DIRECTORY);
      if((mode&0o077)!==0 && !sysd)throw new Error("mode");
      const raw=readFileSync(filename,"utf8");
      const hex=raw.endsWith("\r\n")?raw.slice(0,-2):
        raw.endsWith("\n")?raw.slice(0,-1):raw;
      if(!/^[a-f0-9]{64}$/u.test(hex))throw new Error("key");
      const after=lstatSync(filename);
      if(before.ino!==after.ino || before.dev!==after.dev ||
        before.size!==after.size || before.mtimeMs!==after.mtimeMs)
        throw new Error("changed");
      return hex;
    }catch{throw new Error("WINDOWS_READ_HOST_CREDENTIAL_INVALID");}
  };
  const port=new WindowsRemoteReadPort({endpoint,key:async()=>key(),
    ...(fetchImpl?{fetchImpl}:{})});
  key();
  return port;
}
