import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DelegatedCampaignLedger, type CampaignRecord, type CampaignStep } from "../../../src/campaign/delegated-campaign-ledger.js";
import { type CampaignInvocation, type TypedCampaignCapability } from "../../../src/campaign/delegated-campaign-coordinator.js";
import {
  DelegatedCampaignSupervisor, type TrustedCampaignRegistration,
} from "../../../src/campaign/delegated-campaign-supervisor.js";

const workspaceId = "mcp-access-stack";
const ids = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
let folder = "";
let now = 100000;
let delays: number[] = [];
const step=(id:string,dependsOn:string[]=[]):CampaignStep=>({
  id, action:"inspect",dependsOn,targetResource:"resource:"+id,
  expectedState:"state:"+id,
  argumentsDigest:createHash("sha256").update("arg:"+id).digest("hex"),
});
const clock=()=>now;
const wait=async (ms:number,signal:AbortSignal)=>{
  if(signal.aborted)throw Error("aborted");
  delays.push(ms);
  now+=ms;
};
function result(req:CampaignInvocation,state:"succeeded"|"outcome_unknown"="succeeded") {
  const identity={
    operationId:req.operationId,targetResource:req.targetResource,
    expectedState:req.expectedState,argumentsDigest:req.argumentsDigest,
  };
  return state==="succeeded"?{
    ...identity,state,proof:{kind:"verified" as const,reference:"verified:"+req.operationId},
  }:{...identity,state};
}
async function registered(options:{
  index?:number,steps?:CampaignStep[],
  execute?:(request:CampaignInvocation)=>ReturnType<typeof result>|Promise<ReturnType<typeof result>>,
  reconcile?:(request:CampaignInvocation)=>ReturnType<typeof result>|Promise<ReturnType<typeof result>>,
  calls?:string[],
}={}):Promise<{record:TrustedCampaignRegistration;ledger:DelegatedCampaignLedger}> {
  const campaignId=ids[options.index??0]!;
  const ledger=new DelegatedCampaignLedger(folder,"trusted-owner");
  const tasks=options.steps??[step("first")];
  await ledger.create({
    campaignId,workspaceId,objective:"Only trusted typed inspection",
    authorizedActions:["inspect"],tasks,
  });
  const calls=options.calls??[];
  const binder=async (plan:CampaignRecord)=>{
    return new Map<string,TypedCampaignCapability>(plan.tasks.map(task=>[
      task.id,{
        action:task.action,targetResource:task.targetResource,
        expectedState:task.expectedState,argumentsDigest:task.argumentsDigest,
        execute:async req=>{
          calls.push("execute:"+req.taskId);
          return options.execute?await options.execute(req):result(req);
        },
        reconcile:async req=>{
          calls.push("reconcile:"+req.taskId);
          return options.reconcile?await options.reconcile(req):result(req,"outcome_unknown");
        },
        verify:async()=>true,
      },
    ]));
  };
  return {ledger,record:{workspaceId,campaignId,ledger,bind:binder}};
}
function supervisor(registrations:TrustedCampaignRegistration[],other:{
  maxStepsPerWake?:number,now?:()=>number,
}={}) {
  return new DelegatedCampaignSupervisor(registrations,{
    maxStepsPerWake:other.maxStepsPerWake??1,
    idlePollMs:100,unknownPollMs:200,failureBackoffMs:300,maxBackoffMs:2400,
    now:other.now??clock,wait,
  });
}
beforeEach(async()=>{
  folder=await mkdtemp(path.join(tmpdir(),"mcp-supervisor-fixture-"));
  now=100000;delays=[];
});
afterEach(async()=>{await rm(folder,{force:true,recursive:true})});

