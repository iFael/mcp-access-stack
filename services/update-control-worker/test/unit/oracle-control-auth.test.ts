import {describe,expect,it,jest} from "@jest/globals";
import updateControlWorker from "../../src/worker.js";
import {signOracleControlRequest,verifyOracleControlRequest} from "../../src/oracle-control-auth.js";
import {
  ORACLE_CONTROL_DISPATCH_PATH,ORACLE_CONTROL_CONNECT_PATH,ORACLE_CONTROL_RPC_PATH,
  ORACLE_CONTROL_SCOPE,parseOracleControlAdvance,
} from "@mcp-access-stack/update-control-contract";

const key="a".repeat(64),other="b".repeat(64);
const input={
  runId:"11111111-2222-4333-8444-555555555555",
  expectedSourceSha:"c".repeat(40),expectedLastSeq:8,
  operationId:"11111111-2222-4333-8444-555555555556",
};
const url="https://mcp-v3-update-control.workers.dev"+ORACLE_CONTROL_DISPATCH_PATH;
const channelFetch=jest.fn(async (_request:Request)=>new Response(JSON.stringify({result:{
  runId:input.runId,lastSeq:9,status:"paused_outcome_unknown",stop:"outcome_unknown",
}}),{status:200,headers:{"content-type":"application/json"}}));
function request(body:string,authorization:string,path=url,method="POST"):Request{
  return new Request(path,{method,headers:{"content-type":"application/json",authorization},...(method==="GET"?{}:{body})});
}
describe("isolated Oracle release control signature and routing",()=>{
  it("binds HMAC to body, UUID, SHA, sequence and exact method/path",async()=>{
    const signed=await signOracleControlRequest(input,key);
    expect((await verifyOracleControlRequest(request(signed.body,signed.authorization),key))?.input)
      .toEqual(input);
    const mutation=JSON.stringify({...input,expectedLastSeq:9});
    expect(await verifyOracleControlRequest(request(mutation,signed.authorization),key)).toBeNull();
    expect(await verifyOracleControlRequest(request(signed.body,signed.authorization),other)).toBeNull();
    expect(await verifyOracleControlRequest(request(signed.body,signed.authorization,url+"?debug=1"),key)).toBeNull();
    expect(await verifyOracleControlRequest(request(signed.body,signed.authorization,url,"GET"),key)).toBeNull();
    expect(await verifyOracleControlRequest(request(signed.body,signed.authorization.replace("v2=","v1=")),key)).toBeNull();
    const stale=await signOracleControlRequest(input,key,1);
    expect(await verifyOracleControlRequest(request(stale.body,stale.authorization),key)).toBeNull();
  });
  it("rejects unexpected arguments and forbids dynamic workflow/tool names",()=>{
    expect(()=>parseOracleControlAdvance({...input,command:"shell"})).toThrow();
    expect(()=>parseOracleControlAdvance({...input,expectedSourceSha:"a"})).toThrow();
    expect(()=>parseOracleControlAdvance({...input,expectedLastSeq:-1})).toThrow();
  });
  it("routes only dedicated service-authenticated advance to the isolated DO scope",async()=>{
    channelFetch.mockClear();
    const scopes:string[]=[];
    const env={
      UPDATE_CONTROL_ORACLE_CONTROL_HMAC_KEY:key,
      UPDATE_CONTROL_ADMIN_HMAC_KEY:other,
      UPDATE_CONTROL_ORACLE_CHANNEL:{
        idFromName:(scope:string)=>{scopes.push(scope);return scope;},
        get:(_id:unknown)=>({fetch:channelFetch}),
      },
    };
    const signed=await signOracleControlRequest(input,key);
    const response=await updateControlWorker.fetch(request(signed.body,signed.authorization),env as never);
    expect(response.status).toBe(200);
    expect(scopes).toEqual([ORACLE_CONTROL_SCOPE]);
    const forwarded=channelFetch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe(ORACLE_CONTROL_RPC_PATH);
    expect(await forwarded.json()).toEqual({
      method:"advance_release",arguments:input,
      principal:{workspaceId:"mcp-access-stack",authenticatedActorId:"mcp:v3-release-control",
        ownerScope:"trusted:release-operator"},
    });
  });
  it("never accepts read or administrative credentials as mutating authorization",async()=>{
    channelFetch.mockClear();
    const signed=await signOracleControlRequest(input,key);
    const fake={
      UPDATE_CONTROL_ORACLE_CONTROL_HMAC_KEY:other,
      UPDATE_CONTROL_ADMIN_HMAC_KEY:key,
      UPDATE_CONTROL_ORACLE_CHANNEL:{idFromName:()=>ORACLE_CONTROL_SCOPE,get:()=>({fetch:channelFetch})},
    };
    expect((await updateControlWorker.fetch(request(signed.body,signed.authorization),fake as never)).status)
      .toBe(401);
    expect(channelFetch).not.toHaveBeenCalled();
  });
  it("control handshake and RPC are distinct from existing read routes",()=>{
    expect(ORACLE_CONTROL_CONNECT_PATH).not.toBe("/_internal/oracle-channel");
    expect(ORACLE_CONTROL_RPC_PATH).not.toBe("/_internal/rpc");
    expect(ORACLE_CONTROL_SCOPE).not.toBe("oracle-release-orchestrator-v1");
  });
});
