import { describe,expect,it,jest } from "@jest/globals";
import { InMemoryMutationReceiptStore } from "@vs-code-gpt/shared";
import { OracleControlCaller } from "../../../src/release/oracle-control-caller.js";

const input={
  workspaceId:"mcp-access-stack",
  runId:"11111111-2222-4333-8444-555555555555",
  operationId:"11111111-2222-4333-8444-555555555556",
  expectedSourceSha:"a".repeat(40),expectedLastSeq:8,
};
const endpoint="https://mcp-v3-update-control.workers.dev/_internal/oracle-release-advance";
const context={ownerScope:"owner:release-operator"};
const proof={runId:input.runId,lastSeq:9,status:"paused_outcome_unknown",stop:"outcome_unknown"};
const good=()=>new Response(JSON.stringify({result:proof}),{
  status:200,headers:{"content-type":"application/json"},
});
const binding=(fetchImpl:typeof fetch,authorized=true)=>({
  endpoint,authorize:async()=>authorized,key:async()=> "c".repeat(64),fetchImpl,
});
describe("MCP V3 Oracle control one-shot caller",()=>{
  it("sends one authenticated fixed POST and replays only the persisted observation",async()=>{
    const requests:Array<Request>=[];
    const fetchImpl=jest.fn(async(url:string|URL|Request,options?:RequestInit)=>{
      requests.push(new Request(url,options));return good();
    }) as unknown as typeof fetch;
    const caller=new OracleControlCaller(binding(fetchImpl));
    const store=new InMemoryMutationReceiptStore();
    const first=await caller.advance(input,store,context);
    expect(first).toEqual({status:"observed",operationId:input.operationId,result:proof});
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(endpoint);
    expect(requests[0]!.method).toBe("POST");
    expect(requests[0]!.headers.get("authorization")).toMatch(/^HMAC-SHA256 v2=/u);
    expect(await requests[0]!.json()).toEqual({
      runId:input.runId,operationId:input.operationId,
      expectedSourceSha:input.expectedSourceSha,expectedLastSeq:8,
    });
    const again=await caller.advance(input,store,context);
    expect(again).toEqual(first);
    expect(requests).toHaveLength(1);
  });
  it("marks ambiguous status terminal for this operation and never dispatches twice",async()=>{
    let count=0;
    const caller=new OracleControlCaller(binding(async()=>{
      count++;throw new Error("TRANSPORT_DISCONNECTED");
    }));
    const store=new InMemoryMutationReceiptStore();
    expect((await caller.advance(input,store,context)).status).toBe("outcome_unknown");
    expect((await caller.advance(input,store,context)).status).toBe("outcome_unknown");
    expect(count).toBe(1);
    const receipt=await store.get("oracle-control:mcp-access-stack:"+input.operationId);
    expect(receipt?.state).toBe("reconciliation_required");
  });
  it("rejects conflicting same UUID and altered release state without another POST",async()=>{
    let calls=0;
    const caller=new OracleControlCaller(binding(async()=>{calls++;return good();}));
    const store=new InMemoryMutationReceiptStore();
    await caller.advance(input,store,context);
    await expect(caller.advance({...input,expectedLastSeq:9},store,context)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("requires independent policy and a valid credential, without reserving a receipt",async()=>{
    const fetchImpl=jest.fn(async()=>good()) as unknown as typeof fetch;
    const caller=new OracleControlCaller(binding(fetchImpl,false));
    const store=new InMemoryMutationReceiptStore();
    await expect(caller.advance(input,store,context)).rejects.toThrow("not authorized");
    expect(await store.get("oracle-control:mcp-access-stack:"+input.operationId)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("does not reserve a one-shot operation when its credential is unavailable",async()=>{
    const store=new InMemoryMutationReceiptStore();
    const caller=new OracleControlCaller({...binding(async()=>good()),key:async()=> "invalid"});
    await expect(caller.advance(input,store,context)).rejects.toThrow("credential is unavailable");
    expect(await store.get("oracle-control:mcp-access-stack:"+input.operationId)).toBeUndefined();
  });
  it("does not accept a JSON response claiming an unrelated run or oversized body",async()=>{
    const wrong=new OracleControlCaller(binding(async()=>new Response(
      JSON.stringify({result:{...proof,runId:"11111111-2222-4333-8444-555555555557"}}),
      {status:200,headers:{"content-type":"application/json"}})));
    const store=new InMemoryMutationReceiptStore();
    expect((await wrong.advance(input,store,context)).status).toBe("outcome_unknown");
    const oversized=new OracleControlCaller(binding(async()=>new Response("x".repeat(5000),{
      status:200,headers:{"content-type":"application/json"},
    })));
    expect((await oversized.advance({...input,operationId:"11111111-2222-4333-8444-555555555558"},
      store,context)).status).toBe("outcome_unknown");
  });
  it("rejects any non-allowlisted network endpoint on construction",()=>{
    expect(()=>new OracleControlCaller({...binding(async()=>good()),
      endpoint:"http://127.0.0.1/_internal/oracle-release-advance"})).toThrow();
    expect(()=>new OracleControlCaller({...binding(async()=>good()),
      endpoint:"https://untrusted.example/_internal/oracle-release-advance"})).toThrow();
  });
});