describe("DelegatedCampaignSupervisor",()=>{
  it("runs separately enrolled campaigns fairly with limited budgets and no duplicate dispatch",async()=>{
    const a=await registered({steps:[step("a"),step("b",["a"]),step("c",["b"])]});
    const b=await registered({index:1,steps:[step("x"),step("y",["x"])]});
    const instance=supervisor([a.record,b.record]);
    const done=await instance.serve(new AbortController().signal,8);
    expect(done.stop).toBe("all_completed");
    expect(done.wakes).toBe(5);
    expect(done.campaigns.map(c=>c.executed)).toEqual([3,2]);
    expect(done.campaigns.map(c=>c.state)).toEqual(["completed","completed"]);
    expect(delays.length).toBeGreaterThan(0);
    const again=await instance.serve(new AbortController().signal,1);
    expect(again.stop).toBe("all_completed");
    expect(again.wakes).toBe(0);
  });
  it("keeps uncertain native operations on the original operationId across supervisor recreation",async()=>{
    const calls:string[]=[];
    const records=await registered({
      steps:[step("unknown"),step("independent")],calls,
      execute:req=>req.taskId==="unknown"?result(req,"outcome_unknown"):result(req),
      reconcile:req=>result(req,"outcome_unknown"),
    });
    const first=await supervisor([records.record],{maxStepsPerWake:4})
      .serve(new AbortController().signal,2);
    expect(first.stop).toBe("wake_budget");
    const saved=await records.ledger.get(workspaceId,ids[0]!);
    const originalId=saved?.tasks[0]?.operationId;
    expect(saved?.tasks.map(t=>t.state)).toEqual(["outcome_unknown","completed"]);
    expect(calls.filter(x=>x==="execute:unknown")).toHaveLength(1);
    const resume=new DelegatedCampaignLedger(folder,"trusted-owner");
    const recovered:TrustedCampaignRegistration={
      ...records.record,ledger:resume,
      bind:async plan=>new Map(plan.tasks.map(task=>[task.id,{
        action:task.action,targetResource:task.targetResource,
        expectedState:task.expectedState,argumentsDigest:task.argumentsDigest,
        execute:async()=>{throw Error("unknown must never execute twice")},
        reconcile:async(req:CampaignInvocation)=>{
          expect(req.operationId).toBe(originalId);
          return result(req);
        },
        verify:async()=>true,
      }])),
    };
    const second=await supervisor([recovered],{maxStepsPerWake:3})
      .serve(new AbortController().signal,3);
    expect(second.stop).toBe("all_completed");
    expect(Object.hasOwn(second,"executed")).toBe(false);
    expect(second.campaigns[0]?.reconciled).toBeGreaterThan(0);
    expect((await resume.get(workspaceId,ids[0]!))?.tasks[0]?.operationId).toBe(originalId);
  });
  it("fails closed for missing trusted capability without claiming any operation",async()=>{
    const original=await registered();
    const invalid:TrustedCampaignRegistration={
      ...original.record,bind:async()=>new Map(),
    };
    const report=await supervisor([invalid]).serve(new AbortController().signal,5);
    expect(report.stop).toBe("needs_attention");
    expect(report.wakes).toBe(1);
    expect(report.campaigns[0]?.state).toBe("needs_attention");
    expect((await original.ledger.get(workspaceId,ids[0]!))?.revision).toBe(0);
  });
  it("treats a contested or orphaned run lock as retryable observation, then escalates",async()=>{
    const initial=await registered();
    const dir=path.join(folder,"delegated-campaigns");
    const file=(await readdir(dir)).find(f=>f.endsWith(".json"));
    if(!file)throw Error("campaign snapshot missing");
    await writeFile(path.join(dir,file+".run.lock"),"corrupt owner metadata");
    const report=await supervisor([initial.record]).serve(new AbortController().signal,8);
    expect(report.stop).toBe("needs_attention");
    expect(report.wakes).toBe(4);
    expect(report.campaigns[0]?.failures).toBe(4);
    expect(report.campaigns[0]?.executed).toBe(0);
    expect((await initial.ledger.get(workspaceId,ids[0]!))?.revision).toBe(0);
    expect(delays).toEqual([300,600,1200]);
  });
  it("aborts between operations without interrupting an in-flight trusted capability",async()=>{
    const ctrl=new AbortController();
    let executed=0;
    const record=await registered({
      steps:[step("one"),step("two",["one"])],
      execute:async request=>{
        executed++;
        ctrl.abort();
        return result(request);
      },
    });
    const report=await supervisor([record.record]).serve(ctrl.signal,5);
    expect(report.stop).toBe("stopped");
    expect(executed).toBe(1);
    expect((await record.ledger.get(workspaceId,ids[0]!))?.tasks.map(t=>t.state))
      .toEqual(["completed","pending"]);
  });
  it("rejects duplicate registration and disallows concurrent serve on the same instance",async()=>{
    const x=await registered();
    expect(()=>supervisor([x.record,x.record]))
      .toThrow("duplicate campaign registration");
    let release!:()=>void,entered!:()=>void;
    const started=new Promise<void>(r=>entered=r);
    const held=new Promise<void>(r=>release=r);
    const slow:TrustedCampaignRegistration={
      ...x.record,bind:async plan=>new Map(plan.tasks.map(t=>[t.id,{
        action:t.action,targetResource:t.targetResource,
        expectedState:t.expectedState,argumentsDigest:t.argumentsDigest,
        execute:async(req:CampaignInvocation)=>{entered();await held;return result(req)},
        reconcile:async(req:CampaignInvocation)=>result(req,"outcome_unknown"),
        verify:async()=>true,
      }])),
    };
    const instance=supervisor([slow]);
    const first=instance.serve(new AbortController().signal,1);
    await started;
    try{
      await expect(instance.serve(new AbortController().signal,1))
        .rejects.toThrow("CAMPAIGN_ALREADY_SUPERVISING");
    }finally{
      release();await first;
    }
  });
  it("checks all budgets before running a trusted binder",async()=>{
    const x=await registered();
    expect(()=>new DelegatedCampaignSupervisor([x.record],{maxStepsPerWake:0}))
      .toThrow("maxStepsPerWake");
    await expect(supervisor([x.record]).serve(new AbortController().signal,0))
      .rejects.toThrow("maxWakes");
    expect((await x.ledger.get(workspaceId,ids[0]!))?.revision).toBe(0);
  });
});
