import type { CloudAuditStorage } from "./cloud-audit-store.js";
import { CentralMemoryLegacyArchive } from "./central-memory-legacy-archive.js";

const USER_ID=/^usr_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REPO_ID=/^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const RECORD_ID=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const OP_ID=/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const KINDS=new Set(["decision","context","task","issue","note"]);
const CONFIDENCES=new Set(["user_reported","inferred"]);
const STATUSES=new Set(["active","resolved"]);
const PREFIX="central-memory-recovery:v1:";
const ACTIVATION_PREFIX="central-memory-activation:v1:";


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






const CHECKPOINT_META_KEY="io.github.ifael/mcp-memory-checkpoint";

/**
 * A trusted Oracle tool completion can carry a typed, user-scoped memory receipt.
 * The native operation must never be retried just because its recovery mirror failed.
 */
export async function mirrorNativeCheckpointResponse(
  storage:RecoveryStorage,userId:string,tool:string,response:Response,
  hasWriteAccess:(repositoryId:string)=>Promise<boolean>,
):Promise<"persisted"|"none"|"upstream_error">{
  if(!response.ok)return "upstream_error";
  let payload:unknown;
  try{payload=await response.clone().json();}catch{return "none";}
  if(!object(payload)||!object(payload.result))return "none";
  const result=payload.result;
  if(result.isError===true)return "upstream_error";
  if(!object(result._meta))return "none";
  const metadata=result._meta[CHECKPOINT_META_KEY];
  if(metadata===undefined)return "none";
  if(!object(metadata)||metadata.version!==1||metadata.tool!==tool||
    typeof metadata.operationId!=="string"||
    !Number.isSafeInteger(metadata.expectedRevision)||
    (metadata.expectedRevision as number)<0||!object(metadata.record))
    bad("RECEIPT_INVALID");
  const record=metadata.record as unknown as RecoveryRecord;
  if(record.revision!==(metadata.expectedRevision as number)+1)bad("RECEIPT_INVALID");
  if(!await hasWriteAccess(record.repositoryId))bad("RECEIPT_UNAUTHORIZED");
  await new CentralMemoryRecovery(storage).append(userId,record.repositoryId,
    metadata.operationId,metadata.expectedRevision as number,record);
  return "persisted";
}

/** An off-host failure is visible without converting a successful native operation into an error. */
export async function markNativeCheckpointDeferred(response:Response):Promise<Response>{
  let body:unknown;
  try{body=await response.clone().json();}catch{return response;}
  if(!object(body)||!object(body.result)||body.result.isError===true)return response;
  const result=body.result;
  const meta=object(result._meta)?result._meta:{};
  result._meta={...meta,"io.github.ifael/mcp-memory-warning":"recovery_deferred"};
  const headers=new Headers(response.headers);
  headers.delete("content-length");
  headers.set("content-type","application/json; charset=utf-8");
  headers.set("cache-control","no-store");
  return new Response(JSON.stringify(body),{status:response.status,headers});
}


export interface LegacyActivationReceipt {
  operationId:string;
  importHash:string;
  archiveDigest:string;
  activatedAt:string;
}

/** Persist an Oracle-authoritative one-way cutover receipt off-host. */
export async function mirrorLegacyActivationResponse(
  storage:RecoveryStorage,userId:string,
  args:Record<string,unknown>,response:Response,
):Promise<"persisted"|"upstream_error"> {
  if(!response.ok)return "upstream_error";
  let payload:unknown;
  try{payload=await response.clone().json();}catch{bad("ACTIVATION_RECEIPT_INVALID");}
  if(!object(payload)||!object(payload.result))bad("ACTIVATION_RECEIPT_INVALID");
  const result=payload.result;
  if(result.isError===true)return "upstream_error";
  const output=result.structuredContent;
  if(!object(output)||args.action!=="activate_legacy"||
     typeof args.repositoryId!=="string"||!REPO_ID.test(args.repositoryId)||
     typeof args.operationId!=="string"||!OP_ID.test(args.operationId)||
     typeof args.importHash!=="string"||typeof args.archiveDigest!=="string"||
     output.repositoryId!==args.repositoryId||
     output.importHash!==args.importHash||
     output.archiveDigest!==args.archiveDigest||
     typeof output.activatedAt!=="string"||
     !Number.isFinite(Date.parse(output.activatedAt)))bad("ACTIVATION_RECEIPT_INVALID");
  await verifyLegacyCutoverRecovery(storage,userId,args.repositoryId,
    args.importHash,args.archiveDigest);
  const receipt:LegacyActivationReceipt={
    operationId:args.operationId,importHash:args.importHash,
    archiveDigest:args.archiveDigest,activatedAt:output.activatedAt,
  };
  const key=ACTIVATION_PREFIX+userId+":"+args.repositoryId;
  await storage.transaction(async txn=>{
    const previous=await txn.get<LegacyActivationReceipt>(key);
    if(previous){
      // Recovery of a lost Oracle DB may reapply the same cutover with a new
      // local timestamp. Preserve the first authenticated off-host receipt.
      if(previous.operationId!==receipt.operationId||
         previous.importHash!==receipt.importHash||
         previous.archiveDigest!==receipt.archiveDigest)bad("ACTIVATION_CONFLICT");
      return;
    }
    await txn.put(key,receipt);
  });
  return "persisted";
}

