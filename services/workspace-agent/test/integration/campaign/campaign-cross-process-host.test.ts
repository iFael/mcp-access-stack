import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  DelegatedCampaignLedger, type CampaignRecord,
} from "../../../src/campaign/delegated-campaign-ledger.js";
import { CampaignResourceClaims } from "../../../src/campaign/campaign-resource-claims.js";
import { createFixture, type Fixture } from "../../support/helpers.js";

const ids = [
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
];
const ownerScope = "fixture:multiprocess-campaign";
const script = fileURLToPath(new URL("./campaign-claim-child.ts", import.meta.url));
let fixture:Fixture|undefined;
const spawned:ChildProcess[] = [];
afterEach(async()=>{
  for (const child of spawned) {
    if (child.exitCode===null && child.signalCode===null) child.kill("SIGTERM");
  }
  await fixture?.cleanup();
  fixture=undefined;
  spawned.length=0;
});

type Message = {kind:"ready"|"success"|"failed";pid:number;message?:string};
type Worker = {
  child:ChildProcess;
  next:(kind:"ready"|"outcome")=>Promise<Message>;
  send:(action:"reserve"|"release"|"shutdown",record?:CampaignRecord)=>void;
};
function worker(stateDirectory:string,root:string):Worker {
  const child=fork(script,[stateDirectory,root],{
    execArgv:["--import","tsx"],
    stdio:["ignore","pipe","pipe","ipc"],
    windowsHide:true,
  });
  spawned.push(child);
  const messages:Message[]=[];
  const callbacks=new Set<()=>void>();
  let error:Error|undefined;
  let stderr="";
  child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-1600)});
  child.on("message",raw=>{
    if (!raw || typeof raw!=="object" || !("kind" in raw))return;
    messages.push(raw as Message);
    for(const cb of [...callbacks])cb();
  });
  child.on("error",e=>{error=e;for(const cb of [...callbacks])cb()});
  child.on("exit",(code,signal)=>{
    error=new Error("CHILD_TERMINATED:"+code+":"+signal+":"+stderr);
    for(const cb of [...callbacks])cb();
  });
  return {
    child,
    send:(action,record)=>{child.send({action,record})},
    next:kind=>new Promise<Message>((resolve,reject)=>{
      const alarm=setTimeout(()=>{
        callbacks.delete(tryResolve);
        reject(new Error("FIXTURE_PROCESS_TIMEOUT "+kind+" pid="+child.pid+" stderr="+stderr));
      },8000);
      function tryResolve(){
        const index=messages.findIndex(m=>
          kind==="ready"?m.kind==="ready":(m.kind==="success"||m.kind==="failed"));
        if(index>=0){
          clearTimeout(alarm);callbacks.delete(tryResolve);
          resolve(messages.splice(index,1)[0]!);
        } else if(error){
          clearTimeout(alarm);callbacks.delete(tryResolve);
          reject(error);
        }
      }
      callbacks.add(tryResolve);
      tryResolve();
    }),
  };
}
async function seed():Promise<{
  ledger:DelegatedCampaignLedger;
  records:CampaignRecord[];
  root:string;
}>{
  fixture=await createFixture({profile:"full-repo-readonly"});
  const ledger=new DelegatedCampaignLedger(fixture.basePath,ownerScope);
  const records:CampaignRecord[]=[];
  for (const id of ids){
    records.push(await ledger.create({
      campaignId:id,workspaceId:"test",objective:"Synthetic workspace reservation "+id,
      authorizedActions:["commit"],
      tasks:[{
        id:"write",action:"commit",dependsOn:[],
        targetResource:"git:test:.",expectedState:"head:"+"a".repeat(40),
        argumentsDigest:createHash("sha256").update("synthetic typed write").digest("hex"),
      }],
    }));
  }
  return {ledger,records,root:fixture.workspacePath};
}
async function verified(ledger:DelegatedCampaignLedger,campaignId:string):Promise<CampaignRecord>{
  const claim=await ledger.claimNext("test",campaignId);
  if(claim.disposition!=="claimed")throw Error("CAMPAIGN_CLAIM_NOT_PERSISTED");
  return ledger.transition("test",campaignId,claim.taskId,claim.operationId,
    "completed",{kind:"verified",reference:"fixture:receipt:"+claim.operationId});
}
describe("two real OS processes contend for one CampaignResourceClaims workspace lock",()=>{
  it("admits exactly one writer under simultaneous reserve calls and the other only after verified release",async()=>{
    const {ledger,records,root}=await seed();
    const first=worker(fixture!.basePath,root),second=worker(fixture!.basePath,root);
    const [r1,r2]=await Promise.all([first.next("ready"),second.next("ready")]);
    expect(r1.pid).not.toBe(r2.pid);
    first.send("reserve",records[0]);
    second.send("reserve",records[1]);
    const [a,b]=await Promise.all([first.next("outcome"),second.next("outcome")]);
    expect([a.kind,b.kind].sort()).toEqual(["failed","success"]);
    const winning=a.kind==="success"?0:1;
    const loser=winning===0?1:0;
    const winningChild=winning===0?first:second;
    const losingChild=loser===0?first:second;
    // The loser may hit the admission mutex before the persisted claim:
    // both are fail-closed outcomes; neither can dispatch a writer.
    expect((a.kind==="failed"?a:b).message).toMatch(
      /CAMPAIGN_RUN_LOCKED|CAMPAIGN_RESOURCE_CONFLICT/u,
    );
    losingChild.send("reserve",records[loser]);
    expect((await losingChild.next("outcome")).kind).toBe("failed");

    const completed=await verified(ledger,ids[winning]!);
    winningChild.send("release",completed);
    expect((await winningChild.next("outcome")).kind).toBe("success");
    losingChild.send("reserve",records[loser]);
    expect((await losingChild.next("outcome")).kind).toBe("success");
    losingChild.send("release",await verified(ledger,ids[loser]!));
    expect((await losingChild.next("outcome")).kind).toBe("success");
  },30000);

  it("fails closed on a corrupted admission mutex left by a crashed process",async()=>{
    const {records,root}=await seed();
    const claimsDir=path.join(fixture!.basePath,"delegated-campaign-resource-claims");
    await mkdir(claimsDir,{recursive:true,mode:0o700});
    const guard=path.join(claimsDir,".admission.lock");
    await writeFile(guard,"partial/crash-record",{mode:0o600});
    const child=worker(fixture!.basePath,root);
    await child.next("ready");
    child.send("reserve",records[0]);
    const reply=await child.next("outcome");
    expect(reply.kind).toBe("failed");
    expect(reply.message).toContain("CAMPAIGN_RUN_LOCKED");
    expect(await readFile(guard,"utf8")).toBe("partial/crash-record");
    expect((await readdir(claimsDir)).filter(name=>name.endsWith(".json")))
      .toHaveLength(0);
  },30000);

  it("preserves an incomplete claim after owner process exit until the persisted ledger is verified",async()=>{
    const {ledger,records,root}=await seed();
    const first=worker(fixture!.basePath,root);
    const second=worker(fixture!.basePath,root);
    await Promise.all([first.next("ready"),second.next("ready")]);
    first.send("reserve",records[0]);
    expect((await first.next("outcome")).kind).toBe("success");
    const exited=new Promise<void>(resolve=>first.child.once("exit",()=>resolve()));
    first.child.kill("SIGTERM");
    await exited;
    second.send("reserve",records[1]);
    const refused=await second.next("outcome");
    expect(refused.kind).toBe("failed");
    expect(refused.message).toContain("CAMPAIGN_RESOURCE_CONFLICT");
    await expect(new CampaignResourceClaims(fixture!.basePath).releaseCompleted(
      root,records[0]!,
    )).rejects.toThrow("CAMPAIGN_RESOURCE_INCOMPLETE");

    const completed=await verified(ledger,ids[0]!);
    await new CampaignResourceClaims(fixture!.basePath).releaseCompleted(root,completed);
    second.send("reserve",records[1]);
    expect((await second.next("outcome")).kind).toBe("success");
  },30000);
});
