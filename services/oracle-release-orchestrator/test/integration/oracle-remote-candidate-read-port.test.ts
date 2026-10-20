import {describe,expect,it,jest} from "@jest/globals";
import {OracleRemoteCandidateReadPort}
  from "../../src/oracle-remote-candidate-read-port.js";
import {ORACLE_CANDIDATE_DISPATCH_PATH,parseOracleCandidateCommand}
  from "@mcp-access-stack/update-control-contract";
const url="https://mcp-v3-update-control.workers.dev"+ORACLE_CANDIDATE_DISPATCH_PATH;
const tag="v1.1.0-beta.90",sha="a".repeat(40);
const runId="11111111-2222-4333-8444-555555555555";
const operationId="11111111-2222-4333-8444-555555555556";
const receipt={releaseTag:tag,sourceCommitSha:sha,
  manifestSha256:"b".repeat(64),verifiedArtifactCount:5,runId,operationId};
const success=(result:unknown)=>new Response(JSON.stringify({result}),{
  status:200,headers:{"content-type":"application/json"},
});
describe("Oracle read-only candidate bridge with independent HMAC",()=>{
  it("sends one signed operation-bound request and validates the complete receipt",async()=>{
    const send=jest.fn(async(_url:string|URL|Request,init?:RequestInit)=>{
      expect(init?.headers).toMatchObject({
        authorization:expect.stringMatching(/^HMAC-SHA256 candidate-v1=/u),
      });
      expect(parseOracleCandidateCommand(JSON.parse(String(init?.body))))
        .toEqual({method:"read_candidate",
          arguments:{tag,commitSha:sha,runId,operationId}});
      return success(receipt);
    });
    const port=new OracleRemoteCandidateReadPort({endpoint:url,
      key:async()=> "c".repeat(64),fetchImpl:send as unknown as typeof fetch});
    expect(await port.inspect(tag,sha,runId,operationId)).toEqual(receipt);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects foreign endpoints, wrong run/step ID and a mismatched manifest",async()=>{
    expect(()=>new OracleRemoteCandidateReadPort({
      endpoint:"https://evil.example"+ORACLE_CANDIDATE_DISPATCH_PATH,
      key:async()=> "c".repeat(64),
    })).toThrow("ENDPOINT_INVALID");
    const port=new OracleRemoteCandidateReadPort({endpoint:url,key:async()=>"c".repeat(64),
      fetchImpl:async()=>success({...receipt,operationId:runId})});
    await expect(port.inspect(tag,sha,runId,operationId)).rejects.toThrow(
      "RECEIPT_MISMATCH");
    await expect(port.inspect("../secrets",sha,runId,operationId))
      .rejects.toThrow("REQUEST_INVALID");
  });
});
