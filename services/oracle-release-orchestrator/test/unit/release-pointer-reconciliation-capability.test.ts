import {describe,expect,it,jest} from "@jest/globals";
import {bindReleasePointerReconciliation,type ExecutionNodePointerState}
  from "../../src/release-pointer-reconciliation-capability.js";
import type {ReleaseRunSnapshot,StepIntent} from "../../src/types.js";
const id="1.1.0-beta.90",tag="v"+id;
const op="11111111-2222-4333-8444-555555555555";
const run={runId:"11111111-2222-4333-8444-555555555559",targetRelease:tag,
  sourceCommitSha:"a".repeat(40),status:"running",steps:[
    {stepId:"verify_oracle_health",action:"verify_oracle_health",operationId:
      "11111111-2222-4333-8444-555555555556",status:"succeeded"},
    {stepId:"verify_windows_health",action:"verify_windows_health",operationId:
      "11111111-2222-4333-8444-555555555557",status:"succeeded"},
    {stepId:"reconcile_final_pointers",action:"reconcile_final_pointers",
      operationId:op,status:"outcome_unknown"},
  ]} as unknown as ReleaseRunSnapshot;
const intent={runId:run.runId,action:"reconcile_final_pointers",
  stepId:"reconcile_final_pointers",operationId:op,
  executionClass:"read_only"} as unknown as StepIntent;
const oracle:ExecutionNodePointerState={
  active:{releaseId:id,manifestSha256:"a".repeat(64)},
  previous:{releaseId:"1.1.0-beta.89",manifestSha256:"b".repeat(64)},candidate:null,
};
const windows:ExecutionNodePointerState={
  active:{releaseId:id,manifestSha256:"c".repeat(64)},
  previous:{releaseId:"1.1.0-beta.88",manifestSha256:"d".repeat(64)},candidate:null,
};
function fixture(o=oracle,w=windows){
  let allowed=true;
  const oread=jest.fn(async()=>o),wread=jest.fn(async()=>w);
  return {cap:bindReleasePointerReconciliation({
    oracle:{getState:oread},windows:{getState:wread},
    authorize:async()=>allowed,
  }),oread,wread,deny:()=>{allowed=false;}};
}
describe("dual execution-node pointer reconciliation",()=>{
  it("verifies same active release with independent OS manifest digests and rollback pointers",async()=>{
    const f=fixture();
    const x=await f.cap.execute(intent,run);
    expect(x).toMatchObject({state:"succeeded",evidence:[{
      kind:"pointer_consistency_report",source:"mcp_v3_verified_oracle",
      sha256:expect.stringMatching(/^[a-f0-9]{64}$/u),
    }]});
    expect(f.oread).toHaveBeenCalledTimes(2);
    expect(f.wread).toHaveBeenCalledTimes(2);
    expect(await f.cap.reconcile(intent,{...run,status:"paused_outcome_unknown"}))
      .toMatchObject({outcome:"applied"});
  });
  it("rejects candidate still present, stale active release and missing rollback",async()=>{
    const bads:ExecutionNodePointerState[]=[
      {...oracle,candidate:{releaseId:"1.1.0-beta.91",manifestSha256:"b".repeat(64)}},
      {...oracle,active:{releaseId:"1.1.0-beta.89",manifestSha256:"a".repeat(64)}},
      {...oracle,previous:null},
      {...oracle,previous:oracle.active},
    ];
    for(const bad of bads){
      const f=fixture(bad);
      expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
    }
  });
  it("refuses health gates not yet complete, tampered operation and revoked authorization",async()=>{
    const f=fixture();
    const missing={...run,steps:run.steps.map(s=>s.action==="verify_windows_health"?
      {...s,status:"outcome_unknown"}:s)};
    expect((await f.cap.execute(intent,missing)).state).toBe("outcome_unknown");
    expect((await f.cap.execute({...intent,operationId:
      "11111111-2222-4333-8444-555555555550"},run)).state).toBe("outcome_unknown");
    f.deny();
    expect((await f.cap.reconcile(intent,run)).outcome).toBe("still_unknown");
    expect(f.oread).not.toHaveBeenCalled();
  });
  it("detects state drift between first and final read",async()=>{
    let n=0;
    const cap=bindReleasePointerReconciliation({
      oracle:{getState:async()=>++n===1?oracle:{...oracle,previous:{
        releaseId:"1.1.0-beta.87",manifestSha256:"e".repeat(64)}}},
      windows:{getState:async()=>windows},authorize:async()=>true,
    });
    expect((await cap.execute(intent,run)).state).toBe("outcome_unknown");
  });
});
