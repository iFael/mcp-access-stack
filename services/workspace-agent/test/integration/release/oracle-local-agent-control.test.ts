import { afterEach,describe,expect,it,jest } from "@jest/globals";
import { InMemoryMutationReceiptStore } from "@vs-code-gpt/shared";
import { LocalAgent } from "../../../src/local-agent.js";
import {createFixture,makeWorkspacePolicy,writePolicy,type Fixture} from "../../support/helpers.js";

const input={
  workspaceId:"mcp-access-stack",runId:"11111111-2222-4333-8444-555555555555",
  operationId:"11111111-2222-4333-8444-555555555556",
  expectedSourceSha:"a".repeat(40),expectedLastSeq:8,
};
let fixture:Fixture|undefined;
afterEach(async()=>{await fixture?.cleanup();fixture=undefined;});
async function agent(authorized:boolean,enrolled:boolean,trusted=true){
  fixture=await createFixture({profile:"full-repo-write"});
  const workspace={...makeWorkspacePolicy(fixture.workspacePath,{
    profile:"full-repo-write",confirmationMode:trusted?"trusted-workspace":"standard",
  }),id:"mcp-access-stack",allowShell:["."]};
  await writePolicy(fixture.policyPath,[workspace]);
  const send=jest.fn(async()=>new Response(JSON.stringify({result:{
    runId:input.runId,lastSeq:9,status:"paused_outcome_unknown",stop:"outcome_unknown",
  }}),{status:200,headers:{"content-type":"application/json"}}));
  const audit=await LocalAgent.create(fixture.policyPath,{
    mutationReceiptStore:new InMemoryMutationReceiptStore(),
    ...(enrolled?{oracleControl:{
      endpoint:"https://mcp-v3-update-control.workers.dev/_internal/oracle-release-advance",
      key:async()=> "c".repeat(64),
      authorize:async()=>authorized,
      fetchImpl:send as unknown as typeof fetch,
    }}:{}),
  });
  return {audit,send};
}
describe("MCP V3 local-agent gated Oracle caller audit",()=>{
  it("refuses enrollment absence, keeping installed default read-only",async()=>{
    const h=await agent(true,false);
    await expect(h.audit.oracleReleaseAdvance(input,{ownerScope:"owner:release-operator"}))
      .rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });
  it("requires trusted workspace plus independent release authorization",async()=>{
    const h=await agent(false,true);
    await expect(h.audit.oracleReleaseAdvance(input,{ownerScope:"owner:release-operator"}))
      .rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });
  it("never mutates when owner scope missing",async()=>{
    const h=await agent(true,true);
    await expect(h.audit.oracleReleaseAdvance(input,{})).rejects.toThrow();
    expect(h.send).not.toHaveBeenCalled();
  });
  it("sends one request and returns persisted observation with strict request fields",async()=>{
    const h=await agent(true,true);
    const first=await h.audit.oracleReleaseAdvance(input,{ownerScope:"owner:release-operator"});
    expect(first.status).toBe("observed");
    expect((await h.audit.oracleReleaseAdvance(input,{ownerScope:"owner:release-operator"})).status)
      .toBe("observed");
    expect(h.send).toHaveBeenCalledTimes(1);
  });
});
