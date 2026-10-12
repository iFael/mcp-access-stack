import {
  ORACLE_CONTROL_DISPATCH_PATH, ORACLE_CONTROL_MAX_BODY_BYTES,
  parseOracleControlAdvance, oracleControlCanonicalBytes,
  type OracleControlAdvanceInput,
} from "@mcp-access-stack/update-control-contract";

const AUTH=/^HMAC-SHA256 v2=(0|[1-9][0-9]{0,11})\.([0-9a-f]{64})$/u;
const SKEW_SECONDS=300;
function bytesToHex(bytes:Uint8Array):string{
  return [...bytes].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function hexToBytes(hex:string):Uint8Array{
  const bytes=new Uint8Array(hex.length/2);
  for(let i=0;i<bytes.length;i++) bytes[i]=Number.parseInt(hex.slice(i*2,i*2+2),16);
  return bytes;
}
function exactBuffer(bytes:Uint8Array):ArrayBuffer{
  const copy=new Uint8Array(bytes.byteLength);copy.set(bytes);return copy.buffer;
}
async function readBounded(request:Request):Promise<string>{
  const len=request.headers.get("content-length");
  if(len!==null && (!/^\d+$/u.test(len) || Number(len)>ORACLE_CONTROL_MAX_BODY_BYTES))
    throw new Error("invalid_body");
  const body=await request.body?.getReader();
  if(!body)throw new Error("invalid_body");
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const next=await body.read();
      if(next.done)break;
      size+=next.value.byteLength;
      if(size>ORACLE_CONTROL_MAX_BODY_BYTES){await body.cancel();throw new Error("invalid_body");}
      chunks.push(next.value);
    }
  }finally{body.releaseLock();}
  const data=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.byteLength;}
  return new TextDecoder("utf-8",{fatal:true}).decode(data);
}
export interface VerifiedOracleControlRequest {
  readonly input:OracleControlAdvanceInput;
  readonly rawBody:string;
}
/** Separate bearer: the read-channel token, OAuth session and admin HMAC
 * are NOT accepted. The HMAC binds every argument, including operationId
 * and expected CAS, and authenticates a dedicated service principal. */
export async function verifyOracleControlRequest(
  request:Request,keyHex:string|undefined,
):Promise<VerifiedOracleControlRequest|null>{
  try{
    if(request.method!=="POST" || !/^[0-9a-f]{64}$/u.test(keyHex??""))return null;
    const url=new URL(request.url);
    if(url.pathname!==ORACLE_CONTROL_DISPATCH_PATH || url.search || url.hash ||
      url.protocol!=="https:" || url.username || url.password)return null;
    if((request.headers.get("content-type")??"").split(";",1)[0]?.trim().toLowerCase()!=="application/json")return null;
    const auth=AUTH.exec(request.headers.get("authorization")??"");
    if(!auth?.[1] || !auth[2])return null;
    const ts=Number(auth[1]);
    if(!Number.isSafeInteger(ts) || Math.abs(Math.floor(Date.now()/1000)-ts)>SKEW_SECONDS)return null;
    const rawBody=await readBounded(request);
    const input=parseOracleControlAdvance(JSON.parse(rawBody) as unknown);
    const digest=bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(rawBody))));
    const hmac=await crypto.subtle.importKey("raw",exactBuffer(hexToBytes(keyHex!)),{name:"HMAC",hash:"SHA-256"},false,["verify"]);
    const good=await crypto.subtle.verify("HMAC",hmac,exactBuffer(hexToBytes(auth[2])),
      exactBuffer(oracleControlCanonicalBytes(digest,input,auth[1])));
    return good?{input,rawBody}:null;
  }catch{return null;}
}
export { signOracleControlRequest } from "@mcp-access-stack/update-control-contract";
