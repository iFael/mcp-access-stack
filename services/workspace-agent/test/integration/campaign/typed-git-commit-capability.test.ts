import { afterEach, describe, expect, it } from "@jest/globals";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { InMemoryMutationReceiptStore } from "@vs-code-gpt/shared";
import { LocalAgent } from "../../../src/local-agent.js";
import { FileMutationReceiptStore } from "../../../src/source-control/file-mutation-receipt-store.js";
import { DelegatedCampaignLedger } from "../../../src/campaign/delegated-campaign-ledger.js";
import { CampaignRunLease } from "../../../src/campaign/campaign-run-lease.js";
import { DelegatedCampaignCoordinator } from "../../../src/campaign/delegated-campaign-coordinator.js";
import { bindGitCommit } from "../../../src/campaign/typed-git-commit-capability.js";
import {
  createFixture, git, initializeGitRepository, makeWorkspacePolicy,
  writePolicy, writeWorkspaceFile, type Fixture,
} from "../../support/helpers.js";

const campaignId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let fixture:Fixture|undefined;
afterEach(async()=>{await fixture?.cleanup();fixture=undefined});

async function prepare(capabilities:string[], persistent = false) {
  fixture=await createFixture({profile:"full-repo-write"});
  initializeGitRepository(fixture.workspacePath);
  git(fixture.workspacePath,["checkout","-b","feature/delegated"]);
  await writeWorkspaceFile(fixture.workspacePath,"base.txt","base\n");
  git(fixture.workspacePath,["add","base.txt"]);
  git(fixture.workspacePath,["commit","-m","baseline"]);
  await writeWorkspaceFile(fixture.workspacePath,"new.txt","change\n");
  git(fixture.workspacePath,["add","new.txt"]);
  const oldHead=git(fixture.workspacePath,["rev-parse","HEAD"]).trim();
  const indexSha=git(fixture.workspacePath,["write-tree"]).trim();
  await writePolicy(fixture.policyPath,[{
    ...makeWorkspacePolicy(fixture.workspacePath,{profile:"full-repo-write"}),
    sourceControl:{capabilities,accountOwners:[],additionalRepositories:[]},
  }]);
  const store = persistent
    ? new FileMutationReceiptStore(fixture.workspacePath)
    : new InMemoryMutationReceiptStore();
  const agent=await LocalAgent.create(fixture.policyPath,
    persistent ? {} : {mutationReceiptStore:store});
  const ownerScope="fixture:authorized-campaign";
  const bound=bindGitCommit({
    agent,nativeReceiptStore:store,
    expectedBranch:"feature/delegated",
    input:{
      workspaceId:"test",root:".",message:"Typed delegated commit",
      expectedHeadSha:oldHead,expectedIndexTreeSha:indexSha,
    },
    context:{ownerScope,correlationId:"campaign-integration"},
  });
  const ledger=new DelegatedCampaignLedger(fixture.basePath,ownerScope);
  await ledger.create({
    campaignId,workspaceId:"test",objective:"Only commit fixture with native Git CAS",
    authorizedActions:["commit"],tasks:[{id:"commit",dependsOn:[],...bound.definition}],
  });
  return {agent,store,bound,ledger,oldHead,indexSha};
}

