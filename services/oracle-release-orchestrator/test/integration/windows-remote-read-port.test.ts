import {describe,expect,it,jest} from "@jest/globals";
import {WindowsRemoteReadPort} from "../../src/windows-remote-read-port.js";
import {parseWindowsReadCommand,WINDOWS_READ_DISPATCH_PATH}
  from "@mcp-access-stack/update-control-contract";
const endpoint="https://mcp-v3-update-control.workers.dev"+WINDOWS_READ_DISPATCH_PATH;
const tag="v1.1.0-beta.90",commit="a".repeat(40),digest="b".repeat(64);
const runId="11111111-2222-4333-8444-555555555550";
const operationId="11111111-2222-4333-8444-555555555552";
const prepareId="11111111-2222-4333-8444-555555555551";
const slot={releaseId:tag.slice(1),manifestSha256:digest};
const state={active:null,previous:null,candidate:slot};
const proof={scope:"local_hash_integrity_only",releaseTag:tag,
  sourceCommitSha:commit,manifestSha256:digest,verifiedArtifactCount:9,
  state,localPrepareWitness:{kind:"local_candidate_prepare",runId,
    prepareOperationId:prepareId,releaseId:slot.releaseId,manifestSha256:digest}};
function response(result:unknown){
  return new Response(JSON.stringify({result}),{status:200,
    headers:{"content-type":"application/json"}});
}
describe("disabled Windows remote HMAC reader",()=>{
  it("authenticates the exact candidate intent but returns only local proof",async()=>{
    const fetchImpl=jest.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
      const raw=JSON.parse(String(init?.body)) as unknown;
      const command=parseWindowsReadCommand(raw);
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization"))
        .toMatch(/^HMAC-SHA256 windows-read-v1=/u);
      expect(command.method).toBe("inspect_candidate");
      return response({method:command.method,requestId:command.arguments.requestId,proof});
    });
    const port=new WindowsRemoteReadPort({endpoint,key:async()=> "e".repeat(64),
      fetchImpl:fetchImpl as unknown as typeof fetch});
    expect(await port.inspectCandidate(tag,commit,runId,operationId,prepareId))
      .toMatchObject({scope:"local_hash_integrity_only"});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect("promoteWindows" in port).toBe(false);
  });
  it("refuses mismatched requestId, forged operation and extra path",async()=>{
    for(const override of [
      (id:string)=>({method:"inspect_candidate",requestId:runId,proof}),
      (id:string)=>({method:"inspect_candidate",requestId:id,proof:{
        ...proof,localPrepareWitness:{...proof.localPrepareWitness,prepareOperationId:operationId}}}),
      (id:string)=>({method:"inspect_candidate",requestId:id,proof:{
        ...proof,remoteVerified:true}}),
    ]){
      const port=new WindowsRemoteReadPort({endpoint,key:async()=> "e".repeat(64),
        fetchImpl:(async(_url,init)=>{
          const command=parseWindowsReadCommand(JSON.parse(String(init?.body)));
          return response(override(command.arguments.requestId));
        }) as typeof fetch});
      await expect(port.inspectCandidate(tag,commit,runId,operationId,prepareId))
        .rejects.toThrow();
    }
  });
  it("requires exact TLS route and rejects unauthenticated responses",async()=>{
    expect(()=>new WindowsRemoteReadPort({endpoint:
      "http://mcp-v3-update-control.workers.dev"+WINDOWS_READ_DISPATCH_PATH,
      key:async()=> "e".repeat(64)})).toThrow("ENDPOINT_INVALID");
    expect(()=>new WindowsRemoteReadPort({endpoint:
      "https://evil.example"+WINDOWS_READ_DISPATCH_PATH,
      key:async()=> "e".repeat(64)})).toThrow("ENDPOINT_INVALID");
    const port=new WindowsRemoteReadPort({endpoint,key:async()=> "e".repeat(64),
      fetchImpl:(async()=>new Response(null,{status:401})) as typeof fetch});
    await expect(port.getState()).rejects.toThrow("UNVERIFIED");
  });
  it("rejects unbounded and forged state replies",async()=>{
    const port=new WindowsRemoteReadPort({endpoint,key:async()=> "e".repeat(64),
      fetchImpl:(async(_url,init)=>{
        const command=parseWindowsReadCommand(JSON.parse(String(init?.body)));
        return response({method:command.method,requestId:command.arguments.requestId,
          scope:"local_hash_integrity_only",state,
          privatePath:"C:\\secrets"});
      }) as typeof fetch});
    await expect(port.getState()).rejects.toThrow();
    const huge=new WindowsRemoteReadPort({endpoint,key:async()=> "e".repeat(64),
      fetchImpl:(async()=>response({untrusted:"x".repeat(10000)})) as typeof fetch});
    await expect(huge.getState()).rejects.toThrow("OVERSIZE");
  });
});
