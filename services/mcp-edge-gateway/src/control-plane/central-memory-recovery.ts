import type { CloudAuditStorage } from "./cloud-audit-store.js";

const USER_ID=/^usr_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REPO_ID=/^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECORD_ID=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const OP_ID=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const KINDS=new Set(["decision","context","task","issue","note"]);
const CONFIDENCES=new Set(["user_reported","inferred"]);
const STATUSES=new Set(["active","resolved"]);
const PREFIX="central-memory-recovery:v1:";


function object(value:unknown):value is Record<string,unknown> {
  return value!==null && typeof value==="object" && !Array.isArray(value);
}
/**
 * Persist an Oracle-authoritative memory_update receipt before acknowledging it
 * to the agent. An Oracle commit with an unavailable replica is outcome-unknown
 * to the client: retry the SAME operationId; Oracle and Edge both replay safely.
 */
export async function mirrorMemoryUpdateResponse(
  storage:RecoveryStorage,userId:string,
  arguments_:Record<string,unknown>,response:Response,
):Promise<"persisted"|"upstream_error"> {
  if(!response.ok) return "upstream_error";
  let payload:unknown;
  try {payload=await response.clone().json();}catch{bad("RECEIPT_INVALID");}
  if(!object(payload)||!object(payload.result)) bad("RECEIPT_INVALID");
  const result=payload.result;
  if(result.isError===true) return "upstream_error";
  if(!object(result.structuredContent)||!object(result.structuredContent.record)) {
    bad("RECEIPT_INVALID");
  }
  const record=result.structuredContent.record as unknown as RecoveryRecord;
  const repositoryId=arguments_.repositoryId;
  const operationId=arguments_.operationId;
  const expectedRevision=arguments_.expectedRevision;
  if(typeof repositoryId!=="string"||typeof operationId!=="string"||
    typeof expectedRevision!=="number"||
    arguments_.recordId!==record.recordId||
    (arguments_.action==="resolve"
      ?record.status!=="resolved"
      :record.status!=="active")||
    (arguments_.action!=="resolve"&&
      !["create","revise"].includes(String(arguments_.action)))) bad("RECEIPT_INVALID");
  if(arguments_.action!=="resolve"){
    const expected=["kind","confidence","title","content","evidenceRefs"] as const;
    for(const key of expected){
      if(JSON.stringify(arguments_[key])!==JSON.stringify(record[key])) {
        bad("RECEIPT_INVALID");
      }
    }
  }
  await new CentralMemoryRecovery(storage).append(
    userId,repositoryId,operationId,expectedRevision,record,
  );
  return "persisted";
}




const LEGACY_FILES=["CURRENT_TASK.md","DECISIONS.md","HANDOFF.md",
  "KNOWN_ISSUES.md","NEXT_STEPS.md","PROJECT_CONTEXT.md"] as const;
type LegacyFile=typeof LEGACY_FILES[number];
type LegacyDocument={surface:"oracle"|"windows";filename:LegacyFile;content:string;contentSha256:string};
type LegacyEntry={surface:LegacyDocument["surface"];filename:LegacyFile;contentSha256:string;bytes:number;chunks:number};
type LegacyManifest={version:1;operationId:string;importHash:string;totalBytes:number;files:LegacyEntry[]};
const CHUNK_BYTES=24_576;
const legacyPrefix=(userId:string,repositoryId:string)=>
  PREFIX+userId+":"+repositoryId+":legacy:";
const chunkKey=(prefix:string,file:LegacyEntry,index:number)=>
  prefix+"chunk:"+file.surface+":"+file.filename+":"+String(index).padStart(4,"0");
function encodeBytes(bytes:Uint8Array):string{return btoa(String.fromCharCode(...bytes));}
function decodeBytes(base64:string):Uint8Array{
  return Uint8Array.from(atob(base64),character=>character.charCodeAt(0));
}

