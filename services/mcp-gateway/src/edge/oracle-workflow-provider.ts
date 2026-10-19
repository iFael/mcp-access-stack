import WebSocket,{type ClientOptions,type RawData} from "ws";
import {
  ORACLE_WORKFLOW_CONNECT_PATH,ORACLE_WORKFLOW_ORIGIN,
  ORACLE_WORKFLOW_MAX_RESULT_BYTES,
  parseOracleWorkflowCommand,parseOracleWorkflowResult,
  type OracleWorkflowCommand, type OracleWorkflowObservation,
} from "@mcp-access-stack/update-control-contract";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface OracleWorkflowProviderPort {
  workflowOperation(input:Extract<OracleWorkflowCommand,{method:"workflow_operation"}>["arguments"]):
    Promise<OracleWorkflowObservation>;
  verifyLightweightTag(tag:string,commitSha:string):Promise<boolean>;
}
export interface OracleWorkflowProviderOptions {
  readonly url:URL;
  readonly token:string;
  readonly port:OracleWorkflowProviderPort;
}
export interface OracleWorkflowProviderDependencies {
  readonly socketFactory?:(url:URL,options:ClientOptions)=>WebSocket;
  readonly wait?:(ms:number,signal:AbortSignal)=>Promise<void>;
}
export function validateOracleWorkflowProviderOptions(options:OracleWorkflowProviderOptions):void{
  const u=options.url;
  if(u.protocol!=="wss:" || !u.hostname.toLowerCase().endsWith(".workers.dev") ||
    u.username || u.password || u.search || u.hash ||
    (u.port!=="" && u.port!=="443") || u.pathname!==ORACLE_WORKFLOW_CONNECT_PATH ||
    !/^[A-Za-z0-9_.-]{32,256}$/u.test(options.token) ||
    !options.port || typeof options.port.workflowOperation!=="function" ||
    typeof options.port.verifyLightweightTag!=="function")
    throw new Error("ORACLE_WORKFLOW_PROVIDER_CONFIG_INVALID");
}
/** Outbound workflow-only socket. No repository identity, shell, policy
 * or credentials come from Oracle. Workflow dispatch uses LocalAgent's
 * existing mutation receipts, and this socket never retries a POST. */
export class OracleWorkflowProviderConnector {
  private readonly factory:(url:URL,options:ClientOptions)=>WebSocket;
  private readonly wait:(ms:number,signal:AbortSignal)=>Promise<void>;
  constructor(private readonly options:OracleWorkflowProviderOptions,
    dependencies:OracleWorkflowProviderDependencies={}){
    validateOracleWorkflowProviderOptions(options);
    this.factory=dependencies.socketFactory??((url,opts)=>new WebSocket(url,opts));
    this.wait=dependencies.wait??(async(ms,signal)=>{
      await new Promise<void>((resolve,reject)=>{
        if(signal.aborted){reject(new Error("aborted"));return;}
        const timer=setTimeout(()=>{signal.removeEventListener("abort",onAbort);resolve();},ms);
        const onAbort=()=>{clearTimeout(timer);reject(new Error("aborted"));};
        signal.addEventListener("abort",onAbort,{once:true});
      });
    });
  }
  async run(signal:AbortSignal):Promise<void>{
    let delay=1000;
    while(!signal.aborted){
      const connected=await this.connect(signal);
      if(signal.aborted)break;
      delay=connected?1000:Math.min(30_000,delay*2);
      try{await this.wait(delay,signal);}catch{break;}
    }
  }
  private connect(signal:AbortSignal):Promise<boolean>{
    const socket=this.factory(this.options.url,{
      origin:ORACLE_WORKFLOW_ORIGIN,
      headers:{authorization:"Bearer "+this.options.token},
      handshakeTimeout:10_000,maxPayload:2048,perMessageDeflate:false,
      rejectUnauthorized:true,followRedirects:false,
    });
    return new Promise(resolve=>{
      let opened=false,settled=false;
      const inFlight=new Set<string>();
      const settle=()=>{
        if(settled)return;settled=true;
        signal.removeEventListener("abort",abort);
        socket.off("open",onOpen);socket.off("close",onClose);
        socket.off("error",onError);socket.off("message",onMessage);
        socket.on("error",()=>undefined);
        if(socket.readyState===WebSocket.OPEN || socket.readyState===WebSocket.CONNECTING)
          try{socket.terminate();}catch{/** Already closed. */}
        resolve(opened);
      };
      const onOpen=()=>{opened=true;};
      const onClose=()=>settle();const onError=()=>settle();const abort=()=>settle();
      const send=(frame:unknown)=>{
        if(settled || socket.readyState!==WebSocket.OPEN)return;
        const raw=JSON.stringify(frame);
        if(Buffer.byteLength(raw)>ORACLE_WORKFLOW_MAX_RESULT_BYTES){
          socket.close(1009,"result limit");return;
        }
        try{socket.send(raw);}catch{socket.close(1011,"send failure");}
      };
      const onMessage=(data:RawData,binary:boolean)=>{
        if(binary || settled || socket.readyState!==WebSocket.OPEN)return;
        const raw=Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer);
        if(raw.byteLength>2048){socket.close(1009,"request limit");return;}
        let value:unknown,command:OracleWorkflowCommand;
        try{
          value=JSON.parse(raw.toString("utf8")) as unknown;
          if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("frame");
          const v=value as Record<string,unknown>;
          if(v.version!==1 || v.type!=="request" || typeof v.requestId!=="string" ||
            !UUID.test(v.requestId) || inFlight.has(v.requestId) || inFlight.size>=8 ||
            Object.keys(v).length!==5)throw new Error("frame");
          command=parseOracleWorkflowCommand({method:v.method,arguments:v.arguments});
        }catch{socket.close(1008,"invalid request");return;}
        const id=(value as {requestId:string}).requestId;
        inFlight.add(id);
        const action=Promise.resolve().then(async():Promise<OracleWorkflowObservation|boolean>=>{
          if(command.method==="workflow_operation"){
            return await this.options.port.workflowOperation(command.arguments);
          }
          return await this.options.port.verifyLightweightTag(command.arguments.tag,command.arguments.commitSha);
        });
        void action.then(result=>{
          const validated=parseOracleWorkflowResult(command.method,result);
          if(command.method==="workflow_operation" &&
            (typeof validated!=="object" || validated.operationId!==command.arguments.operationId))
            throw new Error("ORACLE_WORKFLOW_RECEIPT_MISMATCH");
          send({version:1,type:"response",requestId:id,outcome:"success",result:validated});
        }).catch(()=>{
          send({version:1,type:"response",requestId:id,outcome:"error",
            errorCode:"UPDATE_ORCHESTRATOR_UNAVAILABLE"});
        }).finally(()=>inFlight.delete(id));
      };
      socket.on("open",onOpen);socket.on("close",onClose);socket.on("error",onError);
      socket.on("message",onMessage);signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted)abort();
    });
  }
}
