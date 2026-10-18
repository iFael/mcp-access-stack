import {describe,expect,it,jest} from "@jest/globals";
import {OracleRemoteActiveReadPort}
  from "../../src/oracle-remote-active-read-port.js";
import {ORACLE_ACTIVE_DISPATCH_PATH,parseOracleActiveCommand}
  from "@mcp-access-stack/update-control-contract";
const url="https://mcp-v3-update-control.workers.dev"+ORACLE_ACTIVE_DISPATCH_PATH;
const tag="v1.1.0-beta.90",sha="a".repeat(40);
const manifest={releaseTag:tag,sourceCommitSha:sha,
  manifestSha256:"b".repeat(64),verifiedArtifactCount:7};
const state={active:{releaseId:"1.1.0-beta.90",manifestSha256:"b".repeat(64)},
  previous:{releaseId:"1.1.0-beta.89",manifestSha256:"c".repeat(64)},candidate:null};
const response=(result:unknown)=>new Response(JSON.stringify({result}),{
  status:200,headers:{"content-type":"application/json"},
});
describe("isolated ACTIVE read-only Oracle HMAC transport",()=>{
  it("sends independent signed manifest and pointer requests",async()=>{
    const send=jest.fn(async(_url:string|URL|Request,init?:RequestInit)=>{
      expect(init?.headers).toMatchObject({
        authorization:expect.stringMatching(/^HMAC-SHA256 active-v1=/u),
      });
      const command=parseOracleActiveCommand(JSON.parse(String(init?.body)) as unknown);
      return response(command.method==="inspect_active"
        ? {method:command.method,requestId:command.arguments.requestId,manifest}
        : {method:command.method,requestId:command.arguments.requestId,state});
    });
    const port=new OracleRemoteActiveReadPort({endpoint:url,
      key:async()=>"c".repeat(64),fetchImpl:send as unknown as typeof fetch});
    expect(await port.inspectActive(tag,sha)).toEqual(manifest);
    expect(await port.getState()).toEqual(state);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("rejects mismatched signed reply, oversized result and malicious endpoint",async()=>{
    expect(()=>new OracleRemoteActiveReadPort({
      endpoint:"https://evil.example"+ORACLE_ACTIVE_DISPATCH_PATH,
      key:async()=>"c".repeat(64),
    })).toThrow("ENDPOINT_INVALID");
    const port=new OracleRemoteActiveReadPort({endpoint:url,key:async()=>"c".repeat(64),
      fetchImpl:async()=>response({method:"inspect_active",
        requestId:"11111111-2222-4333-8444-555555555555",manifest})});
    await expect(port.inspectActive(tag,sha)).rejects.toThrow("REQUEST_ID_MISMATCH");
    const tooLarge=new OracleRemoteActiveReadPort({endpoint:url,key:async()=>"c".repeat(64),
      fetchImpl:async()=>response("X".repeat(4096))});
    await expect(tooLarge.getState()).rejects.toThrow("TOO_LARGE");
    await expect(port.inspectActive("../secret",sha)).rejects.toThrow("INSPECT_INVALID");
  });
});