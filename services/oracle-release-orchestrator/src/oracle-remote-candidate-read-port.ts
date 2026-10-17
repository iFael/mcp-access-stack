import {
  ORACLE_CANDIDATE_DISPATCH_PATH,ORACLE_CANDIDATE_MAX_RESULT_BYTES,
  parseOracleCandidateReceipt,signOracleCandidateRequest,
  type OracleCandidateReadReceipt,
} from "@mcp-access-stack/update-control-contract";
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const SHA=/^[a-f0-9]{40}$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export interface OracleRemoteCandidateOptions {
  readonly endpoint:string;
  readonly key:()=>Promise<string>;
  readonly fetchImpl?:typeof fetch;
}
function endpoint(raw:string):string{
  const u=new URL(raw);
  if(u.protocol!=="https:" || !u.hostname.toLowerCase().endsWith(".workers.dev") ||
    u.username || u.password || u.search || u.hash ||
    (u.port!=="" && u.port!=="443") ||
    u.pathname!==ORACLE_CANDIDATE_DISPATCH_PATH)
    throw new Error("ORACLE_CANDIDATE_ENDPOINT_INVALID");
  return u.href;
}
async function bounded(response:Response):Promise<unknown>{
  const reader=response.body?.getReader();
  if(!reader)throw new Error("ORACLE_CANDIDATE_RESPONSE_MISSING");
  const chunks:Uint8Array[]=[];let size=0;
  try{
    while(true){
      const part=await reader.read();
      if(part.done)break;
      size+=part.value.byteLength;
      if(size>ORACLE_CANDIDATE_MAX_RESULT_BYTES){
        await reader.cancel();throw new Error("ORACLE_CANDIDATE_RESPONSE_TOO_LARGE");
      }
      chunks.push(part.value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
  return JSON.parse(new TextDecoder("utf8",{fatal:true}).decode(bytes)) as unknown;
}
/** Oracle ledger principal holds a read-only HMAC credential, no release paths.
 * The execution node attests the actual bytes using its separate host scope. */
export class OracleRemoteCandidateReadPort{
  readonly endpoint:string;
  constructor(private readonly options:OracleRemoteCandidateOptions){
    this.endpoint=endpoint(options.endpoint);
  }
  async inspect(tag:string,commitSha:string,runId:string,
    operationId:string):Promise<OracleCandidateReadReceipt>{
    if(!TAG.test(tag) || tag.includes("..") || !SHA.test(commitSha) ||
      !UUID.test(runId) || !UUID.test(operationId))
      throw new Error("ORACLE_CANDIDATE_REQUEST_INVALID");
    const signed=await signOracleCandidateRequest({
      method:"read_candidate",arguments:{tag,commitSha,runId,operationId},
    },await this.options.key());
    const response=await (this.options.fetchImpl??fetch)(this.endpoint,{
      method:"POST",headers:{authorization:signed.authorization,
        "content-type":"application/json"},body:signed.body,
      cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15_000),
    });
    if(response.status!==200 ||
      !/^application\/json\b/iu.test(response.headers.get("content-type")??""))
      throw new Error("ORACLE_CANDIDATE_RESPONSE_UNVERIFIED");
    const payload=await bounded(response);
    if(!payload || typeof payload!=="object" || Array.isArray(payload) ||
      Object.keys(payload).length!==1 || !Object.hasOwn(payload,"result"))
      throw new Error("ORACLE_CANDIDATE_RESPONSE_INVALID");
    const receipt=parseOracleCandidateReceipt((payload as {result:unknown}).result);
    if(receipt.releaseTag!==tag || receipt.sourceCommitSha!==commitSha ||
      receipt.runId!==runId || receipt.operationId!==operationId)
      throw new Error("ORACLE_CANDIDATE_RECEIPT_MISMATCH");
    return receipt;
  }
}
