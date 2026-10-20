import {ORACLE_CANDIDATE_DISPATCH_PATH,ORACLE_CANDIDATE_MAX_BODY_BYTES,
  oracleCandidateCanonicalBytes,parseOracleCandidateCommand,
  type OracleCandidateReadCommand} from "@mcp-access-stack/update-control-contract";

const SIGNATURE=/^HMAC-SHA256 candidate-v1=(0|[1-9][0-9]{0,11})\.([a-f0-9]{64})$/u;
function decodeHex(s:string):Uint8Array{
  const result=new Uint8Array(s.length/2);
  for(let i=0;i<result.length;i++)result[i]=Number.parseInt(s.slice(i*2,i*2+2),16);
  return result;
}
function arrayBuffer(src:Uint8Array):ArrayBuffer{
  const result=new Uint8Array(src.byteLength);result.set(src);return result.buffer;
}
function hex(src:Uint8Array):string{return [...src].map(x=>x.toString(16).padStart(2,"0")).join("");}
/** Fully separate HMAC realm from GitHub, workflow and destructive control.
 * Only typed, read-only requests; no caller-selected path or workspace. */
export async function verifyOracleCandidateRequest(
  request:Request,key:string|undefined,
):Promise<OracleCandidateReadCommand|null>{
  try{
    if(request.method!=="POST" || !/^[a-f0-9]{64}$/u.test(key??""))return null;
    const url=new URL(request.url);
    if(url.protocol!=="https:" || url.username || url.password ||
      url.search || url.hash || url.pathname!==ORACLE_CANDIDATE_DISPATCH_PATH)return null;
    if((request.headers.get("content-type")??"").split(";")[0]?.trim().toLowerCase()!=="application/json")
      return null;
    const signature=SIGNATURE.exec(request.headers.get("authorization")??"");
    if(!signature?.[1] || !signature[2] ||
      Math.abs(Math.floor(Date.now()/1000)-Number(signature[1]))>300)return null;
    const length=request.headers.get("content-length");
    if(length!==null && (!/^\d+$/u.test(length) ||
      Number(length)>ORACLE_CANDIDATE_MAX_BODY_BYTES))return null;
    const stream=request.body?.getReader();
    if(!stream)return null;
    let size=0;const chunks:Uint8Array[]=[];
    try{
      while(true){
        const part=await stream.read();
        if(part.done)break;
        size+=part.value.byteLength;
        if(size>ORACLE_CANDIDATE_MAX_BODY_BYTES){await stream.cancel();return null;}
        chunks.push(part.value);
      }
    }finally{stream.releaseLock();}
    const body=new Uint8Array(size);let pos=0;
    for(const chunk of chunks){body.set(chunk,pos);pos+=chunk.byteLength;}
    const cmd=parseOracleCandidateCommand(JSON.parse(
      new TextDecoder("utf8",{fatal:true}).decode(body)) as unknown);
    const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",arrayBuffer(body))));
    const imported=await crypto.subtle.importKey("raw",arrayBuffer(decodeHex(key!)),
      {name:"HMAC",hash:"SHA-256"},false,["verify"]);
    return await crypto.subtle.verify("HMAC",imported,arrayBuffer(decodeHex(signature[2])),
      arrayBuffer(oracleCandidateCanonicalBytes(digest,signature[1])))?cmd:null;
  }catch{return null;}
}
