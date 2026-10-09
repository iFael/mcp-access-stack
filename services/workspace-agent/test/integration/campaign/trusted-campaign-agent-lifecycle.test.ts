import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { LocalAgent } from "../../../src/local-agent.js";
import { DelegatedCampaignLedger, type CampaignRecord } from "../../../src/campaign/delegated-campaign-ledger.js";
import { CampaignResourceClaims } from "../../../src/campaign/campaign-resource-claims.js";
import {
  TrustedCampaignEnrollmentCatalog, type TrustedCampaignBindingFactories,
} from "../../../src/campaign/trusted-campaign-enrollment-catalog.js";
import { bindGitCleanInspection } from "../../../src/campaign/typed-read-capabilities.js";
import type { TypedCampaignCapability } from "../../../src/campaign/delegated-campaign-coordinator.js";
import type { TrustedCampaignEnrollment } from "../../../src/campaign/trusted-campaign-agent-lifecycle.js";
import {
  createFixture, git, initializeGitRepository, writeWorkspaceFile,
  type Fixture,
} from "../../support/helpers.js";

const ids=[
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];
let f:Fixture|undefined;
const owner="host:trusted-owner";
afterEach(async()=>{await f?.cleanup();f=undefined});
async function fixture(){
  f=await createFixture({profile:"full-repo-readonly"});
  initializeGitRepository(f.workspacePath);
  git(f.workspacePath,["checkout","-b","feature/delegated-host"]);
  await writeWorkspaceFile(f.workspacePath,"baseline.txt","ok\n");
  git(f.workspacePath,["add","baseline.txt"]);
  git(f.workspacePath,["commit","-m","baseline"]);
  return f;
}
function mutationTask(){
  return {
    id:"commit",action:"commit" as const,dependsOn:[],
    targetResource:"git:test:.", expectedState:"head:"+"a".repeat(40),
    argumentsDigest:createHash("sha256").update("locked mutation").digest("hex"),
  };
}
function capability(record:CampaignRecord,run:{
  dispatch:()=>void,
  reconciliation?:()=>boolean,
}):ReadonlyMap<string,TypedCampaignCapability>{
  return new Map(record.tasks.map(t=>[t.id,{
    action:t.action,targetResource:t.targetResource,
    expectedState:t.expectedState,argumentsDigest:t.argumentsDigest,
    execute:async request=>{
      run.dispatch();
      return {
        operationId:request.operationId,targetResource:request.targetResource,
        expectedState:request.expectedState,argumentsDigest:request.argumentsDigest,
        state:"outcome_unknown" as const,
      };
    },
    reconcile:async request=>({
      operationId:request.operationId,targetResource:request.targetResource,
      expectedState:request.expectedState,argumentsDigest:request.argumentsDigest,
      ...(run.reconciliation?.() ? {
        state:"succeeded" as const,
        proof:{kind:"verified" as const,reference:"fixture-reconcile:"+request.operationId},
      } : {state:"outcome_unknown" as const}),
    }),
    verify:async()=>true,
  }]));
}
describe("LocalAgent trusted campaign lifecycle",()=>{
  it("never autostarts, then verifies a real policy-authorized Git inspection after agent restart",async()=>{
    const target=await fixture();
    const ledger=new DelegatedCampaignLedger(target.basePath,owner);
    const firstAgent=await LocalAgent.create(target.policyPath);
    const inspection=bindGitCleanInspection(firstAgent,{
      workspaceId:"test",root:".",expectedBranch:"feature/delegated-host",
    },{ownerScope:owner});
    await ledger.create({
      campaignId:ids[0]!,workspaceId:"test",objective:"Verify Git through local trusted policy",
      authorizedActions:["inspect"],
      tasks:[{id:"git",dependsOn:[],...inspection.definition}],
    });
    const enrollment:TrustedCampaignEnrollment={
      workspaceId:"test",campaignId:ids[0]!,ownerScope:owner,
      bind:async(agent)=>new Map([["git",bindGitCleanInspection(agent,{
        workspaceId:"test",root:".",expectedBranch:"feature/delegated-host",
      },{ownerScope:owner}).capability]]),
    };
    const first=firstAgent.createTrustedCampaignHost([enrollment],{
      stateDirectory:target.basePath,
    });
    expect((await ledger.get("test",ids[0]!))?.revision).toBe(0);
    expect(first.status()).toEqual([]);
    // No service, dispatch or registration is started by LocalAgent.create().
    const recreated=await LocalAgent.create(target.policyPath);
    const host=recreated.createTrustedCampaignHost([enrollment],{
      stateDirectory:target.basePath,
    });
    const outcome=await host.serve(3);
    expect(outcome.stop).toBe("all_completed");
    expect(outcome.campaigns[0]?.executed).toBe(1);
    expect((await ledger.get("test",ids[0]!))?.tasks[0]?.proof?.reference)
      .toMatch(/^git-clean:[a-f0-9]{64}$/u);
    await host.shutdown();
    await expect(host.serve(1)).rejects.toThrow("CAMPAIGN_HOST_STOPPED");
  });
  it("reserves mutating workspace across different agents and preserves unknown until reconciliation",async()=>{
    const target=await fixture();
    const ledger=new DelegatedCampaignLedger(target.basePath,owner);
    for(const id of ids)await ledger.create({
      campaignId:id,workspaceId:"test",objective:"Fixture mutation owner "+id,
      authorizedActions:["commit"],tasks:[mutationTask()],
    });
    let callsA=0,callsB=0,done=false;
    const enrollment=(index:number):TrustedCampaignEnrollment=>({
      workspaceId:"test",campaignId:ids[index]!,ownerScope:owner,
      bind:async(_agent,record)=>capability(record,{
        dispatch:()=>{if(index===0)callsA++;else callsB++},
        reconciliation:()=>index===0&&done,
      }),
    });
    const firstAgent=await LocalAgent.create(target.policyPath);
    const secondAgent=await LocalAgent.create(target.policyPath);
    const first=firstAgent.createTrustedCampaignHost([enrollment(0)],{
      stateDirectory:target.basePath,supervisor:{maxStepsPerWake:1},
    });
    const second=secondAgent.createTrustedCampaignHost([enrollment(1)],{
      stateDirectory:target.basePath,
    });
    const initial=await first.serve(1);
    expect(initial.stop).toBe("wake_budget");
    expect(callsA).toBe(1);
    await expect(second.serve(1)).rejects.toThrow("CAMPAIGN_RESOURCE_CONFLICT");
    expect(callsB).toBe(0);
    expect((await ledger.get("test",ids[1]!))?.revision).toBe(0);
    done=true;
    expect((await first.serve(2)).stop).toBe("all_completed");
    expect(callsA).toBe(1);
    // The previous reservation was released ONLY after confirmed ledger completion.
    const finish=await second.serve(1);
    expect(finish.campaigns[0]?.state).toBe("awaiting_reconciliation");
    expect(callsB).toBe(1);
    const ownerId=(await ledger.get("test",ids[0]!))?.tasks[0]?.operationId;
    expect(ownerId).toBeTruthy();
    await first.shutdown();await second.shutdown();
  });
  it("queues enrolled writers and admits the second only after verified completion",async()=>{
    const target=await fixture();
    const ledger=new DelegatedCampaignLedger(target.basePath,owner);
    for(const id of ids)await ledger.create({
      campaignId:id,workspaceId:"test",objective:"Conflicting campaign "+id,
      authorizedActions:["commit"],tasks:[mutationTask()],
    });
    const agent=await LocalAgent.create(target.policyPath);
    const calls:string[]=[];
    let firstDone=false;
    const enroll=ids.map((id,index)=>({
      workspaceId:"test",campaignId:id,ownerScope:owner,
      bind:async(_agent:LocalAgent,record:CampaignRecord)=>capability(record,{
        dispatch:()=>{calls.push(id)},
        reconciliation:()=>index===0&&firstDone,
      }),
    }));
    const host=agent.createTrustedCampaignHost(enroll,{stateDirectory:target.basePath});
    const first=await host.serve(1);
    expect(first.campaigns.find(c=>c.campaignId===ids[1])?.state).toBe("queued");
    expect(calls).toEqual([ids[0]]);
    firstDone=true;
    const after=await host.serve(2);
    expect(after.campaigns.find(c=>c.campaignId===ids[0])?.state).toBe("completed");
    expect(calls).toEqual([ids[0],ids[1]]);
    expect(after.campaigns.find(c=>c.campaignId===ids[1])?.state)
      .toBe("awaiting_reconciliation");
  }, 20000);
  it("releases a verified completed owner after crash before starting a waiting writer",async()=>{
    const target=await fixture();
    const agent=await LocalAgent.create(target.policyPath);
    const ledger=new DelegatedCampaignLedger(target.basePath,owner);
    const original=await ledger.create({
      campaignId:ids[0]!,workspaceId:"test",objective:"Already completed before host crash",
      authorizedActions:["commit"],tasks:[mutationTask()],
    });
    await ledger.create({
      campaignId:ids[1]!,workspaceId:"test",objective:"Waiting writer after former completion",
      authorizedActions:["commit"],tasks:[mutationTask()],
    });
    const claims=new CampaignResourceClaims(target.basePath);
    await claims.reserve(agent.resolveWorkspaceConcurrencyKey("test"),original);
    const previous=await ledger.claimNext("test",ids[0]!);
    if(previous.disposition!=="claimed")throw Error("claim missing");
    await ledger.transition("test",ids[0]!,previous.taskId,previous.operationId,
      "completed",{kind:"verified",reference:"test:"+previous.operationId});
    // Simulates a crash after durable completion but before releaseCompleted.
    let previousCalls=0,nextCalls=0;
    const enroll=ids.map((id,index):TrustedCampaignEnrollment=>({
      workspaceId:"test",campaignId:id,ownerScope:owner,
      bind:async(_agent,record)=>capability(record,{
        dispatch:()=>{if(index===0)previousCalls++;else nextCalls++},
      }),
    }));
    const host=agent.createTrustedCampaignHost(enroll,{
      stateDirectory:target.basePath,
    });
    const result=await host.serve(1);
    expect(result.campaigns[0]?.state).toBe("awaiting_reconciliation");
    expect(previousCalls).toBe(0);
    expect(nextCalls).toBe(1);
  });

  it("restores two queued writers from the private catalog without repeating the first unknown operation",async()=>{
    const target=await fixture();
    const originalAgent=await LocalAgent.create(target.policyPath);
    const ledger=new DelegatedCampaignLedger(target.basePath,owner);
    for(const id of ids)await ledger.create({
      campaignId:id,workspaceId:"test",objective:"Persisted sequential writer "+id,
      authorizedActions:["commit"],tasks:[mutationTask()],
    });
    let settled=false,firstDispatch=0,secondDispatch=0;
    const factories:TrustedCampaignBindingFactories=new Map(ids.map((id,i)=>[
      "writer-"+i,{
        ownerScope:owner,
        bind:async(_agent:LocalAgent,record:CampaignRecord)=>capability(record,{
          // Stub mutation: this tests admission/recovery, NOT Git permission.
          dispatch:()=>{if(i===0)firstDispatch++;else secondDispatch++},
          reconciliation:()=>i===0&&settled,
        }),
      },
    ]));
    const catalog=new TrustedCampaignEnrollmentCatalog(target.basePath);
    for(let i=0;i<ids.length;i++){
      await catalog.enroll(originalAgent,{
        workspaceId:"test",campaignId:ids[i]!,factoryId:"writer-"+i,
      },factories);
    }
    const originalHost=await originalAgent.createTrustedCampaignHostFromCatalog(
      catalog,factories,{stateDirectory:target.basePath},
    );
    const start=await originalHost.serve(1);
    expect(start.campaigns.find(c=>c.campaignId===ids[1])?.state).toBe("queued");
    expect(firstDispatch).toBe(1);
    expect(secondDispatch).toBe(0);
    const originalOperation=(await ledger.get("test",ids[0]!))?.tasks[0]?.operationId;
    await originalHost.shutdown();

    // Simulated host process recreation with the same trusted allowlist.
    settled=true;
    const replacementAgent=await LocalAgent.create(target.policyPath);
    const recovered=await replacementAgent.createTrustedCampaignHostFromCatalog(
      new TrustedCampaignEnrollmentCatalog(target.basePath),factories,
      {stateDirectory:target.basePath},
    );
    const finished=await recovered.serve(2);
    expect(finished.campaigns.find(c=>c.campaignId===ids[0])?.state).toBe("completed");
    expect(finished.campaigns.find(c=>c.campaignId===ids[1])?.state)
      .toBe("awaiting_reconciliation");
    expect(firstDispatch).toBe(1);
    expect(secondDispatch).toBe(1);
    expect((await ledger.get("test",ids[0]!))?.tasks[0]?.operationId)
      .toBe(originalOperation);
    await recovered.shutdown();
  }, 20000);

  it("refuses a missing persisted objective or changed trusted argument binding",async()=>{
    const target=await fixture();
    const agent=await LocalAgent.create(target.policyPath);
    const ledger=new DelegatedCampaignLedger(target.basePath,owner);
    const enrol:TrustedCampaignEnrollment={
      workspaceId:"test",campaignId:ids[0]!,ownerScope:owner,
      bind:async()=>new Map(),
    };
    const absent=agent.createTrustedCampaignHost([enrol],{
      stateDirectory:target.basePath,
    });
    await expect(absent.serve(1)).rejects.toThrow("CAMPAIGN_NOT_ENROLLED");
    await ledger.create({
      campaignId:ids[0]!,workspaceId:"test",objective:"Trusted host binding mismatch",
      authorizedActions:["commit"],tasks:[mutationTask()],
    });
    const changed=agent.createTrustedCampaignHost([enrol],{
      stateDirectory:target.basePath,
    });
    await expect(changed.serve(1)).rejects.toThrow("CAMPAIGN_BINDING_MISMATCH");
    expect((await ledger.get("test",ids[0]!))?.revision).toBe(0);
  });
});
