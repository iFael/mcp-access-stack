/** Domain-separated Oracle -> MCP release workflow transport.
 * Mutation authorization/receipts stay exclusively in the authenticated
 * LocalAgent. The wire NEVER contains repository, root or ownerScope. */
export const ORACLE_WORKFLOW_DISPATCH_PATH="/_internal/oracle-workflow-dispatch";
export const ORACLE_WORKFLOW_CONNECT_PATH="/_internal/oracle-workflow-provider";
export const ORACLE_WORKFLOW_RPC_PATH="/_internal/oracle-workflow-rpc";
export const ORACLE_WORKFLOW_SCOPE="oracle-workflow-provider-v1";
export const ORACLE_WORKFLOW_ORIGIN="https://mcp-v3-oracle-workflow-provider.invalid";
export const ORACLE_WORKFLOW_MAX_BODY_BYTES=768;
export const ORACLE_WORKFLOW_MAX_RESULT_BYTES=4*1024;
export const ORACLE_WORKFLOW_TIMEOUT_MS=15_000;

const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/u;
function validTag(v:unknown):v is string {
  return typeof v==="string" && v.length<=128 && TAG.test(v) &&
    !v.includes("-oracle.") && !v.includes("-companion.");
}
function record(v:unknown):v is Record<string,unknown>{
  return v!==null && typeof v==="object" && !Array.isArray(v);
}
function keys(v:Record<string,unknown>,names:readonly string[]):boolean {
  return Object.keys(v).length===names.length && names.every(n=>Object.hasOwn(v,n));
}
export type OracleWorkflowCommand=
 | {readonly method:"workflow_operation";readonly arguments:{
    readonly workflow:"release-tag-bootstrap.yml"|"release.yml";
    readonly mode:"dispatch"|"reconcile";readonly tag:string;readonly expectedMainSha:string;
    readonly operationId:string;readonly bootstrapOperationId?:string;
 }}
 | {readonly method:"verify_lightweight_tag";readonly arguments:{
    readonly tag:string;readonly commitSha:string;
 }}
 | {readonly method:"inspect_distribution";readonly arguments:{
    readonly runId:number;readonly tag:string;readonly commitSha:string;
 }};
export type OracleWorkflowObservation=
 | {readonly status:"submitted"|"outcome_unknown";readonly operationId:string}
 | {readonly status:"observed";readonly operationId:string;readonly runId:number;
    readonly state:"queued"|"in_progress"|"completed";readonly conclusion:string|null};

/** Bounded, independently inspected GitHub release inventory; NOT a package signature. */
export interface OracleDistributionInspection {
  readonly sourceCommitSha:string;
  readonly releaseTag:string;
  readonly workflowRunId:number;
  readonly integrityVerified:true;
  readonly releasePublished:true;
  readonly verifiedAssetCount:number;
  readonly assetInventorySha256:string;
}

export function parseOracleWorkflowCommand(value:unknown):OracleWorkflowCommand {
  if(!record(value) || !keys(value,["method","arguments"]) || !record(value.arguments))
    throw new Error("ORACLE_WORKFLOW_COMMAND_INVALID");
  const a=value.arguments;
  if(value.method==="verify_lightweight_tag" && keys(a,["tag","commitSha"]) &&
    validTag(a.tag) && typeof a.commitSha==="string" && SHA.test(a.commitSha)){
    return {method:"verify_lightweight_tag",arguments:{tag:a.tag,commitSha:a.commitSha}};
  }
  if(value.method==="inspect_distribution" &&
    keys(a,["runId","tag","commitSha"]) &&
    Number.isSafeInteger(a.runId) && (a.runId as number)>0 &&
    validTag(a.tag) && typeof a.commitSha==="string" && SHA.test(a.commitSha)){
    return {method:"inspect_distribution",arguments:{
      runId:a.runId as number,tag:a.tag,commitSha:a.commitSha}};
  }
  if(value.method==="workflow_operation" &&
    (keys(a,["workflow","mode","tag","expectedMainSha","operationId"]) ||
      keys(a,["workflow","mode","tag","expectedMainSha","operationId","bootstrapOperationId"])) &&
    (a.workflow==="release-tag-bootstrap.yml" || a.workflow==="release.yml") &&
    (a.mode==="dispatch" || a.mode==="reconcile") &&
    validTag(a.tag) && typeof a.expectedMainSha==="string" && SHA.test(a.expectedMainSha) &&
    typeof a.operationId==="string" && UUID.test(a.operationId) &&
    ((a.workflow==="release.yml" && (a.bootstrapOperationId===undefined ||
      (typeof a.bootstrapOperationId==="string" && UUID.test(a.bootstrapOperationId))) &&
      (a.mode!=="dispatch" || a.bootstrapOperationId!==undefined)) ||
     (a.workflow==="release-tag-bootstrap.yml" && a.bootstrapOperationId===undefined))){
    return {method:"workflow_operation",arguments:{
      workflow:a.workflow,mode:a.mode,tag:a.tag,expectedMainSha:a.expectedMainSha,
      operationId:a.operationId,...(a.bootstrapOperationId===undefined?{}:
        {bootstrapOperationId:a.bootstrapOperationId as string}),
    }};
  }
  throw new Error("ORACLE_WORKFLOW_COMMAND_INVALID");
}

