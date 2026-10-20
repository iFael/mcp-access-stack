/** Reserved PRIVATE Windows read-only protocol. No route is installed by
 * this contract: Windows enrollment and effect-provenance are separate gates. */
export const WINDOWS_READ_CONNECT_PATH="/_internal/windows-read-provider";
export const WINDOWS_READ_RPC_PATH="/_internal/windows-read-rpc";
export const WINDOWS_READ_DISPATCH_PATH="/_internal/windows-read";
export const WINDOWS_READ_SCOPE="windows-read-provider-v1";
export const WINDOWS_READ_ORIGIN="https://mcp-v3-windows-read-provider.invalid";
export const WINDOWS_READ_MAX_BODY_BYTES=768;
export const WINDOWS_READ_MAX_RESULT_BYTES=2048;
export const WINDOWS_READ_TIMEOUT_MS=20_000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const object=(v:unknown):v is Record<string,unknown>=>v!==null &&
  typeof v==="object" && !Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:readonly string[]):boolean=>
  Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
export type WindowsReadCommand=
  | {readonly method:"get_state";readonly arguments:{readonly requestId:string}}
  | {readonly method:"inspect_candidate";readonly arguments:{
    readonly requestId:string;readonly tag:string;readonly commitSha:string;
    readonly runId:string;readonly operationId:string;readonly prepareOperationId:string}}
  | {readonly method:"inspect_active";readonly arguments:{
    readonly requestId:string;readonly tag:string;readonly commitSha:string}};
export type WindowsReadSlot={readonly releaseId:string;
  readonly manifestSha256:string}|null;
export type WindowsReadState={
  readonly active:WindowsReadSlot;readonly previous:WindowsReadSlot;
  readonly candidate:WindowsReadSlot;
};
export type WindowsReadProof={
  readonly scope:"local_hash_integrity_only";
  readonly releaseTag:string;readonly sourceCommitSha:string;
  readonly manifestSha256:string;readonly verifiedArtifactCount:number;
  readonly state:WindowsReadState;
  readonly localPrepareWitness?:{
    readonly kind:"local_candidate_prepare";readonly runId:string;
    readonly prepareOperationId:string;readonly releaseId:string;
    readonly manifestSha256:string;
  };
};
export type WindowsReadResult=
  | {readonly method:"get_state";readonly requestId:string;
    readonly scope:"local_hash_integrity_only";readonly state:WindowsReadState}
  | {readonly method:"inspect_candidate"|"inspect_active";
    readonly requestId:string;readonly proof:WindowsReadProof};
