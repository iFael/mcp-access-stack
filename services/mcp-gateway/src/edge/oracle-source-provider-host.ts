import {constants} from "node:fs";
import {lstat,open,realpath} from "node:fs/promises";
import {dirname,isAbsolute} from "node:path";
import {AppError} from "@vs-code-gpt/shared";
import {
  ORACLE_SOURCE_CONNECT_PATH,
} from "@mcp-access-stack/update-control-contract";
import type {OracleReleaseGitHubReadConfig} from "@vs-code-gpt/local-agent";
import type {OracleSourceProviderOptions,OracleSourceProviderPort} from "./oracle-source-provider.js";

const PREFIX="MCP_V3_ORACLE_SOURCE_PROVIDER_";
const TOKEN=/^[A-Za-z0-9_.-]{32,256}$/u;
export async function loadOracleSourceProviderFromEnvironment(
  env:Readonly<Record<string,string|undefined>>,
  makePort:(config:OracleReleaseGitHubReadConfig)=>OracleSourceProviderPort,
):Promise<OracleSourceProviderOptions|undefined>{
  const fields=["ENABLED","URL","TOKEN_FILE","OWNER","REPOSITORY","OWNER_SCOPE"] as const;
  const names=fields.map(x=>PREFIX+x);
  if(!names.some(n=>env[n]!==undefined))return undefined;
  if(process.platform!=="linux" || env[PREFIX+"ENABLED"]!=="1")
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle source provider is not enabled for Linux.");
  const urlRaw=env[PREFIX+"URL"]?.trim();
  const file=env[PREFIX+"TOKEN_FILE"]?.trim();
  const owner=env[PREFIX+"OWNER"]?.trim();
  const repository=env[PREFIX+"REPOSITORY"]?.trim();
  const ownerScope=env[PREFIX+"OWNER_SCOPE"];
  if(!urlRaw || !file || !owner || !repository || !ownerScope ||
    !/^[A-Za-z0-9-]{1,100}$/u.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(repository) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(ownerScope)){
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle source provider host policy is incomplete.");
  }
  let url:URL;
  try{url=new URL(urlRaw);}catch{throw new AppError("CAPABILITY_UNSUPPORTED","Oracle source provider URL invalid.");}
  if(url.protocol!=="wss:" || !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    (url.port!=="" && url.port!=="443") || url.pathname!==ORACLE_SOURCE_CONNECT_PATH ||
    url.username || url.password || url.search || url.hash){
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle source provider URL invalid.");
  }
  let token:string;
  try{
    if(!isAbsolute(file))throw new Error("absolute required");
    const before=await lstat(file);
    if(!before.isFile() || before.isSymbolicLink() || before.size<32 || before.size>258)
      throw new Error("not regular");
    const mode=before.mode&0o777;
    const dir=env.CREDENTIALS_DIRECTORY;
    const systemd=mode===0o440 && dir!==undefined && isAbsolute(dir) &&
      (await realpath(dirname(file)))===(await realpath(dir));
    if((mode&0o077)!==0 && !systemd)throw new Error("permissions");
    const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
    try{
      const after=await handle.stat();
      if(after.ino!==before.ino || after.dev!==before.dev || !after.isFile() ||
        after.size!==before.size)throw new Error("changed");
      const raw=await handle.readFile("utf8");
      token=raw.endsWith("\r\n")?raw.slice(0,-2):raw.endsWith("\n")?raw.slice(0,-1):raw;
      if(!TOKEN.test(token))throw new Error("invalid");
    }finally{await handle.close();}
  }catch{throw new AppError("CAPABILITY_UNSUPPORTED","Oracle source provider credential unavailable.");}
  // Repository identity is host-owned and cannot be selected over WebSocket.
  const port=makePort({workspaceId:"mcp-access-stack",owner,repository,ownerScope});
  return {url,token,port};
}
