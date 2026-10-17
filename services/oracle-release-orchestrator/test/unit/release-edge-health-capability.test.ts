import {describe,expect,it,jest} from "@jest/globals";
import {bindEdgeHealth} from "../../src/release-edge-health-capability.js";
import type {ReleaseRunSnapshot,StepIntent} from "../../src/types.js";
const uuid="11111111-2222-4333-8444-555555555555";
const deployed="11111111-2222-4333-8444-555555555556";
const run={runId:"11111111-2222-4333-8444-555555555557",targetRelease:"v1.1.0-beta.90",
  sourceCommitSha:"a".repeat(40),status:"running",steps:[
    {action:"deploy_edge",stepId:"deploy_edge",operationId:deployed,status:"succeeded",
      executionClass:"external_effect"},
    {action:"verify_edge_health",stepId:"verify_edge_health",operationId:uuid,
      status:"outcome_unknown",executionClass:"read_only"},
  ]} as unknown as ReleaseRunSnapshot;
const intent={runId:run.runId,stepId:"verify_edge_health",
  action:"verify_edge_health",operationId:uuid,
  executionClass:"read_only"} as unknown as StepIntent;
const good={
  service:"mcp-edge-gateway",status:"ok",edgeEnabled:true,
  controlPlaneReady:true,executionPlaneReady:true,connectorReady:true,
  contractCompatible:true,activeContractRevision:"a".repeat(64),
  expectedContractRevision:"a".repeat(64),runtime:{
    catalogContractRevision:"a".repeat(64),toolSetRevision:"b".repeat(64),
    toolCount:99,connectorInstanceId:"11111111-2222-4333-8444-555555555558",
    connectionGeneration:12,
  },
};
const endpoint="https://mcp-access-stack.workers.dev/health";
function stub(body:unknown,status=200):typeof fetch{
  return jest.fn(async(_url:unknown,init:RequestInit)=>{
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({accept:"application/json"});
    return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
  }) as unknown as typeof fetch;
}
describe("Oracle live Edge health binding",()=>{
  it("attests live 99-tool contract health after original deploy succeeds",async()=>{
    const fetchImpl=stub(good);
    const cap=bindEdgeHealth({endpoint,authorize:async()=>true,fetchImpl});
    const result=await cap.execute(intent,run);
    expect(result).toMatchObject({state:"succeeded",evidence:[{
      kind:"edge_health_report",source:"mcp_v3_verified_edge_health",
      sha256:expect.stringMatching(/^[a-f0-9]{64}$/u),
    }]});
    expect(await cap.reconcile(intent,{...run,status:"paused_outcome_unknown"}))
      .toMatchObject({outcome:"applied"});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("denies health proof without a terminal original deploy or correct operation id",async()=>{
    const fetchImpl=stub(good);
    const cap=bindEdgeHealth({endpoint,authorize:async()=>true,fetchImpl});
    const uncommitted={...run,steps:run.steps.map(s=>s.action==="deploy_edge"?
      {...s,status:"outcome_unknown" as const}:s)};
    expect((await cap.execute(intent,uncommitted)).state).toBe("outcome_unknown");
    expect((await cap.execute({...intent,operationId:deployed},run)).state)
      .toBe("outcome_unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("fails closed on malformed health, missing readiness, wrong catalog or tool count",async()=>{
    for(const body of [
      {...good,connectorReady:false},
      {...good,runtime:{...good.runtime,toolCount:98}},
      {...good,expectedContractRevision:"c".repeat(64)},
      {...good,runtime:{...good.runtime,catalogContractRevision:"c".repeat(64)}},
      {status:"ok"},
    ]){
      const cap=bindEdgeHealth({endpoint,authorize:async()=>true,fetchImpl:stub(body)});
      expect((await cap.execute(intent,run)).state).toBe("outcome_unknown");
    }
  });
  it("refuses host revocation and any cross-domain or plaintext endpoint",async()=>{
    for(const url of ["http://mcp-access-stack.workers.dev/health",
      "https://evil.example/health",
      "https://mcp-access-stack.workers.dev/private",
      "https://mcp-access-stack.workers.dev/health?token=secret"]){
      expect(()=>bindEdgeHealth({endpoint:url,authorize:async()=>true}))
        .toThrow("ENDPOINT_INVALID");
    }
    const fetchImpl=stub(good);
    const cap=bindEdgeHealth({endpoint,authorize:async()=>false,fetchImpl});
    expect((await cap.execute(intent,run)).state).toBe("outcome_unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