async function verifiedActivation(
  storage:RecoveryStorage,userId:string,repositoryId:string,
):Promise<LegacyActivationReceipt|undefined>{
  const value=await storage.get<LegacyActivationReceipt>(
    ACTIVATION_PREFIX+userId+":"+repositoryId);
  if(value===undefined)return undefined;
  if(!value||typeof value.operationId!=="string"||
     !OP_ID.test(value.operationId)||
     !/^[0-9a-f]{64}$/u.test(value.importHash)||
     !/^[0-9a-f]{64}$/u.test(value.archiveDigest)||
     typeof value.activatedAt!=="string"||
     !Number.isFinite(Date.parse(value.activatedAt)))bad("ACTIVATION_CORRUPT");
  const legacy=await new CentralMemoryLegacyArchive(storage).exportVerified(userId,repositoryId);
  if(legacy.importHash!==value.importHash)bad("ACTIVATION_CORRUPT");
  return value;
}

/** A read-only recovery export. Owner ACL is enforced by the Edge caller. */
export async function exportCentralMemoryRecovery(
  storage:RecoveryStorage,userId:string,repositoryId:string,
  input:{kind:"legacy"|"events";surface?:"oracle"|"windows";filename?:string;
    offset?:number;maxChars?:number;limit?:number},
):Promise<Record<string,unknown>>{
  if(!USER_ID.test(userId)||!REPO_ID.test(repositoryId)) bad("INPUT_INVALID");
  if(input.kind==="legacy"){
    if(!["oracle","windows"].includes(input.surface??"")||
      typeof input.filename!=="string"||
      !["CURRENT_TASK.md","DECISIONS.md","HANDOFF.md","KNOWN_ISSUES.md",
        "NEXT_STEPS.md","PROJECT_CONTEXT.md"].includes(input.filename))bad("INPUT_INVALID");
    const offset=input.offset??0,maxChars=input.maxChars??8000;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxChars)||
      maxChars<1||maxChars>12000)bad("INPUT_INVALID");
    const archive=await new CentralMemoryLegacyArchive(storage).exportVerified(userId,repositoryId);
    const source=archive.documents.find(d=>d.surface===input.surface&&d.filename===input.filename);
    if(!source)bad("LEGACY_MISSING");
    const start=Math.min(source.content.length,offset),end=Math.min(start+maxChars,source.content.length);
    return {kind:"legacy",repositoryId,importHash:archive.importHash,
      totalBytes:archive.totalBytes,surface:source.surface,filename:source.filename,
      contentSha256:source.contentSha256,offset:start,totalChars:source.content.length,
      text:source.content.slice(start,end),truncated:end<source.content.length};
  }
  if(input.kind==="events"){
    const offset=input.offset??0,limit=input.limit??5;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||
      limit<1||limit>5)bad("INPUT_INVALID");
    const archive=await new CentralMemoryRecovery(storage).exportVerified(userId,repositoryId);
    const activation=await verifiedActivation(storage,userId,repositoryId);
    return {kind:"events",repositoryId,archiveDigest:archive.archiveDigest,
      totalEvents:archive.events.length,offset,
      events:archive.events.slice(offset,offset+limit),
      truncated:offset+limit<archive.events.length,
      ...(activation?{activation}:{})};
  }
  bad("INPUT_INVALID");
}

/**
 * The irreversible authority switch is permitted only after the Edge's
 * independent recovery copy validates both historical documents and all
 * hash-chained memory events for the same authenticated owner and repository.
 */
export async function verifyLegacyCutoverRecovery(
  storage:RecoveryStorage,userId:string,repositoryId:string,
  expectedImportHash:string,expectedArchiveDigest:string,
):Promise<void>{
  if(!/^[0-9a-f]{64}$/u.test(expectedImportHash)||
     !/^[0-9a-f]{64}$/u.test(expectedArchiveDigest))bad("CUTOVER_INPUT_INVALID");
  const legacy=await new CentralMemoryLegacyArchive(storage).exportVerified(userId,repositoryId);
  const recovery=await new CentralMemoryRecovery(storage).exportVerified(userId,repositoryId);
  const priorActivation=await verifiedActivation(storage,userId,repositoryId);
  const sameCutover=priorActivation?.importHash===expectedImportHash&&
    priorActivation.archiveDigest===expectedArchiveDigest;
  if(legacy.importHash!==expectedImportHash ||
     (recovery.archiveDigest!==expectedArchiveDigest && !sameCutover) ||
     !recovery.events.some(e=>e.record.kind==="decision" &&
       e.record.status==="active" && e.record.evidenceRefs.length>0))
    bad("CUTOVER_BACKUP_MISMATCH");
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
