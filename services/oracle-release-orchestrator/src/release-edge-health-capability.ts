import {createHash} from "node:crypto";
import type {ReleaseRunSnapshot,StepIntent} from "./types.js";
import type {ReleaseStepCapability} from "./release-workflow-executor.js";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA=/^[a-f0-9]{64}$/u;
export interface EdgeHealthBinding {
  readonly endpoint:string;
  readonly authorize:(run:ReleaseRunSnapshot)=>Promise<boolean>;
  readonly fetchImpl?:typeof fetch;
}
function plain(v:unknown):v is Record<string,unknown>{
  return !!v && typeof v==="object" && !Array.isArray(v);
}
function trustedEndpoint(raw:string):string{
  const u=new URL(raw);
  if(u.protocol!=="https:" || !u.hostname.endsWith(".workers.dev") ||
    u.hostname.length<=12 || u.username || u.password || u.search || u.hash ||
    u.pathname!=="/health" || (u.port!=="" && u.port!=="443"))
    throw new Error("ORACLE_EDGE_HEALTH_ENDPOINT_INVALID");
  return u.href;
}
async function health(url:string,read:typeof fetch):Promise<string|null>{
  const response=await read(url,{method:"GET",redirect:"error",cache:"no-store",
    headers:{accept:"application/json"},signal:AbortSignal.timeout(8_000)});
  if(response.status!==200 ||
    !/^application\/json\b/iu.test(response.headers.get("content-type")??""))
    return null;
  const reader=response.body?.getReader();
  if(!reader)return null;
  const parts:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const result=await reader.read();
      if(result.done)break;
      size+=result.value.length;
      if(size>4096){await reader.cancel();return null;}
      parts.push(result.value);
    }
  }finally{reader.releaseLock();}
  const raw=new Uint8Array(size);let offset=0;
  for(const part of parts){raw.set(part,offset);offset+=part.length;}
  const value:unknown=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(raw));
  if(!plain(value) || value.service!=="mcp-edge-gateway" ||
    value.status!=="ok" || value.edgeEnabled!==true ||
    value.controlPlaneReady!==true || value.executionPlaneReady!==true ||
    value.connectorReady!==true || value.contractCompatible!==true ||
    typeof value.activeContractRevision!=="string" ||
    !SHA.test(value.activeContractRevision) ||
    value.expectedContractRevision!==value.activeContractRevision ||
    !plain(value.runtime) || value.runtime.catalogContractRevision!==value.activeContractRevision ||
    typeof value.runtime.toolSetRevision!=="string" ||
    !SHA.test(value.runtime.toolSetRevision) ||
    value.runtime.toolCount!==99 ||
    typeof value.runtime.connectorInstanceId!=="string" ||
    !UUID.test(value.runtime.connectorInstanceId) ||
    !Number.isSafeInteger(value.runtime.connectionGeneration) ||
    (value.runtime.connectionGeneration as number)<1)
    return null;
  return createHash("sha256").update(JSON.stringify({
    contract:value.activeContractRevision,tools:value.runtime.toolSetRevision,
    count:value.runtime.toolCount,instance:value.runtime.connectorInstanceId,
    generation:value.runtime.connectionGeneration,
  })).digest("hex");
}
/** Verifies live Edge readiness only after a durable deploy receipt. It does
 * not claim the public health endpoint independently authenticates deployment. */
export function bindEdgeHealth(options:EdgeHealthBinding):ReleaseStepCapability{
  if(typeof options.authorize!=="function")throw new Error("ORACLE_EDGE_AUTH_REQUIRED");
  const endpoint=trustedEndpoint(options.endpoint);
  const bound=(intent:StepIntent,run:ReleaseRunSnapshot)=>{
    const deploy=run.steps.find(s=>s.action==="deploy_edge");
    const step=run.steps.find(s=>s.stepId===intent.stepId);
    return intent.runId===run.runId && intent.action==="verify_edge_health" &&
      intent.executionClass==="read_only" && UUID.test(intent.operationId) &&
      step?.action==="verify_edge_health" && step.operationId===intent.operationId &&
      (step.status==="in_progress" || step.status==="outcome_unknown") &&
      deploy?.status==="succeeded" && UUID.test(deploy.operationId??"");
  };
  const check=async(intent:StepIntent,run:ReleaseRunSnapshot)=>{
    if(!bound(intent,run) || !await options.authorize(run))return null;
    try{
      const digest=await health(endpoint,options.fetchImpl??fetch);
      if(!digest || !await options.authorize(run))return null;
      return [{kind:"edge_health_report",source:"mcp_v3_verified_edge_health",
        sha256:createHash("sha256").update(JSON.stringify({
          releaseTag:run.targetRelease,sourceCommitSha:run.sourceCommitSha,
          deployOperationId:run.steps.find(s=>s.action==="deploy_edge")?.operationId,
          runtimeDigest:digest,
        })).digest("hex"),observedAt:new Date().toISOString()}];
    }catch{return null;}
  };
  return {
    action:"verify_edge_health",executionClass:"read_only",
    authorize:(_step,run)=>options.authorize(run),
    execute:async(intent,run)=>{
      const evidence=await check(intent,run);
      return evidence?{state:"succeeded",evidence}:{state:"outcome_unknown"};
    },
    reconcile:async(intent,run)=>{
      const evidence=await check(intent,run);
      return evidence?{outcome:"applied",evidence}:{outcome:"still_unknown"};
    },
  };
}
