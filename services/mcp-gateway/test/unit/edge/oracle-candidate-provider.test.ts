import {EventEmitter} from "node:events";
import {describe,expect,it,jest} from "@jest/globals";
import type WebSocket from "ws";
import {
  OracleCandidateProviderConnector,validateOracleCandidateProviderOptions,
} from "../../../src/edge/oracle-candidate-provider.js";
import {ORACLE_CANDIDATE_CONNECT_PATH,ORACLE_CANDIDATE_ORIGIN}
  from "@mcp-access-stack/update-control-contract";
const url=new URL("wss://mcp-v3-update-control.workers.dev"+ORACLE_CANDIDATE_CONNECT_PATH);
const token="candidate-separate-provider-token-".padEnd(48,"c");
const id="11111111-2222-4333-8444-555555555550";
const runId="11111111-2222-4333-8444-555555555551";
const operationId="11111111-2222-4333-8444-555555555552";
const tag="v1.1.0-beta.90",sha="a".repeat(40);
class Socket extends EventEmitter{
  readyState=1;sent:string[]=[];closeCode:number|undefined;
  send(value:string){this.sent.push(value);}
  close(code:number){this.closeCode=code;this.readyState=3;this.emit("close");}
  terminate(){this.readyState=3;this.emit("close");}
  feed(value:unknown){this.emit("message",Buffer.from(JSON.stringify(value)),false);}
}
async function flush(){for(let i=0;i<80;i++)await Promise.resolve();}
describe("read-only Oracle candidate WSS provider",()=>{
  it("uses a different bearer and returns a bounded run/operation receipt",async()=>{
    const socket=new Socket();
    const readCandidate=jest.fn(async(_tag:string,_sha:string)=>({
      releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:"b".repeat(64),verifiedArtifactCount:5,
    }));
    const abort=new AbortController();
    const connector=new OracleCandidateProviderConnector({url,token,port:{readCandidate}},
      {socketFactory:(_url,options)=>{
        expect(options.origin).toBe(ORACLE_CANDIDATE_ORIGIN);
        expect(options.headers).toEqual({authorization:"Bearer "+token});
        queueMicrotask(()=>socket.emit("open"));
        return socket as unknown as WebSocket;
      }});
    const task=connector.run(abort.signal);
    await flush();
    socket.feed({version:1,type:"request",requestId:id,method:"read_candidate",
      arguments:{tag,commitSha:sha,runId,operationId}});
    await flush();
    expect(readCandidate).toHaveBeenCalledWith(tag,sha);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      version:1,type:"response",requestId:id,outcome:"success",
      result:{releaseTag:tag,sourceCommitSha:sha,manifestSha256:"b".repeat(64),
        verifiedArtifactCount:5,runId,operationId},
    });
    abort.abort();await task;
  });
  it("rejects shell/paths before any file read",async()=>{
    const socket=new Socket();
    const readCandidate=jest.fn(async()=>({
      releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:"b".repeat(64),verifiedArtifactCount:5,
    }));
    const abort=new AbortController();
    const connector=new OracleCandidateProviderConnector({url,token,port:{readCandidate}},
      {socketFactory:()=>{queueMicrotask(()=>socket.emit("open"));
        return socket as unknown as WebSocket;}});
    const task=connector.run(abort.signal);
    await flush();
    socket.feed({version:1,type:"request",requestId:id,method:"read_candidate",
      arguments:{tag,commitSha:sha,runId,operationId,path:"../private"}});
    await flush();
    expect(socket.closeCode).toBe(1008);
    expect(readCandidate).not.toHaveBeenCalled();
    abort.abort();await task;
  });
  it("rejects weak tokens and foreign WS endpoints",()=>{
    const port={readCandidate:async()=>({
      releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:"b".repeat(64),verifiedArtifactCount:1,
    })};
    expect(()=>validateOracleCandidateProviderOptions({url,token:"weak",port})).toThrow();
    expect(()=>validateOracleCandidateProviderOptions({
      url:new URL("wss://evil.example"+ORACLE_CANDIDATE_CONNECT_PATH),token,port,
    })).toThrow();
  });
});
