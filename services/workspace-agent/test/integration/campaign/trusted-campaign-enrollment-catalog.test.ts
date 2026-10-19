import { createHash } from "node:crypto";
import { chmod, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { LocalAgent } from "../../../src/local-agent.js";
import { DelegatedCampaignLedger } from "../../../src/campaign/delegated-campaign-ledger.js";
import {
  TrustedCampaignEnrollmentCatalog, type TrustedCampaignBindingFactories,
} from "../../../src/campaign/trusted-campaign-enrollment-catalog.js";
import { bindGitCleanInspection } from "../../../src/campaign/typed-read-capabilities.js";
import {
  createFixture, git, initializeGitRepository, writeWorkspaceFile,
  type Fixture,
} from "../../support/helpers.js";

const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ownerScope = "trusted:host-owner-secret-should-not-be-stored";
const bindingId = "inspect-clean-feature";
let fixture: Fixture | undefined;
afterEach(async()=>{await fixture?.cleanup();fixture=undefined});
async function setup(){
  fixture=await createFixture({profile:"full-repo-readonly"});
  initializeGitRepository(fixture.workspacePath);
  git(fixture.workspacePath,["checkout","-b","feature/enrollment"]);
  await writeWorkspaceFile(fixture.workspacePath,"base.txt","fixture\n");
  git(fixture.workspacePath,["add","base.txt"]);
  git(fixture.workspacePath,["commit","-m","baseline"]);
  const agent=await LocalAgent.create(fixture.policyPath);
  const factories:TrustedCampaignBindingFactories=new Map([[bindingId,{
    ownerScope,
    bind:async(host:LocalAgent)=>{
      const read=bindGitCleanInspection(host,{
        workspaceId:"test",root:".",expectedBranch:"feature/enrollment",
      },{ownerScope});
      return new Map([["git",read.capability]]);
    },
  }]]);
  const definition=bindGitCleanInspection(agent,{
    workspaceId:"test",root:".",expectedBranch:"feature/enrollment",
  },{ownerScope}).definition;
  const ledger=new DelegatedCampaignLedger(fixture.basePath,ownerScope);
  await ledger.create({
    campaignId,workspaceId:"test",objective:"Only trusted Git inspections",
    authorizedActions:["inspect"],
    tasks:[{id:"git",dependsOn:[],...definition}],
  });
  return {agent, factories, ledger, catalog:new TrustedCampaignEnrollmentCatalog(fixture.basePath)};
}

describe("durable trusted host enrollment catalog",()=>{
  it("reconstructs exact authorized typed inspection on LocalAgent restart without autostart or persisted secrets",async()=>{
    const {agent,factories,ledger,catalog}=await setup();
    await catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId:bindingId},factories);
    await catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId:bindingId},factories);
    const raw=await readFile(path.join(fixture!.basePath,"delegated-campaign-enrollments.v1.json"),"utf8");
    expect(raw).not.toContain(ownerScope);
    expect(raw).not.toContain("owner-secret");
    expect(raw).not.toContain("execute");
    expect(raw).not.toContain("shell");
    expect(JSON.parse(raw).enrollments).toHaveLength(1);
    const freshAgent=await LocalAgent.create(fixture!.policyPath);
    const catalogReload=new TrustedCampaignEnrollmentCatalog(fixture!.basePath);
    const host=await freshAgent.createTrustedCampaignHostFromCatalog(catalogReload,factories,{
      stateDirectory:fixture!.basePath,
    });
    expect((await ledger.get("test",campaignId))?.revision).toBe(0);
    expect(host.status()).toEqual([]);
    const outcome=await host.serve(2);
    expect(outcome.stop).toBe("all_completed");
    expect((await ledger.get("test",campaignId))?.tasks[0]?.proof?.reference)
      .toMatch(/^git-clean:[a-f0-9]{64}$/u);
    await host.shutdown();
  },20000);

  it("fails closed on missing trusted factory, swapped owner or changed plan digest",async()=>{
    const {agent,factories,catalog}=await setup();
    await catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId:bindingId},factories);
    await expect(catalog.load(agent,new Map()))
      .rejects.toThrow("CAMPAIGN_FACTORY_NOT_TRUSTED");
    const altered:TrustedCampaignBindingFactories=new Map([[bindingId,{
      ownerScope:"different-trusted-owner",
      bind:factories.get(bindingId)!.bind,
    }]]);
    await expect(catalog.load(agent,altered)).rejects.toThrow();
    const file=path.join(fixture!.basePath,"delegated-campaign-enrollments.v1.json");
    const saved=JSON.parse(await readFile(file,"utf8"));
    saved.enrollments[0].definitionDigest="f".repeat(64);
    await writeFile(file,JSON.stringify(saved));
    await expect(catalog.load(agent,factories)).rejects.toThrow("CAMPAIGN_CATALOG_CONFLICT");
    await expect(catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId:bindingId},factories))
      .rejects.toThrow("CAMPAIGN_CATALOG_CONFLICT");
  },20000);

  it("rejects a changed code-owned binder and invalid catalog schema, without running any task",async()=>{
    const {agent,factories,catalog,ledger}=await setup();
    await catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId:bindingId},factories);
    const changed:TrustedCampaignBindingFactories=new Map([[bindingId,{
      ownerScope,
      bind:async()=>new Map(),
    }]]);
    await expect(catalog.load(agent,changed)).rejects.toThrow("CAMPAIGN_BINDING_MISMATCH");
    expect((await ledger.get("test",campaignId))?.revision).toBe(0);
    const file=path.join(fixture!.basePath,"delegated-campaign-enrollments.v1.json");
    const saved=JSON.parse(await readFile(file,"utf8"));
    saved.enrollments[0].injectedCommand="rm -rf /";
    await writeFile(file,JSON.stringify(saved));
    await expect(catalog.load(agent,factories)).rejects.toThrow("CAMPAIGN_CATALOG_INVALID");
  },20000);

  // POSIX enforces mode bits and permits unprivileged test symlinks.
  const posixIt=process.platform==="win32"?it.skip:it;
  posixIt("rejects a symlinked catalog rather than following external file content",async()=>{
    const {agent,factories,catalog}=await setup();
    await catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId:bindingId},factories);
    const file=path.join(fixture!.basePath,"delegated-campaign-enrollments.v1.json");
    const other=path.join(fixture!.basePath,"fixture-catalog-copy.json");
    await writeFile(other,await readFile(file),{mode:0o600});
    await unlink(file);
    await symlink(other,file);
    await expect(catalog.load(agent,factories)).rejects.toThrow("CAMPAIGN_CATALOG_UNTRUSTED_STATE");
  },20000);

  posixIt("rejects publicly readable catalog or state directory, even with a valid plan",async()=>{
    const {agent,factories,catalog}=await setup();
    await catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId:bindingId},factories);
    const file=path.join(fixture!.basePath,"delegated-campaign-enrollments.v1.json");
    await chmod(file,0o644);
    await expect(catalog.load(agent,factories)).rejects.toThrow("CAMPAIGN_CATALOG_UNTRUSTED_STATE");
    await chmod(file,0o600);
    await chmod(fixture!.basePath,0o755);
    try {
      await expect(catalog.load(agent,factories)).rejects.toThrow("CAMPAIGN_CATALOG_UNTRUSTED_STATE");
    } finally {
      await chmod(fixture!.basePath,0o700);
    }
  },20000);

  it("rejects ID collision or unregistered owner and never creates duplicate enrollments",async()=>{
    const {agent,factories,catalog}=await setup();
    await catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId:bindingId},factories);
    await expect(catalog.enroll(agent,{workspaceId:"test",campaignId,factoryId:"other-factory"},factories))
      .rejects.toThrow("CAMPAIGN_FACTORY_NOT_TRUSTED");
    const alternate:TrustedCampaignBindingFactories=new Map([
      ...factories,
      ["different-id",factories.get(bindingId)!],
    ]);
    await expect(catalog.enroll(agent,{
      workspaceId:"test",campaignId,factoryId:"different-id",
    },alternate)).rejects.toThrow("CAMPAIGN_CATALOG_CONFLICT");
    expect((await catalog.load(agent,factories))).toHaveLength(1);
    await expect(catalog.enroll(agent,{
      workspaceId:"test",campaignId:secondId,factoryId:bindingId,
    },factories)).rejects.toThrow("CAMPAIGN_NOT_ENROLLED");
  },20000);
});
