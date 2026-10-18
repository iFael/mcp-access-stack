import {describe,expect,it,jest} from "@jest/globals";
import worker from "../../src/worker.js";
import {verifyOracleActiveRequest} from "../../src/oracle-active-auth.js";
import {ORACLE_ACTIVE_DISPATCH_PATH,ORACLE_ACTIVE_SCOPE,
  ORACLE_CANDIDATE_SCOPE,parseOracleActiveCommand,parseOracleActiveResult,
  signOracleActiveRequest} from "@mcp-access-stack/update-control-contract";

const key="a".repeat(64),foreign="b".repeat(64);
const url="https://mcp-v3-update-control.workers.dev"+ORACLE_ACTIVE_DISPATCH_PATH;
const requestId="11111111-2222-4333-8444-555555555550";
const cmd={method:"inspect_active" as const,arguments:{
  tag:"v1.1.0-beta.90",commitSha:"c".repeat(40),requestId,
}};
const stateCmd={method:"get_state" as const,arguments:{requestId}};
const healthCmd={method:"get_health" as const,arguments:{requestId}};
const manifest={releaseTag:cmd.arguments.tag,sourceCommitSha:cmd.arguments.commitSha,
  manifestSha256:"d".repeat(64),verifiedArtifactCount:7};
const receipt={method:"inspect_active",requestId,manifest};
const state={active:{releaseId:"1.1.0-beta.90",manifestSha256:"d".repeat(64)},
  previous:{releaseId:"1.1.0-beta.89",manifestSha256:"e".repeat(64)},candidate:null};
const health={status:"healthy",releaseId:"1.1.0-beta.90",manifestSha256:"d".repeat(64),
  processId:1234,observedAt:"2026-10-18T04:00:00.000Z"};
const req=(body:string,authorization:string,path=url)=>new Request(path,{
  method:"POST",headers:{"content-type":"application/json",authorization},body,
});
describe("isolated Oracle ACTIVE signed read-only realm",()=>{
  it("signs only typed manifest/state reads and rejects tampering, replay and paths",async()=>{
    for(const command of [cmd,stateCmd,healthCmd]){
      const signed=await signOracleActiveRequest(command,key);
      expect(await verifyOracleActiveRequest(req(signed.body,signed.authorization),key))
        .toEqual(command);
      expect(await verifyOracleActiveRequest(req(signed.body,signed.authorization),foreign))
        .toBeNull();
      expect(await verifyOracleActiveRequest(req(signed.body,signed.authorization,
        url+"?debug=1"),key)).toBeNull();
      expect(await verifyOracleActiveRequest(req(JSON.stringify({...command,
        arguments:{...command.arguments,path:"../secret"}}),
        signed.authorization),key)).toBeNull();
      const expired=await signOracleActiveRequest(command,key,1);
      expect(await verifyOracleActiveRequest(req(expired.body,expired.authorization),key))
        .toBeNull();
    }
    expect(()=>parseOracleActiveCommand({method:"run_command",arguments:{}})).toThrow();
    expect(()=>parseOracleActiveCommand({...stateCmd,
      arguments:{...stateCmd.arguments,operation:"promote"}})).toThrow();
    expect(()=>parseOracleActiveCommand({...healthCmd,
      arguments:{...healthCmd.arguments,pid:1234}})).toThrow();
    expect(()=>parseOracleActiveCommand({...cmd,
      arguments:{...cmd.arguments,path:"/etc/shadow"}})).toThrow();
  });
  it("rejects forged state and manifest with extra fields or conflicting slots",()=>{
    expect(parseOracleActiveResult("inspect_active",receipt)).toEqual(receipt);
    expect(parseOracleActiveResult("get_state",
      {method:"get_state",requestId,state})).toMatchObject({state});
    expect(()=>parseOracleActiveResult("inspect_active",{...receipt,
      manifest:{...manifest,artifactBytes:"secret"}})).toThrow();
    expect(()=>parseOracleActiveResult("get_state",{method:"get_state",requestId,
      state:{...state,previous:{...state.active}}})).toThrow();
    expect(()=>parseOracleActiveResult("get_state",{method:"get_state",requestId,
      state:{...state,active:{...state.active,materializedAt:"2026"}}})).toThrow();
    expect(()=>parseOracleActiveResult("get_state",{method:"get_state",requestId,
      state:{...state,candidate:{releaseId:"../../secret",manifestSha256:"e".repeat(64)}}})).toThrow();
    expect(parseOracleActiveResult("get_health",{method:"get_health",requestId,health}))
      .toMatchObject({health});
    expect(()=>parseOracleActiveResult("get_health",{method:"get_health",requestId,
      health:{...health,processId:0}})).toThrow();
    expect(()=>parseOracleActiveResult("get_health",{method:"get_health",requestId,
      health:{...health,callerPath:"/etc/shadow"}})).toThrow();
  });
  it("routes only to active DO, never candidate or control",async()=>{
    const forwarded:Request[]=[];
    const scopeNames:string[]=[];
    const env={UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_KEY:key,
      UPDATE_CONTROL_ADMIN_HMAC_KEY:foreign,
      UPDATE_CONTROL_ORACLE_CHANNEL:{
        idFromName:(name:string)=>{scopeNames.push(name);return name;},
        get:()=>({fetch:async(input:Request)=>{
          forwarded.push(input);
          const parsed=await input.json() as {method:string};
          const result=parsed.method==="inspect_active"?receipt:
            parsed.method==="get_state"?{method:"get_state",requestId,state}:
            {method:"get_health",requestId,health};
          return new Response(JSON.stringify({result}),
            {status:200,headers:{"content-type":"application/json"}});
        }}),
      }};
    for(const command of [cmd,stateCmd,healthCmd]){
      const signed=await signOracleActiveRequest(command,key);
      const result=await worker.fetch(req(signed.body,signed.authorization),
        env as never);
      expect(result.status).toBe(200);
    }
    expect(scopeNames).toEqual([ORACLE_ACTIVE_SCOPE,ORACLE_ACTIVE_SCOPE,ORACLE_ACTIVE_SCOPE]);
    expect(scopeNames).not.toContain(ORACLE_CANDIDATE_SCOPE);
    expect(forwarded).toHaveLength(3);
  });
  it("rejects key reuse across candidate and administrative realms before DO dispatch",async()=>{
    const signed=await signOracleActiveRequest(cmd,key);
    const forward=jest.fn(async()=>new Response(JSON.stringify({result:receipt}),{
      headers:{"content-type":"application/json"}}));
    for(const conflict of [
      {UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_KEY:key},
      {UPDATE_CONTROL_ORACLE_CANDIDATE_PROVIDER_TOKEN:key},
      {UPDATE_CONTROL_ORACLE_CONTROL_HMAC_KEY:key},
      {UPDATE_CONTROL_ADMIN_HMAC_KEY:key},
      {UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_KEY:key},
    ]){
      const env={UPDATE_CONTROL_ORACLE_ACTIVE_HMAC_KEY:key,...conflict,
        UPDATE_CONTROL_ORACLE_CHANNEL:{
          idFromName:()=>ORACLE_ACTIVE_SCOPE,get:()=>({fetch:forward}),
        }};
      expect((await worker.fetch(req(signed.body,signed.authorization),
        env as never)).status).toBe(503);
    }
    expect(forward).not.toHaveBeenCalled();
  });
});
