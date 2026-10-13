import WebSocket, {type ClientOptions,type RawData} from "ws";
import {
  ORACLE_CONTROL_CONNECT_PATH, ORACLE_CONTROL_ORIGIN,
  parseOracleControlCommand, parseOracleControlResponse,
  type OracleControlResponse,
} from "@mcp-access-stack/update-control-contract";
import type {TrustedReleaseAdvanceInput,TrustedReleasePrincipal} from "./release-trusted-host.js";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface OracleControlSocketConfig {
  readonly url: URL;
  readonly credential: string;
}
export interface OracleTrustedControl {
  advance(input:TrustedReleaseAdvanceInput,principal:TrustedReleasePrincipal):Promise<{
    run:{runId:string;lastSeq:number;status:string};stop:string;
  }>;
}
export interface OracleControlSocketDependencies {
  readonly socketFactory?: (url:URL,options:ClientOptions)=>WebSocket;
  readonly sleep?: (ms:number,signal:AbortSignal)=>Promise<void>;
}
export function validateOracleControlSocketConfig(config:OracleControlSocketConfig):void {
  const url=config.url;
  if(url.protocol!=="wss:" || !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    (url.port && url.port!=="443") || url.username || url.password || url.search || url.hash ||
    url.pathname!==ORACLE_CONTROL_CONNECT_PATH || !/^[A-Za-z0-9_.-]{32,256}$/u.test(config.credential)) {
    throw new Error("ORACLE_CONTROL_CONNECTION_CONFIG_INVALID");
  }
}
/** Must run inside the SAME process owning the SQLite release ledger.
 * Never use the GET-only Oracle WSS bearer, socket or DynamicUser service. */
export class OracleReleaseControlConnector {
  private readonly socketFactory:(url:URL,options:ClientOptions)=>WebSocket;
  private readonly sleep:(ms:number,signal:AbortSignal)=>Promise<void>;
  private readonly inFlight=new Set<string>();
  constructor(
    private readonly config:OracleControlSocketConfig,
    private readonly host:OracleTrustedControl,
    dependencies:OracleControlSocketDependencies={},
  ){
    validateOracleControlSocketConfig(config);
    this.socketFactory=dependencies.socketFactory??((url,options)=>new WebSocket(url,options));
    this.sleep=dependencies.sleep??((ms,signal)=>new Promise<void>((resolve,reject)=>{
      if(signal.aborted){reject(new Error("aborted"));return;}
      const timer=setTimeout(()=>{signal.removeEventListener("abort",onAbort);resolve();},ms);
      function onAbort(){clearTimeout(timer);reject(new Error("aborted"));}
      signal.addEventListener("abort",onAbort,{once:true});
    }));
  }
  async run(signal:AbortSignal):Promise<void>{
    let backoff=1000;
    while(!signal.aborted){
      const opened=await this.connectOnce(signal);
      if(signal.aborted)break;
      backoff=opened?1000:Math.min(backoff*2,30_000);
      try{await this.sleep(backoff,signal);}catch{break;}
    }
  }
  private connectOnce(signal:AbortSignal):Promise<boolean>{
    const socket=this.socketFactory(this.config.url,{
      headers:{authorization:"Bearer "+this.config.credential},
      origin:ORACLE_CONTROL_ORIGIN,handshakeTimeout:10_000,
      maxPayload:4096,perMessageDeflate:false,rejectUnauthorized:true,followRedirects:false,
    });
    return new Promise(resolve=>{
      let opened=false,settled=false;
      const settle=()=>{
        if(settled)return;settled=true;
        signal.removeEventListener("abort",onAbort);
        socket.off("open",onOpen);socket.off("close",onClose);
        socket.off("error",onError);socket.off("message",onMessage);
        if(socket.readyState===WebSocket.OPEN || socket.readyState===WebSocket.CONNECTING){
          // Terminating a CONNECTING socket can emit a late error; keep it handled.
          socket.on("error",()=>undefined);
          try{socket.terminate();}catch{/* already closed */}
        }
        this.inFlight.clear();
        resolve(opened);
      };
      const onOpen=()=>{opened=true;};
      const onClose=()=>settle();
      const onError=()=>settle();
      const onAbort=()=>settle();
      const onMessage=(data:RawData,isBinary:boolean)=>{
        if(isBinary || socket.readyState!==WebSocket.OPEN)return;
        const raw=Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer);
        if(raw.byteLength>4096){socket.close(1009,"frame limit");return;}
        let value:unknown;
        try{value=JSON.parse(raw.toString("utf8")) as unknown;}catch{socket.close(1008,"invalid frame");return;}
        if(!isRecord(value) || value.type!=="request" || value.version!==1 ||
          typeof value.requestId!=="string" || !UUID.test(value.requestId) ||
          this.inFlight.has(value.requestId) || this.inFlight.size>=8){
          socket.close(1008,"invalid request");return;
        }
        const id=value.requestId;
        let command;
        try{
          const {version:_v,type:_t,requestId:_id,...body}=value;
          command=parseOracleControlCommand(body);
        }catch{socket.close(1008,"invalid command");return;}
        this.inFlight.add(id);
        void this.host.advance({
          runId:command.arguments.runId,
          expectedSourceSha:command.arguments.expectedSourceSha,
          expectedLastSeq:command.arguments.expectedLastSeq,
          requestOperationId:command.arguments.operationId,
        },command.principal).then(result=>{
          const output:OracleControlResponse={
            runId:result.run.runId,lastSeq:result.run.lastSeq,
            status:result.run.status,stop:result.stop,
          };
          parseOracleControlResponse(output);
          this.send(socket,{version:1,type:"response",requestId:id,outcome:"success",result:output});
        }).catch(()=>{
          this.send(socket,{version:1,type:"response",requestId:id,outcome:"error",
            errorCode:"UPDATE_ORCHESTRATOR_UNAVAILABLE"});
        }).finally(()=>this.inFlight.delete(id));
      };
      socket.on("open",onOpen);socket.on("close",onClose);
      socket.on("error",onError);socket.on("message",onMessage);
      signal.addEventListener("abort",onAbort,{once:true});
      if(signal.aborted)onAbort();
    });
  }
  private send(socket:WebSocket,response:unknown):void{
    if(socket.readyState!==WebSocket.OPEN)return;
    const text=JSON.stringify(response);
    if(Buffer.byteLength(text)>4096){socket.close(1009,"frame limit");return;}
    try{socket.send(text);}catch{socket.close(1011,"send failed");}
  }
}
function isRecord(value:unknown):value is Record<string,unknown> {
  return value!==null && typeof value==="object" && !Array.isArray(value);
}
