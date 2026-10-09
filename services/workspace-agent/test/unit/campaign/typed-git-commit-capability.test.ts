import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  InMemoryMutationReceiptStore,
  canonicalSourceControlArgumentsDigest,
  type MutationReceiptIdentity,
} from "@vs-code-gpt/shared";
import { DelegatedCampaignLedger } from "../../../src/campaign/delegated-campaign-ledger.js";
import { DelegatedCampaignCoordinator } from "../../../src/campaign/delegated-campaign-coordinator.js";
import {
  bindGitCommit, type TrustedGitCommitBinding,
} from "../../../src/campaign/typed-git-commit-capability.js";

const workspaceId = "test";
const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const beforeSha = "a".repeat(40);
const indexSha = "b".repeat(40);
const committedSha = "c".repeat(40);
const branch = "feature/delegated-commit";
const input = {
  workspaceId, root: ".", expectedHeadSha: beforeSha,
  expectedIndexTreeSha: indexSha, message: "Test delegated git commit",
};
let directory: string;
let ledger: DelegatedCampaignLedger;
beforeEach(async () => {
  directory=await mkdtemp(path.join(tmpdir(),"typed-delegated-git-"));
  ledger=new DelegatedCampaignLedger(directory,"owner:trusted-git");
});
afterEach(async () => {await rm(directory,{recursive:true,force:true})});

