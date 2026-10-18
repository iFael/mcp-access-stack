/** Isolated read-only Oracle ACTIVE evidence realm. No arbitrary path, command,
 * process action or use of candidate/source/control credentials. */
export const ORACLE_ACTIVE_CONNECT_PATH="/_internal/oracle-active-provider";
export const ORACLE_ACTIVE_RPC_PATH="/_internal/oracle-active-rpc";
export const ORACLE_ACTIVE_DISPATCH_PATH="/_internal/oracle-active-read";
export const ORACLE_ACTIVE_SCOPE="oracle-active-provider-v1";
export const ORACLE_ACTIVE_ORIGIN="https://mcp-v3-oracle-active-provider.invalid";
export const ORACLE_ACTIVE_MAX_BODY_BYTES=512;
export const ORACLE_ACTIVE_MAX_RESULT_BYTES=2048;
export const ORACLE_ACTIVE_TIMEOUT_MS=20_000;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export type OracleActiveReadCommand =
  | {readonly method:"inspect_active";readonly arguments:{
      readonly tag:string;readonly commitSha:string;readonly requestId:string}}
  | {readonly method:"get_state";readonly arguments:{readonly requestId:string}};
export interface OracleActiveManifest {
  readonly releaseTag:string;
  readonly sourceCommitSha:string;
  readonly manifestSha256:string;
  readonly verifiedArtifactCount:number;
}
export interface OracleActivePointer {
  readonly releaseId:string;readonly manifestSha256:string;
}
export interface OracleActiveState {
  readonly active:OracleActivePointer|null;
  readonly previous:OracleActivePointer|null;
  readonly candidate:OracleActivePointer|null;
}
export type OracleActiveReadResult =
  | {readonly method:"inspect_active";readonly requestId:string;
      readonly manifest:OracleActiveManifest}
  | {readonly method:"get_state";readonly requestId:string;
      readonly state:OracleActiveState};
function object(x:unknown):x is Record<string,unknown>{
  return !!x && typeof x==="object" && !Array.isArray(x);
}
function keys(x:Record<string,unknown>,allowed:readonly string[]):boolean{
  return Object.keys(x).length===allowed.length &&
    allowed.every(k=>Object.hasOwn(x,k));
}
function manifest(value:unknown):OracleActiveManifest{
  if(!object(value) ||
    !keys(value,["releaseTag","sourceCommitSha","manifestSha256","verifiedArtifactCount"]) ||
    typeof value.releaseTag!=="string" || !TAG.test(value.releaseTag) ||
    value.releaseTag.includes("..") || typeof value.sourceCommitSha!=="string" ||
    !SHA.test(value.sourceCommitSha) || typeof value.manifestSha256!=="string" ||
    !DIGEST.test(value.manifestSha256) ||
    !Number.isSafeInteger(value.verifiedArtifactCount) ||
    (value.verifiedArtifactCount as number)<1 ||
    (value.verifiedArtifactCount as number)>64)
    throw new Error("ORACLE_ACTIVE_MANIFEST_INVALID");
  return value as unknown as OracleActiveManifest;
}
function slot(value:unknown):OracleActivePointer|null{
  if(value===null)return null;
  if(!object(value) || !keys(value,["releaseId","manifestSha256"]) ||
    typeof value.releaseId!=="string" || !ID.test(value.releaseId) ||
    value.releaseId.includes("..") ||
    typeof value.manifestSha256!=="string" || !DIGEST.test(value.manifestSha256))
    throw new Error("ORACLE_ACTIVE_POINTER_INVALID");
  return value as unknown as OracleActivePointer;
}
export function parseOracleActiveCommand(value:unknown):OracleActiveReadCommand{
  if(!object(value) || !keys(value,["method","arguments"]) ||
    !object(value.arguments) || typeof value.arguments.requestId!=="string" ||
    !UUID.test(value.arguments.requestId))throw new Error("ORACLE_ACTIVE_COMMAND_INVALID");
  if(value.method==="get_state" && keys(value.arguments,["requestId"]))
    return {method:"get_state",arguments:{requestId:value.arguments.requestId}};
  if(value.method==="inspect_active" &&
    keys(value.arguments,["tag","commitSha","requestId"]) &&
    typeof value.arguments.tag==="string" && TAG.test(value.arguments.tag) &&
    !value.arguments.tag.includes("..") &&
    typeof value.arguments.commitSha==="string" && SHA.test(value.arguments.commitSha))
    return {method:"inspect_active",arguments:{
      tag:value.arguments.tag,commitSha:value.arguments.commitSha,
      requestId:value.arguments.requestId}};
  throw new Error("ORACLE_ACTIVE_COMMAND_INVALID");
}
export function parseOracleActiveResult(method:OracleActiveReadCommand["method"],
  value:unknown):OracleActiveReadResult{
  if(!object(value) || typeof value.requestId!=="string" ||
    !UUID.test(value.requestId) || value.method!==method)
    throw new Error("ORACLE_ACTIVE_RESULT_INVALID");
  if(method==="inspect_active" && keys(value,["method","requestId","manifest"]))
    return {method,requestId:value.requestId,manifest:manifest(value.manifest)};
  if(method==="get_state" && keys(value,["method","requestId","state"]) &&
    object(value.state) && keys(value.state,["active","previous","candidate"])){
    const state={active:slot(value.state.active),previous:slot(value.state.previous),
      candidate:slot(value.state.candidate)};
    if(state.active && (state.active.releaseId===state.previous?.releaseId ||
      state.active.releaseId===state.candidate?.releaseId))
      throw new Error("ORACLE_ACTIVE_STATE_CONFLICT");
    return {method,requestId:value.requestId,state};
  }
  throw new Error("ORACLE_ACTIVE_RESULT_INVALID");
}
function bytes(value:Uint8Array):ArrayBuffer{
  const copy=new Uint8Array(value.length);copy.set(value);return copy.buffer;
}
function hex(value:Uint8Array):string{
  return [...value].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function unhex(value:string):Uint8Array{
  const result=new Uint8Array(value.length/2);
  for(let i=0;i<result.length;i++)result[i]=Number.parseInt(value.slice(i*2,i*2+2),16);
  return result;
}
export function oracleActiveCanonicalBytes(digest:string,epoch:string):Uint8Array{
  if(!DIGEST.test(digest) || !/^(0|[1-9][0-9]{0,11})$/u.test(epoch))
    throw new Error("ORACLE_ACTIVE_CANONICAL_INVALID");
  return new TextEncoder().encode(["mcp-v3:oracle-active-read:v1",
    "POST",ORACLE_ACTIVE_DISPATCH_PATH,epoch,digest].join("\n"));
}
export async function signOracleActiveRequest(command:OracleActiveReadCommand,
  keyHex:string,epoch=Math.floor(Date.now()/1000)){
  if(!DIGEST.test(keyHex))throw new Error("ORACLE_ACTIVE_KEY_INVALID");
  const body=JSON.stringify(parseOracleActiveCommand(command));
  const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",
    bytes(new TextEncoder().encode(body)))));
  const key=await crypto.subtle.importKey("raw",bytes(unhex(keyHex)),
    {name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=hex(new Uint8Array(await crypto.subtle.sign("HMAC",key,
    bytes(oracleActiveCanonicalBytes(digest,String(epoch))))));
  return {body,authorization:`HMAC-SHA256 active-v1=${epoch}.${signature}`};
}
