import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe,expect,it } from "@jest/globals";
import { CentralMemoryStore, LEGACY_CODEX_FILES } from "../../../src/memory/central-memory.js";
import { checkpointFromNativeTool, captureNativeToolCheckpoint } from "../../../src/memory/native-tool-checkpoint.js";

const repo="repo_a3c7aaa6-9fb9-4d06-ba79-29f3c4cf1767";
const updateId="cc9a5bb2-1773-4ecc-91ca-ca8b6d424f75";
const mainSha="2843d1adea362c95ba3790badca94d16229b67ae";
const result={update:{updateId,status:"succeeded",step:"windows_promote",mainSha,
  tag:"v1.1.0-beta.135-connector.1",companionTag:"v1.1.0-companion.43022866283"}};

describe("deterministic tool-result checkpoints",()=>{

  it("persists the same confirmed event once and permits off-host replay",()=>{
    const dir=mkdtempSync(path.join(os.tmpdir(),"native-checkpoint-"));
    const releases=path.join(dir,"releases");
    mkdirSync(releases);
    const store=CentralMemoryStore.open(path.join(dir,"state","memory.sqlite"),releases);
    const owner="user:alice";
    try {
      expect(captureNativeToolCheckpoint(store,owner,"mcp_update",
        {workspaceId:"mcp-access-stack"},result)).toBeNull();
      const docs=(["oracle","windows"] as const).flatMap(surface=>
        LEGACY_CODEX_FILES.map(filename=>{
          const content=surface+" "+filename+" evidence";
          return {surface,filename,content,
            contentSha256:createHash("sha256").update(content).digest("hex")};
        }));
      store.importLegacySources(owner,repo,docs);
      const args={workspaceId:"mcp-access-stack",action:"read",updateId};
      const first=captureNativeToolCheckpoint(store,owner,"mcp_update",args,result);
      expect(first).toMatchObject({version:1,expectedRevision:0,
        record:{recordId:"mcp-update:"+updateId,revision:1}});
      expect(captureNativeToolCheckpoint(store,owner,"mcp_update",args,result)).toEqual(first);
      expect(store.history(owner,repo,"mcp-update:"+updateId)).toHaveLength(1);
      const later={update:{...result.update,status:"failed",step:"connector_release",
        error:{code:"WORKFLOW_TIMEOUT"}}};
      const second=captureNativeToolCheckpoint(store,owner,"mcp_update",args,later);
      expect(second).toMatchObject({expectedRevision:1,record:{revision:2}});
      expect(second?.operationId).not.toBe(first?.operationId);
      expect(store.history(owner,repo,"mcp-update:"+updateId)).toHaveLength(2);
      expect(captureNativeToolCheckpoint(store,owner,"mcp_update",args,later)).toEqual(second);
    } finally {
      store.close();
      rmSync(dir,{recursive:true,force:true});
    }
  });


  it("captures terminal mcp_update results with stable identity and sanitized evidence",()=>{
    const input={workspaceId:"mcp-access-stack",action:"read",updateId};
    const one=checkpointFromNativeTool("mcp_update",input,result,repo);
    const two=checkpointFromNativeTool("mcp_update",input,result,repo);
    expect(one).toEqual(two);
    expect(one).toMatchObject({recordId:"mcp-update:"+updateId,repositoryId:repo,
      confidence:"inferred",kind:"note",evidenceRefs:["mcp_update:"+updateId,"main:"+mainSha]});
    expect(one!.operationId).toMatch(/^native:mcp_update:/u);
    expect(one!.content).toContain("windows_promote");
    expect(one!.content).not.toContain("token");
    expect(checkpointFromNativeTool("mcp_update",input,{
      update:{...result.update,status:"running"},
    },repo)).toBeNull();
  });
  it("records meaningful merge completions but does not claim CI success",()=>{
    const cp=checkpointFromNativeTool("github_merge_pull_request",
      {repository:"mcp-access-stack",pullNumber:300},
      {merged:true,mergeSha:mainSha},repo);
    expect(cp).toMatchObject({recordId:"mcp-pr:300",kind:"note"});
    expect(cp!.content).toContain("post-merge CI separately");
    expect(checkpointFromNativeTool("github_merge_pull_request",
      {repository:"another",pullNumber:300},{merged:true,mergeSha:mainSha},repo)).toBeNull();
  });
  it("rejects malformed or untrusted results",()=>{
    expect(checkpointFromNativeTool("mcp_update",{workspaceId:"mcp-access-stack"},
      {update:{...result.update,mainSha:"invalid",token:"secret"}},repo)).toBeNull();
    expect(checkpointFromNativeTool("mcp_update",
      {workspaceId:"wrong"},{update:result.update},repo)).toBeNull();
    expect(checkpointFromNativeTool("mcp_update",
      {workspaceId:"mcp-access-stack"},{update:result.update},"bad")).toBeNull();
    expect(checkpointFromNativeTool("mcp_update",
      {workspaceId:"mcp-access-stack"},{update:{...result.update,tag:"private=secret"}},
      repo)?.content).not.toContain("private=secret");
  });
});
