import {EventEmitter} from "node:events";
import {describe,expect,it,jest} from "@jest/globals";
import type WebSocket from "ws";
import {OracleReleaseControlConnector} from "../../src/oracle-control-connector.js";
import {ORACLE_CONTROL_CONNECT_PATH,ORACLE_CONTROL_ORIGIN}
  from "@mcp-access-stack/update-control-contract";

const url=new URL("wss://mcp-v3-update-control.workers.dev"+ORACLE_CONTROL_CONNECT_PATH);
const credential="oracle-control-dedicated-token-".padEnd(48,"x");
const requestId="11111111-2222-4333-8444-555555555555";
const operationId="11111111-2222-4333-8444-555555555556";
const runId="11111111-2222-4333-8444-555555555557";
const command={
  version:1,type:"request",requestId,method:"advance_release",
  arguments:{runId,operationId,expectedSourceSha:"a".repeat(40),expectedLastSeq:9},
  principal:{workspaceId:"mcp-access-stack",authenticatedActorId:"mcp:v3-release-control",
    ownerScope:"trusted:release-operator"},
};
class Socket extends EventEmitter {
  readyState=1;
  messages:string[]=[];
  closeCode:number|undefined;
  send(message:string){this.messages.push(message);}
  close(code:number){this.closeCode=code;this.readyState=3;this.emit("close");}
  terminate(){this.readyState=3;this.emit("close");}
  feed(message:unknown){this.emit("message",Buffer.from(JSON.stringify(message)),false);}
}
async function settle(){for(let i=0;i<80;i++)await Promise.resolve();}
describe("Oracle control connector fixed outbound WSS boundary",()=>{
  it("relays exact signed CAS and operationId to the one-writer with sanitized receipt",async()=>{
    const socket=new Socket();
    const calls:unknown[]=[];
    const abort=new AbortController();
    const connector=new OracleReleaseControlConnector({url,credential},{
      advance:async(input,principal)=>{
        calls.push({input,principal});
        return {run:{runId,lastSeq:10,status:"paused_outcome_unknown"},
          stop:"outcome_unknown"};
      },
    },{socketFactory:(_url,options)=>{
      expect(options.origin).toBe(ORACLE_CONTROL_ORIGIN);
      expect(options.headers).toEqual({authorization:"Bearer "+credential});
      queueMicrotask(()=>socket.emit("open"));
      return socket as unknown as WebSocket;
    }});
    const running=connector.run(abort.signal);
    await settle();
    socket.feed(command);
    await settle();
    expect(calls).toEqual([{input:{
      runId,expectedSourceSha:"a".repeat(40),expectedLastSeq:9,
      requestOperationId:operationId,
    },principal:command.principal}]);
    expect(socket.messages).toHaveLength(1);
    expect(JSON.parse(socket.messages[0]!)).toEqual({
      version:1,type:"response",requestId,outcome:"success",
      result:{runId,lastSeq:10,status:"paused_outcome_unknown",stop:"outcome_unknown"},
    });
    abort.abort();await running;
  });
  it("rejects spoofed identity without calling Oracle or acknowledging execution",async()=>{
    const socket=new Socket();
    const advance=jest.fn(async()=>({run:{runId,lastSeq:10,status:"running"},
      stop:"outcome_unknown"}));
    const abort=new AbortController();
    const connector=new OracleReleaseControlConnector({url,credential},{
      advance,
    },{socketFactory:()=>{
      queueMicrotask(()=>socket.emit("open"));
      return socket as unknown as WebSocket;
    }});
    const running=connector.run(abort.signal);
    await settle();
    socket.feed({...command,principal:{...command.principal,ownerScope:"operator:spoofed"}});
    await settle();
    expect(advance).not.toHaveBeenCalled();
    expect(socket.closeCode).toBe(1008);
    expect(socket.messages).toHaveLength(0);
    abort.abort();await running;
  });
});
