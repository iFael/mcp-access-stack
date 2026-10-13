import {describe,expect,it,jest} from "@jest/globals";
import {OracleRemoteSourceReadPort} from "../../src/oracle-remote-source-read-port.js";
import {ORACLE_SOURCE_DISPATCH_PATH} from "@mcp-access-stack/update-control-contract";
const sha="a".repeat(40);
const endpoint="https://mcp-v3-update-control.workers.dev"+ORACLE_SOURCE_DISPATCH_PATH;
const checks={commitSha:sha,totalCount:1,returnedCount:1,pendingCount:0,successfulCount:1,
  failingCount:0,allCompleted:true,truncated:false,passed:true,
  checks:[{id:7,name:"CI",status:"completed",conclusion:"success"}]};
const success=(value:unknown)=>new Response(JSON.stringify({result:value}),{
  status:200,headers:{"content-type":"application/json"},
});
describe("Oracle remote source read-only port",()=>{
  it("authenticates each typed read and validates SHA-bound responses",async()=>{
    const calls:unknown[]=[];
    const stub=jest.fn(async(_endpoint:string|URL|Request,init?:RequestInit)=>{
      expect(init?.headers).toMatchObject({authorization:expect.stringMatching(/^HMAC-SHA256 source-v1=/u)});
      const command=JSON.parse(String(init?.body)) as {method:string;arguments:unknown};
      calls.push(command);
      return success(command.method==="read_main_head"?sha:checks);
    });
    const port=new OracleRemoteSourceReadPort({endpoint,key:async()=> "b".repeat(64),
      fetchImpl:stub as unknown as typeof fetch});
    expect(await port.readMainHead()).toBe(sha);
    expect(await port.readCommitChecks(sha)).toEqual(checks);
    expect(calls).toEqual([{method:"read_main_head",arguments:{}},
      {method:"read_commit_checks",arguments:{commitSha:sha}}]);
    expect(stub).toHaveBeenCalledTimes(2);
  });
  it("rejects untrusted endpoint, mismatched SHA or non-JSON response",async()=>{
    expect(()=>new OracleRemoteSourceReadPort({endpoint:"https://example.org"+ORACLE_SOURCE_DISPATCH_PATH,
      key:async()=> "b".repeat(64)})).toThrow("ENDPOINT_INVALID");
    const port=new OracleRemoteSourceReadPort({endpoint,key:async()=> "b".repeat(64),
      fetchImpl:async()=>success({...checks,commitSha:"c".repeat(40)})});
    await expect(port.readCommitChecks(sha)).rejects.toThrow("SHA_MISMATCH");
    await expect(port.readCommitChecks("bad")).rejects.toThrow("SHA_INVALID");
  });
  it("never treats truncated or empty CI as a verified success",async()=>{
    const port=new OracleRemoteSourceReadPort({endpoint,key:async()=> "b".repeat(64),
      fetchImpl:async()=>success({...checks,totalCount:2,truncated:true,
        allCompleted:false,passed:false})});
    const value=await port.readCommitChecks(sha);
    expect(value.passed).toBe(false);
    expect(value.truncated).toBe(true);
  });
});
