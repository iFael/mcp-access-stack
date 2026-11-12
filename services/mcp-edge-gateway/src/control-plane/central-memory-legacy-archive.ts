import type { CloudAuditStorage } from "./cloud-audit-store.js";

const PREFIX="central-memory-legacy:v1:";
const CHUNK_BYTES=24_576;
const FILES=["CURRENT_TASK.md","DECISIONS.md","HANDOFF.md","KNOWN_ISSUES.md",
  "NEXT_STEPS.md","PROJECT_CONTEXT.md"] as const;
type Filename=typeof FILES[number];
type Surface="oracle"|"windows";

export interface LegacyDocument {
  surface:Surface;
  filename:Filename;
  content:string;
  contentSha256:string;
}
interface FileEntry {
  surface:Surface;
  filename:Filename;
  contentSha256:string;
  bytes:number;
  chunks:number;
}
interface Manifest {
  version:1;
  importHash:string;
  totalBytes:number;
  files:FileEntry[];
}
function fail(reason:string):never{throw new Error("MEMORY_ARCHIVE_"+reason);}
function validScope(userId:string,repositoryId:string):void{
  if(!/^usr_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(userId)||
    !/^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(repositoryId))
    fail("SCOPE_INVALID");
}
async function hash(input:Uint8Array|string):Promise<string>{
  const bytes=typeof input==="string"?new TextEncoder().encode(input):input;
  const buffer=await crypto.subtle.digest("SHA-256",new Uint8Array(bytes));
  return [...new Uint8Array(buffer)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
function chunkKey(prefix:string,file:FileEntry,index:number):string{
  return prefix+"chunk:"+file.surface+":"+file.filename+":"+String(index).padStart(4,"0");
}
function encode64(bytes:Uint8Array):string{
  return btoa(String.fromCharCode(...bytes));
}
function decode64(encoded:string):Uint8Array{
  const decoded=atob(encoded);
  return Uint8Array.from(decoded,ch=>ch.charCodeAt(0));
}
async function validate(docs:readonly LegacyDocument[]):Promise<{
  files:Array<{file:FileEntry;bytes:Uint8Array}>;
  importHash:string;totalBytes:number;
}>{
  if(docs.length!==12)fail("INCOMPLETE");
  const sorted=[...docs].sort((a,b)=>(a.surface+":"+a.filename).localeCompare(b.surface+":"+b.filename));
  const expected=["oracle","windows"].flatMap(surface=>
    FILES.map(filename=>surface+":"+filename)).sort();
  const files:Array<{file:FileEntry;bytes:Uint8Array}>=[];
  let totalBytes=0;
  for(let i=0;i<sorted.length;i++){
    const doc=sorted[i]!;
    if(doc.surface+":"+doc.filename!==expected[i]||
       typeof doc.content!=="string"||
       !/^[0-9a-f]{64}$/u.test(doc.contentSha256))fail("INCOMPLETE");
    const bytes=new TextEncoder().encode(doc.content);
    if(bytes.length<1||bytes.length>500_000||await hash(bytes)!==doc.contentSha256)
      fail("SOURCE_MISMATCH");
    totalBytes+=bytes.length;
    files.push({file:{surface:doc.surface,filename:doc.filename,
      contentSha256:doc.contentSha256,bytes:bytes.length,
      chunks:Math.ceil(bytes.length/CHUNK_BYTES)},bytes});
  }
  if(totalBytes>3_000_000)fail("TOO_LARGE");
  const importHash=await hash(JSON.stringify(sorted.map(d=>({
    surface:d.surface,filename:d.filename,hash:d.contentSha256,
  }))));
  return {files,importHash,totalBytes};
}

/** Durable Object backup of original documents; never a second live memory. */
export class CentralMemoryLegacyArchive {
  constructor(private readonly storage:CloudAuditStorage){}
  async persist(userId:string,repositoryId:string,docs:readonly LegacyDocument[],
    expectedHash:string,expectedBytes:number):
    Promise<{importHash:string;replayed:boolean;totalBytes:number}> {
    validScope(userId,repositoryId);
    const validated=await validate(docs);
    if(validated.importHash!==expectedHash||validated.totalBytes!==expectedBytes)
      fail("RECEIPT_MISMATCH");
    const prefix=PREFIX+userId+":"+repositoryId+":";
    return this.storage.transaction(async txn=>{
      const prior=await txn.get<Manifest>(prefix+"manifest");
      if(prior){
        if(prior.version!==1||prior.importHash!==expectedHash||
          prior.totalBytes!==expectedBytes)fail("CONFLICT");
        return {importHash:expectedHash,replayed:true,totalBytes:expectedBytes};
      }
      const manifest:Manifest={version:1,importHash:expectedHash,totalBytes:expectedBytes,
        files:validated.files.map(x=>x.file)};
      for(const {file,bytes} of validated.files){
        for(let i=0;i<file.chunks;i++)
          await txn.put(chunkKey(prefix,file,i),encode64(
            bytes.subarray(i*CHUNK_BYTES,(i+1)*CHUNK_BYTES)));
      }
      await txn.put(prefix+"manifest",manifest);
      return {importHash:expectedHash,replayed:false,totalBytes:expectedBytes};
    });
  }
  async exportVerified(userId:string,repositoryId:string):Promise<{
    importHash:string;totalBytes:number;documents:LegacyDocument[];
  }>{
    validScope(userId,repositoryId);
    const prefix=PREFIX+userId+":"+repositoryId+":";
    const manifest=await this.storage.get<Manifest>(prefix+"manifest");
    if(!manifest||manifest.version!==1||manifest.files.length!==12)fail("MISSING");
    let totalBytes=0;
    const documents:LegacyDocument[]=[];
    for(const file of manifest.files){
      if(file.bytes<1||file.bytes>500_000||file.chunks!==Math.ceil(file.bytes/CHUNK_BYTES))
        fail("CORRUPT");
      const bytes=new Uint8Array(file.bytes);
      let offset=0;
      for(let i=0;i<file.chunks;i++){
        const chunk=await this.storage.get<string>(chunkKey(prefix,file,i));
        if(typeof chunk!=="string")fail("INCOMPLETE");
        let part:Uint8Array;
        try{part=decode64(chunk);}catch{fail("CORRUPT");}
        if(part.length!==Math.min(CHUNK_BYTES,file.bytes-offset))fail("CORRUPT");
        bytes.set(part,offset);offset+=part.length;
      }
      if(await hash(bytes)!==file.contentSha256)fail("CORRUPT");
      let content:string;
      try{content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
      catch{fail("CORRUPT");}
      totalBytes+=bytes.length;
      documents.push({surface:file.surface,filename:file.filename,content,
        contentSha256:file.contentSha256});
    }
    const verified=await validate(documents);
    if(verified.importHash!==manifest.importHash||
      verified.totalBytes!==manifest.totalBytes||totalBytes!==manifest.totalBytes)
      fail("CORRUPT");
    return {importHash:manifest.importHash,totalBytes,documents};
  }
}

/** Verify the Oracle mutation receipt before writing its off-host copy. */
export async function mirrorLegacyImportResponse(
  storage:CloudAuditStorage,userId:string,args:Record<string,unknown>,response:Response,
):Promise<"persisted"|"upstream_error">{
  if(!response.ok)return "upstream_error";
  let payload:unknown;
  try{payload=await response.clone().json();}catch{fail("RECEIPT_INVALID");}
  if(payload===null||typeof payload!=="object"||!("result" in payload))
    fail("RECEIPT_INVALID");
  const result=(payload as {result?:unknown}).result;
  if(result===null||typeof result!=="object")fail("RECEIPT_INVALID");
  const outcome=result as {isError?:boolean;structuredContent?:unknown};
  if(outcome.isError===true)return "upstream_error";
  const receipt=outcome.structuredContent as Record<string,unknown>|undefined;
  if(!receipt||args.action!=="import_legacy"||
    typeof args.repositoryId!=="string"||
    receipt.repositoryId!==args.repositoryId||
    receipt.filesImported!==12||
    typeof receipt.importHash!=="string"||
    typeof receipt.totalBytes!=="number"||
    !Array.isArray(args.documents))fail("RECEIPT_INVALID");
  await new CentralMemoryLegacyArchive(storage).persist(
    userId,args.repositoryId,args.documents as LegacyDocument[],
    receipt.importHash,receipt.totalBytes);
  return "persisted";
}
