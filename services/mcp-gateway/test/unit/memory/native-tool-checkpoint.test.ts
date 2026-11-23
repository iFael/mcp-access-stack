import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe,expect,it } from "@jest/globals";
import { CentralMemoryStore, LEGACY_CODEX_FILES } from "../../../src/memory/central-memory.js";
import { checkpointFromNativeTool, captureNativeToolCheckpoint } from "../../../src/memory/native-tool-checkpoint.js";

const repo="repo_a3c7aaa6-9fb9-4d06-ba79-29f3c4cf1767";
const updateId="upd_48b56969-e75f-4a0b-8a2a-5fa0799f80f0";
const mainSha="0283771123bb27dc9301ed13bc6ab454a0b382c4";
const result={update:{updateId,status:"succeeded",step:"windows_promote",mainSha,
  tag:"v1.1.0-beta.137-connector.1",companionTag:"v1.1.0-companion.43483987901"}};

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
      const imported=store.importLegacySources(owner,repo,docs);
      const args={workspaceId:"mcp-access-stack",action:"read",updateId};
      expect(captureNativeToolCheckpoint(store,owner,"mcp_update",args,result)).toBeNull();
      const kinds=["decision","context","task"] as const;
      kinds.forEach((kind,index)=>store.update(owner,{
        repositoryId:repo,operationId:"operation:curated:"+index,
        action:"create",recordId:"record:curated:"+index,expectedRevision:0,
        kind,confidence:"user_reported",title:"Curated "+kind,
        content:"Verified against legacy source hashes",
        evidenceRefs:docs.slice(index*4,index*4+4).map(doc=>
          "legacy:"+doc.surface+":"+doc.filename+":"+doc.contentSha256),
      }));
      store.activateLegacyAuthority(owner,repo,"operation:activate:1",
        imported.importHash,"a".repeat(64));
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

  it("captures a failed workflow exactly by its reconciled operation ID without logging secrets",()=>{
    const operationId="43737484-ba20-4c3b-92ba-958cb856a21d";
    const input={workspaceId:"mcp-access-stack",repository:"mcp-access-stack",
      workflow:"edge-catalog-activate.yml",operationId,mode:"reconcile",expectedMainSha:mainSha};
    const result={status:"observed",state:"completed",conclusion:"failure",operationId,
      runId:45083739015,rawToken:"secret-not-to-persist"};
    const checkpoint=checkpointFromNativeTool("github_workflow_operation",input,result,repo);
    expect(checkpoint).toMatchObject({kind:"issue",recordId:"mcp-workflow:"+operationId,
      confidence:"inferred",evidenceRefs:["github:run:45083739015"]});
    expect(checkpoint!.content).toContain("failure");
    expect(checkpoint!.content).not.toContain("secret-not-to-persist");
    expect(checkpointFromNativeTool("github_workflow_operation",input,result,repo)).toEqual(checkpoint);
    expect(checkpointFromNativeTool("github_workflow_operation",input,
      {...result,state:"in_progress"},repo)).toBeNull();
    expect(checkpointFromNativeTool("github_workflow_operation",input,
      {...result,conclusion:"success"},repo)).toBeNull();
    expect(checkpointFromNativeTool("github_workflow_operation",input,
      {...result,conclusion:"cancelled"},repo)).toBeNull();
    expect(checkpointFromNativeTool("github_workflow_operation",input,
      {...result,conclusion:"action_required"},repo)).toBeNull();
    expect(checkpointFromNativeTool("github_workflow_operation",
      {...input,repository:"another"},result,repo)).toBeNull();
    expect(checkpointFromNativeTool("github_workflow_operation",input,
      {...result,operationId:"other"},repo)).toBeNull();
  });

  it("captures failed background tasks while excluding commands, logs and error messages",()=>{
    const id="fbed08b4-1b74-4848-a2c3-b716a8cdbed3";
    const input={workspaceId:"mcp-access-stack",id};
    const result={task:{id,workspaceId:"mcp-access-stack",state:"failed",operation:"run_command",
      command:"SECRET=hidden",error:"credential private-data",
      result:{exitCode:1,stdout:"sensitive-output",stderr:"private-stacktrace"},
      lifecycle:{reason:"upstream_timeout",diagnostic:"password"}}};
    const cp=checkpointFromNativeTool("get_background_task",input,result,repo);
    expect(cp).toMatchObject({kind:"issue",recordId:"mcp-task:"+id});
    expect(cp!.content).toContain("failed");
    for(const secret of ["hidden","credential","sensitive","private","password"]){
      expect(cp!.content).not.toContain(secret);
    }
    expect(checkpointFromNativeTool("get_background_task",input,
      {task:{...result.task,state:"running"}},repo)).toBeNull();
    expect(checkpointFromNativeTool("get_background_task",input,
      {task:{...result.task,lifecycle:{reason:"process_failed"}}},repo)).toBeNull();
    expect(checkpointFromNativeTool("get_background_task",input,
      {task:{...result.task,lifecycle:undefined}},repo)).toBeNull();
    expect(checkpointFromNativeTool("get_background_task",input,
      {task:{...result.task,id:"another"}},repo)).toBeNull();
    expect(checkpointFromNativeTool("get_background_task",
      {...input,workspaceId:"other"},result,repo)).toBeNull();
  });
  it("rejects malformed or untrusted results",()=>{
    expect(checkpointFromNativeTool("mcp_update",{workspaceId:"mcp-access-stack"},
      {update:{...result.update,mainSha:"invalid",token:"secret"}},repo)).toBeNull();
    expect(checkpointFromNativeTool("mcp_update",
      {workspaceId:"wrong"},{update:result.update},repo)).toBeNull();
    expect(checkpointFromNativeTool("mcp_update",
      {workspaceId:"mcp-access-stack"},{update:result.update},"bad")).toBeNull();
    expect(checkpointFromNativeTool("mcp_update",
      {workspaceId:"mcp-access-stack"},{update:{...result.update,
        updateId:updateId.slice(4)}},repo)).toBeNull();
    expect(checkpointFromNativeTool("mcp_update",
      {workspaceId:"mcp-access-stack"},{update:{...result.update,
        updateId:"other_"+updateId.slice(4)}},repo)).toBeNull();
    expect(checkpointFromNativeTool("mcp_update",
      {workspaceId:"mcp-access-stack"},{update:{...result.update,tag:"private=secret"}},
      repo)?.content).not.toContain("private=secret");
  });
});
