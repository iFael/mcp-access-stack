import {describe,expect,it,jest} from "@jest/globals";
import worker from "../../src/worker.js";
import {verifyOracleSourceRequest} from "../../src/oracle-source-auth.js";
import {
  ORACLE_SOURCE_DISPATCH_PATH,ORACLE_SOURCE_SCOPE,
  signOracleSourceRequest,parseOracleSourceCommand,parseOracleSourceResult,
} from "@mcp-access-stack/update-control-contract";
const key="a".repeat(64),other="b".repeat(64);
const url="https://mcp-v3-update-control.workers.dev"+ORACLE_SOURCE_DISPATCH_PATH;
const cmd={method:"read_commit_checks" as const,arguments:{commitSha:"c".repeat(40)}};
const req=(body:string,authorization:string,path=url)=>new Request(path,{
  method:"POST",headers:{"content-type":"application/json",authorization},body,
});
describe("Oracle source read-only signed Worker route",()=>{
  it("signs fixed command and fails on tampered body, wrong key or expired signature",async()=>{
    const signed=await signOracleSourceRequest(cmd,key);
    expect(await verifyOracleSourceRequest(req(signed.body,signed.authorization),key)).toEqual(cmd);
    expect(await verifyOracleSourceRequest(req(signed.body,signed.authorization),other)).toBeNull();
    expect(await verifyOracleSourceRequest(req(JSON.stringify({...cmd,arguments:{commitSha:"d".repeat(40)}}),signed.authorization),key)).toBeNull();
    expect(await verifyOracleSourceRequest(req(signed.body,signed.authorization,url+"?bypass=1"),key)).toBeNull();
    const old=await signOracleSourceRequest(cmd,key,1);
    expect(await verifyOracleSourceRequest(req(old.body,old.authorization),key)).toBeNull();
    expect(()=>parseOracleSourceCommand({method:"run_command",arguments:{}})).toThrow();
    expect(()=>parseOracleSourceResult("read_main_head","wrong")).toThrow();
  });
  it("routes validated read only to the dedicated Durable Object",async()=>{
    const fetch=jest.fn(async(_request:Request)=>new Response(JSON.stringify({result:"c".repeat(40)}),{
      status:200,headers:{"content-type":"application/json"},
    }));
    const scopes:string[]=[];
    const env={
      UPDATE_CONTROL_ORACLE_SOURCE_HMAC_KEY:key,
      UPDATE_CONTROL_ADMIN_HMAC_KEY:other,
      UPDATE_CONTROL_ORACLE_CONTROL_HMAC_KEY:"d".repeat(64),
      UPDATE_CONTROL_ORACLE_CHANNEL:{
        idFromName:(scope:string)=>{scopes.push(scope);return scope;},
        get:()=>({fetch}),
      },
    };
    const signed=await signOracleSourceRequest({method:"read_main_head",arguments:{}},key);
    const result=await worker.fetch(req(signed.body,signed.authorization),env as never);
    expect(result.status).toBe(200);
    expect(scopes).toEqual([ORACLE_SOURCE_SCOPE]);
    const forwarded=fetch.mock.calls[0]![0] as Request;
    expect(await forwarded.json()).toEqual({method:"read_main_head",arguments:{}});
  });
  it("rejects any shared admin/control HMAC before DO dispatch",async()=>{
    const fetch=jest.fn(async()=>new Response("{}"));
    const signed=await signOracleSourceRequest(cmd,key);
    const env={
      UPDATE_CONTROL_ORACLE_SOURCE_HMAC_KEY:key,
      UPDATE_CONTROL_ADMIN_HMAC_KEY:key,
      UPDATE_CONTROL_ORACLE_CHANNEL:{idFromName:()=>ORACLE_SOURCE_SCOPE,get:()=>({fetch})},
    };
    expect((await worker.fetch(req(signed.body,signed.authorization),env as never)).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });
});
