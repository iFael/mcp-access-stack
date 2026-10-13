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
  let runs:(GitHubWorkflowRunRecord & {workflow?:string})[]=[];
  let reportedTotal:number|undefined;
  const receipts=new InMemoryMutationReceiptStore();
  const coordinator=new GitHubReleaseWorkflowOperation({
    receipts,authorize:async()=>authorized,
    client:{
      getMainRef:async()=>({ref:"refs/heads/main",object:{sha:main,type:"commit"}}),
      getTagRef:async(_owner,_repo,tag)=>({ref:"refs/tags/"+tag,object:{sha:main,type:"commit"}}),
      getWorkflowRuns:async(_owner,_repo,workflow)=>{
        const filtered=runs.filter(run=>(run.workflow??input.workflow)===workflow);
        return {total_count:reportedTotal??filtered.length,workflow_runs:filtered};
      },
      getTagPushRuns:async()=>({total_count:reportedTotal??runs.filter(r=>r.event==="push").length,
        workflow_runs:runs.filter(r=>r.event==="push")}),
      dispatchWorkflow:async(_owner,_repo,_workflow,_expected,details)=>{
        dispatched++;
        expect(details.operation_id).toMatch(/^[0-9a-f-]{36}$/);
        if(throwOnDispatch)throw new Error("POST outcome unknown");
      },
    },
  });
  function addRun(overrides:Partial<GitHubWorkflowRunRecord> & {workflow?:string}={}) {
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

  it("bootstraps an existing guarded release-tag workflow exactly once and reconciles by UUID",async()=>{
    const f=setup();
    const bootstrap={...input,workflow:"release-tag-bootstrap.yml" as const,
      tag:"v1.1.0-beta.90"};
    expect((await f.coordinator.dispatch(bootstrap,context)).status).toBe("submitted");
    expect((await f.coordinator.dispatch(bootstrap,context)).status).toBe("submitted");
    expect(f.dispatched()).toBe(1);
    f.addRun({name:"Release tag bootstrap",workflow:"release-tag-bootstrap.yml",status:"completed",conclusion:"success"});
    expect(await f.coordinator.reconcile(bootstrap,context)).toMatchObject({
      status:"observed",runId:9921001,conclusion:"success",
    });
    await expect(f.coordinator.dispatch({...bootstrap,tag:"v1.1.0-beta.91"},context))
      .rejects.toThrow();
    expect(f.dispatched()).toBe(1);
  });

  it("dispatches public release once only after successful same-operation bootstrap and pinned tag",async()=>{
    const f=setup();
    const release={...input,workflow:"release.yml" as const,tag:"v1.1.0-beta.90",
      bootstrapOperationId:operationId};
    expect((await f.coordinator.dispatch(release,context)).status).toBe("outcome_unknown");
    expect(f.dispatched()).toBe(0);
    f.addRun({workflow:"release-tag-bootstrap.yml",name:"Release tag bootstrap",
      status:"completed",conclusion:"success"});
    expect((await f.coordinator.dispatch(release,context)).status).toBe("submitted");
    expect((await f.coordinator.dispatch(release,context)).status).toBe("submitted");
    expect(f.dispatched()).toBe(1);
    f.addRun({workflow:"release.yml",id:9921002,name:"Public release",
      status:"completed",conclusion:"success"});
    expect(await f.coordinator.reconcile(release,context)).toMatchObject({
      status:"observed",runId:9921002,state:"completed",conclusion:"success",
    });
    expect(f.dispatched()).toBe(1);
  });

  it("proves public dispatch using distinct Oracle step operation IDs",async()=>{
    const f=setup();
    const publicOperationId="11111111-2222-4333-8444-555555555556";
    const release={...input,workflow:"release.yml" as const,tag:"v1.1.0-beta.90",
      bootstrapOperationId:operationId,operationId:publicOperationId};
    f.addRun({workflow:"release-tag-bootstrap.yml",name:"Release tag bootstrap",
      status:"completed",conclusion:"success",
      display_title:"mcp-release-"+operationId});
    expect((await f.coordinator.dispatch(release,context)).status).toBe("submitted");
    expect(f.dispatched()).toBe(1);
    f.addRun({workflow:"release.yml",name:"Public release",id:9921002,
      display_title:"mcp-release-"+publicOperationId,status:"completed",conclusion:"success"});
    expect(await f.coordinator.reconcile(release,context)).toMatchObject({
      status:"observed",operationId:publicOperationId,runId:9921002,
      state:"completed",conclusion:"success",
    });
    await expect(f.coordinator.dispatch({...release,bootstrapOperationId:
      "11111111-2222-4333-8444-555555555557"},context)).rejects.toThrow();
    expect(f.dispatched()).toBe(1);
  });

  it("rejects dispatch with no trusted bootstrap operationId",async()=>{
    const f=setup();
    await expect(f.coordinator.dispatch({...input,workflow:"release.yml",
      tag:"v1.1.0-beta.90"},context)).rejects.toThrow("bootstrap operation identity");
    expect(f.dispatched()).toBe(0);
  });

  it("does not dispatch public release when a tag-push run already exists",async()=>{
    const f=setup();
    const release={...input,workflow:"release.yml" as const,tag:"v1.1.0-beta.90",
      bootstrapOperationId:operationId};
    f.addRun({workflow:"release.yml",name:"Public release",event:"push",
      head_branch:release.tag,status:"completed",conclusion:"success"});
    expect((await f.coordinator.dispatch(release,context)).status).toBe("outcome_unknown");
    expect(await f.coordinator.reconcile(release,context)).toMatchObject({
      status:"observed",runId:9921001,conclusion:"success",
    });
    expect(f.dispatched()).toBe(0);
  });

  it("does not duplicate same public tag with a different operationId",async()=>{
    const f=setup();
    const release={...input,workflow:"release.yml" as const,tag:"v1.1.0-beta.90",
      bootstrapOperationId:operationId};
    f.addRun({workflow:"release-tag-bootstrap.yml",status:"completed",
      name:"Release tag bootstrap",conclusion:"success"});
    expect((await f.coordinator.dispatch(release,context)).status).toBe("submitted");
    await expect(f.coordinator.dispatch({...release,
      operationId:"11111111-2222-4333-8444-555555555556"},context)).rejects.toThrow();
    expect(f.dispatched()).toBe(1);
  });

  it("does not dispatch public release when bootstrap failed, is pending or tag drifted",async()=>{
    const f=setup();
    const release={...input,workflow:"release.yml" as const,tag:"v1.1.0-beta.90",
      bootstrapOperationId:operationId};
    f.addRun({workflow:"release-tag-bootstrap.yml",status:"in_progress",name:"Release tag bootstrap"});
    expect((await f.coordinator.dispatch(release,context)).status).toBe("outcome_unknown");
    f.setMain("b".repeat(40));
    expect((await f.coordinator.dispatch(release,context)).status).toBe("outcome_unknown");
    expect(f.dispatched()).toBe(0);
  });

  it("never accepts a stale tag, a main-push run, or duplicate tag-push runs",async()=>{
    const f=setup();
    const release={...input,workflow:"release.yml" as const,tag:"v1.1.0-beta.90",
      bootstrapOperationId:operationId};
    f.addRun({workflow:"release.yml",event:"push",head_branch:"main",status:"completed",conclusion:"success"});
    expect((await f.coordinator.reconcile(release,context)).status).toBe("outcome_unknown");
    f.addRun({workflow:"release.yml",id:9921002,event:"push",head_branch:release.tag,
      status:"completed",conclusion:"success"});
    expect((await f.coordinator.reconcile(release,context)).status).toBe("observed");
    f.addRun({workflow:"release.yml",id:9921003,event:"push",head_branch:release.tag,
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
