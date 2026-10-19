import {WINDOWS_READ_DISPATCH_PATH,WINDOWS_READ_MAX_BODY_BYTES,
  windowsReadCanonicalBytes,parseWindowsReadCommand,
  type WindowsReadCommand} from "@mcp-access-stack/update-control-contract";
const SIGNATURE=/^HMAC-SHA256 windows-read-v1=(0|[1-9][0-9]{0,11})\.([a-f0-9]{64})$/u;
function bytes(value:Uint8Array):ArrayBuffer{
  const copy=new Uint8Array(value.byteLength);copy.set(value);return copy.buffer;
}
function unhex(value:string):Uint8Array{
  const result=new Uint8Array(value.length/2);
  for(let i=0;i<result.length;i++)
    result[i]=Number.parseInt(value.slice(i*2,i*2+2),16);
  return result;
}
function hex(value:Uint8Array):string{
  return [...value].map(n=>n.toString(16).padStart(2,"0")).join("");
}
/** Independent Windows-only read realm. No mutation, paths or shared Oracle
 * authentication domains. The DO still requires separate provider enrollment. */
export async function verifyWindowsReadRequest(request:Request,key:string|undefined)
  :Promise<WindowsReadCommand|null>{
  try{
    if(request.method!=="POST" || !/^[a-f0-9]{64}$/u.test(key??""))return null;
    const url=new URL(request.url);
    if(url.protocol!=="https:" || url.username || url.password ||
      url.search || url.hash || url.pathname!==WINDOWS_READ_DISPATCH_PATH)
      return null;
    if((request.headers.get("content-type")??"").split(";")[0]?.trim().toLowerCase()
      !=="application/json")return null;
    const signed=SIGNATURE.exec(request.headers.get("authorization")??"");
    if(!signed?.[1] || !signed[2] ||
      Math.abs(Math.floor(Date.now()/1000)-Number(signed[1]))>300)return null;
    const declared=request.headers.get("content-length");
    if(declared!==null && (!/^\d+$/u.test(declared) ||
      Number(declared)>WINDOWS_READ_MAX_BODY_BYTES))return null;
    const reader=request.body?.getReader();
    if(!reader)return null;
    let size=0;const chunks:Uint8Array[]=[];
    try{
      while(true){
        const chunk=await reader.read();
        if(chunk.done)break;
        size+=chunk.value.byteLength;
        if(size>WINDOWS_READ_MAX_BODY_BYTES){await reader.cancel();return null;}
        chunks.push(chunk.value);
      }
    }finally{reader.releaseLock();}
    const body=new Uint8Array(size);let offset=0;
    for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
    const command=parseWindowsReadCommand(JSON.parse(
      new TextDecoder("utf8",{fatal:true}).decode(body)) as unknown);
    const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes(body))));
    const keyHandle=await crypto.subtle.importKey("raw",bytes(unhex(key!)),
      {name:"HMAC",hash:"SHA-256"},false,["verify"]);
    return await crypto.subtle.verify("HMAC",keyHandle,bytes(unhex(signed[2])),
      bytes(windowsReadCanonicalBytes(digest,signed[1])))?command:null;
  }catch{return null;}
}
