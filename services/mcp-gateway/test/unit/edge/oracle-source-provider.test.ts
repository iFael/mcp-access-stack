import {EventEmitter} from "node:events";
import {describe,expect,it,jest} from "@jest/globals";
import type WebSocket from "ws";
import {OracleSourceProviderConnector,validateOracleSourceProviderOptions}
  from "../../../src/edge/oracle-source-provider.js";
import {ORACLE_SOURCE_CONNECT_PATH,ORACLE_SOURCE_ORIGIN} from "@mcp-access-stack/update-control-contract";

const url=new URL("wss://mcp-v3-update-control.workers.dev"+ORACLE_SOURCE_CONNECT_PATH);
const token="source-provider-wss-token-".padEnd(48,"x");
const id="11111111-2222-4333-8444-555555555555";
class Socket extends EventEmitter {
  readyState=1;
  sent:string[]=[];
  closeCode:number|undefined;
  send(v:string){this.sent.push(v);}
  close(code:number){this.closeCode=code;this.readyState=3;this.emit("close");}
  terminate(){this.readyState=3;this.emit("close");}
  feed(v:unknown){this.emit("message",Buffer.from(JSON.stringify(v)),false);}
}
async function flush(){for(let i=0;i<70;i++)await Promise.resolve();}
describe("Oracle GitHub read-only source WSS provider",()=>{
  it("processes exactly two fixed reads and sends validated receipts",async()=>{
    const socket=new Socket();
    const main=jest.fn(async()=> "a".repeat(40));
    const checks=jest.fn(async(_sha:string)=>({
      commitSha:"a".repeat(40),totalCount:1,returnedCount:1,
      pendingCount:0,successfulCount:1,failingCount:0,allCompleted:true,
      truncated:false,passed:true,
      checks:[{id:4,name:"CI",status:"completed",conclusion:"success"}],
    }));
    const abort=new AbortController();
    const connector=new OracleSourceProviderConnector({url,token,port:{
      readMainHead:main,readCommitChecks:checks,
    }},{socketFactory:(_url,options)=>{
      expect(options.origin).toBe(ORACLE_SOURCE_ORIGIN);
      expect(options.headers).toEqual({authorization:"Bearer "+token});
      queueMicrotask(()=>socket.emit("open"));
      return socket as unknown as WebSocket;
    }});
    const task=connector.run(abort.signal);
    await flush();
    socket.feed({version:1,type:"request",requestId:id,method:"read_main_head",arguments:{}});
    await flush();
    expect(main).toHaveBeenCalledTimes(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      version:1,type:"response",requestId:id,outcome:"success",result:"a".repeat(40),
    });
    socket.feed({version:1,type:"request",requestId:"11111111-2222-4333-8444-555555555556",
      method:"read_commit_checks",arguments:{commitSha:"a".repeat(40)}});
    await flush();
    expect(checks).toHaveBeenCalledWith("a".repeat(40));
    expect(socket.sent).toHaveLength(2);
    abort.abort();await task;
  });
  it("rejects injected repository or command names before any GitHub access",async()=>{
    const socket=new Socket();
    const main=jest.fn(async()=> "a".repeat(40));
    const abort=new AbortController();
    const connector=new OracleSourceProviderConnector({url,token,port:{
      readMainHead:main,readCommitChecks:async()=>({}),
    }},{socketFactory:()=>{
      queueMicrotask(()=>socket.emit("open"));return socket as unknown as WebSocket;
    }});
    const task=connector.run(abort.signal);
    await flush();
    socket.feed({version:1,type:"request",requestId:id,method:"read_main_head",
      arguments:{owner:"attacker"}});
    await flush();
    expect(main).not.toHaveBeenCalled();
    expect(socket.closeCode).toBe(1008);
    abort.abort();await task;
  });
  it("rejects non-TLS/foreign endpoint and weak credential",()=>{
    const port={readMainHead:async()=> "a".repeat(40),
      readCommitChecks:async()=>({})};
    expect(()=>validateOracleSourceProviderOptions({url:new URL("ws://mcp-v3-update-control.workers.dev"+ORACLE_SOURCE_CONNECT_PATH),token,port})).toThrow();
    expect(()=>validateOracleSourceProviderOptions({url,token:"weak",port})).toThrow();
    expect(()=>validateOracleSourceProviderOptions({url:new URL("wss://evil.example"+ORACLE_SOURCE_CONNECT_PATH),token,port})).toThrow();
  });
});
