import { describe, expect, it } from "@jest/globals";
import { InMemoryMutationReceiptStore, type OperationContext } from "@vs-code-gpt/shared";
import { GitHubReleaseWorkflowOperation, type GitHubReleaseWorkflowInput } from "../../../src/source-control/github-release-workflow-operation.js";
import type { GitHubWorkflowRunRecord } from "../../../src/source-control/github-http-client.js";

const sha="a".repeat(40);
const operationId="11111111-2222-4333-8444-555555555555";
const input:GitHubReleaseWorkflowInput={
  workspaceId:"mcp-access-stack",owner:"iFael",repository:"mcp-access-stack",
  workflow:"edge-f09-guarded-rollout.yml",expectedMainSha:sha,operationId,
};
const context:OperationContext={ownerScope:"trusted:test"};
function setup() {
  let main=sha;
  let authorized=true;
  let dispatched=0;
  let throwOnDispatch=false;
  let runs:GitHubWorkflowRunRecord[]=[];
  let reportedTotal:number|undefined;
  const receipts=new InMemoryMutationReceiptStore();
  const coordinator=new GitHubReleaseWorkflowOperation({
    receipts,authorize:async()=>authorized,
    client:{
      getMainRef:async()=>({ref:"refs/heads/main",object:{sha:main,type:"commit"}}),
      getTagRef:async(_owner,_repo,tag)=>({ref:"refs/tags/"+tag,object:{sha:main,type:"commit"}}),
      getWorkflowRuns:async()=>({total_count:reportedTotal??runs.length,workflow_runs:runs}),
      getTagPushRuns:async()=>({total_count:reportedTotal??runs.filter(r=>r.event==="push").length,
        workflow_runs:runs.filter(r=>r.event==="push")}),
      dispatchWorkflow:async(_owner,_repo,_workflow,_expected,details)=>{
        dispatched++;
        expect(details).toMatchObject({operation_id:operationId});
        if(throwOnDispatch)throw new Error("POST outcome unknown");
      },
    },
  });
  function addRun(overrides:Partial<GitHubWorkflowRunRecord>={}) {
    runs.push({
      id:9921001,workflow_id:555,name:"Guarded f09 Edge contract migration",
      display_title:"mcp-release-"+operationId,
      head_sha:sha,event:"workflow_dispatch",status:"queued",
      conclusion:null,run_attempt:1,...overrides,
    });
  }
  return {coordinator,receipts,addRun,dispatched:()=>dispatched,
    setMain:(s:string)=>{main=s;},setAuthorized:(v:boolean)=>{authorized=v;},
    setThrow:(v:boolean)=>{throwOnDispatch=v;},setTotal:(n:number)=>{reportedTotal=n;}};
}
describe("GitHub release workflow operation using canonical mutation receipts",()=>{
  it("submits at most one fixed workflow and reconciles its runId without another POST",async()=>{
    const f=setup();
    expect(await f.coordinator.dispatch(input,context)).toEqual({status:"submitted",operationId});
    expect(f.dispatched()).toBe(1);
    expect(await f.coordinator.dispatch(input,context)).toEqual({status:"submitted",operationId});
    expect(f.dispatched()).toBe(1);
    expect(await f.coordinator.reconcile(input,context)).toEqual({status:"outcome_unknown",operationId});
    f.addRun();
    expect(await f.coordinator.reconcile(input,context)).toEqual({
      status:"observed",operationId,runId:9921001,state:"queued",conclusion:null,
    });
    expect(f.dispatched()).toBe(1);
  });

  it("never retries after ambiguous network response; reconciles original receipt only",async()=>{
    const f=setup();
    f.setThrow(true);
    expect(await f.coordinator.dispatch(input,context)).toEqual({status:"outcome_unknown",operationId});
    f.setThrow(false);
    expect(await f.coordinator.dispatch(input,context)).toEqual({status:"outcome_unknown",operationId});
    expect(f.dispatched()).toBe(1);
    f.addRun({status:"completed",conclusion:"success"});
    expect(await f.coordinator.reconcile(input,context)).toEqual({
      status:"observed",operationId,runId:9921001,state:"completed",conclusion:"success",
    });
    expect((await f.receipts.get("release-workflow:mcp-access-stack:"+operationId))?.state).toBe("completed");
  });

  it("fails closed for main SHA mismatch, absent gate and changed identity",async()=>{
    const f=setup();
    f.setAuthorized(false);
    await expect(f.coordinator.dispatch(input,context)).rejects.toThrow("not authorized");
    f.setAuthorized(true);
    f.setMain("b".repeat(40));
    expect((await f.coordinator.dispatch(input,context)).status).toBe("outcome_unknown");
    expect(f.dispatched()).toBe(0);
    const changed={...input,expectedMainSha:"b".repeat(40)};
    await expect(f.coordinator.dispatch(changed,context)).rejects.toThrow();
    expect(f.dispatched()).toBe(0);
  });

  it("never attributes a run of the wrong SHA, duplicate, or truncated history",async()=>{
    const f=setup();
    await f.coordinator.dispatch(input,context);
    f.addRun({head_sha:"b".repeat(40)});
    expect((await f.coordinator.reconcile(input,context)).status).toBe("outcome_unknown");
    f.setTotal(100);
    expect((await f.coordinator.reconcile(input,context)).status).toBe("outcome_unknown");
    expect(f.dispatched()).toBe(1);
  });

  it("observes an automatically tag-triggered public release and forbids a duplicate dispatch",async()=>{
    const f=setup();
    const release={...input,workflow:"release.yml" as const,tag:"v1.1.0-beta.90"};
    await expect(f.coordinator.dispatch(release,context)).rejects.toThrow("duplicate dispatch");
    expect((await f.coordinator.reconcile(release,context)).status).toBe("outcome_unknown");
    f.addRun({name:"Public release",event:"push",head_branch:release.tag,
      status:"completed",conclusion:"success"});
    expect(await f.coordinator.reconcile(release,context)).toMatchObject({
      status:"observed",runId:9921001,state:"completed",conclusion:"success",
    });
    expect(f.dispatched()).toBe(0);
    expect(await f.receipts.get("release-workflow:mcp-access-stack:"+operationId)).toBeUndefined();
  });

  it("never accepts a stale tag, a main-push run, or duplicate tag-push runs",async()=>{
    const f=setup();
    const release={...input,workflow:"release.yml" as const,tag:"v1.1.0-beta.90"};
    f.addRun({event:"push",head_branch:"main",status:"completed",conclusion:"success"});
    expect((await f.coordinator.reconcile(release,context)).status).toBe("outcome_unknown");
    f.addRun({id:9921002,event:"push",head_branch:release.tag,
      status:"completed",conclusion:"success"});
    expect((await f.coordinator.reconcile(release,context)).status).toBe("observed");
    f.addRun({id:9921003,event:"push",head_branch:release.tag,
      status:"completed",conclusion:"success"});
    expect((await f.coordinator.reconcile(release,context)).status).toBe("outcome_unknown");
    f.setMain("b".repeat(40));
    expect((await f.coordinator.reconcile(release,context)).status).toBe("outcome_unknown");
    expect(f.dispatched()).toBe(0);
  });

  it("rejects reserved Oracle/Companion tags and missing public tag",async()=>{
    const f=setup();
    await expect(f.coordinator.dispatch({...input,workflow:"release.yml"},context))
      .rejects.toThrow("Invalid pinned");
    await expect(f.coordinator.dispatch({...input,workflow:"release.yml",tag:"v1.1.0-companion.7"},context))
      .rejects.toThrow("Invalid pinned");
    await expect(f.coordinator.dispatch({...input,workflow:"release.yml",tag:"v1.1.0-oracle.4"},context))
      .rejects.toThrow("Invalid pinned");
    expect(f.dispatched()).toBe(0);
  });

  it("rejects unlisted workflows and missing owner identity",async()=>{
    const f=setup();
    await expect(f.coordinator.dispatch({...input,workflow:"release.yml" as never},context))
      .rejects.toThrow("Invalid pinned");
    await expect(f.coordinator.dispatch(input,{})).rejects.toThrow("Invalid pinned");
    expect(f.dispatched()).toBe(0);
  });
});
