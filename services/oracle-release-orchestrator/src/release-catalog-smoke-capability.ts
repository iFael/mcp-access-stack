import {createHash} from "node:crypto";
import type {ReleaseRunSnapshot,StepIntent} from "./types.js";
import type {ReleaseStepCapability} from "./release-workflow-executor.js";
const SHA=/^[a-f0-9]{64}$/u,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const NAME=/^[a-z][a-z0-9_-]{0,127}$/u;
export interface CatalogListReceipt {
  readonly names:readonly string[];
  readonly contractRevision:string;
  readonly toolSetRevision:string;
}
export interface CatalogSmokeBinding {
  /** Authenticated MCP V3 tools/list adapter; not a user-defined RPC method. */
  readonly listTools:()=>Promise<CatalogListReceipt>;
  /** Public health URI pinned by deployment configuration. */
  readonly edgeHealthUrl:string;
  readonly authorize:(run:ReleaseRunSnapshot)=>Promise<boolean>;
  readonly fetchImpl?:typeof fetch;
}
function endpoint(raw:string):string{
  const u=new URL(raw);
  if(u.protocol!=="https:" || !u.hostname.endsWith(".workers.dev") ||
    u.hostname.length<=12 || u.username || u.password || u.search || u.hash ||
    u.pathname!=="/health" || (u.port!=="" && u.port!=="443"))
    throw new Error("ORACLE_CATALOG_HEALTH_ENDPOINT_INVALID");
  return u.href;
}
function bound(intent:StepIntent,run:ReleaseRunSnapshot):boolean{
  const step=run.steps.find(s=>s.stepId===intent.stepId);
  return intent.runId===run.runId && intent.action==="smoke_catalog" &&
    intent.executionClass==="read_only" && UUID.test(intent.operationId) &&
    step?.action==="smoke_catalog" && step.operationId===intent.operationId &&
    (step.status==="in_progress" || step.status==="outcome_unknown") &&
    run.steps.some(s=>s.action==="reconcile_final_pointers" &&
      s.status==="succeeded" && UUID.test(s.operationId??""));
}
async function health(url:string,reader:typeof fetch):Promise<unknown>{
  const response=await reader(url,{method:"GET",redirect:"error",cache:"no-store",
    headers:{accept:"application/json"},signal:AbortSignal.timeout(8_000)});
  if(response.status!==200 || !/^application\/json\b/iu.test(
    response.headers.get("content-type")??""))return null;
  const contentLength=response.headers.get("content-length");
  if(contentLength && (!/^[0-9]+$/u.test(contentLength) ||
    Number(contentLength)>4096))return null;
  const readerStream=response.body?.getReader();
  if(!readerStream)return null;
  let size=0;const chunks:Uint8Array[]=[];
  try{
    while(true){
      const part=await readerStream.read();
      if(part.done)break;
      size+=part.value.length;
      if(size>4096){await readerStream.cancel();return null;}
      chunks.push(part.value);
    }
  }finally{readerStream.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)) as unknown;
}
/** Cross-checks the authenticated tools/list inventory against the separately
 * reported Edge runtime identity. It cannot assert that every tool executes. */
export function bindCatalogSmoke(options:CatalogSmokeBinding):ReleaseStepCapability{
  if(typeof options.listTools!=="function" || typeof options.authorize!=="function")
    throw new Error("ORACLE_CATALOG_HOST_INVALID");
  const url=endpoint(options.edgeHealthUrl);
  const check=async(intent:StepIntent,run:ReleaseRunSnapshot)=>{
    if(!bound(intent,run) || !await options.authorize(run))return null;
    try{
      const [catalog,raw]=await Promise.all([
        options.listTools(),health(url,options.fetchImpl??fetch),
      ]);
      if(!raw || typeof raw!=="object" || Array.isArray(raw))return null;
      const h=raw as Record<string,unknown>;
      if(!h.runtime || typeof h.runtime!=="object" || Array.isArray(h.runtime))
        return null;
      const rt=h.runtime as Record<string,unknown>;
      if(h.service!=="mcp-edge-gateway" || h.status!=="ok" ||
        h.contractCompatible!==true || h.connectorReady!==true ||
        h.executionPlaneReady!==true || rt.toolCount!==99 ||
        !SHA.test(String(h.activeContractRevision??"")) ||
        h.expectedContractRevision!==h.activeContractRevision ||
        rt.catalogContractRevision!==h.activeContractRevision ||
        catalog.contractRevision!==h.activeContractRevision ||
        !SHA.test(catalog.toolSetRevision) ||
        catalog.toolSetRevision!==rt.toolSetRevision ||
        catalog.names.length!==99 ||
        new Set(catalog.names).size!==catalog.names.length ||
        catalog.names.some(n=>!NAME.test(n)))return null;
      const revision=createHash("sha256")
        .update("mcp-tool-set-v1\0","utf8")
        .update([...catalog.names].sort().join("\n"),"utf8").digest("hex");
      if(revision!==catalog.toolSetRevision || !await options.authorize(run))
        return null;
      const digest=createHash("sha256").update(JSON.stringify({
        tag:run.targetRelease,commit:run.sourceCommitSha,
        pointerOperationId:run.steps.find(s=>s.action==="reconcile_final_pointers")?.operationId,
        contractRevision:catalog.contractRevision,toolSetRevision:revision,count:99,
      })).digest("hex");
      return [{kind:"catalog_smoke_report",source:"mcp_v3_verified_catalog",
        sha256:digest,observedAt:new Date().toISOString()}];
    }catch{return null;}
  };
  return {
    action:"smoke_catalog",executionClass:"read_only",
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
