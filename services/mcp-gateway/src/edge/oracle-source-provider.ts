import WebSocket,{type ClientOptions,type RawData} from "ws";
import {
  ORACLE_SOURCE_CONNECT_PATH,ORACLE_SOURCE_ORIGIN,ORACLE_SOURCE_MAX_RESULT_BYTES,
  parseOracleSourceCommand,parseOracleSourceResult,
  type OracleSourceReadCommand,
} from "@mcp-access-stack/update-control-contract";

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface OracleSourceProviderPort {
  readMainHead():Promise<string>;
  readCommitChecks(commitSha:string):Promise<unknown>;
}
export interface OracleSourceProviderOptions {
  readonly url:URL;
  readonly token:string;
  readonly port:OracleSourceProviderPort;
}
export interface OracleSourceProviderDependencies {
  readonly socketFactory?:(url:URL,options:ClientOptions)=>WebSocket;
  readonly wait?:(ms:number,signal:AbortSignal)=>Promise<void>;
}
export function validateOracleSourceProviderOptions(options:OracleSourceProviderOptions):void{
  const u=options.url;
  if(u.protocol!=="wss:" || !u.hostname.toLowerCase().endsWith(".workers.dev") ||
    u.username || u.password || u.search || u.hash ||
    (u.port!=="" && u.port!=="443") || u.pathname!==ORACLE_SOURCE_CONNECT_PATH ||
    !/^[A-Za-z0-9_.-]{32,256}$/u.test(options.token) ||
    !options.port || typeof options.port.readMainHead!=="function" ||
    typeof options.port.readCommitChecks!=="function"){
    throw new Error("ORACLE_SOURCE_PROVIDER_CONFIG_INVALID");
  }
}
/** Outbound, bearer-isolated MCP V3 provider. Only two fixed GitHub reads
 * are accepted and each re-enters LocalAgent's authorization/audit pathway.
 * This socket never accepts a shell name, repository name, owner scope or
 * credential sent by Oracle. */
export class OracleSourceProviderConnector {
  private readonly factory:(url:URL,options:ClientOptions)=>WebSocket;
  private readonly wait:(ms:number,signal:AbortSignal)=>Promise<void>;
  constructor(private readonly options:OracleSourceProviderOptions,
    dependencies:OracleSourceProviderDependencies={}){
    validateOracleSourceProviderOptions(options);
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
      origin:ORACLE_SOURCE_ORIGIN,
      headers:{authorization:"Bearer "+this.options.token},
      handshakeTimeout:10_000,maxPayload:2048,perMessageDeflate:false,
      rejectUnauthorized:true,followRedirects:false,
    });
    return new Promise(resolve=>{
      let opened=false,settled=false;
      const inFlight=new Set<string>();
      const settle=()=>{
        if(settled)return;
        settled=true;signal.removeEventListener("abort",abort);
        socket.off("open",onOpen);socket.off("close",onClose);
        socket.off("error",onError);socket.off("message",onMessage);
        socket.on("error",()=>undefined);
        if(socket.readyState===WebSocket.OPEN || socket.readyState===WebSocket.CONNECTING)
          try{socket.terminate();}catch{/** Already closed. */}
        resolve(opened);
      };
      const onOpen=()=>{opened=true;};
      const onClose=()=>settle();
      const onError=()=>settle();
      const abort=()=>settle();
      const send=(frame:unknown)=>{
        if(settled || socket.readyState!==WebSocket.OPEN)return;
        const raw=JSON.stringify(frame);
        if(Buffer.byteLength(raw)>ORACLE_SOURCE_MAX_RESULT_BYTES){
          socket.close(1009,"result limit");return;
        }
        try{socket.send(raw);}catch{socket.close(1011,"send failure");}
      };
      const onMessage=(data:RawData,binary:boolean)=>{
        if(binary || settled || socket.readyState!==WebSocket.OPEN)return;
        const raw=Buffer.isBuffer(data)?data:Buffer.from(data as ArrayBuffer);
        if(raw.byteLength>2048){socket.close(1009,"request limit");return;}
        let value:unknown,command:OracleSourceReadCommand;
        try{
          value=JSON.parse(raw.toString("utf8")) as unknown;
          if(!value || typeof value!=="object" || Array.isArray(value))throw new Error("frame");
          const v=value as Record<string,unknown>;
          if(v.version!==1 || v.type!=="request" || typeof v.requestId!=="string" ||
            !UUID.test(v.requestId) || inFlight.has(v.requestId) || inFlight.size>=8 ||
            Object.keys(v).length!==5)throw new Error("frame");
          command=parseOracleSourceCommand({method:v.method,arguments:v.arguments});
        }catch{socket.close(1008,"invalid request");return;}
        const id=(value as {requestId:string}).requestId;
        inFlight.add(id);
        const action=Promise.resolve().then(()=>command.method==="read_main_head"
          ? this.options.port.readMainHead()
          : this.options.port.readCommitChecks(command.arguments.commitSha));
        void action.then(result=>{
          const validated=parseOracleSourceResult(command.method,result);
          send({version:1,type:"response",requestId:id,outcome:"success",result:validated});
        }).catch(()=>{
          // No raw GitHub errors, tokens, stack traces or repository identity.
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
