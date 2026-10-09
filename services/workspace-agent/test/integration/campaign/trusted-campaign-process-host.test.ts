import { afterEach, describe, expect, it } from "@jest/globals";
import { LocalAgent } from "../../../src/local-agent.js";
import { DelegatedCampaignLedger } from "../../../src/campaign/delegated-campaign-ledger.js";
import {
  TrustedCampaignEnrollmentCatalog,
  type TrustedCampaignBindingFactories,
} from "../../../src/campaign/trusted-campaign-enrollment-catalog.js";
import { TrustedCampaignProcessHost } from "../../../src/campaign/trusted-campaign-process-host.js";
import { bindGitCleanInspection } from "../../../src/campaign/typed-read-capabilities.js";
import {
  createFixture, git, initializeGitRepository, writeWorkspaceFile,
  type Fixture,
} from "../../support/helpers.js";

const campaignId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ownerScope="trusted:process-host-owner";
const factoryId="inspect-branch-v1";
let fixture:Fixture|undefined;
afterEach(async()=>{await fixture?.cleanup();fixture=undefined});

async function setup(){
  fixture=await createFixture({profile:"full-repo-readonly"});
  initializeGitRepository(fixture.workspacePath);
  git(fixture.workspacePath,["checkout","-b","feature/supervised"]);
  await writeWorkspaceFile(fixture.workspacePath,"base.txt","test\n");
  git(fixture.workspacePath,["add","base.txt"]);
  git(fixture.workspacePath,["commit","-m","baseline"]);
  const agent=await LocalAgent.create(fixture.policyPath);
  const factory=async (host:LocalAgent)=>{
    const port=bindGitCleanInspection(host,{
      workspaceId:"test",expectedBranch:"feature/supervised",root:".",
    },{ownerScope});
    return {
      definition:port.definition,
      ports:new Map([["git-a",port.capability],["git-b",port.capability]]),
    };
  };
  const bound=await factory(agent);
  const ledger=new DelegatedCampaignLedger(fixture.basePath,ownerScope);
  await ledger.create({
    campaignId,workspaceId:"test",objective:"Check the same permitted branch twice",
    authorizedActions:["inspect"],
    tasks:[
      {id:"git-a",dependsOn:[],...bound.definition},
      {id:"git-b",dependsOn:["git-a"],...bound.definition},
    ],
  });
  const factories:TrustedCampaignBindingFactories=new Map([[factoryId,{
    ownerScope,bind:async host=>(await factory(host)).ports,
  }]]);
  const catalog=new TrustedCampaignEnrollmentCatalog(fixture.basePath);
  await catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId},factories);
  return {agent,ledger,catalog,factories};
}

describe("trusted process host restart, budgeting and shutdown",()=>{
  it("resumes from persisted catalog and ledger across real LocalAgent recreation",async()=>{
    const {agent,ledger,catalog,factories}=await setup();
    const initial=new TrustedCampaignProcessHost(agent,catalog,factories,{
      stateDirectory:fixture!.basePath,supervisor:{maxStepsPerWake:1},
    });
    // No work is dispatched simply by constructing the process host.
    expect((await ledger.get("test",campaignId))?.revision).toBe(0);
    const first=await initial.run(undefined,{maxEpochs:1,maxWakesPerEpoch:1});
    expect(first.stop).toBe("wake_budget");
    expect(first.wakes).toBe(1);
    expect((await ledger.get("test",campaignId))?.tasks.map(t=>t.state))
      .toEqual(["completed","pending"]);
    const restartedAgent=await LocalAgent.create(fixture!.policyPath);
    const restarted=new TrustedCampaignProcessHost(restartedAgent,
      new TrustedCampaignEnrollmentCatalog(fixture!.basePath),factories,{
        stateDirectory:fixture!.basePath,supervisor:{maxStepsPerWake:1},
      });
    const final=await restarted.run(undefined,{maxEpochs:4,maxWakesPerEpoch:1});
    expect(final.stop).toBe("all_completed");
    expect((await ledger.get("test",campaignId))?.tasks.map(t=>t.state))
      .toEqual(["completed","completed"]);
    expect(new Set((await ledger.get("test",campaignId))!.tasks.map(t=>t.operationId)).size)
      .toBe(2);
  },20000);

  it("stops before startup on aborted signal and never dispatches a capability",async()=>{
    const {agent,ledger,catalog,factories}=await setup();
    const runner=new TrustedCampaignProcessHost(agent,catalog,factories,{
      stateDirectory:fixture!.basePath,
    });
    const cancelled=new AbortController();
    cancelled.abort();
    const out=await runner.run(cancelled.signal);
    expect(out.stop).toBe("stopped");
    expect(out.wakes).toBe(0);
    expect((await ledger.get("test",campaignId))?.revision).toBe(0);
  },20000);

  it("fails closed without code-owned factories and does not implicitly start",async()=>{
    const {agent,ledger,catalog}=await setup();
    const runner=new TrustedCampaignProcessHost(agent,catalog,new Map(),{
      stateDirectory:fixture!.basePath,
    });
    expect((await ledger.get("test",campaignId))?.revision).toBe(0);
    await expect(runner.run()).rejects.toThrow("CAMPAIGN_FACTORY_NOT_TRUSTED");
    expect((await ledger.get("test",campaignId))?.revision).toBe(0);
  },20000);
});