export class CentralMemoryLegacyBackup {
  constructor(private readonly storage:RecoveryStorage){}
  async archive(
    userId:string,repositoryId:string,operationId:string,
    documents:readonly LegacyDocument[],importHash:string,expectedBytes:number,
  ):Promise<{importHash:string;totalBytes:number;replayed:boolean}>{
    if(!USER_ID.test(userId)||!REPO_ID.test(repositoryId)||!OP_ID.test(operationId)||
      !/^[0-9a-f]{64}$/u.test(importHash)||documents.length!==12)bad("LEGACY_INPUT_INVALID");
    const sorted=[...documents].sort((a,b)=>
      (a.surface+":"+a.filename).localeCompare(b.surface+":"+b.filename));
    const expected=["oracle","windows"].flatMap(surface=>
      LEGACY_FILES.map(filename=>surface+":"+filename)).sort();
    const fileData:Array<{entry:LegacyEntry;bytes:Uint8Array}>=[];
    let totalBytes=0;
    for(let i=0;i<sorted.length;i++){
      const d=sorted[i]!;
      if(d.surface+":"+d.filename!==expected[i]||typeof d.content!=="string"||
        !/^[0-9a-f]{64}$/u.test(d.contentSha256))bad("LEGACY_INPUT_INVALID");
      const bytes=new TextEncoder().encode(d.content);
      if(bytes.length<1||bytes.length>500_000||
        await digest(d.content)!==d.contentSha256)bad("LEGACY_SOURCE_MISMATCH");
      totalBytes+=bytes.length;
      fileData.push({entry:{
        surface:d.surface,filename:d.filename,contentSha256:d.contentSha256,
        bytes:bytes.length,chunks:Math.ceil(bytes.length/CHUNK_BYTES),
      },bytes});
    }
    if(totalBytes>3_000_000||totalBytes!==expectedBytes)bad("LEGACY_SIZE_MISMATCH");
    const actualHash=await digest(JSON.stringify(sorted.map(d=>({
      surface:d.surface,filename:d.filename,hash:d.contentSha256,
    }))));
    if(actualHash!==importHash)bad("LEGACY_RECEIPT_MISMATCH");
    const prefix=legacyPrefix(userId,repositoryId);
    return this.storage.transaction(async txn=>{
      const previous=await txn.get<LegacyManifest>(prefix+"manifest");
      if(previous){
        if(previous.version!==1||previous.importHash!==importHash||
          previous.operationId!==operationId||previous.totalBytes!==totalBytes)
          bad("LEGACY_CONFLICT");
        return {importHash,totalBytes,replayed:true};
      }
      for(const {entry,bytes} of fileData){
        for(let index=0;index<entry.chunks;index++){
          const fragment=bytes.subarray(index*CHUNK_BYTES,(index+1)*CHUNK_BYTES);
          await txn.put(chunkKey(prefix,entry,index),encodeBytes(fragment));
        }
      }
      await txn.put(prefix+"manifest",{
        version:1,operationId,importHash,totalBytes,files:fileData.map(d=>d.entry),
      } satisfies LegacyManifest);
      return {importHash,totalBytes,replayed:false};
    });
  }

  async restore(userId:string,repositoryId:string):
    Promise<{importHash:string;totalBytes:number;documents:LegacyDocument[]}>{
    if(!USER_ID.test(userId)||!REPO_ID.test(repositoryId))bad("LEGACY_INPUT_INVALID");
    const prefix=legacyPrefix(userId,repositoryId);
    const manifest=await this.storage.get<LegacyManifest>(prefix+"manifest");
    if(!manifest||manifest.version!==1||manifest.files.length!==12)bad("LEGACY_MISSING");
    const documents:LegacyDocument[]=[];
    let totalBytes=0;
    for(const entry of manifest.files){
      if(entry.bytes<1||entry.bytes>500_000||
        entry.chunks!==Math.ceil(entry.bytes/CHUNK_BYTES))bad("LEGACY_CORRUPT");
      const bytes=new Uint8Array(entry.bytes);
      let offset=0;
      for(let i=0;i<entry.chunks;i++){
        const text=await this.storage.get<string>(chunkKey(prefix,entry,i));
        if(typeof text!=="string")bad("LEGACY_INCOMPLETE");
        let chunk:Uint8Array;
        try{chunk=decodeBytes(text);}catch{bad("LEGACY_CORRUPT");}
        if(chunk.length!==Math.min(CHUNK_BYTES,entry.bytes-offset))bad("LEGACY_CORRUPT");
        bytes.set(chunk,offset);offset+=chunk.length;
      }
      let content:string;
      try{content=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}
      catch{bad("LEGACY_CORRUPT");}
      if(await digest(content)!==entry.contentSha256)bad("LEGACY_CORRUPT");
      documents.push({surface:entry.surface,filename:entry.filename,
        content,contentSha256:entry.contentSha256});
      totalBytes+=bytes.length;
    }
    if(totalBytes!==manifest.totalBytes)bad("LEGACY_CORRUPT");
    const sorted=[...documents].sort((a,b)=>
      (a.surface+":"+a.filename).localeCompare(b.surface+":"+b.filename));
    const expected=["oracle","windows"].flatMap(surface=>
      LEGACY_FILES.map(filename=>surface+":"+filename)).sort();
    if(sorted.some((d,i)=>d.surface+":"+d.filename!==expected[i]))bad("LEGACY_CORRUPT");
    if(await digest(JSON.stringify(sorted.map(d=>({
      surface:d.surface,filename:d.filename,hash:d.contentSha256,
    }))))!==manifest.importHash)bad("LEGACY_CORRUPT");
    return {importHash:manifest.importHash,totalBytes,documents:sorted};
  }
}
export async function mirrorLegacyImportResponse(
  storage:RecoveryStorage,userId:string,args:Record<string,unknown>,response:Response,
):Promise<"persisted"|"upstream_error">{
  if(!response.ok)return "upstream_error";
  let payload:unknown;
  try{payload=await response.clone().json();}catch{bad("LEGACY_RECEIPT_INVALID");}
  if(!object(payload)||!object(payload.result))bad("LEGACY_RECEIPT_INVALID");
  const result=payload.result;
  if(result.isError===true)return "upstream_error";
  const receipt=result.structuredContent;
  if(!object(receipt)||args.action!=="import_legacy"||
    typeof args.operationId!=="string"||typeof args.repositoryId!=="string"||
    receipt.repositoryId!==args.repositoryId||receipt.filesImported!==12||
    typeof receipt.importHash!=="string"||typeof receipt.totalBytes!=="number"||
    !Array.isArray(args.documents))bad("LEGACY_RECEIPT_INVALID");
  await new CentralMemoryLegacyBackup(storage).archive(
    userId,args.repositoryId,args.operationId,args.documents as LegacyDocument[],
    receipt.importHash,receipt.totalBytes,
  );
  return "persisted";
}

