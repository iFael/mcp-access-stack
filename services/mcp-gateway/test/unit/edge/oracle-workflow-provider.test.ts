import {EventEmitter} from "node:events";
import {describe,expect,it,jest} from "@jest/globals";
import type WebSocket from "ws";
import {OracleWorkflowProviderConnector,validateOracleWorkflowProviderOptions}
  from "../../../src/edge/oracle-workflow-provider.js";
import {ORACLE_WORKFLOW_CONNECT_PATH,ORACLE_WORKFLOW_ORIGIN}
  from "@mcp-access-stack/update-control-contract";

const url=new URL("wss://mcp-v3-update-control.workers.dev"+ORACLE_WORKFLOW_CONNECT_PATH);
const token="workflow-provider-wss-token-".padEnd(48,"w");
const id="11111111-2222-4333-8444-555555555555";
const operationId="22222222-2222-4222-8222-222222222222";
const sha="a".repeat(40);
const argumentsForWorkflow={workflow:"release-tag-bootstrap.yml" as const,mode:"reconcile" as const,
  tag:"v1.1.0-beta.90",expectedMainSha:sha,operationId};
class Socket extends EventEmitter {
  readyState=1;
  sent:string[]=[];
  closeCode:number|undefined;
  send(v:string){this.sent.push(v);}
  close(code:number){this.closeCode=code;this.readyState=3;this.emit("close");}
  terminate(){this.readyState=3;this.emit("close");}
  feed(v:unknown){this.emit("message",Buffer.from(JSON.stringify(v)),false);}
}
async function flush(){for(let i=0;i<80;i++)await Promise.resolve();}
describe("separately authenticated Oracle GitHub workflow provider WSS",()=>{
  it("only forwards typed workflow and tag commands and returns validated receipts",async()=>{
    const socket=new Socket();
    const workflow=jest.fn(async(_input:unknown)=>({status:"observed" as const,operationId,runId:77,
      state:"completed" as const,conclusion:"success"}));
    const tag=jest.fn(async(_tag:string,_commitSha:string)=>true);
    const ctrl=new AbortController();
    const connector=new OracleWorkflowProviderConnector({url,token,port:{
      workflowOperation:workflow,verifyLightweightTag:tag,
    }},{socketFactory:(_url,opts)=>{
      expect(opts.origin).toBe(ORACLE_WORKFLOW_ORIGIN);
      expect(opts.headers).toEqual({authorization:"Bearer "+token});
      queueMicrotask(()=>socket.emit("open"));return socket as unknown as WebSocket;
    }});
    const task=connector.run(ctrl.signal);
    await flush();
    socket.feed({version:1,type:"request",requestId:id,method:"workflow_operation",
      arguments:argumentsForWorkflow});
    await flush();
    expect(workflow).toHaveBeenCalledWith(argumentsForWorkflow);
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      version:1,type:"response",requestId:id,outcome:"success",
      result:{status:"observed",operationId,runId:77,state:"completed",conclusion:"success"},
    });
    const id2="11111111-2222-4333-8444-555555555556";
    socket.feed({version:1,type:"request",requestId:id2,method:"verify_lightweight_tag",
      arguments:{tag:argumentsForWorkflow.tag,commitSha:sha}});
    await flush();
    expect(tag).toHaveBeenCalledWith(argumentsForWorkflow.tag,sha);
    expect(JSON.parse(socket.sent[1]!)).toMatchObject({
      requestId:id2,outcome:"success",result:true,
    });
    ctrl.abort();await task;
  });
  it("rejects caller-selected repository, invalid method and duplicate identity",async()=>{
    const socket=new Socket();
    const workflow=jest.fn(async()=>({status:"outcome_unknown" as const,operationId}));
    const ctrl=new AbortController();
    const connector=new OracleWorkflowProviderConnector({url,token,port:{
      workflowOperation:workflow,verifyLightweightTag:async()=>false,
    }},{socketFactory:()=>{queueMicrotask(()=>socket.emit("open"));return socket as unknown as WebSocket;}});
    const task=connector.run(ctrl.signal);await flush();
    socket.feed({version:1,type:"request",requestId:id,method:"workflow_operation",
      arguments:{...argumentsForWorkflow,owner:"attacker"}});
    await flush();
    expect(socket.closeCode).toBe(1008);
    expect(workflow).not.toHaveBeenCalled();
    ctrl.abort();await task;
  });
  it("refuses mismatched receipt without inventing success",async()=>{
    const socket=new Socket();
    const ctrl=new AbortController();
    const connector=new OracleWorkflowProviderConnector({url,token,port:{
      workflowOperation:async()=>({status:"submitted",operationId:
        "22222222-2222-4222-8222-222222222223"}),
      verifyLightweightTag:async()=>false,
    }},{socketFactory:()=>{queueMicrotask(()=>socket.emit("open"));return socket as unknown as WebSocket;}});
    const task=connector.run(ctrl.signal);await flush();
    socket.feed({version:1,type:"request",requestId:id,method:"workflow_operation",
      arguments:argumentsForWorkflow});
    await flush();
    expect(JSON.parse(socket.sent[0]!)).toEqual({version:1,type:"response",requestId:id,
      outcome:"error",errorCode:"UPDATE_ORCHESTRATOR_UNAVAILABLE"});
    ctrl.abort();await task;
  });
  it("rejects untrusted WSS endpoints and weak tokens",()=>{
    const port={workflowOperation:async()=>({status:"outcome_unknown" as const,operationId}),
      verifyLightweightTag:async()=>false};
    expect(()=>validateOracleWorkflowProviderOptions({url,token:"short",port})).toThrow();
    expect(()=>validateOracleWorkflowProviderOptions({url:new URL(
      "ws://mcp-v3-update-control.workers.dev"+ORACLE_WORKFLOW_CONNECT_PATH),token,port})).toThrow();
    expect(()=>validateOracleWorkflowProviderOptions({url:new URL(
      "wss://evil.example"+ORACLE_WORKFLOW_CONNECT_PATH),token,port})).toThrow();
  });
});
