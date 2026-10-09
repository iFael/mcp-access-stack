import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  type GitHubCommitChecksResult, type InspectGitResult,
} from "@vs-code-gpt/shared";
import {
  DelegatedCampaignLedger, type CampaignStep,
} from "../../../src/campaign/delegated-campaign-ledger.js";
import {
  DelegatedCampaignCoordinator,
} from "../../../src/campaign/delegated-campaign-coordinator.js";
import {
  bindGitCleanInspection, bindGitHubCommitChecks,
  type GitHubChecksReader, type GitInspector,
} from "../../../src/campaign/typed-read-capabilities.js";

const sha = "a".repeat(40);
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "mcp-access-stack";
let directory = "";
beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "mcp-typed-campaign-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function checks(overrides: Partial<GitHubCommitChecksResult> = {}): GitHubCommitChecksResult {
  return {
    owner: "iFael", repository: "mcp-access-stack", commitSha: sha,
    totalCount: 1, returnedCount: 1, pendingCount: 0, successfulCount: 1,
    failingCount: 0, truncated: false, allCompleted: true, passed: true,
    checks: [{
      id: 42, name: "validate", status: "completed", conclusion: "success",
      detailsUrl: null, startedAt: null, completedAt: null,
    }],
    ...overrides,
  };
}
function git(overrides: Partial<InspectGitResult> = {}): InspectGitResult {
  return {
    workspaceId, root: ".", branch: "main", diffMode: "none",
    staged: "", unstaged: "", status: [], truncated: false,
    ...overrides,
  };
}
function ciPort(fetch: () => Promise<GitHubCommitChecksResult>) {
  return bindGitHubCommitChecks({
    githubGetCommitChecks: async (input, ctx) => {
      expect(ctx.ownerScope).toBe("owner:trusted-session");
      expect(input.workspaceId).toBe(workspaceId);
      expect(input.owner).toBe("iFael");
      expect(input.repository).toBe("mcp-access-stack");
      expect(input.commitSha).toBe(sha);
      return fetch();
    },
  } as GitHubChecksReader, { workspaceId, root: ".", owner: "iFael", repository: "mcp-access-stack", commitSha: sha },
  { ownerScope: "owner:trusted-session", correlationId: "trusted-read-campaign" });
}
function gitPort(fetch: () => Promise<InspectGitResult>) {
  return bindGitCleanInspection({
    inspectGit: async (input, ctx) => {
      expect(ctx.ownerScope).toBe("owner:trusted-session");
      expect(input.workspaceId).toBe(workspaceId);
      expect(input.diffMode).toBe("none");
      expect(input.root).toBe(".");
      return fetch();
    },
  } as GitInspector, { workspaceId, root: ".", expectedBranch: "main" },
  { ownerScope: "owner:trusted-session", correlationId: "trusted-read-campaign" });
}
async function drive(items: Array<{id:string; dependsOn:string[]; port: ReturnType<typeof ciPort> | ReturnType<typeof gitPort>}>) {
  const ledger = new DelegatedCampaignLedger(directory, "authorized-owner");
  await ledger.create({
    campaignId: id, workspaceId,
    objective: "Observe Git and verify CI without mutating anything.",
    authorizedActions: ["inspect", "ci"],
    tasks: items.map(({id,dependsOn,port}): CampaignStep =>
      ({id,dependsOn,...port.definition})),
  });
  return new DelegatedCampaignCoordinator(ledger, new Map(items.map(x=>[x.id,x.port.capability])))
    .run(workspaceId,id);
}
describe("real typed read capability adapters", () => {
  it("runs Git inspection then exact SHA CI checks using the existing typed LocalAgent methods", async () => {
    let gitCalls=0, ciCalls=0;
    const inspect=gitPort(async()=>{gitCalls++;return git()});
    const ci=ciPort(async()=>{ciCalls++;return checks()});
    const result=await drive([
      {id:"git",dependsOn:[],port:inspect},
      {id:"ci",dependsOn:["git"],port:ci},
    ]);
    expect(result.stop).toBe("all_completed");
    expect(result.campaign.tasks.map(x=>x.state)).toEqual(["completed","completed"]);
    expect(result.campaign.tasks[1]?.proof?.reference).toMatch(new RegExp("^ci:"+sha+":"));
    expect(gitCalls).toBe(2);
    expect(ciCalls).toBe(2);
  });
  it("fails closed when a Git branch differs or the worktree is not clean", async () => {
    const different=await drive([{id:"git",dependsOn:[],port:gitPort(async()=>git({branch:"feature"}))}]);
    expect(different.campaign.tasks[0]?.state).toBe("outcome_unknown");
    const ledger = new DelegatedCampaignLedger(directory,"owner-b");
    await ledger.create({
      campaignId:id,workspaceId,objective:"read-only",authorizedActions:["inspect"],
      tasks:[{id:"git",dependsOn:[],...gitPort(async()=>git()).definition}],
    });
    const dirty=await new DelegatedCampaignCoordinator(ledger,new Map([["git",
      gitPort(async()=>git({status:[{path:"a.ts",indexStatus:"M",workTreeStatus:" "}]})).capability,
    ]])).run(workspaceId,id);
    expect(dirty.campaign.tasks[0]?.state).toBe("in_flight");
    expect(dirty.stop).toBe("awaiting_reconciliation");
  });
  it("will not call the reader on a tampered campaign operation binding", async () => {
    let calls=0;
    const cap=ciPort(async()=>{calls++;return checks()});
    const forged={...cap.capability,expectedState:"commit:"+"f".repeat(40)};
    const ledger=new DelegatedCampaignLedger(directory,"owner-c");
    await ledger.create({
      campaignId:id,workspaceId,objective:"ci",authorizedActions:["ci"],
      tasks:[{id:"ci",dependsOn:[],...cap.definition}],
    });
    await expect(new DelegatedCampaignCoordinator(ledger,new Map([["ci",forged]])).run(workspaceId,id))
      .rejects.toThrow("CAMPAIGN_BINDING_MISMATCH");
    expect(calls).toBe(0);
  });
  it("rejects green check results from another SHA, never claiming CI GREEN", async () => {
    const result=await drive([{id:"ci",dependsOn:[],port:ciPort(async()=>checks({commitSha:"f".repeat(40)}))}]);
    expect(result.campaign.tasks[0]?.state).toBe("outcome_unknown");
  });
  it("does not mark CI completed for a truncated, missing, or pending check set", async () => {
    const variants=[
      checks({totalCount:2,returnedCount:1,truncated:true,allCompleted:false,passed:false}),
      checks({totalCount:1,pendingCount:1,successfulCount:0,allCompleted:false,passed:false,
        checks:[{id:42,name:"validate",status:"in_progress",conclusion:null,detailsUrl:null,startedAt:null,completedAt:null}]}),
      checks({totalCount:0,returnedCount:0,successfulCount:0,checks:[],allCompleted:false,passed:false}),
    ];
    for(const [i,result] of variants.entries()){
      const ledger=new DelegatedCampaignLedger(directory,"pending-owner-"+i);
      const bound=ciPort(async()=>result);
      await ledger.create({
        campaignId:id,workspaceId,objective:"ci pending",authorizedActions:["ci"],
        tasks:[{id:"ci",dependsOn:[],...bound.definition}],
      });
      const run=await new DelegatedCampaignCoordinator(ledger,new Map([["ci",bound.capability]])).run(workspaceId,id);
      expect(run.campaign.tasks[0]?.state).toBe("in_flight");
      expect(run.stop).toBe("awaiting_reconciliation");
    }
  });
  it("marks a confirmed failed check as failed, not a passing dependency", async () => {
    const failure=checks({
      successfulCount:0,failingCount:1,passed:false,
      checks:[{id:42,name:"validate",status:"completed",conclusion:"failure",detailsUrl:null,startedAt:null,completedAt:null}],
    });
    const run=await drive([{id:"ci",dependsOn:[],port:ciPort(async()=>failure)}]);
    expect(run.campaign.tasks[0]?.state).toBe("failed");
    expect(run.stop).toBe("no_runnable_step");
  });
  it("verifies a terminal receipt via fresh read and leaves changing checks uncertain", async () => {
    let reads=0;
    const first=checks();
    const changed=checks({checks:[{...first.checks[0]!,id:99}]});
    const result=await drive([{id:"ci",dependsOn:[],port:ciPort(async()=>++reads===1?first:changed)}]);
    expect(reads).toBe(2);
    expect(result.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(result.campaign.tasks[0]?.proof).toBeUndefined();
  });
  it("requires exact workspace scope and rejects invalid input before any reader call", async () => {
    let calls=0;
    const p=ciPort(async()=>{calls++;return checks()});
    const req={
      campaignId:id,workspaceId:"different-workspace",taskId:"ci",
      operationId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ...p.definition,
    };
    await expect(p.capability.execute(req)).rejects.toThrow("CAMPAIGN_WORKSPACE_MISMATCH");
    expect(calls).toBe(0);
    expect(()=>bindGitHubCommitChecks({} as GitHubChecksReader,{
      workspaceId,owner:"iFael",repository:"mcp-access-stack",commitSha:"abc",
    }, {ownerScope:"owner:trusted-session"})).toThrow();
    expect(() => bindGitCleanInspection({} as GitInspector, {
      workspaceId, root:".", expectedBranch:"main",
    }, {})).toThrow("CAMPAIGN_OWNER_REQUIRED");
  });
});
