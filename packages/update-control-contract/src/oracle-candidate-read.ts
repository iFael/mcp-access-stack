/** Privately scoped Oracle candidate inspection over a dedicated read-only
 * WSS principal and signed Oracle->Worker RPC. Not a public MCP tool. */
export const ORACLE_CANDIDATE_CONNECT_PATH="/_internal/oracle-candidate-provider";
export const ORACLE_CANDIDATE_RPC_PATH="/_internal/oracle-candidate-rpc";
export const ORACLE_CANDIDATE_DISPATCH_PATH="/_internal/oracle-candidate-read";
export const ORACLE_CANDIDATE_SCOPE="oracle-candidate-provider-v1";
export const ORACLE_CANDIDATE_ORIGIN="https://mcp-v3-oracle-candidate-provider.invalid";
export const ORACLE_CANDIDATE_MAX_BODY_BYTES=512;
export const ORACLE_CANDIDATE_MAX_RESULT_BYTES=1024;
export const ORACLE_CANDIDATE_TIMEOUT_MS=20_000;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface OracleCandidateReadCommand {
  readonly method:"read_candidate";
  readonly arguments:{
    readonly tag:string;
    readonly commitSha:string;
    readonly runId:string;
    readonly operationId:string;
  };
}
export interface OracleCandidateReadReceipt {
  readonly releaseTag:string;
  readonly sourceCommitSha:string;
  readonly manifestSha256:string;
  readonly verifiedArtifactCount:number;
  readonly runId:string;
  readonly operationId:string;
}
function record(x:unknown):x is Record<string,unknown>{
  return !!x && typeof x==="object" && !Array.isArray(x);
}
function keys(x:Record<string,unknown>,list:readonly string[]):boolean {
  return Object.keys(x).length===list.length && list.every(key=>Object.hasOwn(x,key));
}
export function parseOracleCandidateCommand(value:unknown):OracleCandidateReadCommand{
  if(!record(value) || !keys(value,["method","arguments"]) ||
    value.method!=="read_candidate" || !record(value.arguments) ||
    !keys(value.arguments,["tag","commitSha","runId","operationId"]) ||
    typeof value.arguments.tag!=="string" || !TAG.test(value.arguments.tag) ||
    value.arguments.tag.includes("..") ||
    typeof value.arguments.commitSha!=="string" || !SHA.test(value.arguments.commitSha) ||
    typeof value.arguments.runId!=="string" || !UUID.test(value.arguments.runId) ||
    typeof value.arguments.operationId!=="string" || !UUID.test(value.arguments.operationId))
    throw new Error("ORACLE_CANDIDATE_COMMAND_INVALID");
  return {method:"read_candidate",arguments:{
    tag:value.arguments.tag,commitSha:value.arguments.commitSha,
    runId:value.arguments.runId,operationId:value.arguments.operationId}};
}
export function parseOracleCandidateReceipt(value:unknown):OracleCandidateReadReceipt{
  if(!record(value) || !keys(value,["releaseTag","sourceCommitSha","manifestSha256",
    "verifiedArtifactCount","runId","operationId"]) ||
    typeof value.releaseTag!=="string" || !TAG.test(value.releaseTag) ||
    value.releaseTag.includes("..") || typeof value.sourceCommitSha!=="string" ||
    !SHA.test(value.sourceCommitSha) || typeof value.manifestSha256!=="string" ||
    !DIGEST.test(value.manifestSha256) ||
    !Number.isSafeInteger(value.verifiedArtifactCount) ||
    (value.verifiedArtifactCount as number)<1 ||
    (value.verifiedArtifactCount as number)>64 ||
    typeof value.runId!=="string" || !UUID.test(value.runId) ||
    typeof value.operationId!=="string" || !UUID.test(value.operationId))
    throw new Error("ORACLE_CANDIDATE_RECEIPT_INVALID");
  return value as unknown as OracleCandidateReadReceipt;
}
export function oracleCandidateCanonicalBytes(digest:string,epoch:string):Uint8Array{
  if(!DIGEST.test(digest) || !/^(0|[1-9][0-9]{0,11})$/u.test(epoch))
    throw new Error("ORACLE_CANDIDATE_CANONICAL_INVALID");
  return new TextEncoder().encode(["mcp-v3:oracle-candidate-read:v1","POST",
    ORACLE_CANDIDATE_DISPATCH_PATH,epoch,digest].join("\n"));
}
function hex(bytes:Uint8Array):string{return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");}
function unhex(s:string):Uint8Array{
  const bytes=new Uint8Array(s.length/2);
  for(let i=0;i<bytes.length;i++)bytes[i]=Number.parseInt(s.slice(2*i,2*i+2),16);
  return bytes;
}
function toBuffer(bytes:Uint8Array):ArrayBuffer{const b=new Uint8Array(bytes.length);b.set(bytes);return b.buffer;}
export async function signOracleCandidateRequest(
  command:OracleCandidateReadCommand,keyHex:string,epoch=Math.floor(Date.now()/1000),
):Promise<{body:string;authorization:string}>{
  if(!DIGEST.test(keyHex))throw new Error("ORACLE_CANDIDATE_KEY_INVALID");
  const body=JSON.stringify(parseOracleCandidateCommand(command));
  const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(body))));
  const key=await crypto.subtle.importKey("raw",toBuffer(unhex(keyHex)),
    {name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=hex(new Uint8Array(await crypto.subtle.sign("HMAC",key,
    toBuffer(oracleCandidateCanonicalBytes(digest,String(epoch))))));
  return {body,authorization:`HMAC-SHA256 candidate-v1=${epoch}.${signature}`};
}