export interface RecoveryRecord {
  repositoryId:string;
  recordId:string;
  kind:string;
  status:string;
  confidence:string;
  title:string;
  content:string;
  evidenceRefs:string[];
  revision:number;
  updatedAt:string;
}
export interface RecoveryEntry {
  version:1;
  operationId:string;
  record:RecoveryRecord;
  recordDigest:string;
  previousDigest:string;
  chainDigest:string;
}
type RecordHead={revision:number;chainDigest:string};
type RecoveryManifest={records:number;events:number};
type OperationReceipt={repositoryId:string;recordId:string;revision:number;recordDigest:string};

function bad(code:string):never {throw new Error("MEMORY_RECOVERY_"+code);}
function validRecord(record:RecoveryRecord, repositoryId:string):void {
  if(record.repositoryId!==repositoryId||!REPO_ID.test(repositoryId)||
    !RECORD_ID.test(record.recordId)||!KINDS.has(record.kind)||
    !STATUSES.has(record.status)||!CONFIDENCES.has(record.confidence)||
    !Number.isSafeInteger(record.revision)||record.revision<1||
    typeof record.title!=="string"||record.title.length<1||record.title.length>200||
    typeof record.content!=="string"||record.content.length<1||
    new TextEncoder().encode(record.content).length>24_000||
    !Array.isArray(record.evidenceRefs)||record.evidenceRefs.length>8||
    record.evidenceRefs.some(x=>typeof x!=="string"||x.length>250)||
    Number.isNaN(Date.parse(record.updatedAt))) bad("RECORD_INVALID");
}
async function digest(value:string):Promise<string>{
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(v=>v.toString(16).padStart(2,"0")).join("");
}
const eventKey=(p:string,recordId:string,revision:number)=>
  p+"event:"+recordId+":"+String(revision).padStart(12,"0");

/**
 * Off-host, append-only disaster-recovery replica in the existing Cloudflare DO.
 * This is not a read authority, nor an alternative source of current context.
 * Cloudflare's Durable Object storage provides durable encrypted-at-rest storage.
 */
export interface RecoveryStorage extends CloudAuditStorage {
  list<T>(options:{prefix:string;limit?:number}):Promise<Map<string,T>>;
}
export class CentralMemoryRecovery {
  constructor(private readonly storage:RecoveryStorage){}

