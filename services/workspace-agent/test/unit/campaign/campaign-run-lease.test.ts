import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CampaignRunLease } from "../../../src/campaign/campaign-run-lease.js";
import { DelegatedCampaignLedger, type CampaignStep } from "../../../src/campaign/delegated-campaign-ledger.js";
import { DelegatedCampaignCoordinator, type TypedCampaignCapability } from "../../../src/campaign/delegated-campaign-coordinator.js";

const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "mcp-access-stack";
let dir = "";
let now = 40000;
const host = "controlled-fixture-host";
const oldPid = 45678;
function fakeLease(alive: (pid: number) => boolean = () => false) {
  return new CampaignRunLease({
    hostname: host, pid: process.pid,
    now: () => now, isProcessAlive: alive,
    leaseMs: 2000, heartbeatMs: 300,
  });
}
function previousLease(fields: Record<string,unknown> = {}): string {
  return JSON.stringify({
    version: 1, ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    hostname: host, pid: oldPid,
    issuedAt: 10000, renewedAt: 11000, expiresAt: 13000,
    ...fields,
  });
}
async function campaignFile() {
  const folder = path.join(dir,"delegated-campaigns");
  const file = (await readdir(folder)).find(x => x.endsWith(".json"));
  if (!file) throw new Error("campaign record not found");
  return path.join(folder,file);
}
async function makeLedger(lock: CampaignRunLease) {
  const ledger = new DelegatedCampaignLedger(dir, "owner:session",lock);
  const task: CampaignStep = {
    id:"commit", action:"commit", dependsOn:[],
    targetResource:"git:fixture:.", expectedState:"head:"+"1".repeat(40),
    argumentsDigest:createHash("sha256").update("typed-input").digest("hex"),
  };
  await ledger.create({
    campaignId,workspaceId,objective:"Safely reconcile one previously claimed operation",
    authorizedActions:["commit"],tasks:[task],
  });
  return {ledger,task};
}
beforeEach(async()=> {
  dir=await mkdtemp(path.join(tmpdir(),"mcp-campaign-run-lease-"));
  now=40000;
});
afterEach(async()=>await rm(dir,{recursive:true,force:true}));

