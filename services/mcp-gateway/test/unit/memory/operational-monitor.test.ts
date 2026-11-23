import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { CentralMemoryStore, LEGACY_CODEX_FILES } from "../../../src/memory/central-memory.js";
import { CentralMemoryOperationalMonitor } from "../../../src/memory/operational-monitor.js";

const repo = "repo_a3c7aaa6-9fb9-4d06-ba79-29f3c4cf1767";
const secondRepo = "repo_211ade70-85c8-409b-90ce-a0bb0f18dc8a";
const activate = (db: CentralMemoryStore, owner: string, repoId: string) => {
  const docs = (["oracle","windows"] as const).flatMap(surface =>
    LEGACY_CODEX_FILES.map(filename => {
      const content = surface + " " + filename + " evidence";
      return {surface,filename,content,
        contentSha256:createHash("sha256").update(content).digest("hex")};
    }));
  const imported = db.importLegacySources(owner,repoId,docs);
  (["decision","context","task"] as const).forEach((kind,index) => db.update(owner,{
    repositoryId:repoId,operationId:"test:curated:"+repoId+":"+index,
    action:"create",recordId:"curated:"+index,expectedRevision:0,
    kind,confidence:"user_reported",title:kind,content:"Verified proof",
    evidenceRefs:docs.slice(index*4,index*4+4).map(d=>
      "legacy:"+d.surface+":"+d.filename+":"+d.contentSha256),
  }));
  db.activateLegacyAuthority(owner,repoId,"test:activate:"+repoId,
    imported.importHash,"a".repeat(64));
};
describe("independent Oracle operational monitoring",()=>{
  it("debounces failures, records a single sanitized issue, and reports recovery without closing investigation",()=>{
    const dir=mkdtempSync(path.join(os.tmpdir(),"monitor-memory-"));
    mkdirSync(path.join(dir,"release"));
    const db=CentralMemoryStore.open(path.join(dir,"state","memory.sqlite"),path.join(dir,"release"));
    try{
      activate(db,"user:alice",repo);
      let edge=true;
      const monitor=new CentralMemoryOperationalMonitor(db,()=>({
        workspaceBackendReady:true,edgeConnectorReady:edge,
      }));
      monitor.tick();
      edge=false;
      monitor.tick();monitor.tick();
      expect(db.context("user:alice",repo,"MCP runtime signal").records).toHaveLength(0);
      monitor.tick();
      const first=db.activeMonitorIssue("user:alice",repo,"edge_connector");
      expect(first).toMatchObject({kind:"issue",revision:1,status:"active"});
      expect(first!.content).toContain('"cause":"unverified"');
      db.update("user:alice",{
        repositoryId:repo,operationId:"test:improvement:001",action:"create",
        recordId:"mcp-improvement:review-checks",expectedRevision:0,
        kind:"task",confidence:"inferred",title:"Investigate recurring CI failures",
        content:"Investigate with validated evidence",evidenceRefs:["ci:example"],
      });
      const priority=db.context("user:alice",repo,"",2).records;
      expect(priority.map(r=>r.recordId)).toEqual([first!.recordId,"mcp-improvement:review-checks"]);
      monitor.tick();monitor.tick();
      expect(db.activeMonitorIssue("user:alice",repo,"edge_connector")?.revision).toBe(1);
      edge=true;monitor.tick();monitor.tick();
      expect(db.activeMonitorIssue("user:alice",repo,"edge_connector")?.revision).toBe(2);
      expect(db.activeMonitorIssue("user:alice",repo,"edge_connector")?.content)
        .toContain('"observed":"recovered"');
      monitor.tick();
      expect(db.activeMonitorIssue("user:alice",repo,"edge_connector")?.revision).toBe(2);
      edge=false;monitor.tick();monitor.tick();monitor.tick();
      expect(db.activeMonitorIssue("user:alice",repo,"edge_connector")?.revision).toBe(3);
      const exported=db.monitorRecoveryEvents("user:alice",repo,0,25);
      expect(exported.events.map(e=>e.record.revision)).toEqual([1,2,3]);
      expect(exported.events.map(e=>e.expectedRevision)).toEqual([0,1,2]);
      expect(exported.hasMore).toBe(false);
      expect(db.context("user:bob",repo,"MCP runtime signal").records).toHaveLength(0);
      expect(db.context("user:alice",secondRepo,"MCP runtime signal").records).toHaveLength(0);
    } finally{db.close();rmSync(dir,{recursive:true,force:true});}
  });
  it("fails closed without activated ownership and does not fabricate incidents",()=>{
    const dir=mkdtempSync(path.join(os.tmpdir(),"monitor-empty-"));
    mkdirSync(path.join(dir,"release"));
    const db=CentralMemoryStore.open(path.join(dir,"state","memory.sqlite"),path.join(dir,"release"));
    try{
      const monitor=new CentralMemoryOperationalMonitor(db,()=>({
        workspaceBackendReady:false,edgeConnectorReady:false,
      }));
      for(let i=0;i<8;i++)monitor.tick();
      expect(db.activatedScopes()).toEqual([]);
      expect(db.monitorRecoveryEvents("user:alice",repo,0,10).events).toEqual([]);
      expect(()=>db.monitorRecoveryEvents("user:alice",repo,-1,10)).toThrow();
    }finally{db.close();rmSync(dir,{recursive:true,force:true});}
  });
});