  async append(
    userId:string,repositoryId:string,operationId:string,
    expectedRevision:number,record:RecoveryRecord,
  ):Promise<{replayed:boolean;digest:string}> {
    if(!USER_ID.test(userId)||!REPO_ID.test(repositoryId)||
      !OP_ID.test(operationId)||!Number.isSafeInteger(expectedRevision)||
      expectedRevision<0) bad("INPUT_INVALID");
    validRecord(record,repositoryId);
    if(record.revision!==expectedRevision+1) bad("CAS_MISMATCH");
    const p=PREFIX+userId+":"+repositoryId+":";
    const recordDigest=await digest(JSON.stringify(record));
    const requestReceipt:OperationReceipt={
      repositoryId,recordId:record.recordId,revision:record.revision,recordDigest,
    };
    return this.storage.transaction(async txn=>{
      const known=await txn.get<OperationReceipt>(p+"operation:"+operationId);
      if(known){
        if(JSON.stringify(known)!==JSON.stringify(requestReceipt)) bad("REPLAY_CONFLICT");
        const stored=await txn.get<RecoveryEntry>(eventKey(p,record.recordId,record.revision));
        if(!stored||stored.recordDigest!==recordDigest) bad("EVENT_CORRUPT");
        return {replayed:true,digest:stored.chainDigest};
      }
      const headKey=p+"head:"+record.recordId;
      const head=await txn.get<RecordHead>(headKey);
      if((head?.revision??0)!==expectedRevision) bad("CAS_MISMATCH");
      const manifest=await txn.get<RecoveryManifest>(p+"manifest");
      const nextRecords=(manifest?.records??0)+(head?0:1);
      const nextEvents=(manifest?.events??0)+1;
      if(nextRecords>1000||nextEvents>50_000) bad("ARCHIVE_TOO_LARGE");
      const previousDigest=head?.chainDigest??"0".repeat(64);
      const chainDigest=await digest(previousDigest+":"+operationId+":"+recordDigest);
      const entry:RecoveryEntry={version:1,operationId,record,recordDigest,previousDigest,chainDigest};
      await txn.put(eventKey(p,record.recordId,record.revision),entry);
      await txn.put(headKey,{revision:record.revision,chainDigest} satisfies RecordHead);
      await txn.put(p+"operation:"+operationId,requestReceipt);
      await txn.put(p+"manifest",{records:nextRecords,events:nextEvents} satisfies RecoveryManifest);
      return {replayed:false,digest:chainDigest};
    });
  }

  async exportVerified(userId:string,repositoryId:string):
    Promise<{events:RecoveryEntry[];archiveDigest:string}> {
    if(!USER_ID.test(userId)||!REPO_ID.test(repositoryId)) bad("INPUT_INVALID");
    const prefix=PREFIX+userId+":"+repositoryId+":head:";
    const heads=await this.storage.list<RecordHead>({prefix,limit:1001});
    if(heads.size>1000) bad("ARCHIVE_TOO_LARGE");
    const manifest=await this.storage.get<RecoveryManifest>(
      PREFIX+userId+":"+repositoryId+":manifest",
    );
    if(!manifest || manifest.records!==heads.size) bad("ARCHIVE_INCOMPLETE");
    const events:RecoveryEntry[]=[];
    for(const key of [...heads.keys()].sort()){
      const recordId=key.slice(prefix.length);
      const history=await this.verifyRecord(userId,repositoryId,recordId);
      if(history.length>10000 || events.length+history.length>50000) bad("ARCHIVE_TOO_LARGE");
      events.push(...history);
    }
    if(events.length!==manifest.events) bad("ARCHIVE_INCOMPLETE");
    return {events,archiveDigest:await digest(JSON.stringify(events))};
  }

  /** Read only: a recovery tool can reconstruct and validate a fresh Oracle DB. */
  async verifyRecord(userId:string,repositoryId:string,recordId:string):
    Promise<RecoveryEntry[]> {
    if(!USER_ID.test(userId)||!REPO_ID.test(repositoryId)||
      !RECORD_ID.test(recordId)) bad("INPUT_INVALID");
    const prefix=PREFIX+userId+":"+repositoryId+":";
    const head=await this.storage.get<RecordHead>(prefix+"head:"+recordId);
    if(!head) return [];
    const events:RecoveryEntry[]=[];
    let previousDigest="0".repeat(64);
    for(let revision=1;revision<=head.revision;revision++){
      const entry=await this.storage.get<RecoveryEntry>(eventKey(prefix,recordId,revision));
      if(!entry || entry.version!==1 || entry.record.revision!==revision ||
        entry.record.repositoryId!==repositoryId || entry.record.recordId!==recordId||
        entry.previousDigest!==previousDigest) bad("EVENT_CORRUPT");
      validRecord(entry.record,repositoryId);
      const actualDigest=await digest(JSON.stringify(entry.record));
      if(actualDigest!==entry.recordDigest||
        await digest(previousDigest+":"+entry.operationId+":"+actualDigest)!==entry.chainDigest) {
        bad("EVENT_CORRUPT");
      }
      events.push(entry);
      previousDigest=entry.chainDigest;
    }
    if(previousDigest!==head.chainDigest) bad("EVENT_CORRUPT");
    return events;
  }
}