function pointer(v:unknown):WindowsReadSlot{
  if(v===null)return null;
  if(!object(v) || !exact(v,["releaseId","manifestSha256"]) ||
    typeof v.releaseId!=="string" || !ID.test(v.releaseId) ||
    v.releaseId.includes("..") || typeof v.manifestSha256!=="string" ||
    !DIGEST.test(v.manifestSha256))
    throw new Error("WINDOWS_READ_POINTER_INVALID");
  return {releaseId:v.releaseId,manifestSha256:v.manifestSha256};
}
function state(v:unknown):WindowsReadState{
  if(!object(v) || !exact(v,["active","previous","candidate"]))
    throw new Error("WINDOWS_READ_STATE_INVALID");
  const result={active:pointer(v.active),previous:pointer(v.previous),
    candidate:pointer(v.candidate)};
  if(result.active?.releaseId===result.candidate?.releaseId && result.active!==null ||
    result.active?.releaseId===result.previous?.releaseId && result.active!==null)
    throw new Error("WINDOWS_READ_POINTER_CONFLICT");
  return result;
}
export function parseWindowsReadCommand(v:unknown):WindowsReadCommand{
  if(!object(v) || !exact(v,["method","arguments"]) || !object(v.arguments) ||
    typeof v.arguments.requestId!=="string" ||
    !UUID.test(v.arguments.requestId))
    throw new Error("WINDOWS_READ_COMMAND_INVALID");
  if(v.method==="get_state" && exact(v.arguments,["requestId"]))
    return {method:"get_state",arguments:{requestId:v.arguments.requestId}};
  if((v.method==="inspect_active" || v.method==="inspect_candidate") &&
    typeof v.arguments.tag==="string" && TAG.test(v.arguments.tag) &&
    !v.arguments.tag.includes("..") && typeof v.arguments.commitSha==="string" &&
    SHA.test(v.arguments.commitSha)){
    if(v.method==="inspect_active" &&
      exact(v.arguments,["requestId","tag","commitSha"]))
      return {method:"inspect_active",arguments:{
        requestId:v.arguments.requestId,tag:v.arguments.tag,
        commitSha:v.arguments.commitSha}};
    if(v.method==="inspect_candidate" &&
      exact(v.arguments,["requestId","tag","commitSha","runId","operationId",
        "prepareOperationId"]) &&
      typeof v.arguments.runId==="string" && UUID.test(v.arguments.runId) &&
      typeof v.arguments.operationId==="string" && UUID.test(v.arguments.operationId) &&
      typeof v.arguments.prepareOperationId==="string" &&
      UUID.test(v.arguments.prepareOperationId))
      return {method:"inspect_candidate",arguments:{
        requestId:v.arguments.requestId,tag:v.arguments.tag,
        commitSha:v.arguments.commitSha,runId:v.arguments.runId,
        operationId:v.arguments.operationId,
        prepareOperationId:v.arguments.prepareOperationId}};
  }
  throw new Error("WINDOWS_READ_COMMAND_INVALID");
}
/** Typed parsing never upgrades the local result to a verified release receipt. */
export function parseWindowsReadResult(command:WindowsReadCommand,
  v:unknown):WindowsReadResult{
  if(!object(v) || v.method!==command.method ||
    v.requestId!==command.arguments.requestId)
    throw new Error("WINDOWS_READ_CORRELATION_INVALID");
  if(command.method==="get_state"){
    if(!exact(v,["method","requestId","scope","state"]) ||
      v.scope!=="local_hash_integrity_only")
      throw new Error("WINDOWS_READ_SCOPE_INVALID");
    return {method:"get_state",requestId:command.arguments.requestId,
      scope:"local_hash_integrity_only",state:state(v.state)};
  }
  if(!exact(v,["method","requestId","proof"]) || !object(v.proof) ||
    v.proof.scope!=="local_hash_integrity_only" ||
    !object(v.proof.state))
    throw new Error("WINDOWS_READ_PROOF_INVALID");
  const proof=v.proof;
  const expected=["scope","releaseTag","sourceCommitSha","manifestSha256",
    "verifiedArtifactCount","state"];
  const candidate=command.method==="inspect_candidate";
  if(!exact(proof,candidate?[...expected,"localPrepareWitness"]:expected) ||
    proof.releaseTag!==command.arguments.tag ||
    proof.sourceCommitSha!==command.arguments.commitSha ||
    typeof proof.manifestSha256!=="string" || !DIGEST.test(proof.manifestSha256) ||
    !Number.isSafeInteger(proof.verifiedArtifactCount) ||
    (proof.verifiedArtifactCount as number)<1 ||
    (proof.verifiedArtifactCount as number)>64)
    throw new Error("WINDOWS_READ_PROOF_MISMATCH");
  const positions=state(proof.state);
  const selected=candidate?positions.candidate:positions.active;
  if(selected?.releaseId!==command.arguments.tag.slice(1) ||
    selected.manifestSha256!==proof.manifestSha256 ||
    !candidate && (positions.candidate!==null || positions.previous===null))
    throw new Error("WINDOWS_READ_RELEASE_MISMATCH");
  let witness:WindowsReadProof["localPrepareWitness"];
  if(candidate){
    const expectedArgs=command.arguments;
    const vWitness=proof.localPrepareWitness;
    if(!object(vWitness) ||
      !exact(vWitness,["kind","runId","prepareOperationId",
        "releaseId","manifestSha256"]) ||
      vWitness.kind!=="local_candidate_prepare" ||
      vWitness.runId!==expectedArgs.runId ||
      vWitness.prepareOperationId!==expectedArgs.prepareOperationId ||
      vWitness.releaseId!==selected.releaseId ||
      vWitness.manifestSha256!==selected.manifestSha256)
      throw new Error("WINDOWS_READ_PREPARE_WITNESS_INVALID");
    witness={kind:"local_candidate_prepare",
      runId:expectedArgs.runId,prepareOperationId:expectedArgs.prepareOperationId,
      releaseId:selected.releaseId,manifestSha256:selected.manifestSha256};
  }
  return {method:command.method,requestId:command.arguments.requestId,
    proof:{scope:"local_hash_integrity_only",
      releaseTag:command.arguments.tag,sourceCommitSha:command.arguments.commitSha,
      manifestSha256:selected.manifestSha256,
      verifiedArtifactCount:proof.verifiedArtifactCount as number,state:positions,
      ...(witness?{localPrepareWitness:witness}:{})}};
}
function buffer(value:Uint8Array):ArrayBuffer{
  const copy=new Uint8Array(value.length);copy.set(value);return copy.buffer;
}
function hex(value:Uint8Array):string{
  return [...value].map(b=>b.toString(16).padStart(2,"0")).join("");
}
function unhex(v:string):Uint8Array{
  const b=new Uint8Array(v.length/2);
  for(let i=0;i<b.length;i++)b[i]=Number.parseInt(v.slice(i*2,i*2+2),16);
  return b;
}
export function windowsReadCanonicalBytes(digest:string,epoch:string):Uint8Array{
  if(!DIGEST.test(digest) || !/^(0|[1-9][0-9]{0,11})$/u.test(epoch))
    throw new Error("WINDOWS_READ_CANONICAL_INVALID");
  return new TextEncoder().encode(["mcp-v3:windows-read:v1",
    "POST",WINDOWS_READ_DISPATCH_PATH,epoch,digest].join("\n"));
}
export async function signWindowsReadRequest(command:WindowsReadCommand,
  keyHex:string,epoch=Math.floor(Date.now()/1000)){
  if(!DIGEST.test(keyHex))throw new Error("WINDOWS_READ_KEY_INVALID");
  const body=JSON.stringify(parseWindowsReadCommand(command));
  const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",
    buffer(new TextEncoder().encode(body)))));
  const key=await crypto.subtle.importKey("raw",buffer(unhex(keyHex)),
    {name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=hex(new Uint8Array(await crypto.subtle.sign("HMAC",key,
    buffer(windowsReadCanonicalBytes(digest,String(epoch))))));
  return {body,authorization:`HMAC-SHA256 windows-read-v1=${epoch}.${signature}`};
}
