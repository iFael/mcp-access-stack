import WebSocket,{type ClientOptions,type RawData} from "ws";
import {
  WINDOWS_READ_CONNECT_PATH,WINDOWS_READ_ORIGIN,
  WINDOWS_READ_MAX_RESULT_BYTES,WINDOWS_READ_MAX_BODY_BYTES,
  parseWindowsReadCommand,parseWindowsReadResult,
  type WindowsReadCommand,type WindowsReadProof,type WindowsReadState,
} from "@mcp-access-stack/update-control-contract";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const MAX_FRAME_BYTES=2048;
const MAX_IN_FLIGHT=4;

/** Must be supplied by an independently trusted, Windows-native reader.
 * The connector never materializes a release, assigns operation IDs, or
 * converts local hash observations into authenticated release receipts. */
export interface WindowsReadProviderPort{
  getState():Promise<WindowsReadState>;
  inspectCandidate(tag:string,commitSha:string,runId:string,
    operationId:string,prepareOperationId:string):Promise<WindowsReadProof>;
  inspectActive(tag:string,commitSha:string):Promise<WindowsReadProof>;
}
export interface WindowsReadProviderOptions{
  readonly url:URL;
  readonly token:string;
  readonly port:WindowsReadProviderPort;
}
export interface WindowsReadProviderDependencies{
  readonly socketFactory?:(url:URL,options:ClientOptions)=>WebSocket;
  readonly wait?:(ms:number,signal:AbortSignal)=>Promise<void>;
}
export function validateWindowsReadProviderOptions(options:WindowsReadProviderOptions):void{
  const url=options.url;
  if(url.protocol!=="wss:" || !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    url.username || url.password || url.search || url.hash ||
    (url.port!=="" && url.port!=="443") ||
    url.pathname!==WINDOWS_READ_CONNECT_PATH ||
    !/^[A-Za-z0-9_.-]{32,256}$/u.test(options.token) ||
    typeof options.port?.getState!=="function" ||
    typeof options.port?.inspectCandidate!=="function" ||
    typeof options.port?.inspectActive!=="function")
    throw new Error("WINDOWS_READ_PROVIDER_CONFIG_INVALID");
}

/** WSS transport only. No host enrollment or native execution is enabled. */
export class WindowsReadProviderConnector{
  private readonly socketFactory:(url:URL,options:ClientOptions)=>WebSocket;
  private readonly wait:(ms:number,signal:AbortSignal)=>Promise<void>;
  constructor(private readonly options:WindowsReadProviderOptions,
    deps:WindowsReadProviderDependencies={}){
    validateWindowsReadProviderOptions(options);
    this.socketFactory=deps.socketFactory??((url,opts)=>new WebSocket(url,opts));
    this.wait=deps.wait??(async(ms,signal)=>new Promise<void>((resolve,reject)=>{
      if(signal.aborted){reject(new Error("aborted"));return;}
      const timer=setTimeout(()=>{signal.removeEventListener("abort",abort);resolve();},ms);
      const abort=()=>{clearTimeout(timer);reject(new Error("aborted"));};
      signal.addEventListener("abort",abort,{once:true});
    }));
  }
  async run(signal:AbortSignal):Promise<void>{
    let delay=1000;
    while(!signal.aborted){
      const opened=await this.connect(signal);
      if(signal.aborted)break;
      delay=opened?1000:Math.min(30_000,delay*2);
      try{await this.wait(delay,signal);}catch{break;}
    }
  }
  private connect(signal:AbortSignal):Promise<boolean>{
    const socket=this.socketFactory(this.options.url,{
      origin:WINDOWS_READ_ORIGIN,
      headers:{authorization:"Bearer "+this.options.token},
      handshakeTimeout:10_000,maxPayload:MAX_FRAME_BYTES,
      perMessageDeflate:false,rejectUnauthorized:true,followRedirects:false,
    });
    return new Promise(resolve=>{
      let opened=false,settled=false;
      const pending=new Set<string>();
      const settle=()=>{
        if(settled)return;settled=true;
        signal.removeEventListener("abort",abort);
        socket.off("open",onOpen);socket.off("close",onClose);
        socket.off("error",onError);socket.off("message",onMessage);
        socket.on("error",()=>undefined);
        if(socket.readyState===WebSocket.OPEN || socket.readyState===WebSocket.CONNECTING)
          try{socket.terminate();}catch{/** already closed */}
        resolve(opened);
      };
      const onOpen=()=>{opened=true;};
      const onClose=()=>settle(),onError=()=>settle(),abort=()=>settle();
      const send=(frame:unknown)=>{
        if(settled || socket.readyState!==WebSocket.OPEN)return;
        const data=JSON.stringify(frame);
        if(Buffer.byteLength(data,"utf8")>WINDOWS_READ_MAX_RESULT_BYTES){
          socket.close(1009,"result limit");return;
        }
        try{socket.send(data);}catch{socket.close(1011,"send failure");}
      };
      const onMessage=(input:RawData,binary:boolean)=>{
        if(binary || settled || socket.readyState!==WebSocket.OPEN){
          if(binary)socket.close(1003,"text frames required");
          return;
        }
        const data=Buffer.isBuffer(input)?input:Buffer.from(input as ArrayBuffer);
        if(data.byteLength>MAX_FRAME_BYTES){
          socket.close(1009,"request limit");return;
        }
        let command:WindowsReadCommand,id:string;
        try{
          const value=JSON.parse(data.toString("utf8")) as unknown;
          if(!value || typeof value!=="object" || Array.isArray(value))
            throw new Error("frame");
          const frame=value as Record<string,unknown>;
          if(frame.version!==1 || frame.type!=="request" ||
            typeof frame.requestId!=="string" || !UUID.test(frame.requestId) ||
            pending.has(frame.requestId) || pending.size>=MAX_IN_FLIGHT ||
            Object.keys(frame).length!==5)throw new Error("frame");
          command=parseWindowsReadCommand({method:frame.method,arguments:frame.arguments});
          if(Buffer.byteLength(JSON.stringify(command),"utf8")>WINDOWS_READ_MAX_BODY_BYTES)
            throw new Error("command too large");
          id=frame.requestId;
        }catch{socket.close(1008,"invalid request");return;}
        pending.add(id);
        void Promise.resolve().then(async()=>{
          let response:unknown;
          if(command.method==="get_state"){
            response={method:"get_state",requestId:command.arguments.requestId,
              scope:"local_hash_integrity_only",
              state:await this.options.port.getState()};
          }else if(command.method==="inspect_active"){
            response={method:"inspect_active",requestId:command.arguments.requestId,
              proof:await this.options.port.inspectActive(
                command.arguments.tag,command.arguments.commitSha)};
          }else{
            const args=command.arguments;
            response={method:"inspect_candidate",requestId:args.requestId,
              proof:await this.options.port.inspectCandidate(args.tag,args.commitSha,
                args.runId,args.operationId,args.prepareOperationId)};
          }
          return parseWindowsReadResult(command,response);
        }).then(result=>send({version:1,type:"response",requestId:id,
          outcome:"success",result}))
          .catch(()=>send({version:1,type:"response",requestId:id,
            outcome:"error",errorCode:"UPDATE_ORCHESTRATOR_UNAVAILABLE"}))
          .finally(()=>pending.delete(id));
      };
      socket.on("open",onOpen);socket.on("close",onClose);
      socket.on("error",onError);socket.on("message",onMessage);
      signal.addEventListener("abort",abort,{once:true});
      if(signal.aborted)abort();
    });
  }
}
