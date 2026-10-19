import { createHash } from "node:crypto";
import {
  ORACLE_CONTROL_DISPATCH_PATH, parseOracleControlAdvance,
  parseOracleControlResponse, signOracleControlRequest,
  type OracleControlAdvanceInput, type OracleControlResponse,
} from "@mcp-access-stack/update-control-contract";
import {
  AppError, type MutationReceiptIdentity, type MutationReceiptStore,
  type OperationContext,
} from "@vs-code-gpt/shared";

const MAX_RESULT_BYTES=4*1024;
export interface OracleControlCallerBinding {
  /** Host-owned credential provisioner. No key, path, token or URL from the MCP caller. */
  readonly key:()=>Promise<string>;
  readonly endpoint:string;
  /** Host-owned authorization independent of a read-only owner scope. */
  readonly authorize:(input:OracleControlAdvanceInput,ownerScope:string)=>Promise<boolean>;
  readonly fetchImpl?:typeof fetch;
}
export interface OracleControlCallerInput extends OracleControlAdvanceInput {
  readonly workspaceId:string;
}
export type OracleControlCallerResult =
  | {readonly status:"observed";readonly operationId:string;readonly result:OracleControlResponse}
  | {readonly status:"outcome_unknown";readonly operationId:string};

function allowedEndpoint(raw:string):string {
  let url:URL;
  try{url=new URL(raw);}catch{throw new AppError("CAPABILITY_UNSUPPORTED","Oracle control endpoint is invalid.");}
  if(url.protocol!=="https:" || !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    (url.port && url.port!=="443") || url.username || url.password ||
    url.pathname!==ORACLE_CONTROL_DISPATCH_PATH || url.search || url.hash){
    throw new AppError("CAPABILITY_UNSUPPORTED","Oracle control endpoint is not allowlisted.");
  }
  return url.href;
}
async function boundedJson(response:Response):Promise<unknown>{
  const reader=response.body?.getReader();
  if(!reader)throw new Error("EMPTY_CONTROL_RESPONSE");
  let count=0;const chunks:Uint8Array[]=[];
  try{
    while(true){
      const chunk=await reader.read();
      if(chunk.done)break;
      count+=chunk.value.byteLength;
      if(count>MAX_RESULT_BYTES){await reader.cancel();throw new Error("CONTROL_RESPONSE_TOO_LARGE");}
      chunks.push(chunk.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(count);let cursor=0;
  for(const chunk of chunks){bytes.set(chunk,cursor);cursor+=chunk.byteLength;}
  return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes)) as unknown;
}

/**
 * Existing MCP V3 mutation-receipt store is the one-shot dispatch authority.
 * A timeout, crash or disconnect after markExecuting is outcome_unknown and
 * MUST be reconciled through the existing read-only Update Center; never POST again.
 */
export class OracleControlCaller {
  private readonly endpoint:string;
  constructor(private readonly binding:OracleControlCallerBinding){
    this.endpoint=allowedEndpoint(binding.endpoint);
    if(typeof binding.authorize!=="function" || typeof binding.key!=="function"){
      throw new AppError("CAPABILITY_UNSUPPORTED","Oracle release control requires explicit host policy.");
    }
  }
  async advance(
    input:OracleControlCallerInput,
    receipts:MutationReceiptStore,
    context:OperationContext,
  ):Promise<OracleControlCallerResult>{
    const parsed=parseOracleControlAdvance({
      runId:input.runId,expectedSourceSha:input.expectedSourceSha,
      expectedLastSeq:input.expectedLastSeq,operationId:input.operationId,
    });
    if(input.workspaceId!=="mcp-access-stack" || !context.ownerScope ||
      !await this.binding.authorize(parsed,context.ownerScope)){
      throw new AppError("PERMISSION_DENIED","Oracle release-control gate is not authorized.");
    }
    const identity:MutationReceiptIdentity={
      workspaceId:input.workspaceId,operation:"oracle_release_advance",
      targetResource:`oracle:${input.workspaceId}:run/${parsed.runId}`,
      idempotencyKey:`oracle-control:${input.workspaceId}:${parsed.operationId}`,
      canonicalArgumentsDigest:createHash("sha256").update(JSON.stringify({
        ...input,ownerScopeDigest:createHash("sha256").update(context.ownerScope).digest("hex"),
      })).digest("hex"),
    };
    const unknown:OracleControlCallerResult={status:"outcome_unknown",operationId:parsed.operationId};
    const previous=await receipts.get(identity.idempotencyKey);
    if(previous!==undefined){
      const replay=await receipts.reserve(identity);
      if(replay.disposition==="replay_completed"){
        const stored=replay.receipt.result as unknown;
        if(stored && typeof stored==="object" && "status" in stored &&
          stored.status==="observed" && "result" in stored){
          try{
            const result=parseOracleControlResponse(stored.result);
            if(result.runId===parsed.runId && result.lastSeq>=parsed.expectedLastSeq)
              return {status:"observed",operationId:parsed.operationId,result};
          }catch{/* corrupted receipt: no dispatch */}
        }
      }
      return unknown;
    }
    // Missing or invalid credentials cannot consume the one-shot receipt.
    let signed:Awaited<ReturnType<typeof signOracleControlRequest>>;
    try{
      signed=await signOracleControlRequest(parsed,await this.binding.key());
    }catch{throw new AppError("CAPABILITY_UNSUPPORTED","Oracle control credential is unavailable.");}
    const reservation=await receipts.reserve(identity);
    if(reservation.disposition!=="execute")return unknown;
    try{
      await receipts.markExecuting(identity);
      const timeout=AbortSignal.timeout(15_000);
      const signal=context.signal ? AbortSignal.any([context.signal,timeout]) : timeout;
      const response=await (this.binding.fetchImpl??fetch)(this.endpoint,{
        method:"POST",headers:{"content-type":"application/json",authorization:signed.authorization},
        body:signed.body,redirect:"error",cache:"no-store",signal,
      });
      if(response.status!==200 ||
        !(response.headers.get("content-type")??"").toLowerCase().startsWith("application/json"))
        throw new Error("CONTROL_RESPONSE_UNVERIFIED");
      const envelope=await boundedJson(response);
      if(!envelope || typeof envelope!=="object" || Array.isArray(envelope) ||
        Object.keys(envelope).length!==1 || !Object.hasOwn(envelope,"result"))
        throw new Error("CONTROL_RESPONSE_INVALID");
      const result=parseOracleControlResponse((envelope as {result:unknown}).result);
      if(result.runId!==parsed.runId || result.lastSeq<parsed.expectedLastSeq)
        throw new Error("CONTROL_CAS_UNVERIFIED");
      const outcome:OracleControlCallerResult={
        status:"observed",operationId:parsed.operationId,result,
      };
      await receipts.markCompleted(identity,outcome);
      return outcome;
    }catch{
      const persisted=await receipts.get(identity.idempotencyKey);
      if(persisted?.state==="executing")await receipts.markReconciliationRequired(identity);
      // The remote operation may have executed. NO automatic redelivery.
      return unknown;
    }
  }
}
