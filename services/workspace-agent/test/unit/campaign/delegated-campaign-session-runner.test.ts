import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DelegatedCampaignLedger, type CampaignRecord, type CampaignStep,
} from "../../../src/campaign/delegated-campaign-ledger.js";
import {
  DelegatedCampaignSessionRunner,
} from "../../../src/campaign/delegated-campaign-session-runner.js";
import type {
  TypedCampaignCapability,
} from "../../../src/campaign/delegated-campaign-coordinator.js";

const campaignId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId="mcp-access-stack";
let dir="";
beforeEach(async()=>{dir=await mkdtemp(path.join(tmpdir(),"campaign-session-runner-"))});
afterEach(async()=>await rm(dir,{recursive:true,force:true}));
const task=(id:string,dependsOn:string[]=[]):CampaignStep=>({
  id,action:"inspect",dependsOn,
  targetResource:"repo:"+id, expectedState:"state:"+id,
  argumentsDigest:createHash("sha256").update(id).digest("hex"),
});
async function setup(tasks:CampaignStep[]) {
  const ledger=new DelegatedCampaignLedger(dir,"trusted-owner");
  await ledger.create({
    campaignId,workspaceId,objective:"Complete dependent, typed read-only checks",
    authorizedActions:["inspect"],tasks,
  });
  return ledger;
}
function capabilities(record:CampaignRecord,calls:string[],mode:"success"|"unknown"="success") {
  return new Map<string,TypedCampaignCapability>(record.tasks.map(t=>[t.id,{
    action:t.action,targetResource:t.targetResource,expectedState:t.expectedState,
    argumentsDigest:t.argumentsDigest,
    execute:async r=>{
      calls.push(r.taskId);
      if(mode==="unknown"&&r.taskId==="a")throw Error("response lost");
      return {
        operationId:r.operationId,targetResource:r.targetResource,
        expectedState:r.expectedState,argumentsDigest:r.argumentsDigest,
        state:"succeeded" as const,proof:{kind:"verified" as const,reference:"test:"+r.operationId},
      };
    },
    reconcile:async r=>({
      operationId:r.operationId,targetResource:r.targetResource,
      expectedState:r.expectedState,argumentsDigest:r.argumentsDigest,
      state:"outcome_unknown" as const,
    }),
    verify:async()=>true,
  }]));
}

describe("DelegatedCampaignSessionRunner",()=>{
  it("advances bounded passes, then restarts with SAME persisted operation identities",async()=>{
    const ledger=await setup([task("a"),task("b",["a"]),task("c",["b"])]);
    const calls:string[]=[];
    const binder=async (record:CampaignRecord)=>capabilities(record,calls);
    const first=await new DelegatedCampaignSessionRunner(ledger,binder).run({
      workspaceId,campaignId,maxPasses:2,maxStepsPerPass:1,
    });
    expect(first.stop).toBe("step_budget");
    expect(first.executed).toBe(2);
    expect(first.passes).toBe(2);
    expect(calls).toEqual(["a","b"]);
    const ids=first.campaign.tasks.slice(0,2).map(t=>t.operationId);
    const restarted=new DelegatedCampaignSessionRunner(
      new DelegatedCampaignLedger(dir,"trusted-owner"),binder,
    );
    const final=await restarted.run({workspaceId,campaignId,maxPasses:2,maxStepsPerPass:1});
    expect(final.stop).toBe("all_completed");
    expect(final.executed).toBe(1);
    expect(final.campaign.tasks.slice(0,2).map(t=>t.operationId)).toEqual(ids);
    expect(calls).toEqual(["a","b","c"]);
  });
  it("does not auto-repeat an unknown task; advances only independent resources",async()=>{
    const ledger=await setup([task("a"),task("b"),task("c",["a"])]);
    const calls:string[]=[];
    const result=await new DelegatedCampaignSessionRunner(ledger,
      async record=>capabilities(record,calls,"unknown"),
    ).run({workspaceId,campaignId,maxPasses:5,maxStepsPerPass:6});
    expect(result.stop).toBe("awaiting_reconciliation");
    expect(result.executed).toBe(2);
    expect(calls).toEqual(["a","b"]);
    expect(result.campaign.tasks.map(t=>t.state)).toEqual([
      "outcome_unknown","completed","pending",
    ]);
  });
  it("fails before any mutation if the trusted binder cannot reconstruct a task",async()=>{
    const ledger=await setup([task("a"),task("b",["a"])]);
    let called=0;
    const runner=new DelegatedCampaignSessionRunner(ledger,async record=>{
      called++;
      return capabilities(record,[]).size>1
        ? new Map([["a",capabilities(record,[]).get("a")!]])
        : capabilities(record,[]);
    });
    await expect(runner.run({workspaceId,campaignId,maxPasses:1,maxStepsPerPass:3}))
      .rejects.toThrow("CAMPAIGN_BINDING_MISMATCH");
    expect((await ledger.get(workspaceId,campaignId))?.revision).toBe(0);
    expect(called).toBe(1);
  });
  it("rejects unbounded or invalid pass/step budgets before loading the campaign",async()=>{
    const ledger=await setup([task("a")]);
    let invoked=0;
    const runner=new DelegatedCampaignSessionRunner(ledger,async r=>{
      invoked++;
      return capabilities(r,[]);
    });
    await expect(runner.run({workspaceId,campaignId,maxPasses:0,maxStepsPerPass:2}))
      .rejects.toThrow("bounded");
    await expect(runner.run({workspaceId,campaignId,maxPasses:1,maxStepsPerPass:129}))
      .rejects.toThrow("bounded");
    expect(invoked).toBe(0);
  });
});
