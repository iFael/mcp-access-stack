import {randomUUID} from "node:crypto";
import {ORACLE_ACTIVE_DISPATCH_PATH,ORACLE_ACTIVE_MAX_RESULT_BYTES,
  parseOracleActiveResult,signOracleActiveRequest,
  type OracleActiveReadCommand,type OracleActiveReadResult,
  type OracleActiveManifest,type OracleActiveState}
  from "@mcp-access-stack/update-control-contract";
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
export interface OracleRemoteActiveOptions{
  readonly endpoint:string;
  readonly key:()=>Promise<string>;
  readonly fetchImpl?:typeof fetch;
}
function endpoint(raw:string):string{
  const u=new URL(raw);
  if(u.protocol!=="https:" || !u.hostname.toLowerCase().endsWith(".workers.dev") ||
    u.username || u.password || u.search || u.hash ||
    (u.port!=="" && u.port!=="443") || u.pathname!==ORACLE_ACTIVE_DISPATCH_PATH)
    throw new Error("ORACLE_ACTIVE_ENDPOINT_INVALID");
  return u.href;
}
async function bounded(response:Response):Promise<unknown>{
  const reader=response.body?.getReader();
  if(!reader)throw new Error("ORACLE_ACTIVE_RESPONSE_MISSING");
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>ORACLE_ACTIVE_MAX_RESULT_BYTES){
        await reader.cancel();throw new Error("ORACLE_ACTIVE_RESPONSE_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let pos=0;
  for(const part of chunks){bytes.set(part,pos);pos+=part.byteLength;}
  return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes)) as unknown;
}
/** Read-only HMAC principal; independent of candidate and control credentials. */
export class OracleRemoteActiveReadPort{
  readonly endpoint:string;
  constructor(private readonly options:OracleRemoteActiveOptions){
    this.endpoint=endpoint(options.endpoint);
  }
  private async read(command:OracleActiveReadCommand):Promise<OracleActiveReadResult>{
    const signed=await signOracleActiveRequest(command,await this.options.key());
    const response=await (this.options.fetchImpl??fetch)(this.endpoint,{
      method:"POST",headers:{authorization:signed.authorization,
        "content-type":"application/json"},body:signed.body,
      cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15_000),
    });
    if(response.status!==200 ||
      !/^application\/json\b/iu.test(response.headers.get("content-type")??""))
      throw new Error("ORACLE_ACTIVE_RESPONSE_UNVERIFIED");
    const payload=await bounded(response);
    if(!payload || typeof payload!=="object" || Array.isArray(payload) ||
      Object.keys(payload).length!==1 || !Object.hasOwn(payload,"result"))
      throw new Error("ORACLE_ACTIVE_RESPONSE_INVALID");
    const result=parseOracleActiveResult(command.method,
      (payload as {result:unknown}).result);
    if(result.requestId!==command.arguments.requestId)
      throw new Error("ORACLE_ACTIVE_REQUEST_ID_MISMATCH");
    return result;
  }
  async inspectActive(tag:string,commitSha:string):Promise<OracleActiveManifest>{
    if(!TAG.test(tag) || tag.includes("..") || !SHA.test(commitSha))
      throw new Error("ORACLE_ACTIVE_INSPECT_INVALID");
    const response=await this.read({method:"inspect_active",
      arguments:{tag,commitSha,requestId:randomUUID()}});
    if(response.method!=="inspect_active" || response.manifest.releaseTag!==tag ||
      response.manifest.sourceCommitSha!==commitSha)
      throw new Error("ORACLE_ACTIVE_INSPECT_MISMATCH");
    return response.manifest;
  }
  async getState():Promise<OracleActiveState>{
    const response=await this.read({method:"get_state",
      arguments:{requestId:randomUUID()}});
    if(response.method!=="get_state")throw new Error("ORACLE_ACTIVE_STATE_MISMATCH");
    return response.state;
  }
}