export function parseOracleWorkflowResult(method:OracleWorkflowCommand["method"],value:unknown):
  OracleWorkflowObservation|boolean|OracleDistributionInspection {
  if(method==="inspect_distribution"){
    if(!record(value) || !keys(value,["sourceCommitSha","releaseTag","workflowRunId",
      "integrityVerified","releasePublished","verifiedAssetCount","assetInventorySha256"]) ||
      typeof value.sourceCommitSha!=="string" || !SHA.test(value.sourceCommitSha) ||
      !validTag(value.releaseTag) || !Number.isSafeInteger(value.workflowRunId) ||
      (value.workflowRunId as number)<1 ||
      value.integrityVerified!==true || value.releasePublished!==true ||
      value.verifiedAssetCount!==5 ||
      typeof value.assetInventorySha256!=="string" || !DIGEST.test(value.assetInventorySha256))
      throw new Error("ORACLE_WORKFLOW_DISTRIBUTION_PROOF_INVALID");
    return {sourceCommitSha:value.sourceCommitSha,releaseTag:value.releaseTag,
      workflowRunId:value.workflowRunId as number,integrityVerified:true,
      releasePublished:true,verifiedAssetCount:5,assetInventorySha256:value.assetInventorySha256};
  }
  if(method==="verify_lightweight_tag"){
    if(typeof value!=="boolean")throw new Error("ORACLE_WORKFLOW_RESULT_INVALID");
    return value;
  }
  if(!record(value) || typeof value.operationId!=="string" || !UUID.test(value.operationId))
    throw new Error("ORACLE_WORKFLOW_RESULT_INVALID");
  if((value.status==="submitted" || value.status==="outcome_unknown") &&
    keys(value,["status","operationId"]))
    return {status:value.status,operationId:value.operationId};
  if(value.status==="observed" &&
    keys(value,["status","operationId","runId","state","conclusion"]) &&
    Number.isSafeInteger(value.runId) && (value.runId as number)>0 &&
    (value.state==="queued" || value.state==="in_progress" || value.state==="completed") &&
    (value.state==="completed" ? typeof value.conclusion==="string" &&
      value.conclusion.length>0 && value.conclusion.length<=64 : value.conclusion===null)){
    return {status:"observed",operationId:value.operationId,runId:value.runId as number,
      state:value.state,conclusion:value.conclusion as string|null};
  }
  throw new Error("ORACLE_WORKFLOW_RESULT_INVALID");
}

export function oracleWorkflowCanonicalBytes(digest:string,epoch:string):Uint8Array {
  if(!DIGEST.test(digest) || !/^(0|[1-9][0-9]{0,11})$/u.test(epoch))
    throw new Error("ORACLE_WORKFLOW_CANONICAL_INVALID");
  return new TextEncoder().encode(["mcp-v3:oracle-workflow:v1","POST",
    ORACLE_WORKFLOW_DISPATCH_PATH,epoch,digest].join("\n"));
}
function hex(b:Uint8Array):string{return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}
function unhex(s:string):Uint8Array {
  const a=new Uint8Array(s.length/2);
  for(let i=0;i<a.length;i++)a[i]=Number.parseInt(s.slice(i*2,i*2+2),16);
  return a;
}
function buffer(b:Uint8Array):ArrayBuffer {const a=new Uint8Array(b.length);a.set(b);return a.buffer;}
export async function signOracleWorkflowRequest(
  command:OracleWorkflowCommand,keyHex:string,epoch=Math.floor(Date.now()/1000),
):Promise<{readonly body:string;readonly authorization:string}> {
  if(!DIGEST.test(keyHex))throw new Error("ORACLE_WORKFLOW_KEY_INVALID");
  const body=JSON.stringify(parseOracleWorkflowCommand(command));
  if(new TextEncoder().encode(body).byteLength>ORACLE_WORKFLOW_MAX_BODY_BYTES)
    throw new Error("ORACLE_WORKFLOW_REQUEST_TOO_LARGE");
  const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(body))));
  const key=await crypto.subtle.importKey("raw",buffer(unhex(keyHex)),
    {name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const tag=hex(new Uint8Array(await crypto.subtle.sign("HMAC",key,
    buffer(oracleWorkflowCanonicalBytes(digest,String(epoch))))));
  return {body,authorization:`HMAC-SHA256 workflow-v1=${epoch}.${tag}`};
}
