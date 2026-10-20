import {describe,expect,it,jest} from "@jest/globals";
import worker from "../../src/worker.js";
import {verifyOracleCandidateRequest} from "../../src/oracle-candidate-auth.js";
import {
  ORACLE_CANDIDATE_DISPATCH_PATH,ORACLE_CANDIDATE_SCOPE,
  signOracleCandidateRequest,parseOracleCandidateCommand,parseOracleCandidateReceipt,
} from "@mcp-access-stack/update-control-contract";

const key="a".repeat(64),other="b".repeat(64);
const url="https://mcp-v3-update-control.workers.dev"+ORACLE_CANDIDATE_DISPATCH_PATH;
const runId="11111111-2222-4333-8444-555555555555";
const operationId="11111111-2222-4333-8444-555555555556";
const cmd={method:"read_candidate" as const,arguments:{
  tag:"v1.1.0-beta.90",commitSha:"c".repeat(40),runId,operationId,
}};
const receipt={releaseTag:cmd.arguments.tag,sourceCommitSha:cmd.arguments.commitSha,
  manifestSha256:"d".repeat(64),verifiedArtifactCount:5,runId,operationId};
const req=(body:string,authorization:string,path=url)=>new Request(path,{
  method:"POST",headers:{"content-type":"application/json",authorization},body,
});
describe("Dedicated Oracle candidate read-only signed route",()=>{
  it("signs an exact typed request; wrong key, tampering, shared scope and old signatures fail",async()=>{
    const signed=await signOracleCandidateRequest(cmd,key);
    expect(await verifyOracleCandidateRequest(req(signed.body,signed.authorization),key))
      .toEqual(cmd);
    expect(await verifyOracleCandidateRequest(req(signed.body,signed.authorization),other))
      .toBeNull();
    expect(await verifyOracleCandidateRequest(req(JSON.stringify({...cmd,
      arguments:{...cmd.arguments,commitSha:"d".repeat(40)}}),
      signed.authorization),key)).toBeNull();
    expect(await verifyOracleCandidateRequest(req(signed.body,signed.authorization,
      url+"?bypass=1"),key)).toBeNull();
    const expired=await signOracleCandidateRequest(cmd,key,1);
    expect(await verifyOracleCandidateRequest(req(expired.body,expired.authorization),key))
      .toBeNull();
    expect(()=>parseOracleCandidateCommand({method:"run_command",arguments:{}})).toThrow();
    expect(()=>parseOracleCandidateCommand({...cmd,arguments:{
      ...cmd.arguments,path:"../../secrets"}})).toThrow();
    expect(()=>parseOracleCandidateReceipt({...receipt,manifestSha256:"bad"})).toThrow();
  });
  it("routes only to the segregated candidate Durable Object",async()=>{
    const forward=jest.fn(async(_request:Request)=>new Response(JSON.stringify({result:receipt}),{
      status:200,headers:{"content-type":"application/json"},
    }));
    const scopes:string[]=[];
    const env={
      UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_KEY:key,
      UPDATE_CONTROL_ADMIN_HMAC_KEY:other,
      UPDATE_CONTROL_ORACLE_CONTROL_HMAC_KEY:"e".repeat(64),
      UPDATE_CONTROL_ORACLE_CHANNEL:{
        idFromName:(scope:string)=>{scopes.push(scope);return scope;},
        get:()=>({fetch:forward}),
      },
    };
    const signed=await signOracleCandidateRequest(cmd,key);
    const response=await worker.fetch(req(signed.body,signed.authorization),env as never);
    expect(response.status).toBe(200);
    expect(scopes).toEqual([ORACLE_CANDIDATE_SCOPE]);
    expect(await (forward.mock.calls[0]![0] as Request).json()).toEqual(cmd);
  });
  it("rejects HMAC reused with administration or publication before dispatch",async()=>{
    const forward=jest.fn(async()=>new Response("{}"));
    const signed=await signOracleCandidateRequest(cmd,key);
    for(const conflicted of [
      {UPDATE_CONTROL_ADMIN_HMAC_KEY:key},
      {UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_KEY:key},
      {UPDATE_CONTROL_ORACLE_SOURCE_HMAC_KEY:key},
      {UPDATE_CONTROL_ORACLE_CANDIDATE_PROVIDER_TOKEN:key},
    ]){
      const env={UPDATE_CONTROL_ORACLE_CANDIDATE_HMAC_KEY:key,...conflicted,
        UPDATE_CONTROL_ORACLE_CHANNEL:{
          idFromName:()=>ORACLE_CANDIDATE_SCOPE,get:()=>({fetch:forward}),
        }};
      expect((await worker.fetch(req(signed.body,signed.authorization),env as never)).status)
        .toBe(503);
    }
    expect(forward).not.toHaveBeenCalled();
  });
});
