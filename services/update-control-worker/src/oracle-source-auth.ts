import {
  ORACLE_SOURCE_DISPATCH_PATH,ORACLE_SOURCE_MAX_BODY_BYTES,
  oracleSourceCanonicalBytes,parseOracleSourceCommand,
  type OracleSourceReadCommand,
} from "@mcp-access-stack/update-control-contract";
const SIGNATURE=/^HMAC-SHA256 source-v1=(0|[1-9][0-9]{0,11})\.([a-f0-9]{64})$/u;
function bytes(s:string):Uint8Array{
  const x=new Uint8Array(s.length/2);
  for(let i=0;i<x.length;i++)x[i]=Number.parseInt(s.slice(i*2,i*2+2),16);
  return x;
}
function ab(b:Uint8Array):ArrayBuffer{const copy=new Uint8Array(b.byteLength);copy.set(b);return copy.buffer;}
function hex(b:Uint8Array):string{return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}
export async function verifyOracleSourceRequest(
  request:Request,keyHex:string|undefined,
):Promise<OracleSourceReadCommand|null>{
  try{
    if(request.method!=="POST" || !/^[a-f0-9]{64}$/u.test(keyHex??""))return null;
    const url=new URL(request.url);
    if(url.protocol!=="https:" || url.username || url.password ||
      url.search || url.hash || url.pathname!==ORACLE_SOURCE_DISPATCH_PATH)return null;
    if((request.headers.get("content-type")??"").split(";")[0]?.trim().toLowerCase()!=="application/json")return null;
    const header=SIGNATURE.exec(request.headers.get("authorization")??"");
    if(!header?.[1] || !header[2] || Math.abs(Math.floor(Date.now()/1000)-Number(header[1]))>300)
      return null;
    const length=request.headers.get("content-length");
    if(length!==null && (!/^\d+$/u.test(length) || Number(length)>ORACLE_SOURCE_MAX_BODY_BYTES))return null;
    const reader=request.body?.getReader();
    if(!reader)return null;
    let count=0;const chunks:Uint8Array[]=[];
    try{
      while(true){
        const next=await reader.read();
        if(next.done)break;
        count+=next.value.byteLength;
        if(count>ORACLE_SOURCE_MAX_BODY_BYTES){await reader.cancel();return null;}
        chunks.push(next.value);
      }
    }finally{reader.releaseLock();}
    const body=new Uint8Array(count);let pos=0;
    for(const chunk of chunks){body.set(chunk,pos);pos+=chunk.byteLength;}
    const command=parseOracleSourceCommand(JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(body)) as unknown);
    const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",ab(body))));
    const key=await crypto.subtle.importKey("raw",ab(bytes(keyHex!)),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
    return await crypto.subtle.verify("HMAC",key,ab(bytes(header[2])),
      ab(oracleSourceCanonicalBytes(digest,header[1])))?command:null;
  }catch{return null;}
}
