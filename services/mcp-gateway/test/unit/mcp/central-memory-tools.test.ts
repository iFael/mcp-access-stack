import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SourceControlExecutor, WorkspaceExecutor } from "@vs-code-gpt/shared";
import { createMcpServer } from "../../../src/mcp/server.js";
import { CentralMemoryStore } from "../../../src/memory/central-memory.js";

const repo="repo_a3c7aaa6-9fb9-4d06-ba79-29f3c4cf1767";
const cleanup: Array<() => Promise<void>|void> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(ownerScope?:string, available=true) {
  const root=mkdtempSync(path.join(os.tmpdir(),"memory-mcp-"));
  const releaseRoot=path.join(root,"releases");
  mkdirSync(releaseRoot);
  const store=CentralMemoryStore.open(path.join(root,"state","memory.sqlite"),releaseRoot);
  const server=createMcpServer({
    workspaceExecutor:{} as WorkspaceExecutor,
    sourceControlExecutor:{} as SourceControlExecutor,
    ...(available?{memoryStore:store}:{}),
    operationContextFactory:(_extra,_timeout) => ({
      context:{...(ownerScope===undefined?{}:{ownerScope})},release:()=>undefined,
    }),
  });
  const client=new Client({name:"memory-test",version:"1.0.0"},{capabilities:{}});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport),client.connect(clientTransport)]);
  cleanup.push(async()=>{await client.close();await server.close();store.close();rmSync(root,{recursive:true,force:true});});
  return client;
}
const updateArgs={
  workspaceId:"mcp-access-stack",repositoryId:repo,
  operationId:"operation:one",recordId:"decision:one",expectedRevision:0,action:"create",
  kind:"decision",confidence:"user_reported",title:"Single authority",
  content:"Use one operational memory in Oracle",evidenceRefs:["user:confirmed"],
};
describe("public central-memory tools",()=>{
  it("reads and writes through the authenticated MCP tool context",async()=>{
    const client=await fixture("user:alice");
    const list=await client.listTools();
    expect(list.tools.map(tool=>tool.name)).toContain("memory_context");
    expect(list.tools.map(tool=>tool.name)).toContain("memory_update");
    const created=await client.callTool({name:"memory_update",arguments:updateArgs});
    if(created.isError) throw new Error(JSON.stringify(created));
    expect(created.structuredContent).toMatchObject({record:{revision:1,kind:"decision"},replayed:false});
    const replay=await client.callTool({name:"memory_update",arguments:updateArgs});
    expect(replay.structuredContent).toMatchObject({record:{revision:1},replayed:true});
    const context=await client.callTool({
      name:"memory_context",arguments:{workspaceId:"mcp-access-stack",repositoryId:repo},
    });
    expect(context.structuredContent).toMatchObject({totalActive:1,records:[{title:"Single authority"}]});
    const history=await client.callTool({
      name:"memory_context",arguments:{workspaceId:"mcp-access-stack",repositoryId:repo,historyRecordId:"decision:one"},
    });
    expect(history.structuredContent).toMatchObject({history:[{revision:1}]});
  });
  it("imports all twelve legacy sources through MCP exactly once",async()=>{
    const client=await fixture("user:alice");
    const docs=(["oracle","windows"] as const).flatMap(surface=>
      ["CURRENT_TASK.md","DECISIONS.md","HANDOFF.md","KNOWN_ISSUES.md",
       "NEXT_STEPS.md","PROJECT_CONTEXT.md"].map(filename=>{
        const content=surface+":"+filename+"\nlegacy source preserved\n";
        return {surface,filename,content,contentSha256:
          createHash("sha256").update(content).digest("hex")};
      }));
    const args={workspaceId:"mcp-access-stack",repositoryId:repo,
      operationId:"operation:legacy:1",action:"import_legacy",documents:docs};
    const first=await client.callTool({name:"memory_update",arguments:args});
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({filesImported:12,replayed:false});
    const replay=await client.callTool({name:"memory_update",arguments:args});
    expect(replay.structuredContent).toMatchObject({filesImported:12,replayed:true});
    const invalid=await client.callTool({name:"memory_update",arguments:{
      ...args,recordId:"fake-record",
    }});
    expect(invalid.isError).toBe(true);
    const context=await client.callTool({
      name:"memory_context",arguments:{workspaceId:"mcp-access-stack",repositoryId:repo},
    });
    expect(context.structuredContent).toMatchObject({totalActive:0,records:[]});
    const found=await client.callTool({name:"memory_context",arguments:{
      workspaceId:"mcp-access-stack",repositoryId:repo,query:"legacy source preserved",
    }});
    const matches=(found.structuredContent as {archiveMatches:Array<{surface:string;filename:string}>})
      .archiveMatches;
    expect(matches).toHaveLength(12);
    expect(matches).toEqual(expect.arrayContaining([
      expect.objectContaining({surface:"oracle",filename:"DECISIONS.md"}),
      expect.objectContaining({surface:"windows",filename:"DECISIONS.md"}),
    ]));
    const excerpt=await client.callTool({
      name:"memory_context",arguments:{workspaceId:"mcp-access-stack",repositoryId:repo,
        legacySource:{surface:"oracle",filename:"DECISIONS.md",offset:7,maxChars:15}},
    });
    expect(excerpt.isError).toBeFalsy();
    expect(excerpt.structuredContent).toMatchObject({legacyExcerpt:{
      offset:7,totalChars:docs.find(x=>x.surface==="oracle"&&x.filename==="DECISIONS.md")!.content.length,
      truncated:true,sourceSha256:docs.find(x=>x.surface==="oracle"&&x.filename==="DECISIONS.md")!.contentSha256,
    }});
    const expected=docs.find(x=>x.surface==="oracle"&&x.filename==="DECISIONS.md")!.content;
    expect((excerpt.structuredContent as {legacyExcerpt:{text:string}}).legacyExcerpt.text)
      .toBe(expected.slice(7,22));
  });
  it("fails closed without trusted identity or without Oracle memory",async()=>{
    for(const [user,available] of [[undefined,true],["user:alice",false]] as const){
      const client=await fixture(user,available);
      const result=await client.callTool({name:"memory_update",arguments:updateArgs});
      expect(result.isError).toBe(true);
      expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({
        text: available?"MEMORY_IDENTITY_REQUIRED":"MEMORY_UNAVAILABLE",
      })]));
    }
  });
  it("cannot select another runtime through the tool arguments",async()=>{
    const client=await fixture("user:alice");
    const result=await client.callTool({name:"memory_context",arguments:{
      workspaceId:"recontei-app",repositoryId:repo,
    }});
    expect(result.isError).toBe(true);
  });
});
