import {EventEmitter} from "node:events";
import {describe,expect,it,jest} from "@jest/globals";
import type WebSocket from "ws";
import {
  WindowsReadProviderConnector,validateWindowsReadProviderOptions,
} from "../../../src/edge/windows-read-provider.js";
import {
  WINDOWS_READ_CONNECT_PATH,WINDOWS_READ_ORIGIN,
  parseWindowsReadResult,type WindowsReadCommand,
} from "@mcp-access-stack/update-control-contract";

const url=new URL("wss://mcp-v3-update-control.workers.dev"+WINDOWS_READ_CONNECT_PATH);
const token="windows-read-provider-test-token-".padEnd(48,"z");
const requestId="11111111-2222-4333-8444-555555555550";
const rpcId="11111111-2222-4333-8444-555555555551";
const tag="v1.1.0-beta.90",sha="a".repeat(40);
const runId="11111111-2222-4333-8444-555555555552";
const operationId="11111111-2222-4333-8444-555555555553";
const prepareOperationId="11111111-2222-4333-8444-555555555554";
const pointer={releaseId:tag.slice(1),manifestSha256:"b".repeat(64)};
const other={releaseId:"1.1.0-beta.89",manifestSha256:"c".repeat(64)};
const state={active:other,previous:null,candidate:pointer};
const witness={kind:"local_candidate_prepare" as const,
  runId,prepareOperationId,releaseId:pointer.releaseId,
  manifestSha256:pointer.manifestSha256};
const activeProof={scope:"local_hash_integrity_only" as const,releaseTag:tag,
  sourceCommitSha:sha,manifestSha256:pointer.manifestSha256,
  verifiedArtifactCount:9,
  state:{active:pointer,previous:other,candidate:null}};
const proof={scope:"local_hash_integrity_only" as const,releaseTag:tag,
  sourceCommitSha:sha,manifestSha256:pointer.manifestSha256,
  verifiedArtifactCount:9,state,localPrepareWitness:witness};
