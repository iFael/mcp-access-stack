import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "@jest/globals";
import { DelegatedCampaignLedger } from "../../../src/campaign/delegated-campaign-ledger.js";
import { FileMutationReceiptStore } from "../../../src/source-control/file-mutation-receipt-store.js";
import { bindGitCommit } from "../../../src/campaign/typed-git-commit-capability.js";
import { LocalAgent } from "../../../src/local-agent.js";
import {
  createFixture, git, initializeGitRepository, makeWorkspacePolicy,
  writePolicy, writeWorkspaceFile, type Fixture,
} from "../../support/helpers.js";

const ids=["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
const ownerScope="fixture:trusted-full-host";
const script=fileURLToPath(new URL("./campaign-local-agent-host-child.ts",import.meta.url));
// Node --import requires a URL on Windows; D:\\ paths are not valid ESM URL schemes.
const resolver=new URL("./campaign-local-shared-resolver.mjs",import.meta.url).href;
let fixture:Fixture|undefined;
const children:ChildProcess[]=[];
afterEach(async()=>{
  for(const child of children){
    if(child.exitCode===null && child.signalCode===null)child.kill("SIGTERM");
  }
  await fixture?.cleanup(); fixture=undefined;children.length=0;
});
type ChildMsg={kind:"ready"|"executing"|"result"|"error";pid:number;status?:string;detail?:string;operationId?:string};
function host(policyPath:string,stateDirectory:string,campaignId:string,native?:{head:string;index:string}){
  const child=fork(script,[policyPath,stateDirectory,campaignId,...(native?[native.head,native.index]:[])],{
    execArgv:["--import","tsx","--import",resolver],
    stdio:["ignore","pipe","pipe","ipc"],
  });
  children.push(child);
  const backlog:ChildMsg[]=[];
  const listeners=new Set<()=>void>();
  let terminal:Error|undefined;
  let stderr="";
  child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-2600)});
  child.on("message",raw=>{
    if(!raw||typeof raw!=="object"||!("kind" in raw))return;
    backlog.push(raw as ChildMsg);
    for(const listener of [...listeners])listener();
  });
  child.on("error",error=>{terminal=error;for(const l of [...listeners])l()});
  child.on("exit",(code,signal)=>{
    terminal=new Error("CHILD_EXIT "+code+" "+signal+" "+stderr);
    for(const l of [...listeners])l();
  });
  const next=(kind:"ready"|"executing"|"outcome")=>new Promise<ChildMsg>((resolve,reject)=>{
    const alarm=setTimeout(()=>{
      listeners.delete(deliver);
      reject(new Error("HOST_STAGE_TIMEOUT "+kind+" pid="+child.pid+" stderr="+stderr));
    },11000);
    function deliver(){
      const index=backlog.findIndex(msg=>
        kind==="outcome" ? msg.kind==="result"||msg.kind==="error" : msg.kind===kind||msg.kind==="error");
      if(index>=0){
        clearTimeout(alarm);listeners.delete(deliver);
        resolve(backlog.splice(index,1)[0]!);
      }else if(terminal){
        clearTimeout(alarm);listeners.delete(deliver);reject(terminal);
      }
    }
    listeners.add(deliver);deliver();
  });
  return {child,next,send:(action:"start"|"release"|"shutdown")=>child.send({action})};
}
describe("two isolated LocalAgent processes with the worktree-only shared build",()=>{
  it("passes a file URL to Node preload on every platform",()=>{
    expect(new URL(resolver).protocol).toBe("file:");
  });
  it("blocks the second complete host before dispatch and admits it only after verified release",async()=>{
    fixture=await createFixture({profile:"full-repo-readonly"});
    const ledger=new DelegatedCampaignLedger(fixture.basePath,ownerScope);
    for(const id of ids)await ledger.create({
      campaignId:id,workspaceId:"test",objective:"Synthetic two-host resource claim "+id,
      authorizedActions:["commit"],
      tasks:[{id:"write",action:"commit",dependsOn:[],targetResource:"git:test:.",
        expectedState:"head:"+"a".repeat(40),
        argumentsDigest:createHash("sha256").update("synthetic-typed-write").digest("hex")}],
    });
    const a=host(fixture.policyPath,fixture.basePath,ids[0]!);
    const b=host(fixture.policyPath,fixture.basePath,ids[1]!);
    const [readyA,readyB]=await Promise.all([a.next("ready"),b.next("ready")]);
    expect(readyA.pid).not.toBe(readyB.pid);

    a.send("start");
    const executingA=await a.next("executing");
    expect(executingA.operationId).toBeTruthy();
    b.send("start");
    const rejected=await b.next("outcome");
    expect(rejected.kind).toBe("error");
    expect(rejected.detail).toMatch(/CAMPAIGN_RESOURCE_CONFLICT|CAMPAIGN_RUN_LOCKED/u);
    expect((await ledger.get("test",ids[1]!))?.revision).toBe(0);
    expect((await ledger.get("test",ids[0]!))?.tasks[0]?.operationId)
      .toBe(executingA.operationId);

    a.send("release");
    const doneA=await a.next("outcome");
    expect(doneA).toMatchObject({kind:"result",status:"all_completed"});
    b.send("start");
    const executingB=await b.next("executing");
    expect(executingB.operationId).toBeTruthy();
    expect(executingB.operationId).not.toBe(executingA.operationId);
    b.send("release");
    expect(await b.next("outcome")).toMatchObject({kind:"result",status:"all_completed"});
    const storedA=await ledger.get("test",ids[0]!);
    const storedB=await ledger.get("test",ids[1]!);
    expect(storedA?.tasks[0]?.operationId).toBe(executingA.operationId);
    expect(storedA?.tasks[0]?.state).toBe("completed");
    expect(storedB?.tasks[0]?.state).toBe("completed");
    a.send("shutdown");b.send("shutdown");
  },50000);

  it("uses real native Git CAS across two OS LocalAgent processes and never redispatches the loser",async()=>{
    fixture=await createFixture({profile:"full-repo-write"});
    initializeGitRepository(fixture.workspacePath);
    git(fixture.workspacePath,["checkout","-b","feature/delegated"]);
    await writeWorkspaceFile(fixture.workspacePath,"base.txt","base\n");
    git(fixture.workspacePath,["add","base.txt"]);
    git(fixture.workspacePath,["commit","-m","fixture baseline"]);
    await writeWorkspaceFile(fixture.workspacePath,"change.txt","staged\n");
    git(fixture.workspacePath,["add","change.txt"]);
    const head=git(fixture.workspacePath,["rev-parse","HEAD"]).trim();
    const index=git(fixture.workspacePath,["write-tree"]).trim();
    await writePolicy(fixture.policyPath,[{
      ...makeWorkspacePolicy(fixture.workspacePath,{profile:"full-repo-write"}),
      sourceControl:{capabilities:["git.commit.write"],accountOwners:[],additionalRepositories:[]},
    }]);
    const agent=await LocalAgent.create(fixture.policyPath);
    const bound=bindGitCommit({
      agent, nativeReceiptStore:new FileMutationReceiptStore(fixture.workspacePath),
      expectedBranch:"feature/delegated",
      input:{
        workspaceId:"test",root:".",message:"Native OS campaign commit",
        expectedHeadSha:head,expectedIndexTreeSha:index,
      },
      context:{ownerScope},
    });
    const ledger=new DelegatedCampaignLedger(fixture.basePath,ownerScope);
    for(const id of ids)await ledger.create({
      campaignId:id,workspaceId:"test",objective:"Native CAS between OS processes "+id,
      authorizedActions:["commit"],tasks:[{id:"write",dependsOn:[],...bound.definition}],
    });
    const a=host(fixture.policyPath,fixture.basePath,ids[0]!,{head,index});
    const b=host(fixture.policyPath,fixture.basePath,ids[1]!,{head,index});
    const [readyA,readyB]=await Promise.all([a.next("ready"),b.next("ready")]);
    expect(readyA.pid).not.toBe(readyB.pid);
    a.send("start");
    const armedA=await a.next("executing");
    expect(armedA.operationId).toBeTruthy();
    b.send("start");
    const blocked=await b.next("outcome");
    expect(blocked.kind).toBe("error");
    expect(blocked.detail).toMatch(/CAMPAIGN_RESOURCE_CONFLICT|CAMPAIGN_RUN_LOCKED/u);
    expect((await ledger.get("test",ids[1]!))?.revision).toBe(0);

    a.send("release");
    expect(await a.next("outcome")).toMatchObject({kind:"result",status:"all_completed"});
    const committedHead=git(fixture.workspacePath,["rev-parse","HEAD"]).trim();
    expect(committedHead).not.toBe(head);
    expect(git(fixture.workspacePath,["rev-list","--count",head+"..HEAD"]).trim()).toBe("1");
    expect((await ledger.get("test",ids[0]!))?.tasks[0]?.state).toBe("completed");

    b.send("start");
    const armedB=await b.next("executing");
    expect(armedB.operationId).toBeTruthy();
    b.send("release");
    const losingOutcome=await b.next("outcome");
    expect(losingOutcome.kind).toBe("result");
    expect((await ledger.get("test",ids[1]!))?.tasks[0]?.state).toBe("outcome_unknown");
    expect(git(fixture.workspacePath,["rev-parse","HEAD"]).trim()).toBe(committedHead);
    b.send("start");
    expect((await b.next("outcome")).kind).toBe("result");
    expect((await ledger.get("test",ids[1]!))?.tasks[0]?.operationId).toBe(armedB.operationId);
    expect(git(fixture.workspacePath,["rev-list","--count",head+"..HEAD"]).trim()).toBe("1");
    a.send("shutdown");b.send("shutdown");
  },60000);

  it("retains the same durable writer claim after the first full host crashes mid-operation",async()=>{
    fixture=await createFixture({profile:"full-repo-readonly"});
    const ledger=new DelegatedCampaignLedger(fixture.basePath,ownerScope);
    for(const id of ids)await ledger.create({
      campaignId:id,workspaceId:"test",objective:"Synthetic host-crash resource claim "+id,
      authorizedActions:["commit"],
      tasks:[{id:"write",action:"commit",dependsOn:[],targetResource:"git:test:.",
        expectedState:"head:"+"a".repeat(40),
        argumentsDigest:createHash("sha256").update("synthetic-typed-write").digest("hex")}],
    });
    const a=host(fixture.policyPath,fixture.basePath,ids[0]!);
    const b=host(fixture.policyPath,fixture.basePath,ids[1]!);
    await Promise.all([a.next("ready"),b.next("ready")]);
    a.send("start");
    const executingA=await a.next("executing");
    const exited=new Promise<void>((resolve,reject)=>{
      a.child.once("exit",()=>resolve());
      a.child.once("error",reject);
    });
    a.child.kill("SIGTERM");
    await exited;
    const previous=await ledger.get("test",ids[0]!);
    expect(previous?.tasks[0]?.operationId).toBe(executingA.operationId);
    expect(previous?.tasks[0]?.state).toBe("in_flight");
    b.send("start");
    const rejected=await b.next("outcome");
    expect(rejected.kind).toBe("error");
    expect(rejected.detail).toMatch(/CAMPAIGN_RESOURCE_CONFLICT|CAMPAIGN_RUN_LOCKED/u);
    expect((await ledger.get("test",ids[1]!))?.revision).toBe(0);
    expect((await ledger.get("test",ids[0]!))?.tasks[0]?.operationId)
      .toBe(executingA.operationId);
    b.send("shutdown");
  },50000);
});
