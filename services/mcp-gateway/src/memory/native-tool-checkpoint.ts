import { createHash } from "node:crypto";
import type { CentralMemoryStore, MemoryRecord, MemoryConfidence, MemoryKind } from "./central-memory.js";


/** Captures a tool-confirmed lifecycle checkpoint into the single Oracle store.
 * The returned metadata lets the Edge mirror the same immutable revision off-host.
 * This does not create a second memory authority.
 */
export function captureNativeToolCheckpoint(
  store:CentralMemoryStore,ownerScope:string,tool:string,input:unknown,structured:unknown,
):{
  version:1;tool:string;operationId:string;expectedRevision:number;record:MemoryRecord;
}|null {
  if(!ownerScope.startsWith("user:"))return null;
  const repositoryId=store.primaryRepositoryId(ownerScope);
  if(!repositoryId)return null; // the legacy import/cutover has not established scope
  const checkpoint=checkpointFromNativeTool(tool,input,structured,repositoryId);
  if(!checkpoint)return null;
  const history=store.history(ownerScope,repositoryId,checkpoint.recordId);
  const last=history.at(-1);
  if(last && last.status==="active"&&last.content===checkpoint.content &&
      last.title===checkpoint.title) {
    // Reissue the very same checkpoint metadata: it may not yet exist off-host.
    return {version:1,tool,operationId:checkpoint.operationId,
      expectedRevision:last.revision-1,record:last};
  }
  const expectedRevision=last?.revision??0;
  const action=last?"revise":"create";
  const saved=store.update(ownerScope,{
    ...checkpoint,action,expectedRevision,
  });
  return {version:1,tool,operationId:checkpoint.operationId,
    expectedRevision,record:saved.record};
}

export interface NativeToolCheckpoint {
  operationId:string;
  recordId:string;
  repositoryId:string;
  kind:MemoryKind;
  confidence:MemoryConfidence;
  title:string;
  content:string;
  evidenceRefs:string[];
}

function object(value:unknown):Record<string,unknown>|null{
  return value!==null&&typeof value==="object"&&!Array.isArray(value)
    ?value as Record<string,unknown>:null;
}
function sha(value:string):string{return createHash("sha256").update(value).digest("hex");}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA=/^[0-9a-f]{40}$/u;
const TAG=/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/u;
const REPOSITORY=/^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function checkpointFromNativeTool(
  tool:string,input:unknown,structured:unknown,repositoryId:string,
):NativeToolCheckpoint|null{
  if(!REPOSITORY.test(repositoryId))return null;
  const args=object(input),data=object(structured);
  if(!args||!data)return null;
  if(tool==="mcp_update"){
    if(args.workspaceId!=="mcp-access-stack")return null;
    const update=object(data.update);
    if(!update||!["succeeded","failed"].includes(String(update.status))||
      typeof update.updateId!=="string"||!UUID.test(update.updateId)||
      typeof update.mainSha!=="string"||!SHA.test(update.mainSha))return null;
    const status=String(update.status);
    const version=typeof update.tag==="string"&&TAG.test(update.tag)?update.tag:null;
    const companion=typeof update.companionTag==="string"&&TAG.test(update.companionTag)
      ?update.companionTag:null;
    const step=typeof update.step==="string"&&/^[a-z_]{2,40}$/u.test(update.step)
      ?update.step:"unknown";
    const error=object(update.error);
    const errorCode=typeof error?.code==="string"&&/^[A-Z_]{2,60}$/u.test(error.code)
      ?error.code:null;
    const evidence=JSON.stringify({status,step,mainSha:update.mainSha,
      tag:version,companionTag:companion,errorCode});
    const digest=sha(evidence);
    return {
      repositoryId,
      recordId:"mcp-update:"+update.updateId,
      operationId:"native:mcp_update:"+update.updateId+":"+digest.slice(0,12),
      kind:"note",confidence:"inferred",
      title:"MCP V3 update "+update.updateId+" — "+status,
      content:"Tool-observed update lifecycle result. Reconcile with the native ledger before further operations: "+
        evidence,
      evidenceRefs:["mcp_update:"+update.updateId,"main:"+update.mainSha],
    };
  }
  if(tool==="github_merge_pull_request"){
    if(args.repository!=="mcp-access-stack"||data.merged!==true)return null;
    const number=typeof args.pullNumber==="number"?args.pullNumber:0;
    const shaValue=typeof data.mergeSha==="string"?data.mergeSha:"";
    if(!Number.isSafeInteger(number)||number<1||number>999_999||
      !SHA.test(shaValue))return null;
    const fingerprint=sha(number+":"+shaValue);
    return {
      repositoryId,
      recordId:"mcp-pr:"+number,
      operationId:"native:github_merge:"+number+":"+fingerprint.slice(0,12),
      kind:"note",confidence:"inferred",
      title:"PR #"+number+" integrated into MCP V3",
      content:"Tool-observed GitHub merge completed: PR #"+number+", merge SHA "+shaValue+
        ". Verify current main and post-merge CI separately.",
      evidenceRefs:["github:pr:"+number,"merge:"+shaValue],
    };
  }
  return null;
}
