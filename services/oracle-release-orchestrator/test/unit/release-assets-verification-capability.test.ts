import {describe,it,expect,jest} from "@jest/globals";
import {bindReleaseAssetsVerification} from "../../src/release-assets-verification-capability.js";
import type {ReleaseRunSnapshot,StepIntent} from "../../src/types.js";
import type {ReleaseAssetVerificationBinding} from "../../src/release-assets-verification-capability.js";
const sha="a".repeat(40),digest="c".repeat(64),tag="v1.1.0-beta.90";
const UUIDS={
 run:"11111111-2222-4333-8444-555555555555",
 bootstrap:"11111111-2222-4333-8444-555555555556",
 build:"11111111-2222-4333-8444-555555555557",
 published:"11111111-2222-4333-8444-555555555558",
 verify:"11111111-2222-4333-8444-555555555559",
};
const steps=(Object.entries({
  publish_release_tag:UUIDS.bootstrap,build_and_sign_release:UUIDS.build,
  publish_signed_release:UUIDS.published,verify_release_assets:UUIDS.verify,
})).map(([action,operationId])=>({
  stepId:action,action,operationId,executionClass:action==="verify_release_assets"?"read_only":"external_effect",
  status:action==="verify_release_assets"?"outcome_unknown":"succeeded",
}));
const run={runId:UUIDS.run,sourceCommitSha:sha,targetRelease:tag,status:"running",
  steps,lastSeq:8} as unknown as ReleaseRunSnapshot;
const intent={runId:UUIDS.run,stepId:"verify_release_assets",
  action:"verify_release_assets",operationId:UUIDS.verify,
  executionClass:"read_only"} as unknown as StepIntent;
function setup(){
  let authorized=true, published=true, passed=true, main=sha, badInventory=false;
  let reads=0;
  const dispatch=jest.fn(async(input:{mode:string;operationId:string;bootstrapOperationId:string})=>({
    status:"observed" as const,operationId:input.operationId,runId:777,
    state:"completed" as const,conclusion:"success",
  }));
  const inspection=jest.fn(async(runId:number)=>({
    sourceCommitSha:sha,releaseTag:tag,workflowRunId:runId,
    integrityVerified:true,releasePublished:published,
    verifiedAssetCount:badInventory?4:5,assetInventorySha256:digest,
  }));
  const binding:ReleaseAssetVerificationBinding={
    workspaceId:"mcp-access-stack",owner:"iFael",repository:"mcp-access-stack",
    authorize:async()=>authorized,
    source:{
      readMainHead:async()=>{reads++;return main;},
      readCommitChecks:async()=>({
        commitSha:sha,totalCount:1,returnedCount:1,successfulCount:passed?1:0,
        pendingCount:passed?0:1,failingCount:0,allCompleted:passed,
        truncated:false,passed,
        checks:[{id:12,name:"CI",status:passed?"completed":"in_progress",
          conclusion:passed?"success":null}],
      }),
    },
    workflow:{workflowOperation:dispatch,inspectDistribution:inspection},
  };
  return {cap:bindReleaseAssetsVerification(binding),dispatch,inspection,
    setAuthorized:(a:boolean)=>{authorized=a;},
    setPublished:(a:boolean)=>{published=a;},
    setPassed:(a:boolean)=>{passed=a;},
    setMain:(s:string)=>{main=s;},
    setBadInventory:(a:boolean)=>{badInventory=a;},
    getReads:()=>reads};
}
describe("independent GitHub proof for Oracle verify_release_assets",()=>{
  it("uses existing release operation only; verifies tag, CI and all five actual asset checksums",async()=>{
    const f=setup();
    const result=await f.cap.execute(intent,run);
    expect(result.state).toBe("succeeded");
    if(result.state!=="succeeded")throw new Error("proof missing");
    expect(result.evidence.map(e=>e.kind)).toEqual([
      "canonical_ci_run","signed_manifest","release_asset_digest"]);
    expect(result.evidence[2]?.sha256).toBe(digest);
    expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      mode:"reconcile",operationId:UUIDS.build,bootstrapOperationId:UUIDS.bootstrap,
      expectedMainSha:sha}));
    const resumed=await f.cap.reconcile(intent,{...run,status:"paused_outcome_unknown"});
    expect(resumed.outcome).toBe("applied");
    expect(f.dispatch.mock.calls.every(args=>args[0]!.mode==="reconcile")).toBe(true);
  });
  it("fails closed for unpublished assets, malformed inventory, or incomplete CI",async()=>{
    const f=setup();
    f.setPublished(false);
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
    f.setPublished(true);f.setBadInventory(true);
    expect((await f.cap.reconcile(intent,run)).outcome).toBe("still_unknown");
    f.setBadInventory(false);f.setPassed(false);
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
  });
  it("rejects authorization revocation or mismatched original operation without any read",async()=>{
    const f=setup();
    f.setAuthorized(false);
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
    expect((await f.cap.reconcile(intent,run)).outcome).toBe("still_unknown");
    expect(f.getReads()).toBe(0);
    f.setAuthorized(true);
    expect((await f.cap.execute({...intent,operationId:UUIDS.build},run)).state)
      .toBe("outcome_unknown");
    expect(f.getReads()).toBe(0);
  });
  it("checks main ref before and after the authenticated proof",async()=>{
    const f=setup();
    f.setMain("b".repeat(40));
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
    expect(f.dispatch).not.toHaveBeenCalled();
  });
});
