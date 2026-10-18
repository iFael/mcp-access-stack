import {ORACLE_ACTIVE_DISPATCH_PATH,ORACLE_ACTIVE_MAX_BODY_BYTES,
  oracleActiveCanonicalBytes,parseOracleActiveCommand,
  type OracleActiveReadCommand} from "@mcp-access-stack/update-control-contract";
const SIGNATURE=/^HMAC-SHA256 active-v1=(0|[1-9][0-9]{0,11})\.([a-f0-9]{64})$/u;
function buffer(value:Uint8Array):ArrayBuffer{
  const copy=new Uint8Array(value.length);copy.set(value);return copy.buffer;
}
function unhex(value:string):Uint8Array{
  const result=new Uint8Array(value.length/2);
  for(let i=0;i<result.length;i++)result[i]=Number.parseInt(value.slice(i*2,i*2+2),16);
  return result;
}
function hex(value:Uint8Array):string{
  return [...value].map(x=>x.toString(16).padStart(2,"0")).join("");
}
/** Dedicated active-state HMAC verification, independent of all other realms. */
export async function verifyOracleActiveRequest(request:Request,key:string|undefined)
  :Promise<OracleActiveReadCommand|null>{
  try{
    if(request.method!=="POST" || !/^[a-f0-9]{64}$/u.test(key??""))return null;
    const url=new URL(request.url);
    if(url.protocol!=="https:" || url.username || url.password ||
      url.search || url.hash || url.pathname!==ORACLE_ACTIVE_DISPATCH_PATH)return null;
    if((request.headers.get("content-type")??"").split(";")[0]?.trim().toLowerCase()
      !=="application/json")return null;
    const signature=SIGNATURE.exec(request.headers.get("authorization")??"");
    if(!signature?.[1] || !signature[2] ||
      Math.abs(Math.floor(Date.now()/1000)-Number(signature[1]))>300)return null;
    const declared=request.headers.get("content-length");
    if(declared!==null && (!/^\d+$/u.test(declared) ||
      Number(declared)>ORACLE_ACTIVE_MAX_BODY_BYTES))return null;
    const reader=request.body?.getReader();
    if(!reader)return null;
    const parts:Uint8Array[]=[];let count=0;
    try{
      while(true){
        const part=await reader.read();
        if(part.done)break;
        count+=part.value.byteLength;
        if(count>ORACLE_ACTIVE_MAX_BODY_BYTES){await reader.cancel();return null;}
        parts.push(part.value);
      }
    }finally{reader.releaseLock();}
    const body=new Uint8Array(count);let offset=0;
    for(const part of parts){body.set(part,offset);offset+=part.byteLength;}
    const command=parseOracleActiveCommand(JSON.parse(
      new TextDecoder("utf8",{fatal:true}).decode(body)) as unknown);
    const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",buffer(body))));
    const imported=await crypto.subtle.importKey("raw",buffer(unhex(key!)),
      {name:"HMAC",hash:"SHA-256"},false,["verify"]);
    return await crypto.subtle.verify("HMAC",imported,buffer(unhex(signature[2])),
      buffer(oracleActiveCanonicalBytes(digest,signature[1])))?command:null;
  }catch{return null;}
}
