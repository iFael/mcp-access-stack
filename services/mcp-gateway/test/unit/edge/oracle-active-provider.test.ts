import {EventEmitter} from "node:events";
import {describe,expect,it,jest} from "@jest/globals";
import type WebSocket from "ws";
import {OracleActiveProviderConnector,validateOracleActiveProviderOptions}
  from "../../../src/edge/oracle-active-provider.js";
import {ORACLE_ACTIVE_CONNECT_PATH,ORACLE_ACTIVE_ORIGIN}
  from "@mcp-access-stack/update-control-contract";
const url=new URL("wss://mcp-v3-update-control.workers.dev"+ORACLE_ACTIVE_CONNECT_PATH);
const token="oracle-active-private-provider-".padEnd(48,"a");
const id="11111111-2222-4333-8444-555555555550";
const requestId="11111111-2222-4333-8444-555555555551";
const tag="v1.1.0-beta.90",sha="a".repeat(40);
const manifest={releaseTag:tag,sourceCommitSha:sha,
  manifestSha256:"b".repeat(64),verifiedArtifactCount:5};
const state={active:{releaseId:"1.1.0-beta.90",manifestSha256:"b".repeat(64)},
  previous:{releaseId:"1.1.0-beta.89",manifestSha256:"c".repeat(64)},candidate:null};
class Socket extends EventEmitter{
  readyState=1;sent:string[]=[];closeCode:number|undefined;
  send(value:string){this.sent.push(value);}
  close(code:number){this.closeCode=code;this.readyState=3;this.emit("close");}
  terminate(){this.readyState=3;this.emit("close");}
  feed(value:unknown){this.emit("message",Buffer.from(JSON.stringify(value)),false);}
}
async function flush(){for(let i=0;i<100;i++)await Promise.resolve();}
describe("segregated ACTIVE-only Oracle provider",()=>{
  it("returns real typed active/state reads, correlated to request IDs",async()=>{
    const socket=new Socket();
    const inspectActive=jest.fn(async(_tag:string,_sha:string)=>manifest);
    const getState=jest.fn(async()=>state);
    const abort=new AbortController();
    const connector=new OracleActiveProviderConnector({url,token,port:{inspectActive,getState}},
      {socketFactory:(_url,opts)=>{
        expect(opts.origin).toBe(ORACLE_ACTIVE_ORIGIN);
        expect(opts.headers).toEqual({authorization:"Bearer "+token});
        queueMicrotask(()=>socket.emit("open"));
        return socket as unknown as WebSocket;
      }});
    const task=connector.run(abort.signal);await flush();
    socket.feed({version:1,type:"request",requestId:id,
      method:"inspect_active",arguments:{tag,commitSha:sha,requestId}});
    await flush();
    expect(inspectActive).toHaveBeenCalledWith(tag,sha);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      version:1,type:"response",requestId:id,outcome:"success",
      result:{method:"inspect_active",requestId,manifest},
    });
    socket.feed({version:1,type:"request",
      requestId:"11111111-2222-4333-8444-555555555552",
      method:"get_state",arguments:{requestId}});
    await flush();
    expect(getState).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      outcome:"success",result:{method:"get_state",requestId,state},
    });
    abort.abort();await task;
  });
  it("refuses caller-selected paths and never invokes a native reader",async()=>{
    const socket=new Socket();
    const inspectActive=jest.fn(async()=>manifest);
    const getState=jest.fn(async()=>state);
    const abort=new AbortController();
    const connector=new OracleActiveProviderConnector({url,token,port:{inspectActive,getState}},
      {socketFactory:()=>{queueMicrotask(()=>socket.emit("open"));
        return socket as unknown as WebSocket;}});
    const task=connector.run(abort.signal);await flush();
    socket.feed({version:1,type:"request",requestId:id,
      method:"get_state",arguments:{requestId,path:"/etc/shadow"}});
    await flush();
    expect(socket.closeCode).toBe(1008);
    expect(inspectActive).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
    abort.abort();await task;
  });
  it("rejects weak/foreign credentials and unsupported ports",()=>{
    const port={inspectActive:async()=>manifest,getState:async()=>state};
    expect(()=>validateOracleActiveProviderOptions({url,token:"weak",port})).toThrow();
    expect(()=>validateOracleActiveProviderOptions({
      url:new URL("wss://evil.example"+ORACLE_ACTIVE_CONNECT_PATH),token,port,
    })).toThrow();
    expect(()=>validateOracleActiveProviderOptions({url,token,
      port:{inspectActive:port.inspectActive} as never})).toThrow();
  });
});