import {describe,expect,it,jest} from "@jest/globals";
import {ORACLE_WORKFLOW_DISPATCH_PATH,parseOracleWorkflowCommand}
  from "@mcp-access-stack/update-control-contract";
import {OracleRemoteWorkflowPort} from "../../src/oracle-remote-workflow-port.js";

const sha="a".repeat(40),key="b".repeat(64),id="11111111-2222-4333-8444-555555555555";
const url="https://mcp-v3-update-control.workers.dev"+ORACLE_WORKFLOW_DISPATCH_PATH;
const repo={workspaceId:"mcp-access-stack",owner:"octo",repository:"repo"};
const input={...repo,workflow:"release-tag-bootstrap.yml" as const,mode:"reconcile" as const,
  tag:"v1.1.0-beta.90",expectedMainSha:sha,operationId:id};
function success(result:unknown){
  return new Response(JSON.stringify({result}),{status:200,headers:{"content-type":"application/json"}});
}
describe("isolated Oracle -> Worker authenticated workflow client",()=>{
  it("sends HMAC domain-separated commands without repository identity and verifies observations",async()=>{
    const calls:unknown[]=[];
    const fetchImpl=jest.fn(async(_target:string|URL|Request,init?:RequestInit)=>{
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({authorization:expect.stringMatching(/^HMAC-SHA256 workflow-v1=/u)});
      const raw=JSON.parse(String(init?.body)) as unknown;
      const command=parseOracleWorkflowCommand(raw);
      calls.push(command);
      if(command.method==="verify_lightweight_tag")return success(true);
      if(command.method==="inspect_distribution")return success({sourceCommitSha:sha,releaseTag:input.tag,workflowRunId:123,integrityVerified:true,releasePublished:true,verifiedAssetCount:5,assetInventorySha256:"b".repeat(64)});
      return success({status:"observed",operationId:id,runId:123,state:"completed",conclusion:"success"});
    });
    const port=new OracleRemoteWorkflowPort({...repo,endpoint:url,key:async()=>key,
      fetchImpl:fetchImpl as unknown as typeof fetch});
    expect(await port.workflowOperation(input)).toMatchObject({status:"observed",runId:123});
    expect(await port.verifyLightweightTag(input.tag,sha)).toBe(true);
    expect(await port.inspectDistribution(123,input.tag,sha)).toMatchObject({assetInventorySha256:"b".repeat(64)});
    expect(calls).toEqual([
      {method:"workflow_operation",arguments:{
        workflow:"release-tag-bootstrap.yml",mode:"reconcile",tag:input.tag,
        expectedMainSha:sha,operationId:id,
      }},
      {method:"verify_lightweight_tag",arguments:{tag:input.tag,commitSha:sha}},
      {method:"inspect_distribution",arguments:{runId:123,tag:input.tag,commitSha:sha}},
    ]);
  });
  it("rejects foreign repository, invalid release dispatch, mismatch and untrusted URL",async()=>{
    expect(()=>new OracleRemoteWorkflowPort({...repo,endpoint:
      "https://untrusted.example"+ORACLE_WORKFLOW_DISPATCH_PATH,key:async()=>key}))
      .toThrow("ENDPOINT_INVALID");
    const fetchImpl=jest.fn(async()=>success({status:"submitted",operationId:
      "22222222-2222-4222-8222-222222222222"}));
    const port=new OracleRemoteWorkflowPort({...repo,endpoint:url,key:async()=>key,
      fetchImpl:fetchImpl as unknown as typeof fetch});
    await expect(port.workflowOperation({...input,owner:"attacker"})).rejects.toThrow("IDENTITY_INVALID");
    await expect(port.workflowOperation({...input,mode:"dispatch",workflow:"release.yml"} as never))
      .rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(port.workflowOperation(input)).rejects.toThrow("RECEIPT_MISMATCH");
  });
  it("never retries an uncertain dispatch or accepts malformed/oversized response",async()=>{
    const fetchImpl=jest.fn(async()=>{throw new Error("network_timeout");});
    const port=new OracleRemoteWorkflowPort({...repo,endpoint:url,key:async()=>key,
      fetchImpl:fetchImpl as unknown as typeof fetch});
    await expect(port.workflowOperation({...input,mode:"dispatch"})).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const malformed=new OracleRemoteWorkflowPort({...repo,endpoint:url,key:async()=>key,
      fetchImpl:async()=>success({status:"observed",operationId:id,runId:12,
        state:"completed",conclusion:"success",extra:true})});
    await expect(malformed.workflowOperation(input)).rejects.toThrow("RESULT_INVALID");
    const oversized=new OracleRemoteWorkflowPort({...repo,endpoint:url,key:async()=>key,
      fetchImpl:async()=>new Response("x".repeat(5000),{
        status:200,headers:{"content-type":"application/json"}})});
    await expect(oversized.workflowOperation(input)).rejects.toThrow("TOO_LARGE");
  });
});
