import {
  ORACLE_SOURCE_DISPATCH_PATH,ORACLE_SOURCE_MAX_RESULT_BYTES,
  parseOracleSourceResult,signOracleSourceRequest,
  type OracleSourceReadChecks,type OracleSourceReadCommand,
} from "@mcp-access-stack/update-control-contract";
import type {ReleaseSourceControlReadPort} from "./release-source-control-read-capabilities.js";

const SHA=/^[a-f0-9]{40}$/u;
export interface OracleRemoteSourceReadOptions {
  readonly endpoint:string;
  /** Dedicated Oracle -> Worker read HMAC, never control/admin HMAC. */
  readonly key:()=>Promise<string>;
  readonly fetchImpl?:typeof fetch;
}
function allowEndpoint(raw:string):string {
  let url:URL;
  try{url=new URL(raw);}catch{throw new Error("ORACLE_SOURCE_ENDPOINT_INVALID");}
  if(url.protocol!=="https:" || !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    url.username || url.password || url.search || url.hash ||
    (url.port!=="" && url.port!=="443") || url.pathname!==ORACLE_SOURCE_DISPATCH_PATH){
    throw new Error("ORACLE_SOURCE_ENDPOINT_INVALID");
  }
  return url.href;
}
async function bounded(response:Response):Promise<unknown>{
  const reader=response.body?.getReader();
  if(!reader)throw new Error("ORACLE_SOURCE_RESPONSE_MISSING");
  let size=0;const chunks:Uint8Array[]=[];
  try{
    while(true){
      const next=await reader.read();
      if(next.done)break;
      size+=next.value.byteLength;
      if(size>ORACLE_SOURCE_MAX_RESULT_BYTES){await reader.cancel();throw new Error("ORACLE_SOURCE_RESPONSE_TOO_LARGE");}
      chunks.push(next.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let pos=0;
  for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}
  return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes)) as unknown;
}
/** Read-only Oracle-side port. Signed GET evidence transits Worker DO to
 * the already-authenticated MCP V3 workspace agent; no GitHub token or
 * repository identity is held by the Oracle single-writer. */
export class OracleRemoteSourceReadPort implements ReleaseSourceControlReadPort {
  private readonly endpoint:string;
  constructor(private readonly options:OracleRemoteSourceReadOptions){
    this.endpoint=allowEndpoint(options.endpoint);
  }
  private async read(command:OracleSourceReadCommand):Promise<unknown>{
    const signed=await signOracleSourceRequest(command,await this.options.key());
    const result=await (this.options.fetchImpl??fetch)(this.endpoint,{
      method:"POST",headers:{"authorization":signed.authorization,
        "content-type":"application/json"},
      body:signed.body,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12_000),
    });
    if(result.status!==200 || !/^application\/json\b/iu.test(result.headers.get("content-type")??"")){
      throw new Error("ORACLE_SOURCE_RESPONSE_UNVERIFIED");
    }
    const payload=await bounded(result);
    if(!payload || typeof payload!=="object" || Array.isArray(payload) ||
      Object.keys(payload).length!==1 || !Object.hasOwn(payload,"result")){
      throw new Error("ORACLE_SOURCE_RESPONSE_INVALID");
    }
    return (payload as {result:unknown}).result;
  }
  async readMainHead():Promise<string>{
    const value=await this.read({method:"read_main_head",arguments:{}});
    return parseOracleSourceResult("read_main_head",value) as string;
  }
  async readCommitChecks(commitSha:string):Promise<OracleSourceReadChecks>{
    if(!SHA.test(commitSha))throw new Error("ORACLE_SOURCE_SHA_INVALID");
    const value=await this.read({method:"read_commit_checks",arguments:{commitSha}});
    const parsed=parseOracleSourceResult("read_commit_checks",value) as OracleSourceReadChecks;
    if(parsed.commitSha!==commitSha)throw new Error("ORACLE_SOURCE_SHA_MISMATCH");
    return parsed;
  }
}
