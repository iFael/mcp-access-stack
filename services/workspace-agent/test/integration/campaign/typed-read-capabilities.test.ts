import { afterEach, describe, expect, it } from "@jest/globals";
import type { GitHubExecutor } from "@vs-code-gpt/shared";
import { LocalAgent } from "../../../src/local-agent.js";
import { DelegatedCampaignLedger } from "../../../src/campaign/delegated-campaign-ledger.js";
import { DelegatedCampaignCoordinator } from "../../../src/campaign/delegated-campaign-coordinator.js";
import {
  bindGitCleanInspection, bindGitHubCommitChecks,
} from "../../../src/campaign/typed-read-capabilities.js";
import {
  createFixture, git, initializeGitRepository, makeWorkspacePolicy,
  writePolicy, writeWorkspaceFile, type Fixture,
} from "../../support/helpers.js";

const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let fixture: Fixture | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});

describe("typed delegated campaign with real Workspace Agent Git inspector", () => {
  it("calls the policy-authorized Git read capability twice and completes verified inspection", async () => {
    fixture = await createFixture({ profile: "full-repo-readonly" });
    initializeGitRepository(fixture.workspacePath);
    git(fixture.workspacePath, ["checkout", "-b", "feature/read-check"]);
    await writeWorkspaceFile(fixture.workspacePath, "base.txt", "tracked\n");
    git(fixture.workspacePath, ["add", "base.txt"]);
    git(fixture.workspacePath, ["commit", "-m", "test baseline"]);

    const agent = await LocalAgent.create(fixture.policyPath);
    const auth = { ownerScope: "test:delegated-inspection", correlationId: "delegated-integration" };
    const bound = bindGitCleanInspection(agent, {
      workspaceId: "test", root: ".", expectedBranch: "feature/read-check",
    }, auth);
    const ledger = new DelegatedCampaignLedger(fixture.basePath, auth.ownerScope);
    await ledger.create({
      campaignId, workspaceId: "test",
      objective: "Verify Git cleanliness through the policy-authorized typed inspector.",
      authorizedActions: ["inspect"],
      tasks: [{ id: "git", dependsOn: [], ...bound.definition }],
    });
    const result = await new DelegatedCampaignCoordinator(
      ledger, new Map([["git", bound.capability]]),
    ).run("test", campaignId);
    expect(result.stop).toBe("all_completed");
    expect(result.executed).toBe(1);
    expect(result.campaign.tasks[0]?.proof?.reference).toMatch(/^git-clean:[a-f0-9]{64}$/u);
    expect((await agent.inspectGit({workspaceId:"test",root:".",diffMode:"none"},auth)).status)
      .toHaveLength(0);
  });

  it("routes exact SHA CI through real LocalAgent source-control authorization and two verified reads", async () => {
    fixture = await createFixture({ profile:"full-repo-readonly" });
    initializeGitRepository(fixture.workspacePath);
    const sha = "a".repeat(40);
    await writePolicy(fixture.policyPath, [{
      ...makeWorkspacePolicy(fixture.workspacePath,{profile:"full-repo-readonly"}),
      sourceControl:{
        capabilities:["github.repository.read"], accountOwners:[],
        additionalRepositories:["iFael/mcp-access-stack"],
      },
    }]);
    let polls=0;
    const backend={
      getCommitChecks:async (input:{owner:string;repository:string;commitSha:string})=>{
        polls++;
        return {
          owner:input.owner,repository:input.repository,commitSha:input.commitSha,
          totalCount:1,returnedCount:1,pendingCount:0,successfulCount:1,
          failingCount:0,truncated:false,allCompleted:true,passed:true,
          checks:[{id:42,name:"validate",status:"completed" as const,
            conclusion:"success" as const,detailsUrl:null,startedAt:null,completedAt:null}],
        };
      },
    } as unknown as GitHubExecutor;
    const agent=await LocalAgent.create(fixture.policyPath,{githubExecutor:backend});
    const ownerScope="owner:ci-read";
    const bound=bindGitHubCommitChecks(agent,{
      workspaceId:"test",owner:"iFael",repository:"mcp-access-stack",
      commitSha:sha,
    },{ownerScope});
    const ledger=new DelegatedCampaignLedger(fixture.basePath,ownerScope);
    await ledger.create({
      campaignId,workspaceId:"test",objective:"Prove exact SHA CI through authorized LocalAgent",
      authorizedActions:["ci"],tasks:[{id:"ci",dependsOn:[],...bound.definition}],
    });
    const result=await new DelegatedCampaignCoordinator(
      ledger,new Map([["ci",bound.capability]]),
    ).run("test",campaignId);
    expect(result.stop).toBe("all_completed");
    expect(result.campaign.tasks[0]?.proof?.reference).toMatch(new RegExp("^ci:"+sha+":"));
    expect(polls).toBe(2);
  });

  it("denies GitHub CI checks without native repository permission before backend invocation", async () => {
    fixture=await createFixture({profile:"full-repo-readonly"});
    initializeGitRepository(fixture.workspacePath);
    await writePolicy(fixture.policyPath,[{
      ...makeWorkspacePolicy(fixture.workspacePath,{profile:"full-repo-readonly"}),
      sourceControl:{capabilities:[],accountOwners:[],additionalRepositories:["iFael/mcp-access-stack"]},
    }]);
    let backendCalls=0;
    const backend={
      getCommitChecks:async()=>{backendCalls++;throw new Error("must not be called");},
    } as unknown as GitHubExecutor;
    const agent=await LocalAgent.create(fixture.policyPath,{githubExecutor:backend});
    const ownerScope="owner:unauthorized-ci";
    const bound=bindGitHubCommitChecks(agent,{
      workspaceId:"test",owner:"iFael",repository:"mcp-access-stack",
      commitSha:"a".repeat(40),
    },{ownerScope});
    const ledger=new DelegatedCampaignLedger(fixture.basePath,ownerScope);
    await ledger.create({
      campaignId,workspaceId:"test",objective:"No bypass for unauthorized CI",
      authorizedActions:["ci"],tasks:[{id:"ci",dependsOn:[],...bound.definition}],
    });
    const result=await new DelegatedCampaignCoordinator(
      ledger,new Map([["ci",bound.capability]]),
    ).run("test",campaignId);
    expect(result.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(backendCalls).toBe(0);
  });

  it("does not mark a dirty local repository as verified clean", async () => {
    fixture = await createFixture({ profile: "full-repo-readonly" });
    initializeGitRepository(fixture.workspacePath);
    git(fixture.workspacePath, ["checkout", "-b", "feature/read-check"]);
    await writeWorkspaceFile(fixture.workspacePath, "base.txt", "tracked\n");
    git(fixture.workspacePath, ["add", "base.txt"]);
    git(fixture.workspacePath, ["commit", "-m", "baseline"]);
    await writeWorkspaceFile(fixture.workspacePath, "untracked.txt", "not clean");
    const agent = await LocalAgent.create(fixture.policyPath);
    const bound = bindGitCleanInspection(agent, {
      workspaceId: "test", expectedBranch: "feature/read-check",
    }, { ownerScope: "test:read-only" });
    const ledger = new DelegatedCampaignLedger(fixture.basePath, "test:read-only");
    await ledger.create({
      campaignId, workspaceId:"test", objective:"Inspect tracked state",
      authorizedActions:["inspect"],
      tasks:[{id:"git",dependsOn:[],...bound.definition}],
    });
    const result = await new DelegatedCampaignCoordinator(
      ledger,new Map([["git",bound.capability]]),
    ).run("test",campaignId);
    expect(result.campaign.tasks[0]?.state).toBe("in_flight");
    expect(result.stop).toBe("awaiting_reconciliation");
  });
});
