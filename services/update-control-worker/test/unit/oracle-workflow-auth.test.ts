import {describe,expect,it,jest} from "@jest/globals";
import {
  ORACLE_WORKFLOW_DISPATCH_PATH,ORACLE_WORKFLOW_SCOPE,
  parseOracleWorkflowCommand,parseOracleWorkflowResult,
  signOracleWorkflowRequest,
} from "@mcp-access-stack/update-control-contract";
import {verifyOracleWorkflowRequest} from "../../src/oracle-workflow-auth.js";
import worker from "../../src/worker.js";

const sha="a".repeat(40),key="b".repeat(64),other="c".repeat(64);
const id="11111111-2222-4333-8444-555555555555";
const command={method:"workflow_operation" as const,arguments:{
  workflow:"release-tag-bootstrap.yml" as const,mode:"dispatch" as const,
  tag:"v1.1.0-beta.90",expectedMainSha:sha,operationId:id,
}};
const url="https://mcp-v3-update-control.workers.dev"+ORACLE_WORKFLOW_DISPATCH_PATH;
const request=(body:string,auth:string,location=url)=>new Request(location,{
  method:"POST",headers:{"content-type":"application/json","authorization":auth},body,
});
describe("separate authenticated Oracle release workflow transport",()=>{
  it("uses a fixed wire schema, with no repository, shell or ownerScope sent by Oracle",()=>{
    expect(parseOracleWorkflowCommand(command)).toEqual(command);
    expect(ORACLE_WORKFLOW_SCOPE).not.toBe("oracle-source-provider-v1");
    for(const bad of [
      {...command,arguments:{...command.arguments,owner:"spoof"}},
      {...command,arguments:{...command.arguments,workflow:"custom.yml"}},
      {...command,arguments:{...command.arguments,expectedMainSha:"wrong"}},
      {...command,arguments:{...command.arguments,operationId:"wrong"}},
      {method:"execute_shell",arguments:{}},
      {method:"verify_lightweight_tag",arguments:{tag:"v1.0.0-oracle.1",commitSha:sha}},
      {method:"verify_lightweight_tag",arguments:{tag:"v1.1.0-beta.90",commitSha:sha,workspaceId:"other"}},
    ]) expect(()=>parseOracleWorkflowCommand(bad)).toThrow();
    expect(()=>parseOracleWorkflowCommand({...command,arguments:{
      ...command.arguments,workflow:"release.yml",
    }})).toThrow();
    expect(parseOracleWorkflowCommand({method:"workflow_operation",arguments:{
      ...command.arguments,workflow:"release.yml",bootstrapOperationId:id,
    }})).toMatchObject({method:"workflow_operation"});
  });
  it("validates run identity, terminal status and strict result shape",()=>{
    const success={status:"observed",operationId:id,runId:12,state:"completed",conclusion:"success"};
    expect(parseOracleWorkflowResult("workflow_operation",success)).toEqual(success);
    expect(parseOracleWorkflowResult("verify_lightweight_tag",false)).toBe(false);
    const proof={sourceCommitSha:sha,releaseTag:"v1.1.0-beta.90",workflowRunId:12,
      integrityVerified:true,releasePublished:true,verifiedAssetCount:5,
      assetInventorySha256:"c".repeat(64)};
    expect(parseOracleWorkflowCommand({method:"inspect_distribution",
      arguments:{runId:12,tag:proof.releaseTag,commitSha:sha}})).toMatchObject({
      method:"inspect_distribution"});
    expect(parseOracleWorkflowResult("inspect_distribution",proof)).toEqual(proof);
    expect(()=>parseOracleWorkflowResult("inspect_distribution",
      {...proof,verifiedAssetCount:4})).toThrow();
    expect(()=>parseOracleWorkflowResult("inspect_distribution",
      {...proof,releasePublished:false})).toThrow();
    for(const bad of [
      {...success,operationId:"wrong"},
      {...success,runId:0},
      {...success,state:"queued",conclusion:"success"},
      {...success,state:"completed",conclusion:null},
      {...success,extra:true},
    ]) expect(()=>parseOracleWorkflowResult("workflow_operation",bad)).toThrow();
  });
  it("routes only verified requests through the workflow-specific Durable Object scope",async()=>{
    const scopes:string[]=[];
    const dispatch=jest.fn(async(_request:Request)=>new Response(JSON.stringify({
      result:{status:"outcome_unknown",operationId:id},
    }),{status:200,headers:{"content-type":"application/json"}}));
    const env={
      UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_KEY:key,
      UPDATE_CONTROL_ORACLE_WORKFLOW_PROVIDER_TOKEN:"w".repeat(48),
      UPDATE_CONTROL_ORACLE_SOURCE_HMAC_KEY:other,
      UPDATE_CONTROL_ADMIN_HMAC_KEY:"d".repeat(64),
      UPDATE_CONTROL_ORACLE_CONTROL_HMAC_KEY:"e".repeat(64),
      UPDATE_CONTROL_ORACLE_CHANNEL:{idFromName:(scope:string)=>{scopes.push(scope);return scope;},
        get:()=>({fetch:dispatch})},
    };
    const signed=await signOracleWorkflowRequest(command,key);
    const result=await worker.fetch(request(signed.body,signed.authorization),env as never);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({result:{status:"outcome_unknown",operationId:id}});
    expect(scopes).toEqual([ORACLE_WORKFLOW_SCOPE]);
    const forwarded=dispatch.mock.calls[0]![0] as Request;
    expect(new URL(forwarded.url).pathname).toBe("/_internal/oracle-workflow-rpc");
    expect(await forwarded.json()).toEqual(command);
    const spoofed=await worker.fetch(request(signed.body,signed.authorization),{
      ...env,UPDATE_CONTROL_ORACLE_WORKFLOW_HMAC_KEY:other,
      UPDATE_CONTROL_ORACLE_SOURCE_HMAC_KEY:other,
    } as never);
    expect(spoofed.status).toBe(503);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("verifies domain-separated HMAC and rejects tamper, query, expired and wrong key",async()=>{
    const signed=await signOracleWorkflowRequest(command,key);
    expect(signed.authorization).toMatch(/^HMAC-SHA256 workflow-v1=/u);
    expect(await verifyOracleWorkflowRequest(request(signed.body,signed.authorization),key))
      .toEqual(command);
    expect(await verifyOracleWorkflowRequest(request(signed.body,signed.authorization),other))
      .toBeNull();
    expect(await verifyOracleWorkflowRequest(request(signed.body,signed.authorization,url+"?spoof=1"),key))
      .toBeNull();
    const modified=JSON.stringify({method:"verify_lightweight_tag",arguments:{
      tag:"v1.1.0-beta.90",commitSha:sha,
    }});
    expect(await verifyOracleWorkflowRequest(request(modified,signed.authorization),key))
      .toBeNull();
    const expired=await signOracleWorkflowRequest(command,key,1);
    expect(await verifyOracleWorkflowRequest(request(expired.body,expired.authorization),key))
      .toBeNull();
  });
});