class Socket extends EventEmitter {
  readyState=1;
  sent:string[]=[];
  closeCode:number|undefined;
  send(data:string){this.sent.push(data);}
  close(code:number){this.closeCode=code;this.readyState=3;this.emit("close");}
  terminate(){this.readyState=3;this.emit("close");}
  feed(frame:unknown){this.emit("message",Buffer.from(JSON.stringify(frame)),false);}
}
async function flush(){for(let i=0;i<100;i++)await Promise.resolve();}
const candidate:WindowsReadCommand={method:"inspect_candidate",arguments:{
  requestId:rpcId,tag,commitSha:sha,runId,operationId,prepareOperationId,
}};
const port=()=>({
  getState:jest.fn(async()=>state),
  inspectCandidate:jest.fn(async(_tag:string,_sha:string,_runId:string,
    _operationId:string,_prepareId:string)=>proof),
  inspectActive:jest.fn(async(_tag:string,_sha:string)=>activeProof),
});
function start(socket:Socket,provider=port()){
  const stop=new AbortController();
  const connector=new WindowsReadProviderConnector({url,token,port:provider as never},{
    socketFactory:(_url,opts)=>{
      expect(opts.origin).toBe(WINDOWS_READ_ORIGIN);
      expect(opts.headers).toEqual({authorization:"Bearer "+token});
      expect(opts.rejectUnauthorized).toBe(true);
      expect(opts.followRedirects).toBe(false);
      queueMicrotask(()=>socket.emit("open"));
      return socket as unknown as WebSocket;
    },
  });
  return {stop,task:connector.run(stop.signal),provider};
}
describe("Windows-only WSS read provider (code-only, no native registration)",()=>{
  it("projects state and candidate only after validation of the local proof",async()=>{
    const socket=new Socket();
    const {stop,task,provider}=start(socket);await flush();
    const frame=(id:string,command:WindowsReadCommand)=>({
      version:1,type:"request",requestId:id,...command,
    });
    socket.feed(frame(requestId,candidate));
    await flush();
    expect(provider.inspectCandidate).toHaveBeenCalledWith(tag,sha,runId,
      operationId,prepareOperationId);
    expect(socket.sent).toHaveLength(1);
    const candidateResult=JSON.parse(socket.sent[0]!) as {result:unknown};
    expect(candidateResult).toMatchObject({outcome:"success",
      result:{method:"inspect_candidate",requestId:rpcId,
        proof:{scope:"local_hash_integrity_only",
          localPrepareWitness:{prepareOperationId}}}});
    expect(parseWindowsReadResult(candidate,candidateResult.result))
      .toHaveProperty("method","inspect_candidate");
    const stateCommand:WindowsReadCommand={method:"get_state",
      arguments:{requestId:rpcId}};
    socket.feed(frame("11111111-2222-4333-8444-555555555555",stateCommand));
    await flush();
    expect(provider.getState).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      outcome:"success",result:{method:"get_state",requestId:rpcId,
        scope:"local_hash_integrity_only",state}});
    stop.abort();await task;
  });
  it("refuses invalid caller-selected paths without invoking any reader",async()=>{
    const socket=new Socket();
    const {stop,task,provider}=start(socket);await flush();
    socket.feed({version:1,type:"request",requestId,method:"inspect_candidate",
      arguments:{...candidate.arguments,path:"C:\\secret"}});
    await flush();
    expect(socket.closeCode).toBe(1008);
    expect(provider.inspectCandidate).not.toHaveBeenCalled();
    stop.abort();await task;
  });
  it("returns a bounded error rather than laundering a forged local receipt",async()=>{
    const socket=new Socket();
    const provided=port();
    provided.inspectCandidate.mockImplementation(async()=>({
      ...proof,scope:"remote_verified" as never,
      localPrepareWitness:{...witness,prepareOperationId:operationId},
    }));
    const {stop,task}=start(socket,provided);await flush();
    socket.feed({version:1,type:"request",requestId,...candidate});
    await flush();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type:"response",requestId,outcome:"error",
      errorCode:"UPDATE_ORCHESTRATOR_UNAVAILABLE"});
    expect(socket.sent[0]).not.toContain("remote_verified");
    stop.abort();await task;
  });
  it("accepts exact active-state evidence, never a candidate witness",async()=>{
    const socket=new Socket();
    const {stop,task,provider}=start(socket);await flush();
    const active:WindowsReadCommand={method:"inspect_active",arguments:{
      requestId:rpcId,tag,commitSha:sha,
    }};
    socket.feed({version:1,type:"request",requestId,...active});
    await flush();
    expect(provider.inspectActive).toHaveBeenCalledWith(tag,sha);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({
      type:"response",outcome:"success",requestId,
      result:{method:"inspect_active",requestId:rpcId,
        proof:{scope:"local_hash_integrity_only",state:{
          candidate:null,active:pointer,previous:other}}}});
    expect("localPrepareWitness" in (JSON.parse(socket.sent[0]!) as {
      result:{proof:Record<string,unknown>}}).result.proof).toBe(false);
    stop.abort();await task;
  });
  it("rejects forged envelope, wrong TLS route and missing native reader",async()=>{
    const reader=port();
    expect(()=>validateWindowsReadProviderOptions({
      url:new URL("wss://evil.example"+WINDOWS_READ_CONNECT_PATH),
      token,port:reader as never})).toThrow();
    expect(()=>validateWindowsReadProviderOptions({
      url,token:"short",port:reader as never})).toThrow();
    expect(()=>validateWindowsReadProviderOptions({
      url,token,port:{getState:reader.getState} as never})).toThrow();
    const socket=new Socket();
    const {stop,task,provider}=start(socket);await flush();
    socket.feed({version:1,type:"request",requestId,
      method:"execute",arguments:{requestId:rpcId}});
    await flush();
    expect(socket.closeCode).toBe(1008);
    expect(provider.getState).not.toHaveBeenCalled();
    stop.abort();await task;
  });
});
