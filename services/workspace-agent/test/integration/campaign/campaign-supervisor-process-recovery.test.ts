import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { CampaignRunLease } from "../../../src/campaign/campaign-run-lease.js";
import { DelegatedCampaignLedger, type CampaignStep } from "../../../src/campaign/delegated-campaign-ledger.js";
import { DelegatedCampaignCoordinator, type TypedCampaignCapability } from "../../../src/campaign/delegated-campaign-coordinator.js";
import { DelegatedCampaignSupervisor } from "../../../src/campaign/delegated-campaign-supervisor.js";

const workspaceId="fixture-process-recovery";
const campaignId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let dir="";
let now=40_000;
beforeEach(async()=>{dir=await mkdtemp(path.join(tmpdir(),"campaign-os-pid-"));now=40_000});
afterEach(async()=>{await rm(dir,{recursive:true,force:true})});
const task:CampaignStep={
  id:"operation",action:"commit",dependsOn:[],
  targetResource:"git:fixture:.",expectedState:"head:"+"a".repeat(40),
  argumentsDigest:createHash("sha256").update("persisted args").digest("hex"),
};

describe("campaign lock recovery using real OS child process liveness",()=>{
  it("does not steal a live PID lock, then reconciles original identity after actual child exit",async()=>{
    const lease=new CampaignRunLease({
      now:()=>now,leaseMs:2000,heartbeatMs:300,hostname:hostname(),
      // No liveness override: this test calls REAL process.kill(pid, 0).
    });
    const ledger=new DelegatedCampaignLedger(dir,"trusted-process-owner",lease);
    await ledger.create({
      campaignId,workspaceId,objective:"Recover original operation after real process exit",
      authorizedActions:["commit"],tasks:[task],
    });
    const first=await ledger.claimNext(workspaceId,campaignId);
    if(first.disposition!=="claimed")throw Error("claim not persisted");
    const stateDir=path.join(dir,"delegated-campaigns");
    const file=(await readdir(stateDir)).find(n=>n.endsWith(".json"));
    if(!file)throw Error("campaign file missing");
    const lockPath=path.join(stateDir,file+".run.lock");
    // Node subprocess is intentionally NOT connected to production nor to
    // any repository. It only holds an OS PID for a reliable liveness probe.
    const child=spawn(process.execPath,["-e","setInterval(() => {}, 1000)"],{
      stdio:"ignore",windowsHide:true,
    });
    const spawned=new Promise<void>((resolve,reject)=>{
      child.once("spawn",()=>resolve());
      child.once("error",reject);
    });
    const exited=new Promise<void>((resolve,reject)=>{
      child.once("exit",()=>resolve());
      child.once("error",reject);
    });
    try{
      await spawned;
      if(!child.pid)throw Error("fixture child did not spawn");
      await writeFile(lockPath,JSON.stringify({
        version:1,ownerId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        hostname:hostname(),pid:child.pid,
        issuedAt:10000,renewedAt:11000,expiresAt:13000,
      }));
      let executed=0;
      const capability:TypedCampaignCapability={
        action:"commit",targetResource:task.targetResource,expectedState:task.expectedState,
        argumentsDigest:task.argumentsDigest,
        execute:async()=>{executed++;throw Error("must not dispatch again")},
        reconcile:async request=>({
          operationId:request.operationId,targetResource:request.targetResource,
          expectedState:request.expectedState,argumentsDigest:request.argumentsDigest,
          state:"succeeded",proof:{kind:"verified",reference:"fixture-receipt:"+request.operationId},
        }),
        verify:async()=>true,
      };
      const coordinator=new DelegatedCampaignCoordinator(ledger,new Map([["operation",capability]]));
      await expect(coordinator.run(workspaceId,campaignId))
        .rejects.toMatchObject({code:"EEXIST"});
      expect((await ledger.get(workspaceId,campaignId))?.tasks[0]?.operationId)
        .toBe(first.operationId);
      child.kill("SIGTERM");
      await exited;
      const restored=await coordinator.run(workspaceId,campaignId);
      expect(restored.stop).toBe("all_completed");
      expect(restored.reconciled).toBe(1);
      expect(restored.executed).toBe(0);
      expect(executed).toBe(0);
      expect(restored.campaign.tasks[0]?.operationId).toBe(first.operationId);
      expect((await readdir(stateDir)).filter(n=>n.endsWith(".lock"))).toEqual([]);
    }finally{
      if(child.exitCode===null && child.signalCode===null){
        child.kill("SIGTERM");
        await exited;
      }
    }
  },20_000);
});