async function makeCampaign(bound: ReturnType<typeof bindGitCommit>) {
  await ledger.create({
    campaignId,workspaceId,objective:"Commit only with native CAS and receipt",
    authorizedActions:["commit"],
    tasks:[{id:"commit",dependsOn:[],...bound.definition}],
  });
}
function result(branchName=branch) {
  return {root:".",branch:branchName,commitSha:committedSha};
}
function makeBinding(opts: {
  store?:InMemoryMutationReceiptStore,
  actualBranch?:string,
  native?: (context: {idempotencyKey?: string; ownerScope?: string}) => Promise<typeof result extends never ? never : ReturnType<typeof result>>,
}={}) {
  const store=opts.store??new InMemoryMutationReceiptStore();
  let commits=0, reads=0;
  const agent={
    inspectGit:async()=>{reads++;return {
      workspaceId,root:".",branch:opts.actualBranch??branch,
      diffMode:"none" as const,status:[],staged:"",unstaged:"",truncated:false,
    }},
    gitCommit:async (_input:unknown,context: {idempotencyKey?:string;ownerScope?:string})=>{
      commits++;
      if(opts.native)return opts.native(context);
      const id: MutationReceiptIdentity={
        workspaceId,operation:"git_commit",targetResource:"git:test:.",
        canonicalArgumentsDigest:canonicalSourceControlArgumentsDigest(input),
        idempotencyKey:context.idempotencyKey!,
      };
      await store.reserve(id);await store.markExecuting(id);
      await store.markCompleted(id,result());
      return result();
    },
  };
  const bound=bindGitCommit({
    agent:agent as unknown as TrustedGitCommitBinding["agent"],
    nativeReceiptStore:store,
    input,expectedBranch:branch,context:{ownerScope:"owner:trusted-git"},
  });
  return {bound,store,getCalls:()=>({commits,reads})};
}
async function run(bound: ReturnType<typeof bindGitCommit>) {
  return new DelegatedCampaignCoordinator(ledger,new Map([["commit",bound.capability]]))
    .run(workspaceId,campaignId);
}
describe("typed Git commit adapter",()=>{
  it("uses the trusted source-control native receipt, then confirms it by a separate read",async()=>{
    const {bound,getCalls}=makeBinding();
    await makeCampaign(bound);
    const outcome=await run(bound);
    expect(outcome.stop).toBe("all_completed");
    expect(outcome.campaign.tasks[0]?.proof?.reference).toMatch(/^git-commit:[a-f0-9]{40}:[a-f0-9]{64}$/u);
    expect(getCalls()).toEqual({commits:1,reads:1});
    expect((await run(bound)).executed).toBe(0);
    expect(getCalls().commits).toBe(1);
  });
  it("does not commit when the trusted branch differs",async()=>{
    const {bound,getCalls}=makeBinding({actualBranch:"feature/different"});
    await makeCampaign(bound);
    const x=await run(bound);
    expect(x.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(getCalls().commits).toBe(0);
  });
  it("does not retry an operation after the backend reports timeout but a native receipt completed",async()=>{
    const store=new InMemoryMutationReceiptStore();
    let commitCalls=0;
    const {bound}=makeBinding({store,native:async context=>{
      commitCalls++;
      const identity:MutationReceiptIdentity={
        workspaceId,operation:"git_commit",targetResource:"git:test:.",
        canonicalArgumentsDigest:canonicalSourceControlArgumentsDigest(input),
        idempotencyKey:context.idempotencyKey!,
      };
      await store.reserve(identity);await store.markExecuting(identity);
      await store.markCompleted(identity,result());
      throw new Error("transport timeout after native commit");
    }});
    await makeCampaign(bound);
    const first=await run(bound);
    expect(first.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(commitCalls).toBe(1);
    const freshLedger=new DelegatedCampaignLedger(directory,"owner:trusted-git");
    const second=await new DelegatedCampaignCoordinator(freshLedger,
      new Map([["commit",bound.capability]])).run(workspaceId,campaignId);
    expect(second.stop).toBe("all_completed");
    expect(commitCalls).toBe(1);
    expect(second.reconciled).toBe(1);
  });
  it("does not treat missing native receipt as not_started even after a claimed crash",async()=>{
    const {bound,getCalls}=makeBinding();
    await makeCampaign(bound);
    const claim=await ledger.claimNext(workspaceId,campaignId);
    expect(claim.disposition).toBe("claimed");
    const recovered=await run(bound);
    expect(recovered.stop).toBe("awaiting_reconciliation");
    expect(recovered.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(getCalls().commits).toBe(0);
    expect(recovered.reconciled).toBe(1);
  });
  it("rejects another identity sharing the same native key without calling gitCommit",async()=>{
    const store=new InMemoryMutationReceiptStore();
    const {bound,getCalls}=makeBinding({store});
    await makeCampaign(bound);
    const claim=await ledger.claimNext(workspaceId,campaignId);
    if(claim.disposition!=="claimed")throw Error("no claim");
    const identity:MutationReceiptIdentity={
      workspaceId,operation:"git_commit",targetResource:"git:wrong:.",
      canonicalArgumentsDigest:canonicalSourceControlArgumentsDigest(input),
      idempotencyKey:`campaign:${campaignId}:${claim.operationId}`,
    };
    await store.reserve(identity);await store.markExecuting(identity);
    const x=await run(bound);
    expect(x.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(getCalls().commits).toBe(0);
  });
  it("does not accept a forged completed receipt with different branch or invalid commit",async()=>{
    const store=new InMemoryMutationReceiptStore();
    const {bound}=makeBinding({store});
    await makeCampaign(bound);
    const claim=await ledger.claimNext(workspaceId,campaignId);
    if(claim.disposition!=="claimed")throw Error("no claim");
    const identity:MutationReceiptIdentity={
      workspaceId,operation:"git_commit",targetResource:"git:test:.",
      canonicalArgumentsDigest:canonicalSourceControlArgumentsDigest(input),
      idempotencyKey:`campaign:${campaignId}:${claim.operationId}`,
    };
    await store.reserve(identity);await store.markExecuting(identity);
    await store.markCompleted(identity,result("feature/wrong"));
    expect((await run(bound)).campaign.tasks[0]?.state).toBe("outcome_unknown");
  });
  it("rejects missing trusted owner and protected main branch",()=>{
    const {bound}=makeBinding();
    expect(bound.definition.expectedState).toContain("branch:"+branch);
    const source={
      agent:({gitCommit:async()=>result(),inspectGit:async()=>({})}) as unknown as TrustedGitCommitBinding["agent"],
      nativeReceiptStore:new InMemoryMutationReceiptStore(),input,
    };
    expect(()=>bindGitCommit({...source,expectedBranch:"main",context:{ownerScope:"owner:trusted-git"}}))
      .toThrow("UNSAFE_COMMIT_BRANCH");
    expect(()=>bindGitCommit({...source,expectedBranch:branch,context:{}}))
      .toThrow("TRUSTED_GIT_COMMIT_BINDING_REQUIRED");
  });
});