describe("delegated Git commit through real LocalAgent and native receipt",()=>{
  it("commits a temporary repository exactly once and reconciles from a durable claim on restart",async()=>{
    const {bound,ledger,oldHead}=await prepare(["git.commit.write"]);
    const result=await new DelegatedCampaignCoordinator(
      ledger,new Map([["commit",bound.capability]]),
    ).run("test",campaignId);
    expect(result.stop).toBe("all_completed");
    const after=git(fixture!.workspacePath,["rev-parse","HEAD"]).trim();
    expect(after).not.toBe(oldHead);
    expect(result.campaign.tasks[0]?.proof?.reference).toContain(after);
    expect(git(fixture!.workspacePath,["rev-list","--count",oldHead+"..HEAD"]).trim()).toBe("1");
    const recovery=new DelegatedCampaignCoordinator(
      new DelegatedCampaignLedger(fixture!.basePath,"fixture:authorized-campaign"),
      new Map([["commit",bound.capability]]),
    );
    expect((await recovery.run("test",campaignId)).executed).toBe(0);
    expect(git(fixture!.workspacePath,["rev-list","--count",oldHead+"..HEAD"]).trim()).toBe("1");
  });

  it("reconciles a completed file-backed native receipt after a crash before ledger completion",async()=>{
    const {bound,ledger,oldHead,indexSha}=await prepare(["git.commit.write"], true);
    const claimed=await ledger.claimNext("test",campaignId);
    if(claimed.disposition!=="claimed") throw new Error("claim not persisted");
    const observation=await bound.capability.execute({
      campaignId,workspaceId:"test",taskId:"commit",operationId:claimed.operationId,
      ...bound.definition,
    });
    expect(observation.state).toBe("succeeded");
    const actual=git(fixture!.workspacePath,["rev-parse","HEAD"]).trim();
    expect(actual).not.toBe(oldHead);
    expect((await new FileMutationReceiptStore(fixture!.workspacePath).get(
      `campaign:${campaignId}:${claimed.operationId}`,
    ))?.state).toBe("completed");

    const newAgent=await LocalAgent.create(fixture!.policyPath);
    let repeated=0;
    const defensiveAgent={
      inspectGit:(...args:Parameters<typeof newAgent.inspectGit>)=>newAgent.inspectGit(...args),
      gitCommit:async()=>{
        repeated++;
        throw new Error("must not dispatch on campaign restart");
      },
    };
    const recovered=bindGitCommit({
      agent:defensiveAgent as unknown as Parameters<typeof bindGitCommit>[0]["agent"],
      nativeReceiptStore:new FileMutationReceiptStore(fixture!.workspacePath),
      input:{
        workspaceId:"test",root:".",message:"Typed delegated commit",
        expectedHeadSha:oldHead,expectedIndexTreeSha:indexSha,
      },
      expectedBranch:"feature/delegated",
      context:{ownerScope:"fixture:authorized-campaign",correlationId:"campaign-integration"},
    });
    // A simulated process crash left the exclusive .run.lock orphaned.
    // Recovery must reclaim ONLY after proved same-host death, then inspect
    // the file-backed native receipt without invoking gitCommit again.
    const stateDir=path.join(fixture!.basePath,"delegated-campaigns");
    const campaignFile=(await readdir(stateDir)).find(n=>n.endsWith(".json"));
    if(!campaignFile)throw Error("durable campaign record missing");
    await writeFile(path.join(stateDir,campaignFile+".run.lock"),JSON.stringify({
      version:1,ownerId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      hostname:"fixture-host",pid:41011,issuedAt:10000,renewedAt:11000,expiresAt:13000,
    }));
    const recoveredLedger=new DelegatedCampaignLedger(
      fixture!.basePath,"fixture:authorized-campaign",
      new CampaignRunLease({
        hostname:"fixture-host",pid:process.pid,
        now:()=>40000,isProcessAlive:()=>false,
        leaseMs:2000,heartbeatMs:300,
      }),
    );
    const outcome=await new DelegatedCampaignCoordinator(
      recoveredLedger,new Map([["commit",recovered.capability]]),
    ).run("test",campaignId);
    expect(outcome.stop).toBe("all_completed");
    expect(outcome.reconciled).toBe(1);
    expect(repeated).toBe(0);
    expect(git(fixture!.workspacePath,["rev-list","--count",oldHead+"..HEAD"]).trim()).toBe("1");
  });

  it("allows only one native Git CAS commit when two LocalAgent instances race on the same temporary HEAD/index",async()=>{
    const {ledger,oldHead,indexSha,bound:firstBound}=await prepare(["git.commit.write"]);
    const secondCampaignId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const ownerScope="fixture:authorized-campaign";
    const secondStore=new InMemoryMutationReceiptStore();
    const secondAgent=await LocalAgent.create(fixture!.policyPath,{mutationReceiptStore:secondStore});
    const second=bindGitCommit({
      agent:secondAgent,nativeReceiptStore:secondStore,
      expectedBranch:"feature/delegated",
      input:{
        workspaceId:"test",root:".",message:"Competing delegated commit",
        expectedHeadSha:oldHead,expectedIndexTreeSha:indexSha,
      },
      context:{ownerScope,correlationId:"campaign-concurrent-cas"},
    });
    const secondLedger=new DelegatedCampaignLedger(fixture!.basePath,ownerScope);
    await secondLedger.create({
      campaignId:secondCampaignId,workspaceId:"test",
      objective:"Competing commit must fail native HEAD/index CAS",
      authorizedActions:["commit"],
      tasks:[{id:"commit",dependsOn:[],...second.definition}],
    });
    const [firstResult,secondResult]=await Promise.all([
      new DelegatedCampaignCoordinator(ledger,new Map([["commit",firstBound.capability]]))
        .run("test",campaignId),
      new DelegatedCampaignCoordinator(secondLedger,new Map([["commit",second.capability]]))
        .run("test",secondCampaignId),
    ]);
    const results=[firstResult,secondResult];
    expect(results.filter(r=>r.campaign.tasks[0]?.state==="completed")).toHaveLength(1);
    expect(results.filter(r=>r.campaign.tasks[0]?.state==="outcome_unknown")).toHaveLength(1);
    expect(git(fixture!.workspacePath,["rev-list","--count",oldHead+"..HEAD"]).trim()).toBe("1");
    const losing=results.find(r=>r.campaign.tasks[0]?.state==="outcome_unknown")!;
    const operationId=losing.campaign.tasks[0]?.operationId;
    expect(operationId).toBeTruthy();
    const beforeHead=git(fixture!.workspacePath,["rev-parse","HEAD"]).trim();
    const losingCoordinator=losing===firstResult
      ? new DelegatedCampaignCoordinator(ledger,new Map([["commit",firstBound.capability]]))
      : new DelegatedCampaignCoordinator(secondLedger,new Map([["commit",second.capability]]));
    const retried=await losingCoordinator.run("test",losing===firstResult?campaignId:secondCampaignId);
    expect(retried.executed).toBe(0);
    expect(retried.campaign.tasks[0]?.operationId).toBe(operationId);
    expect(git(fixture!.workspacePath,["rev-parse","HEAD"]).trim()).toBe(beforeHead);
  },30000);

  // Real LocalAgent and temporary Git setup can exceed Jest's default 5s
  // under loaded Windows CI. Preserve the native denial and HEAD assertions.
  it("native policy denies commit before changing the temporary Git HEAD",async()=>{
    const {bound,ledger,oldHead}=await prepare([]);
    const result=await new DelegatedCampaignCoordinator(
      ledger,new Map([["commit",bound.capability]]),
    ).run("test",campaignId);
    expect(result.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(git(fixture!.workspacePath,["rev-parse","HEAD"]).trim()).toBe(oldHead);
  },30000);

  it("native CAS rejects changed index and leaves HEAD untouched",async()=>{
    const {bound,ledger,oldHead}=await prepare(["git.commit.write"]);
    await writeWorkspaceFile(fixture!.workspacePath,"extra.txt","later\n");
    git(fixture!.workspacePath,["add","extra.txt"]);
    const result=await new DelegatedCampaignCoordinator(
      ledger,new Map([["commit",bound.capability]]),
    ).run("test",campaignId);
    expect(result.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(git(fixture!.workspacePath,["rev-parse","HEAD"]).trim()).toBe(oldHead);
  });
});
