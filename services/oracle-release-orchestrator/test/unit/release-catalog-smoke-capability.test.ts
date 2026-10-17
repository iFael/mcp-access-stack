import {createHash} from "node:crypto";
import {describe,expect,it,jest} from "@jest/globals";
import {bindCatalogSmoke} from "../../src/release-catalog-smoke-capability.js";
import type {ReleaseRunSnapshot,StepIntent} from "../../src/types.js";
const names=Array.from({length:99},(_,i)=>"tool_"+String(i).padStart(3,"0"));
const revision=createHash("sha256").update("mcp-tool-set-v1\0")
  .update(names.join("\n")).digest("hex");
const contract="a".repeat(64),op="11111111-2222-4333-8444-555555555555";
const run={runId:"11111111-2222-4333-8444-555555555557",
  sourceCommitSha:"b".repeat(40),targetRelease:"v1.1.0-beta.90",status:"running",
  steps:[
    {stepId:"reconcile_final_pointers",action:"reconcile_final_pointers",
      operationId:"11111111-2222-4333-8444-555555555556",status:"succeeded"},
    {stepId:"smoke_catalog",action:"smoke_catalog",operationId:op,
      status:"outcome_unknown"},
  ]} as unknown as ReleaseRunSnapshot;
const intent={runId:run.runId,stepId:"smoke_catalog",action:"smoke_catalog",
  operationId:op,executionClass:"read_only"} as unknown as StepIntent;
const health={service:"mcp-edge-gateway",status:"ok",contractCompatible:true,
  connectorReady:true,executionPlaneReady:true,activeContractRevision:contract,
  expectedContractRevision:contract,
  runtime:{toolSetRevision:revision,toolCount:99,
    catalogContractRevision:contract}};
const endpoint="https://mcp-access-stack.workers.dev/health";
function fixture(namesFor=names,healthFor:unknown=health){
  let allowed=true;
  const listTools=jest.fn(async()=>({names:namesFor,
    toolSetRevision:revision,contractRevision:contract}));
  const fetchImpl=jest.fn(async()=>new Response(JSON.stringify(healthFor),{
    status:200,headers:{"content-type":"application/json"},
  })) as unknown as typeof fetch;
  return {cap:bindCatalogSmoke({edgeHealthUrl:endpoint,
    listTools,authorize:async()=>allowed,fetchImpl}),
    listTools,fetchImpl,deny:()=>{allowed=false;}};
}
describe("Oracle independent authenticated tool catalog smoke",()=>{
  it("recomputes all 99 tool names and cross-checks live edge revisions",async()=>{
    const f=fixture();
    const result=await f.cap.execute(intent,run);
    expect(result).toMatchObject({state:"succeeded",evidence:[{
      kind:"catalog_smoke_report",source:"mcp_v3_verified_catalog",
      sha256:expect.stringMatching(/^[a-f0-9]{64}$/u),
    }]});
    expect(await f.cap.reconcile(intent,{...run,status:"paused_outcome_unknown"}))
      .toMatchObject({outcome:"applied"});
    expect(f.listTools).toHaveBeenCalledTimes(2);
  });
  it("rejects a renamed tool, duplicate name, stale contract or missing tool",async()=>{
    const changed=[...names];changed[2]="tampered_tool";
    for(const array of [changed,[...names.slice(0,98)],[
      ...names.slice(0,98),names[0]!
    ]]){
      const f=fixture(array);
      expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
    }
    const f=fixture(names,{...health,activeContractRevision:"c".repeat(64)});
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
  });
  it("requires completed final pointers, original operation and host authorization",async()=>{
    const f=fixture();
    const pending={...run,steps:run.steps.map(s=>
      s.action==="reconcile_final_pointers"?{...s,status:"outcome_unknown" as const}:s)};
    expect((await f.cap.execute(intent,pending)).state).toBe("outcome_unknown");
    expect((await f.cap.execute({...intent,operationId:
      "11111111-2222-4333-8444-555555555558"},run)).state)
      .toBe("outcome_unknown");
    f.deny();
    expect((await f.cap.reconcile(intent,run)).outcome).toBe("still_unknown");
    expect(f.listTools).not.toHaveBeenCalled();
  });
  it("refuses untrusted health endpoint",()=>{
    expect(()=>bindCatalogSmoke({
      edgeHealthUrl:"https://evil.example/health",
      listTools:async()=>({names,contractRevision:contract,toolSetRevision:revision}),
      authorize:async()=>true,
    })).toThrow("ENDPOINT_INVALID");
  });
});
