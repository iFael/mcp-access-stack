import {describe,expect,it,jest} from "@jest/globals";
import worker from "../../src/worker.js";
import {verifyWindowsReadRequest} from "../../src/windows-read-auth.js";
import {WINDOWS_READ_DISPATCH_PATH,WINDOWS_READ_CONNECT_PATH,
  WINDOWS_READ_RPC_PATH,WINDOWS_READ_SCOPE,
  ORACLE_ACTIVE_SCOPE,signWindowsReadRequest}
  from "@mcp-access-stack/update-control-contract";
const key="a".repeat(64),foreign="b".repeat(64);
const url="https://mcp-v3-update-control.workers.dev"+WINDOWS_READ_DISPATCH_PATH;
const id="11111111-2222-4333-8444-555555555550";
const command={method:"inspect_candidate" as const,arguments:{
  requestId:id,tag:"v1.1.0-beta.90",commitSha:"c".repeat(40),
  runId:"11111111-2222-4333-8444-555555555551",
  operationId:"11111111-2222-4333-8444-555555555552",
  prepareOperationId:"11111111-2222-4333-8444-555555555553",
}};
const token="windows-provider-separated-token-".padEnd(48,"z");
const valid=(body:string,authorization:string,target=url)=>
  new Request(target,{method:"POST",headers:{
    "content-type":"application/json",authorization},body});
const signed=()=>signWindowsReadRequest(command,key);
describe("independent Windows HMAC verifier",()=>{
  it("accepts typed intent only with dedicated signature and rejects replay and tampering",async()=>{
    const s=await signed();
    expect(await verifyWindowsReadRequest(valid(s.body,s.authorization),key))
      .toEqual(command);
    expect(await verifyWindowsReadRequest(valid(s.body,s.authorization),foreign))
      .toBeNull();
    expect(await verifyWindowsReadRequest(valid(s.body,s.authorization,url+"?debug"),key))
      .toBeNull();
    expect(await verifyWindowsReadRequest(valid(JSON.stringify({...command,
      arguments:{...command.arguments,cmd:"Get-Item C:\\Secret"}}),
      s.authorization),key)).toBeNull();
    const expired=await signWindowsReadRequest(command,key,1);
    expect(await verifyWindowsReadRequest(valid(expired.body,expired.authorization),key))
      .toBeNull();
  });
  it("fails closed before Worker dispatch without both isolated secrets",async()=>{
    const s=await signed();
    const fetch=jest.fn(async()=>new Response("{}"));
    const channel={idFromName:(scope:string)=>scope,get:()=>({fetch})};
    for(const env of [
      {},
      {UPDATE_CONTROL_WINDOWS_READ_HMAC_KEY:key},
      {UPDATE_CONTROL_WINDOWS_READ_PROVIDER_TOKEN:token},
      {UPDATE_CONTROL_WINDOWS_READ_HMAC_KEY:key,UPDATE_CONTROL_WINDOWS_READ_PROVIDER_TOKEN:key},
      {UPDATE_CONTROL_WINDOWS_READ_HMAC_KEY:key,
        UPDATE_CONTROL_WINDOWS_READ_PROVIDER_TOKEN:token,
        UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_KEY:key},
      {UPDATE_CONTROL_WINDOWS_READ_HMAC_KEY:key,
        UPDATE_CONTROL_WINDOWS_READ_PROVIDER_TOKEN:token,
        UPDATE_CONTROL_ORACLE_ACTIVE_PROVIDER_TOKEN:token},
    ]){
      const result=await worker.fetch(valid(s.body,s.authorization),
        {...env,UPDATE_CONTROL_ORACLE_CHANNEL:channel} as never);
      expect(result.status).toBe(503);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it("dispatches only to Windows scope, with no mutation and bounded response",async()=>{
    const s=await signed();
    const scopes:string[]=[];
    const forwarded:Request[]=[];
    const responseResult={method:"get_state",requestId:id,
      scope:"local_hash_integrity_only",
      state:{active:null,previous:null,candidate:null}};
    const env={
      UPDATE_CONTROL_WINDOWS_READ_HMAC_KEY:key,
      UPDATE_CONTROL_WINDOWS_READ_PROVIDER_TOKEN:token,
      UPDATE_CONTROL_ORACLE_CHANNEL:{
        idFromName:(name:string)=>{scopes.push(name);return name;},
        get:()=>({fetch:async(r:Request)=>{
          forwarded.push(r);
          return new Response(JSON.stringify({result:responseResult}),{
            headers:{"content-type":"application/json"}});
        }}),
      },
    };
    const result=await worker.fetch(valid(s.body,s.authorization),env as never);
    expect(result.status).toBe(200);
    expect(scopes).toEqual([WINDOWS_READ_SCOPE]);
    expect(scopes).not.toContain(ORACLE_ACTIVE_SCOPE);
    expect(forwarded).toHaveLength(1);
    expect(new URL(forwarded[0]!.url).pathname).toBe(WINDOWS_READ_RPC_PATH);
    expect((await forwarded[0]!.json() as unknown)).toEqual(command);
    const malformed=await worker.fetch(valid(s.body,s.authorization,url+"#x"),env as never);
    expect(malformed.status).toBe(401);
    expect(forwarded).toHaveLength(1);
  });
  it("requires Windows bearer enrollment before opening the WSS route",async()=>{
    const tracked=jest.fn(async()=>new Response(null,{status:200}));
    const env={UPDATE_CONTROL_WINDOWS_READ_PROVIDER_TOKEN:token,
      UPDATE_CONTROL_WINDOWS_READ_HMAC_KEY:key,
      UPDATE_CONTROL_ORACLE_CHANNEL:{idFromName:(scope:string)=>scope,
        get:()=>({fetch:tracked})}};
    const r=await worker.fetch(new Request(
      "https://mcp-v3-update-control.workers.dev"+WINDOWS_READ_CONNECT_PATH,{
        method:"GET",headers:{upgrade:"websocket",
          origin:"https://mcp-v3-windows-read-provider.invalid",
          authorization:"Bearer "+token},
      }),env as never);
    expect(r.status).toBe(200);
    expect(tracked).toHaveBeenCalledTimes(1);
  });
});
