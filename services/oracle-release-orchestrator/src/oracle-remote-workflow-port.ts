import {
  ORACLE_WORKFLOW_DISPATCH_PATH,ORACLE_WORKFLOW_MAX_RESULT_BYTES,
  parseOracleWorkflowCommand,parseOracleWorkflowResult,signOracleWorkflowRequest,
  type OracleWorkflowCommand,type OracleWorkflowObservation,type OracleDistributionInspection,
} from "@mcp-access-stack/update-control-contract";
import type {TypedTagBootstrapPort} from "./release-tag-bootstrap-capability.js";
import type {TypedPublicDistributionPort,PublicWorkflowRequest} from "./release-public-distribution-capability.js";

type BootstrapRequest=Parameters<TypedTagBootstrapPort["workflowOperation"]>[0];
type WorkflowRequest=BootstrapRequest|PublicWorkflowRequest;
type WorkflowPayload=Extract<OracleWorkflowCommand,{method:"workflow_operation"}>["arguments"];

export interface OracleRemoteWorkflowOptions {
  readonly endpoint:string;
  /** Dedicated workflow HMAC; must not be source/control/admin HMAC. */
  readonly key:()=>Promise<string>;
  readonly workspaceId:string;
  readonly owner:string;
  readonly repository:string;
  readonly fetchImpl?:typeof fetch;
}
function endpoint(raw:string):string {
  let url:URL;
  try{url=new URL(raw);}catch{throw new Error("ORACLE_WORKFLOW_ENDPOINT_INVALID");}
  if(url.protocol!=="https:" || !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    url.username || url.password || url.search || url.hash ||
    (url.port!=="" && url.port!=="443") || url.pathname!==ORACLE_WORKFLOW_DISPATCH_PATH)
    throw new Error("ORACLE_WORKFLOW_ENDPOINT_INVALID");
  return url.href;
}
async function readBounded(response:Response):Promise<unknown>{
  const len=response.headers.get("content-length");
  if(len!==null && (!/^\d+$/u.test(len) || Number(len)>ORACLE_WORKFLOW_MAX_RESULT_BYTES))
    throw new Error("ORACLE_WORKFLOW_RESPONSE_TOO_LARGE");
  const reader=response.body?.getReader();
  if(!reader)throw new Error("ORACLE_WORKFLOW_RESPONSE_MISSING");
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const next=await reader.read();
      if(next.done)break;
      size+=next.value.byteLength;
      if(size>ORACLE_WORKFLOW_MAX_RESULT_BYTES){
        await reader.cancel();throw new Error("ORACLE_WORKFLOW_RESPONSE_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let pos=0;
  for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}
  return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes)) as unknown;
}

/** Oracle-owned workflow intent -> isolated HMAC Worker -> MCP provider.
 * Exactly one POST per call; failed or timed-out dispatch is uncertain and
 * MUST be reconciled using the same Oracle-ledger operationId, never retried
 * using an alternate id. Does not verify signed artifact publication. */
export class OracleRemoteWorkflowPort implements TypedTagBootstrapPort,
    TypedPublicDistributionPort {
  private readonly url:string;
  get workspaceId(){return this.options.workspaceId;}
  get owner(){return this.options.owner;}
  get repository(){return this.options.repository;}
  constructor(private readonly options:OracleRemoteWorkflowOptions){
    this.url=endpoint(options.endpoint);
    if(options.workspaceId!=="mcp-access-stack" ||
      !/^[A-Za-z0-9-]{1,100}$/u.test(options.owner) ||
      !/^[A-Za-z0-9._-]{1,100}$/u.test(options.repository))
      throw new Error("ORACLE_WORKFLOW_HOST_IDENTITY_INVALID");
  }
  private async request(command:OracleWorkflowCommand):Promise<OracleWorkflowObservation|boolean|OracleDistributionInspection>{
    const parsed=parseOracleWorkflowCommand(command);
    const signed=await signOracleWorkflowRequest(parsed,await this.options.key());
    // HMAC authenticates this exact bounded intent; do not redirect, retry,
    // or turn a transport error into a proof of GitHub execution.
    const response=await (this.options.fetchImpl??fetch)(this.url,{
      method:"POST",headers:{authorization:signed.authorization,
        "content-type":"application/json"},
      body:signed.body,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(12_000),
    });
    if(response.status!==200 ||
       !/^application\/json\b/iu.test(response.headers.get("content-type")??""))
      throw new Error("ORACLE_WORKFLOW_RESPONSE_UNVERIFIED");
    const payload=await readBounded(response);
    if(!payload || typeof payload!=="object" || Array.isArray(payload) ||
      Object.keys(payload).length!==1 || !Object.hasOwn(payload,"result"))
      throw new Error("ORACLE_WORKFLOW_RESPONSE_INVALID");
    return parseOracleWorkflowResult(parsed.method,(payload as {result:unknown}).result);
  }
  async workflowOperation(input:WorkflowRequest):Promise<OracleWorkflowObservation>{
    if(input.workspaceId!==this.options.workspaceId ||
       input.owner!==this.options.owner || input.repository!==this.options.repository ||
       Object.keys(input).some(k=>!["workspaceId","owner","repository","workflow",
         "mode","tag","expectedMainSha","operationId","bootstrapOperationId"].includes(k)))
      throw new Error("ORACLE_WORKFLOW_IDENTITY_INVALID");
    const args:WorkflowPayload={
      workflow:input.workflow,mode:input.mode,tag:input.tag,
      expectedMainSha:input.expectedMainSha,operationId:input.operationId,
      ...("bootstrapOperationId" in input
        ? {bootstrapOperationId:input.bootstrapOperationId}:{}),
    };
    const result=await this.request({method:"workflow_operation",arguments:args});
    if(typeof result!=="object" || result===null || !("operationId" in result) ||
      result.operationId!==input.operationId)
      throw new Error("ORACLE_WORKFLOW_RECEIPT_MISMATCH");
    return result;
  }
  async inspectDistribution(runId:number,tag:string,commitSha:string):Promise<OracleDistributionInspection>{
    const result=await this.request({method:"inspect_distribution",
      arguments:{runId,tag,commitSha}});
    if(typeof result!=="object" || result===null || !("workflowRunId" in result) ||
      result.workflowRunId!==runId ||
      result.releaseTag!==tag || result.sourceCommitSha!==commitSha ||
      !("assetInventorySha256" in result))
      throw new Error("ORACLE_WORKFLOW_DISTRIBUTION_MISMATCH");
    return result as OracleDistributionInspection;
  }
  async verifyLightweightTag(tag:string,commitSha:string):Promise<boolean>{
    const result=await this.request({method:"verify_lightweight_tag",
      arguments:{tag,commitSha}});
    if(typeof result!=="boolean")throw new Error("ORACLE_WORKFLOW_TAG_RESULT_INVALID");
    return result;
  }
}
