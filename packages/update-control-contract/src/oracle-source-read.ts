/** Oracle -> authenticated MCP V3 agent: two fixed GitHub reads only.
 * Distinct from GET-only Update Center and mutating release-control WSS. */
export const ORACLE_SOURCE_CONNECT_PATH="/_internal/oracle-source-provider";
export const ORACLE_SOURCE_RPC_PATH="/_internal/oracle-source-rpc";
export const ORACLE_SOURCE_DISPATCH_PATH="/_internal/oracle-source-read";
export const ORACLE_SOURCE_SCOPE="oracle-source-provider-v1";
export const ORACLE_SOURCE_ORIGIN="https://mcp-v3-oracle-source-provider.invalid";
export const ORACLE_SOURCE_MAX_BODY_BYTES=512;
export const ORACLE_SOURCE_MAX_RESULT_BYTES=64*1024;
export const ORACLE_SOURCE_TIMEOUT_MS=15_000;
const SHA=/^[0-9a-f]{40}$/u;
const DIGEST=/^[0-9a-f]{64}$/u;

export type OracleSourceReadCommand =
  | {readonly method:"read_main_head";readonly arguments:Record<string,never>}
  | {readonly method:"read_commit_checks";readonly arguments:{readonly commitSha:string}};

export interface OracleSourceReadChecks {
  readonly commitSha:string;
  readonly totalCount:number;
  readonly returnedCount:number;
  readonly pendingCount:number;
  readonly successfulCount:number;
  readonly failingCount:number;
  readonly allCompleted:boolean;
  readonly truncated:boolean;
  readonly passed:boolean;
  readonly checks:readonly {readonly id:number;readonly name:string;readonly status:string;
    readonly conclusion:string|null}[];
}
function record(v:unknown):v is Record<string,unknown>{
  return v!==null && typeof v==="object" && !Array.isArray(v);
}
function keys(v:Record<string,unknown>,k:readonly string[]):boolean{
  return Object.keys(v).length===k.length && k.every(n=>Object.hasOwn(v,n));
}
export function parseOracleSourceCommand(value:unknown):OracleSourceReadCommand{
  if(!record(value) || !keys(value,["method","arguments"]) || !record(value.arguments))
    throw new Error("ORACLE_SOURCE_COMMAND_INVALID");
  if(value.method==="read_main_head" && keys(value.arguments,[])){
    return {method:"read_main_head",arguments:{}};
  }
  if(value.method==="read_commit_checks" && keys(value.arguments,["commitSha"]) &&
    typeof value.arguments.commitSha==="string" && SHA.test(value.arguments.commitSha)){
    return {method:"read_commit_checks",arguments:{commitSha:value.arguments.commitSha}};
  }
  throw new Error("ORACLE_SOURCE_COMMAND_INVALID");
}
export function parseOracleSourceResult(method:OracleSourceReadCommand["method"],value:unknown):
  string|OracleSourceReadChecks{
  if(method==="read_main_head"){
    if(typeof value!=="string" || !SHA.test(value))throw new Error("ORACLE_SOURCE_RESULT_INVALID");
    return value;
  }
  if(!record(value) ||
    !keys(value,["commitSha","totalCount","returnedCount","pendingCount","successfulCount",
      "failingCount","allCompleted","truncated","passed","checks"]) ||
    typeof value.commitSha!=="string" || !SHA.test(value.commitSha) ||
    !Array.isArray(value.checks) || value.checks.length>100 ||
    !["totalCount","returnedCount","pendingCount","successfulCount","failingCount"].every(k=>
      Number.isSafeInteger(value[k]) && (value[k] as number)>=0) ||
    typeof value.allCompleted!=="boolean" || typeof value.truncated!=="boolean" ||
    typeof value.passed!=="boolean"){
    throw new Error("ORACLE_SOURCE_RESULT_INVALID");
  }
  const counts=value as unknown as OracleSourceReadChecks;
  if(counts.returnedCount!==counts.checks.length ||
    counts.totalCount<counts.returnedCount ||
    counts.pendingCount+counts.successfulCount+counts.failingCount!==counts.returnedCount ||
    counts.truncated!==(counts.totalCount>counts.returnedCount) ||
    counts.allCompleted!==(counts.totalCount>0 && !counts.truncated && counts.pendingCount===0) ||
    counts.passed!==(counts.allCompleted && counts.failingCount===0) ||
    counts.checks.some(x=>!record(x)||!keys(x,["id","name","status","conclusion"])||
      !Number.isSafeInteger(x.id) || x.id<1 || typeof x.name!=="string" ||
      x.name.trim().length===0 || x.name.length>256 ||
      !["queued","in_progress","completed","unknown"].includes(x.status) ||
      (x.conclusion!==null && !["success","failure","neutral","cancelled","skipped",
        "timed_out","action_required","stale","startup_failure","unknown"].includes(x.conclusion))) ||
    new Set(counts.checks.map(x=>x.id)).size!==counts.checks.length){
    throw new Error("ORACLE_SOURCE_RESULT_INVALID");
  }
  return counts;
}
export function oracleSourceCanonicalBytes(bodyDigest:string,epoch:string):Uint8Array{
  if(!DIGEST.test(bodyDigest) || !/^(0|[1-9][0-9]{0,11})$/u.test(epoch))
    throw new Error("ORACLE_SOURCE_CANONICAL_INVALID");
  return new TextEncoder().encode(["mcp-v3:oracle-source-read:v1","POST",
    ORACLE_SOURCE_DISPATCH_PATH,epoch,bodyDigest].join("\n"));
}
function hex(b:Uint8Array):string{return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}
function unhex(s:string):Uint8Array{
  const bytes=new Uint8Array(s.length/2);
  for(let i=0;i<bytes.length;i++)bytes[i]=Number.parseInt(s.slice(i*2,i*2+2),16);
  return bytes;
}
function buffer(b:Uint8Array):ArrayBuffer{const x=new Uint8Array(b.byteLength);x.set(b);return x.buffer;}
export async function signOracleSourceRequest(
  command:OracleSourceReadCommand,keyHex:string,epoch=Math.floor(Date.now()/1000),
):Promise<{readonly body:string;readonly authorization:string}>{
  if(!DIGEST.test(keyHex))throw new Error("ORACLE_SOURCE_KEY_INVALID");
  const body=JSON.stringify(parseOracleSourceCommand(command));
  const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(body))));
  const key=await crypto.subtle.importKey("raw",buffer(unhex(keyHex)),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const tag=hex(new Uint8Array(await crypto.subtle.sign("HMAC",key,
    buffer(oracleSourceCanonicalBytes(digest,String(epoch))))));
  return {body,authorization:`HMAC-SHA256 source-v1=${epoch}.${tag}`};
}
