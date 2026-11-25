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
const UPDATE_ID=/^upd_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA=/^[0-9a-f]{40}$/u;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const WORKFLOWS=new Set(["release.yml","release-tag-bootstrap.yml","edge-cas-candidate-stage.yml",
  "edge-catalog-activate.yml","edge-catalog-recover-prepare.yml",
  "companion-only-distribution.yml","cloudflare-version-inventory.yml","edge-f09-guarded-rollout.yml"]);
const WORKFLOW_FAILURES=new Set(["failure","timed_out","startup_failure"]);
const TASK_REASONS=new Set(["timeout","client_disconnected","upstream_timeout"]);
const TAG=/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/u;
const REPOSITORY=/^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function checkpointFromNativeTool(
  tool:string,input:unknown,structured:unknown,repositoryId:string,
):NativeToolCheckpoint|null{
  if(!REPOSITORY.test(repositoryId))return null;
  const args=object(input),data=object(structured);
  if(!args||!data)return null;
  if(tool==="mcp_update" || (tool==="mcp_fluxo" && args.operation==="update_mcp")){
    if(args.workspaceId!=="mcp-access-stack")return null;
    const update=object(data.update);
    if(!update||!["succeeded","failed"].includes(String(update.status))||
      typeof update.updateId!=="string"||!UPDATE_ID.test(update.updateId)||
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
      kind:status==="failed"?"issue":"note",confidence:"inferred",
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
  if(tool==="github_workflow_operation"){
    if(args.workspaceId!=="mcp-access-stack"||args.repository!=="mcp-access-stack"||
      args.mode!=="reconcile"||data.status!=="observed"||data.state!=="completed"||
      typeof args.operationId!=="string"||!UUID.test(args.operationId)||
      data.operationId!==args.operationId||
      typeof args.expectedMainSha!=="string"||!SHA.test(args.expectedMainSha)||
      typeof args.workflow!=="string"||!WORKFLOWS.has(args.workflow)||
      typeof data.runId!=="number"||!Number.isSafeInteger(data.runId)||data.runId<1||
      typeof data.conclusion!=="string"||!WORKFLOW_FAILURES.has(data.conclusion))return null;
    const evidence=JSON.stringify({workflow:args.workflow,runId:data.runId,
      mainSha:args.expectedMainSha,conclusion:data.conclusion});
    return {
      repositoryId,recordId:"mcp-workflow:"+args.operationId,
      operationId:"native:github_workflow:"+args.operationId+":"+sha(evidence).slice(0,12),
      kind:"issue",confidence:"inferred",
      title:"MCP workflow "+args.workflow+" — "+data.conclusion,
      content:"Tool-observed terminal workflow failure (root cause not established): "+evidence,
      evidenceRefs:["github:run:"+data.runId],
    };
  }
  if(tool==="get_background_task"){
    const task=object(data.task);
    if(args.workspaceId!=="mcp-access-stack"||typeof args.id!=="string"||
      !UUID.test(args.id)||!task||task.id!==args.id||
      task.workspaceId!==args.workspaceId||
      (task.state!=="failed"&&task.state!=="cancelled"))return null;
    const result=object(task.result);
    const lifecycle=object(task.lifecycle)??object(result?.lifecycle);
    const reason=typeof lifecycle?.reason==="string"&&TASK_REASONS.has(lifecycle.reason)
      ?lifecycle.reason:null;
    if(!reason)return null; // User commands failing are not MCP infrastructure incidents.
    const exitCode=typeof result?.exitCode==="number"&&Number.isSafeInteger(result.exitCode)
      ?result.exitCode:null;
    const evidence=JSON.stringify({state:task.state,exitCode,reason});
    return {
      repositoryId,recordId:"mcp-task:"+args.id,
      operationId:"native:background_task:"+args.id+":"+sha(evidence).slice(0,12),
      kind:"issue",confidence:"inferred",
      title:"MCP background task "+args.id+" — "+task.state,
      content:"Tool-observed terminal background task failure (root cause not established): "+evidence,
      evidenceRefs:["mcp:background_task:"+args.id],
    };
  }
  return null;
}
