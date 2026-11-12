import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
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
    expect(created.isError).toBeFalsy();
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