describe("CampaignRunLease: proven process death, not TTL alone",()=>{
  it("reclaims an expired, same-host, provably dead process and removes only its own lease",async()=>{
    const {ledger}=await makeLedger(fakeLease());
    const lock=(await campaignFile())+".run.lock";
    await writeFile(lock,previousLease());
    let ran=0;
    const value=await ledger.withExclusiveRun(workspaceId,campaignId,async()=>{
      ran++;
      const recovered=JSON.parse(await readFile(lock,"utf8")) as {ownerId:string;pid:number;expiresAt:number};
      expect(recovered.pid).toBe(process.pid);
      expect(recovered.ownerId).not.toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
      expect(recovered.expiresAt).toBeGreaterThan(now);
      return "reconciled";
    });
    expect(value).toBe("reconciled");
    expect(ran).toBe(1);
    expect((await readdir(path.dirname(lock))).filter(x=>x.endsWith(".lock"))).toEqual([]);
  });
  it.each([
    ["owner is alive", previousLease(), (_pid:number)=>true],
    ["owner PID was reused",previousLease(),(_pid:number)=>true],
    ["lease has not expired",previousLease({expiresAt:50000}),(_pid:number)=>false],
    ["another host",previousLease({hostname:"different-host"}),(_pid:number)=>false],
    ["corrupt record","not-json",(_pid:number)=>false],
    ["missing PID",previousLease({pid:null}),(_pid:number)=>false],
    ["missing owner identity",previousLease({ownerId:"fake"}),(_pid:number)=>false],
  ])("fails closed when %s",async(_label,data,alive)=>{
    const {ledger}=await makeLedger(fakeLease(alive));
    const lock=(await campaignFile())+".run.lock";
    await writeFile(lock,data);
    const original=await readFile(lock,"utf8");
    let calls=0;
    await expect(ledger.withExclusiveRun(workspaceId,campaignId,async()=>{
      calls++;
    })).rejects.toMatchObject({code:"EEXIST"});
    expect(calls).toBe(0);
    expect(await readFile(lock,"utf8")).toBe(original);
  });
  it("also recovers the short ledger transaction lock only after verified process death",async()=>{
    const {ledger}=await makeLedger(fakeLease());
    const lock=(await campaignFile())+".lock";
    await writeFile(lock,previousLease());
    const claim=await ledger.claimNext(workspaceId,campaignId);
    expect(claim.disposition).toBe("claimed");
    if(claim.disposition!=="claimed")return;
    expect(claim.operationId).toMatch(/^[a-f0-9-]{36}$/u);
    const recovered=await ledger.get(workspaceId,campaignId);
    expect(recovered?.tasks[0]?.state).toBe("in_flight");
    expect(recovered?.tasks[0]?.operationId).toBe(claim.operationId);
    const missing=(await readdir(path.dirname(lock))).filter(x=>x.endsWith(".lock"));
    expect(missing).toEqual([]);
    // A second claim is still blocked by the durable in-flight task.
    expect((await ledger.claimNext(workspaceId,campaignId)).disposition)
      .toBe("no_runnable_step");
  });

  it("renews heartbeat while a live owner holds the lease",async()=>{
    const {ledger}=await makeLedger(fakeLease(()=>true));
    const lock=(await campaignFile())+".run.lock";
    let started!:()=>void;
    let release!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve});
    const hold=new Promise<void>(resolve=>{release=resolve});
    const ongoing=ledger.withExclusiveRun(workspaceId,campaignId,async()=>{
      started();
      await hold;
    });
    await entered;
    const initial=JSON.parse(await readFile(lock,"utf8")) as {renewedAt:number;expiresAt:number};
    now+=100;
    try{
      // Wait for the durable heartbeat, not for one assumed timer/FS interval.
      // CI scheduling and fsync can delay the first 300ms renewal.
      const deadline=Date.now()+3000;
      let renewed=initial;
      while(renewed.renewedAt===initial.renewedAt && Date.now()<deadline){
        await new Promise<void>(resolve=>setTimeout(resolve,50));
        renewed=JSON.parse(await readFile(lock,"utf8")) as {renewedAt:number;expiresAt:number};
      }
      expect(renewed.renewedAt).toBeGreaterThan(initial.renewedAt);
      expect(renewed.expiresAt).toBeGreaterThan(initial.expiresAt);
      const other=new DelegatedCampaignLedger(dir,"owner:session",fakeLease(()=>true));
      await expect(other.withExclusiveRun(workspaceId,campaignId,async()=>undefined))
        .rejects.toMatchObject({code:"EEXIST"});
    } finally {
      release();
      await ongoing;
    }
  });

  it("fails closed when another process owns the exclusive recovery guard",async()=>{
    const {ledger}=await makeLedger(fakeLease());
    const lock=(await campaignFile())+".run.lock";
    await writeFile(lock,previousLease());
    await writeFile(lock+".recovery.lock","another recovery is pending");
    await expect(ledger.withExclusiveRun(workspaceId,campaignId,async()=>undefined))
      .rejects.toMatchObject({code:"EEXIST"});
    expect(await readFile(lock,"utf8")).toBe(previousLease());
    expect(await readFile(lock+".recovery.lock","utf8")).toContain("another");
  });
  it("does not let two contenders steal a newly acquired generation",async()=>{
    const {ledger}=await makeLedger(fakeLease());
    const lock=(await campaignFile())+".run.lock";
    await writeFile(lock,previousLease());
    let release!:()=>void,entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve});
    const hold=new Promise<void>(resolve=>{release=resolve});
    let first=0,second=0;
    const active=ledger.withExclusiveRun(workspaceId,campaignId,async()=>{
      first++;entered();await hold;
    });
    await started;
    try {
      const other=new DelegatedCampaignLedger(dir,"owner:session",fakeLease(()=>true));
      await expect(other.withExclusiveRun(workspaceId,campaignId,async()=>{second++}))
        .rejects.toMatchObject({code:"EEXIST"});
    } finally {
      release();
      await active;
    }
    expect(first).toBe(1);
    expect(second).toBe(0);
  });
  it("recovers a crashed coordinator by reconciling SAME operation without execute",async()=>{
    const {ledger,task}=await makeLedger(fakeLease());
    const claimed=await ledger.claimNext(workspaceId,campaignId);
    if(claimed.disposition!=="claimed") throw Error("claim absent");
    const lock=(await campaignFile())+".run.lock";
    await writeFile(lock,previousLease());
    let executed=0;
    const seen:string[]=[];
    const port:TypedCampaignCapability={
      action:"commit",targetResource:task.targetResource,expectedState:task.expectedState,
      argumentsDigest:task.argumentsDigest,
      execute:async()=>{executed++;throw Error("must not replay the mutation")},
      reconcile:async request=>{
        seen.push(request.operationId);
        return {
          operationId:request.operationId,targetResource:request.targetResource,
          expectedState:request.expectedState,argumentsDigest:request.argumentsDigest,
          state:"succeeded",proof:{kind:"verified",reference:"native-receipt:"+request.operationId},
        };
      },
      verify:async()=>true,
    };
    const out=await new DelegatedCampaignCoordinator(ledger,new Map([["commit",port]]))
      .run(workspaceId,campaignId);
    expect(out.stop).toBe("all_completed");
    expect(out.executed).toBe(0);
    expect(out.reconciled).toBe(1);
    expect(seen).toEqual([claimed.operationId]);
    expect(executed).toBe(0);
  });
});
