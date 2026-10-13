import {
  ORACLE_WORKFLOW_DISPATCH_PATH,ORACLE_WORKFLOW_MAX_BODY_BYTES,
  oracleWorkflowCanonicalBytes,parseOracleWorkflowCommand,
  type OracleWorkflowCommand,
} from "@mcp-access-stack/update-control-contract";

const SIGNATURE=/^HMAC-SHA256 workflow-v1=(0|[1-9][0-9]{0,11})\.([a-f0-9]{64})$/u;
function unhex(s:string):Uint8Array {
  const a=new Uint8Array(s.length/2);
  for(let i=0;i<a.length;i++)a[i]=Number.parseInt(s.slice(i*2,i*2+2),16);
  return a;
}
function ab(b:Uint8Array):ArrayBuffer {
  const a=new Uint8Array(b.length);a.set(b);return a.buffer;
}
function hex(b:Uint8Array):string {return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");}

/** Separate HMAC and canonical domain from read-source/control. Never
 * dispatch on an unauthenticated, expired or non-canonical body. */
export async function verifyOracleWorkflowRequest(
  request:Request,keyHex:string|undefined,
):Promise<OracleWorkflowCommand|null>{
  try {
    if(request.method!=="POST" || !/^[a-f0-9]{64}$/u.test(keyHex??""))return null;
    const url=new URL(request.url);
    if(url.protocol!=="https:" || url.username || url.password || url.search || url.hash ||
      url.pathname!==ORACLE_WORKFLOW_DISPATCH_PATH)return null;
    if((request.headers.get("content-type")??"").split(";")[0]?.trim().toLowerCase()!=="application/json")
      return null;
    const signature=SIGNATURE.exec(request.headers.get("authorization")??"");
    if(!signature?.[1] || !signature[2] ||
      Math.abs(Math.floor(Date.now()/1000)-Number(signature[1]))>300)return null;
    const length=request.headers.get("content-length");
    if(length!==null && (!/^\d+$/u.test(length) || Number(length)>ORACLE_WORKFLOW_MAX_BODY_BYTES))
      return null;
    const reader=request.body?.getReader();
    if(!reader)return null;
    let size=0;const chunks:Uint8Array[]=[];
    try{
      while(true){
        const part=await reader.read();
        if(part.done)break;
        size+=part.value.byteLength;
        if(size>ORACLE_WORKFLOW_MAX_BODY_BYTES){await reader.cancel();return null;}
        chunks.push(part.value);
      }
    }finally{reader.releaseLock();}
    const body=new Uint8Array(size);let pos=0;
    for(const chunk of chunks){body.set(chunk,pos);pos+=chunk.byteLength;}
    const command=parseOracleWorkflowCommand(JSON.parse(
      new TextDecoder("utf8",{fatal:true}).decode(body)) as unknown);
    // Reject alternate JSON encodings under a valid signature; one encoding
    // produces one exact intent digest at all transport hops.
    if(new TextDecoder().decode(body)!==JSON.stringify(command))return null;
    const digest=hex(new Uint8Array(await crypto.subtle.digest("SHA-256",ab(body))));
    const key=await crypto.subtle.importKey("raw",ab(unhex(keyHex!)),
      {name:"HMAC",hash:"SHA-256"},false,["verify"]);
    const valid=await crypto.subtle.verify("HMAC",key,ab(unhex(signature[2])),
      ab(oracleWorkflowCanonicalBytes(digest,signature[1])));
    return valid?command:null;
  } catch {return null;}
}
