import {describe,expect,it,jest} from "@jest/globals";
import {bindWindowsCandidate,type WindowsCandidateReceipt}
  from "../../src/release-windows-candidate-capability.js";
import type {ReleaseRunSnapshot,StepIntent} from "../../src/types.js";
const runId="11111111-2222-4333-8444-555555555555";
const operationId="11111111-2222-4333-8444-555555555556";
const preparedId="11111111-2222-4333-8444-555555555557";
const tag="v1.1.0-beta.90",sourceCommitSha="a".repeat(40);
const sha="b".repeat(64);
const receipt:WindowsCandidateReceipt={
  platform:"windows",releaseTag:tag,sourceCommitSha,runId,operationId,
  manifestSha256:sha,verifiedArtifactCount:13,
};
const state={active:{releaseId:"1.1.0-beta.89",manifestSha256:"c".repeat(64)},
  previous:{releaseId:"1.1.0-beta.88",manifestSha256:"d".repeat(64)},
  candidate:{releaseId:"1.1.0-beta.90",manifestSha256:sha}};
const run={runId,targetRelease:tag,sourceCommitSha,status:"running",
  steps:[
    {stepId:"prepare_windows",action:"prepare_windows",operationId:preparedId,status:"succeeded"},
    {stepId:"validate_windows_candidate",action:"validate_windows_candidate",
      operationId,status:"outcome_unknown"},
  ]} as unknown as ReleaseRunSnapshot;
const intent={runId,operationId,stepId:"validate_windows_candidate",
  action:"validate_windows_candidate",executionClass:"read_only"} as unknown as StepIntent;
function fixture(){
  const inspectCandidate=jest.fn(async(_tag:string,_sha:string,_run:string,_op:string)=>receipt);
  const getState=jest.fn(async()=>state);
  let allowed=true;
  return {
    cap:bindWindowsCandidate({port:{inspectCandidate,getState},
      authorize:async()=>allowed}),
    inspectCandidate,getState,deny:()=>{allowed=false;},
  };
}
describe("Windows independently attested candidate and original prepare receipt",()=>{
  it("attests complete candidate bytes, pointer consistency, and original operation",async()=>{
    const f=fixture();
    expect(await f.cap.execute(intent,run)).toMatchObject({state:"succeeded",
      evidence:[{kind:"windows_candidate_manifest",
        source:"mcp_v3_verified_windows",sha256:sha}]});
    expect(f.inspectCandidate).toHaveBeenCalledWith(tag,sourceCommitSha,runId,operationId);
    expect(f.inspectCandidate).toHaveBeenCalledTimes(2);
    expect(f.getState).toHaveBeenCalledTimes(2);
    expect(await f.cap.reconcile(intent,{...run,status:"paused_outcome_unknown"}))
      .toMatchObject({outcome:"applied"});
  });
  it("refuses a prepare not completed, step replay mismatch or revoked scope",async()=>{
    const f=fixture();
    const pending={...run,steps:run.steps.map(s=>s.action==="prepare_windows"?
      {...s,status:"outcome_unknown" as const}:s)};
    expect((await f.cap.execute(intent,pending)).state).toBe("outcome_unknown");
    expect((await f.cap.execute({...intent,operationId:preparedId},run)).state)
      .toBe("outcome_unknown");
    f.deny();
    expect((await f.cap.reconcile(intent,run)).outcome).toBe("still_unknown");
    expect(f.inspectCandidate).not.toHaveBeenCalled();
  });
  it("rejects forged identity, corrupt manifest, candidate drift and premature promotion",async()=>{
    const cases=[
      {receipt:{...receipt,platform:"oracle" as "windows"}},
      {receipt:{...receipt,runId:operationId}},
      {receipt:{...receipt,sourceCommitSha:"e".repeat(40)}},
      {receipt:{...receipt,verifiedArtifactCount:0}},
      {state:{...state,candidate:{...state.candidate,manifestSha256:"f".repeat(64)}}},
      {state:{...state,candidate:null}},
      {state:{...state,active:state.candidate}},
    ];
    for(const changes of cases){
      const cap=bindWindowsCandidate({port:{
        inspectCandidate:async()=>changes.receipt??receipt,
        getState:async()=>changes.state??state,
      },authorize:async()=>true});
      expect((await cap.execute(intent,run)).state).toBe("outcome_unknown");
    }
  });
  it("denies release state changing between independent observations",async()=>{
    let calls=0;
    const cap=bindWindowsCandidate({port:{
      inspectCandidate:async()=>receipt,
      getState:async()=>++calls===1?state:{
        ...state,previous:{releaseId:"1.1.0-beta.87",manifestSha256:"e".repeat(64)},
      },
    },authorize:async()=>true});
    expect((await cap.execute(intent,run)).state).toBe("outcome_unknown");
  });
});
