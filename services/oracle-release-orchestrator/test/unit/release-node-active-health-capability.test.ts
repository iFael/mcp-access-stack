import {describe,expect,it,jest} from "@jest/globals";
import {bindReleaseNodeActiveHealth,
  type ReleaseNodeActiveHealthBinding,type NodeHealthPlatform}
  from "../../src/release-node-active-health-capability.js";
import type {ReleaseRunSnapshot,StepIntent} from "../../src/types.js";
const now=Date.parse("2026-10-17T18:00:00.000Z"),tag="v1.1.0-beta.90";
const commit="a".repeat(40),manifestHash="b".repeat(64);
const healthId="11111111-2222-4333-8444-555555555553";
const promotionId="11111111-2222-4333-8444-555555555554";
const runId="11111111-2222-4333-8444-555555555555";
function runFor(platform:NodeHealthPlatform):{
  run:ReleaseRunSnapshot;intent:StepIntent;
}{
  const promotion=platform==="oracle"?"promote_oracle":"promote_windows";
  const action=platform==="oracle"?"verify_oracle_health":"verify_windows_health";
  const run={runId,targetRelease:tag,sourceCommitSha:commit,status:"running",
    steps:[
      {stepId:promotion,action:promotion,status:"succeeded",operationId:promotionId},
      {stepId:action,action,status:"outcome_unknown",operationId:healthId},
    ]} as unknown as ReleaseRunSnapshot;
  const intent={runId,stepId:action,action,operationId:healthId,
    executionClass:"read_only"} as unknown as StepIntent;
  return {run,intent};
}
const manifest={releaseTag:tag,sourceCommitSha:commit,
  manifestSha256:manifestHash,verifiedArtifactCount:13};
const state={active:{releaseId:tag.slice(1),manifestSha256:manifestHash},
  previous:{releaseId:"1.1.0-beta.89",manifestSha256:"c".repeat(64)},candidate:null};
const health={status:"healthy" as const,releaseId:tag.slice(1),
  manifestSha256:manifestHash,processId:1234,
  observedAt:new Date(now-3_000).toISOString()};
function fixture(platform:NodeHealthPlatform){
  const inspectActive=jest.fn(async(_tag:string,_commit:string)=>manifest);
  const getState=jest.fn(async()=>state);
  const getHealth=jest.fn(async()=>health);
  let authorized=true;
  const binding={platform,port:{inspectActive,getState,getHealth},
    authorize:async()=>authorized,now:()=>now} satisfies ReleaseNodeActiveHealthBinding;
  return {cap:bindReleaseNodeActiveHealth(binding),
    inspectActive,getState,getHealth,deny:()=>{authorized=false;}};
}
describe.each(["oracle","windows"] as const)(
  "%s active release and runtime health",platform=>{
    it("attests two actual snapshots and the original terminal promotion",async()=>{
      const f=fixture(platform),{run,intent}=runFor(platform);
      expect(await f.cap.execute(intent,run)).toMatchObject({
        state:"succeeded",evidence:[
          {kind:platform+"_active_manifest",
            source:"mcp_v3_verified_"+platform,
            sha256:expect.stringMatching(/^[a-f0-9]{64}$/u)},
          {kind:platform+"_health_report",
            source:"mcp_v3_verified_"+platform,
            sha256:expect.stringMatching(/^[a-f0-9]{64}$/u)},
        ],
      });
      expect(f.inspectActive).toHaveBeenCalledTimes(2);
      expect(f.inspectActive).toHaveBeenCalledWith(tag,commit);
      expect(f.getState).toHaveBeenCalledTimes(2);
      expect(f.getHealth).toHaveBeenCalledTimes(2);
      expect(await f.cap.reconcile(intent,{...run,status:"paused_outcome_unknown"}))
        .toMatchObject({outcome:"applied"});
    });
    it("refuses nonterminal promotion, mismatched operation, and revoked policy",async()=>{
      const f=fixture(platform),{run,intent}=runFor(platform);
      const pending={...run,steps:run.steps.map(s=>s.action==="promote_"+platform?
        {...s,status:"outcome_unknown" as const}:s)};
      expect((await f.cap.execute(intent,pending)).state).toBe("outcome_unknown");
      expect((await f.cap.execute({...intent,operationId:promotionId},run)).state)
        .toBe("outcome_unknown");
      f.deny();
      expect((await f.cap.reconcile(intent,run)).outcome).toBe("still_unknown");
      expect(f.inspectActive).not.toHaveBeenCalled();
    });
    it("fails closed on mismatched manifest bytes, stale health, absent rollback or candidate",async()=>{
      const {run,intent}=runFor(platform);
      for(const override of [
        {manifest:{...manifest,sourceCommitSha:"e".repeat(40)}},
        {state:{...state,active:{...state.active,manifestSha256:"f".repeat(64)}}},
        {state:{...state,candidate:state.active}},
        {state:{...state,previous:null}},
        {health:{...health,observedAt:new Date(now-300_000).toISOString()}},
        {health:{...health,manifestSha256:"a".repeat(64)}},
        {health:{...health,status:"unhealthy" as const}},
      ]){
        const port={
          inspectActive:async()=>override.manifest??manifest,
          getState:async()=>override.state??state,
          getHealth:async()=>override.health??health,
        };
        const cap=bindReleaseNodeActiveHealth({platform,port,
          authorize:async()=>true,now:()=>now});
        expect((await cap.execute(intent,run)).state).toBe("outcome_unknown");
      }
    });
    it("rejects a cutover between the two live reads",async()=>{
      const {run,intent}=runFor(platform);let reads=0;
      const cap=bindReleaseNodeActiveHealth({
        platform,port:{inspectActive:async()=>manifest,
          getState:async()=>++reads===1?state:{...state,previous:{
            releaseId:"1.1.0-beta.88",manifestSha256:"c".repeat(64)}},
          getHealth:async()=>health},
        authorize:async()=>true,now:()=>now,
      });
      expect((await cap.execute(intent,run)).state).toBe("outcome_unknown");
    });
  });
