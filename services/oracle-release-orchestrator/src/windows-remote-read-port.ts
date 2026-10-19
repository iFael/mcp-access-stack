import {randomUUID} from "node:crypto";
import {
  WINDOWS_READ_DISPATCH_PATH,WINDOWS_READ_MAX_RESULT_BYTES,
  parseWindowsReadResult,signWindowsReadRequest,
  type WindowsReadCommand,type WindowsReadResult,
  type WindowsReadProof,type WindowsReadState,
} from "@mcp-access-stack/update-control-contract";
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface WindowsRemoteReadOptions{
  readonly endpoint:string;
  readonly key:()=>Promise<string>;
  readonly fetchImpl?:typeof fetch;
}
function endpoint(raw:string):string{
  const url=new URL(raw);
  if(url.protocol!=="https:" || !url.hostname.toLowerCase().endsWith(".workers.dev") ||
    url.username || url.password || url.search || url.hash ||
    (url.port!=="" && url.port!=="443") ||
    url.pathname!==WINDOWS_READ_DISPATCH_PATH)
    throw new Error("WINDOWS_READ_ENDPOINT_INVALID");
  return url.href;
}
async function bounded(response:Response):Promise<unknown>{
  const reader=response.body?.getReader();
  if(!reader)throw new Error("WINDOWS_READ_RESPONSE_MISSING");
  const parts:Uint8Array[]=[];let len=0;
  try{
    while(true){
      const next=await reader.read();
      if(next.done)break;
      len+=next.value.byteLength;
      if(len>WINDOWS_READ_MAX_RESULT_BYTES){
        await reader.cancel();
        throw new Error("WINDOWS_READ_RESPONSE_OVERSIZE");
      }
      parts.push(next.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(len);let position=0;
  for(const part of parts){bytes.set(part,position);position+=part.byteLength;}
  return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes)) as unknown;
}
/** This remains DISCONNECTED until a Windows-specific Worker HMAC route and
 * owner-controlled provider exist. Local hash evidence is never a trusted
 * WindowsCandidateReceipt or an active runtime health observation. */
export class WindowsRemoteReadPort{
  readonly endpoint:string;
  constructor(private readonly options:WindowsRemoteReadOptions){
    this.endpoint=endpoint(options.endpoint);
  }
  private async read(command:WindowsReadCommand):Promise<WindowsReadResult>{
    const signed=await signWindowsReadRequest(command,await this.options.key());
    const response=await (this.options.fetchImpl??fetch)(this.endpoint,{
      method:"POST",headers:{authorization:signed.authorization,
        "content-type":"application/json"},body:signed.body,cache:"no-store",
      redirect:"error",signal:AbortSignal.timeout(15_000),
    });
    if(response.status!==200 ||
      !/^application\/json\b/iu.test(response.headers.get("content-type")??""))
      throw new Error("WINDOWS_READ_RESPONSE_UNVERIFIED");
    const payload=await bounded(response);
    if(!payload || typeof payload!=="object" || Array.isArray(payload) ||
      Object.keys(payload).length!==1 || !Object.hasOwn(payload,"result"))
      throw new Error("WINDOWS_READ_RESPONSE_INVALID");
    return parseWindowsReadResult(command,
      (payload as {result:unknown}).result);
  }
  async getState():Promise<WindowsReadState>{
    const result=await this.read({method:"get_state",
      arguments:{requestId:randomUUID()}});
    if(result.method!=="get_state")throw new Error("WINDOWS_READ_STATE_INVALID");
    return result.state;
  }
  async inspectCandidate(tag:string,commitSha:string,runId:string,
    operationId:string,prepareOperationId:string):Promise<WindowsReadProof>{
    if(!TAG.test(tag) || tag.includes("..") || !SHA.test(commitSha) ||
      !UUID.test(runId) || !UUID.test(operationId) ||
      !UUID.test(prepareOperationId))
      throw new Error("WINDOWS_READ_CANDIDATE_ARGS_INVALID");
    const result=await this.read({method:"inspect_candidate",arguments:{
      requestId:randomUUID(),tag,commitSha,runId,operationId,prepareOperationId,
    }});
    if(result.method!=="inspect_candidate")
      throw new Error("WINDOWS_READ_CANDIDATE_INVALID");
    return result.proof;
  }
  async inspectActive(tag:string,commitSha:string):Promise<WindowsReadProof>{
    if(!TAG.test(tag) || tag.includes("..") || !SHA.test(commitSha))
      throw new Error("WINDOWS_READ_ACTIVE_ARGS_INVALID");
    const result=await this.read({method:"inspect_active",arguments:{
      requestId:randomUUID(),tag,commitSha,
    }});
    if(result.method!=="inspect_active")
      throw new Error("WINDOWS_READ_ACTIVE_INVALID");
    return result.proof;
  }
}
