import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CampaignResourceClaims } from "../../../src/campaign/campaign-resource-claims.js";
import { DelegatedCampaignLedger, type CampaignAction, type CampaignRecord } from "../../../src/campaign/delegated-campaign-ledger.js";

const ws="mcp-access-stack";
const ids=["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"];
let state="",root="",store:CampaignResourceClaims,ledger:DelegatedCampaignLedger;
beforeEach(async()=>{
  state=await mkdtemp(path.join(tmpdir(),"campaign-resource-"));
  root=path.join(state,"workspace");
  store=new CampaignResourceClaims(state);
  ledger=new DelegatedCampaignLedger(state,"owner-a");
});
afterEach(async()=>{await rm(state,{recursive:true,force:true})});
async function plan(i:number, action:CampaignAction="commit"):Promise<CampaignRecord>{
  const id=ids[i]!;
  const t={id:"step",action,dependsOn:[],targetResource:"git:"+ws+":.",
    expectedState:"head:"+"a".repeat(40),
    argumentsDigest:createHash("sha256").update(action).digest("hex")};
  return ledger.create({
    campaignId:id,workspaceId:ws,objective:"Fixture scoped plan",
    authorizedActions:[action],tasks:[t],
  });
}
async function completed(record:CampaignRecord):Promise<CampaignRecord>{
  const claim=await ledger.claimNext(ws,record.campaignId);
  if(claim.disposition!=="claimed")throw Error("missing claim");
  return ledger.transition(ws,record.campaignId,claim.taskId,claim.operationId,
    "completed",{kind:"verified",reference:"receipt:"+claim.operationId});
}
describe("CampaignResourceClaims",()=>{
  it("holds durable workspace ownership across store recreations and blocks another writer",async()=>{
    const a=await plan(0),b=await plan(1);
    await store.reserve(root,a);
    await store.reserve(root,a);
    await expect(new CampaignResourceClaims(state).reserve(root,b))
      .rejects.toThrow("CAMPAIGN_RESOURCE_CONFLICT");
    await expect(store.releaseCompleted(root,a))
      .rejects.toThrow("CAMPAIGN_RESOURCE_INCOMPLETE");
    const done=await completed(a);
    await new CampaignResourceClaims(state).releaseCompleted(root,done);
    await store.reserve(root,b);
  });
  it("never releases an uncertain reservation, even if its lock is no longer active",async()=>{
    const a=await plan(0),b=await plan(1);
    await store.reserve(root,a);
    const claim=await ledger.claimNext(ws,a.campaignId);
    if(claim.disposition!=="claimed")throw Error("claim");
    const unknown=await ledger.transition(ws,a.campaignId,claim.taskId,claim.operationId,"outcome_unknown");
    await expect(store.releaseCompleted(root,unknown))
      .rejects.toThrow("CAMPAIGN_RESOURCE_INCOMPLETE");
    await expect(store.reserve(root,b)).rejects.toThrow("CAMPAIGN_RESOURCE_CONFLICT");
  });
  it("fails closed for tampered claim and never assumes its owner",async()=>{
    const a=await plan(0);
    await store.reserve(root,a);
    const folder=path.join(state,"delegated-campaign-resource-claims");
    const file=(await readdir(folder)).find(n=>n.endsWith(".json"));
    if(!file)throw Error("missing claim");
    const claimPath=path.join(folder,file);
    const original=JSON.parse(await readFile(claimPath,"utf8")) as Record<string,unknown>;
    await writeFile(claimPath,JSON.stringify({...original,definitionDigest:"f".repeat(64)}));
    await expect(store.reserve(root,a)).rejects.toThrow("CAMPAIGN_RESOURCE_CONFLICT");
    await expect(store.releaseCompleted(root,await completed(a)))
      .rejects.toThrow("CAMPAIGN_RESOURCE_CLAIM_MISMATCH");
  });
  it("exempts only genuinely read-only inspect/ci, not tests that may mutate files",async()=>{
    const inspect=await plan(0,"inspect");
    const ci=await plan(1,"ci");
    expect(CampaignResourceClaims.needsReservation(inspect)).toBe(false);
    expect(CampaignResourceClaims.needsReservation(ci)).toBe(false);
    await store.reserve(root,inspect);
    await store.reserve(root,ci);
    // Read-only enrollment never creates a claim directory at all.
    const claims = await readdir(path.join(state,"delegated-campaign-resource-claims"))
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
    expect(claims).toHaveLength(0);
    const testRecord={...inspect,tasks:inspect.tasks.map(t=>({...t,action:"test" as const}))};
    expect(CampaignResourceClaims.needsReservation(testRecord)).toBe(true);
  });
  it("completed plans may release an already absent claim but not another owner",async()=>{
    const a=await plan(0),b=await plan(1);
    const done=await completed(a);
    await store.releaseCompleted(root,done);
    await store.reserve(root,b);
    // A completed former owner cannot delete its successor's reservation.
    await store.releaseCompleted(root,done);
    await expect(store.reserve(root,a)).rejects.toThrow("CAMPAIGN_RESOURCE_CONFLICT");
  });
});
