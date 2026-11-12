import { createHash, randomUUID } from "node:crypto";
import { chmodSync, createReadStream, existsSync, linkSync, lstatSync, mkdirSync, realpathSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

export const LEGACY_CODEX_FILES = [
  "CURRENT_TASK.md","DECISIONS.md","HANDOFF.md","KNOWN_ISSUES.md",
  "NEXT_STEPS.md","PROJECT_CONTEXT.md",
] as const;
export interface LegacyCodexDocument {
  surface: "oracle" | "windows";
  filename: typeof LEGACY_CODEX_FILES[number];
  content: string;
  contentSha256: string;
}
export interface LegacyImportReceipt {
  repositoryId: string;
  importHash: string;
  filesImported: number;
  totalBytes: number;
  replayed: boolean;
}
export type MemoryKind = "decision" | "context" | "task" | "issue" | "note";

export interface RecoverableMemoryEvent {
  version:1;
  operationId:string;
  record:MemoryRecord;
  recordDigest:string;
  previousDigest:string;
  chainDigest:string;
}

export type MemoryConfidence = "user_reported" | "inferred";
export type MemoryStatus = "active" | "resolved";
export type MemoryAction = "create" | "revise" | "resolve";

export interface MemoryRecord {
  recordId: string; repositoryId: string; kind: MemoryKind; status: MemoryStatus;
  confidence: MemoryConfidence; title: string; content: string; evidenceRefs: string[];
  revision: number; updatedAt: string;
}
export interface MemoryMutation {
  repositoryId: string; operationId: string; action: MemoryAction;
  recordId: string; expectedRevision: number;
  kind?: MemoryKind | undefined; confidence?: MemoryConfidence | undefined;
  title?: string | undefined; content?: string | undefined;
  evidenceRefs?: string[] | undefined;
}
export interface MemoryContext {
  repositoryId: string; records: MemoryRecord[]; totalActive: number;
  archiveMatches: Array<{surface:"oracle"|"windows";filename:string;contentSha256:string;excerpt:string}>;
}

const REPO_ID = /^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OP_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const OWNER = /^user:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const schema = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY, checksum TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS records (
  owner_scope TEXT NOT NULL, repository_id TEXT NOT NULL, record_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('decision','context','task','issue','note')),
  status TEXT NOT NULL CHECK(status IN ('active','resolved')),
  confidence TEXT NOT NULL CHECK(confidence IN ('user_reported','inferred')),
  title TEXT NOT NULL, content TEXT NOT NULL, evidence_refs TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0), updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_scope,repository_id,record_id)
);
CREATE INDEX IF NOT EXISTS records_lookup
  ON records(owner_scope,repository_id,status,updated_at);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, owner_scope TEXT NOT NULL,
  repository_id TEXT NOT NULL, operation_id TEXT NOT NULL, record_id TEXT NOT NULL,
  revision INTEGER NOT NULL, action TEXT NOT NULL, snapshot_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL, UNIQUE(owner_scope,operation_id)
);
CREATE INDEX IF NOT EXISTS events_lookup
  ON events(owner_scope,repository_id,record_id,seq);
CREATE TABLE IF NOT EXISTS receipts (
  owner_scope TEXT NOT NULL, operation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL, result_json TEXT NOT NULL,
  PRIMARY KEY(owner_scope,operation_id)
);
CREATE TABLE IF NOT EXISTS legacy_sources (
  owner_scope TEXT NOT NULL,repository_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK(surface IN ('oracle','windows')),
  filename TEXT NOT NULL,content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  PRIMARY KEY(owner_scope,repository_id,surface,filename)
);
CREATE TABLE IF NOT EXISTS legacy_imports (
  owner_scope TEXT NOT NULL,repository_id TEXT NOT NULL,
  import_hash TEXT NOT NULL,files_imported INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,imported_at TEXT NOT NULL,
  PRIMARY KEY(owner_scope,repository_id)
);
CREATE TABLE IF NOT EXISTS recovery_imports (
  owner_scope TEXT NOT NULL,repository_id TEXT NOT NULL,archive_digest TEXT NOT NULL,
  event_count INTEGER NOT NULL,record_count INTEGER NOT NULL,restored_at TEXT NOT NULL,
  PRIMARY KEY(owner_scope,repository_id)
);
CREATE TRIGGER IF NOT EXISTS immutable_event_update
  BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'MEMORY_EVENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS immutable_event_delete
  BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'MEMORY_EVENT_IMMUTABLE'); END;
`;

function invalid(reason: string): never { throw new Error("MEMORY_" + reason); }
function pathIsPresent(value:string):boolean {
  try {lstatSync(value);return true;}
  catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT") return false;
    throw error;
  }
}
function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function ownerValid(value: string): void {
  if (!OWNER.test(value)) invalid("IDENTITY_REQUIRED");
}
function repoValid(value: string): void {
  if (!REPO_ID.test(value)) invalid("REPOSITORY_INVALID");
}
function asRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    recordId:String(row.record_id),repositoryId:String(row.repository_id),
    kind:row.kind as MemoryKind,status:row.status as MemoryStatus,
    confidence:row.confidence as MemoryConfidence,title:String(row.title),
    content:String(row.content),evidenceRefs:JSON.parse(String(row.evidence_refs)) as string[],
    revision:Number(row.revision),updatedAt:String(row.updated_at),
  };
}
function validateMutation(input: MemoryMutation): void {
  repoValid(input.repositoryId);
  if (!OP_ID.test(input.operationId) || !RECORD_ID.test(input.recordId)) invalid("IDENTIFIER_INVALID");
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      (input.action === "create") !== (input.expectedRevision === 0)) invalid("REVISION_INVALID");
  if (input.action === "resolve") {
    if (input.kind !== undefined || input.confidence !== undefined ||
        input.title !== undefined || input.content !== undefined ||
        input.evidenceRefs !== undefined) invalid("RESOLVE_FIELDS_INVALID");
    return;
  }
  if (!["decision","context","task","issue","note"].includes(input.kind ?? "") ||
      !["user_reported","inferred"].includes(input.confidence ?? "") ||
      typeof input.title !== "string" || input.title.length < 1 || input.title.length > 200 ||
      typeof input.content !== "string" || input.content.length < 1 ||
      Buffer.byteLength(input.content,"utf8") > 24_000 ||
      !Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 8 ||
      input.evidenceRefs.some(ref => typeof ref !== "string" || ref.length > 250)) {
    invalid("CONTENT_INVALID");
  }
}

/** Oracle-only authority; ownerScope must come from authenticated Edge context. */
export class CentralMemoryStore {
  private constructor(private readonly db: DatabaseSync, private readonly releaseRoot: string) {}

  static open(databasePath: string, immutableReleaseRoot: string): CentralMemoryStore {
    if (!path.isAbsolute(databasePath) || !path.isAbsolute(immutableReleaseRoot)) invalid("PATH_INVALID");
    if (!existsSync(immutableReleaseRoot)) invalid("RELEASE_ROOT_MISSING");
    const parent = path.dirname(path.resolve(databasePath));
    mkdirSync(parent,{recursive:true,mode:0o700});
    const actualParent = realpathSync(parent);
    if (actualParent !== parent || lstatSync(parent).isSymbolicLink()) invalid("PATH_INVALID");
    const releaseRoot = realpathSync(immutableReleaseRoot);
    const relative = path.relative(releaseRoot,path.join(actualParent,path.basename(databasePath)));
    if (relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) &&
        !path.isAbsolute(relative))) invalid("PATH_INSIDE_RELEASE");
    if (pathIsPresent(databasePath) && (lstatSync(databasePath).isSymbolicLink() ||
       !lstatSync(databasePath).isFile())) invalid("PATH_INVALID");
    chmodSync(parent,0o700);
    const db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec("PRAGMA busy_timeout=5000");
      if ((db.prepare("PRAGMA journal_mode=WAL").get() as {journal_mode?:string}).journal_mode !== "wal") {
        invalid("WAL_UNAVAILABLE");
      }
      db.exec("PRAGMA synchronous=FULL");
      // Version 1 schema is immutable. Future upgrades require explicit, CAS-safe
      // migrations; do not apply CREATE IF NOT EXISTS to an unknown database.
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing=db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'",
        ).get();
        if(existing) {
          const versions=db.prepare("SELECT version,checksum FROM schema_version").all() as
            Array<{version:number;checksum:string}>;
          if(versions.length!==1 || versions[0]?.version!==1 ||
              versions[0]?.checksum!==sha(schema)) invalid("SCHEMA_MISMATCH");
        } else {
          const objects=db.prepare(
            "SELECT name FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'",
          ).all();
          if(objects.length!==0) invalid("UNVERSIONED_DB");
          db.exec(schema);
          db.prepare("INSERT INTO schema_version(version,checksum) VALUES(1,?)").run(sha(schema));
        }
        const required=["records","events","receipts","legacy_sources","legacy_imports",
          "recovery_imports","immutable_event_update","immutable_event_delete"];
        const objects=db.prepare(
          "SELECT name FROM sqlite_master WHERE type IN ('table','trigger')",
        ).all() as Array<{name:string}>;
        const present=new Set(objects.map(row=>row.name));
        if(required.some(name=>!present.has(name))) invalid("SCHEMA_MISMATCH");
        const integrity=db.prepare("PRAGMA quick_check").get() as {quick_check:string};
        if(integrity.quick_check!=="ok") invalid("SCHEMA_CORRUPT");
        db.exec("COMMIT");
      }catch(error) {db.exec("ROLLBACK");throw error;}
      chmodSync(databasePath,0o600);
      return new CentralMemoryStore(db,releaseRoot);
    } catch (error) { db.close(); throw error; }
  }

  context(ownerScope: string, repositoryId: string, query = "", limit = 25): MemoryContext {
    ownerValid(ownerScope); repoValid(repositoryId);
    if (query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 50) invalid("QUERY_INVALID");
    const escaped = query.replace(/[\\%_]/gu, ch => "\\" + ch);
    const match = "%" + escaped + "%";
    const records = this.db.prepare(
      "SELECT * FROM records WHERE owner_scope=? AND repository_id=? AND status='active' " +
      "AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') " +
      "ORDER BY updated_at DESC,record_id ASC LIMIT ?",
    ).all(ownerScope,repositoryId,match,match,limit) as Array<Record<string,unknown>>;
    const total = this.db.prepare(
      "SELECT COUNT(*) AS n FROM records WHERE owner_scope=? AND repository_id=? AND status='active'",
    ).get(ownerScope,repositoryId) as {n:number};
    const archiveMatches:MemoryContext["archiveMatches"]=[];
    if(query){
      const candidates=this.db.prepare(
        "SELECT surface,filename,content,content_sha256 FROM legacy_sources "+
        "WHERE owner_scope=? AND repository_id=? AND content LIKE ? ESCAPE '\\' "+
        "ORDER BY CASE surface WHEN 'oracle' THEN 0 ELSE 1 END,filename LIMIT 12",
      ).all(ownerScope,repositoryId,match) as Array<{
        surface:"oracle"|"windows";filename:string;content:string;content_sha256:string
      }>;
      for(const row of candidates){
        if(sha(row.content)!==row.content_sha256)invalid("IMPORT_CORRUPT");
        const index=row.content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
        if(index<0)continue;
        const start=Math.max(0,index-200),end=Math.min(row.content.length,index+query.length+300);
        archiveMatches.push({
          surface:row.surface,filename:row.filename,contentSha256:row.content_sha256,
          excerpt:(start>0?"…":"")+row.content.slice(start,end)+(end<row.content.length?"…":""),
        });
      }
    }
    return {repositoryId,records:records.map(asRecord),totalActive:total.n,archiveMatches};
  }

  update(ownerScope: string, input: MemoryMutation): {record:MemoryRecord;replayed:boolean} {
    ownerValid(ownerScope); validateMutation(input);
    const requestHash = sha(JSON.stringify(input));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare(
        "SELECT request_hash,result_json FROM receipts WHERE owner_scope=? AND operation_id=?",
      ).get(ownerScope,input.operationId) as {request_hash:string;result_json:string}|undefined;
      if (previous) {
        if (previous.request_hash !== requestHash) invalid("IDEMPOTENCY_CONFLICT");
        const replay=JSON.parse(previous.result_json) as {record:MemoryRecord};
        this.db.exec("COMMIT");
        return {...replay,replayed:true};
      }
      const old = this.db.prepare(
        "SELECT * FROM records WHERE owner_scope=? AND repository_id=? AND record_id=?",
      ).get(ownerScope,input.repositoryId,input.recordId) as Record<string,unknown>|undefined;
      const currentRevision = old ? Number(old.revision) : 0;
      if (input.expectedRevision !== currentRevision ||
          (input.action === "create") !== (old === undefined)) invalid("CAS_CONFLICT");
      if (old?.status === "resolved") invalid("ALREADY_RESOLVED");
      const now = new Date().toISOString();
      const next: MemoryRecord = input.action === "resolve"
        ? {...asRecord(old!),status:"resolved",revision:currentRevision+1,updatedAt:now}
        : {
          recordId:input.recordId,repositoryId:input.repositoryId,
          kind:input.kind!,status:"active",confidence:input.confidence!,
          title:input.title!,content:input.content!,evidenceRefs:input.evidenceRefs!,
          revision:currentRevision+1,updatedAt:now,
        };
      this.db.prepare(
        "INSERT INTO records(owner_scope,repository_id,record_id,kind,status,confidence,title,content,evidence_refs,revision,updated_at) " +
        "VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_scope,repository_id,record_id) DO UPDATE SET " +
        "kind=excluded.kind,status=excluded.status,confidence=excluded.confidence,title=excluded.title," +
        "content=excluded.content,evidence_refs=excluded.evidence_refs,revision=excluded.revision,updated_at=excluded.updated_at",
      ).run(ownerScope,input.repositoryId,input.recordId,next.kind,next.status,next.confidence,
        next.title,next.content,JSON.stringify(next.evidenceRefs),next.revision,now);
      this.db.prepare(
        "INSERT INTO events(owner_scope,repository_id,operation_id,record_id,revision,action,snapshot_json,occurred_at) " +
        "VALUES(?,?,?,?,?,?,?,?)",
      ).run(ownerScope,input.repositoryId,input.operationId,input.recordId,next.revision,input.action,
        JSON.stringify(next),now);
      this.db.prepare(
        "INSERT INTO receipts(owner_scope,operation_id,request_hash,result_json) VALUES(?,?,?,?)",
      ).run(ownerScope,input.operationId,requestHash,JSON.stringify({record:next}));
      this.db.exec("COMMIT");
      return {record:next,replayed:false};
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  history(ownerScope: string, repositoryId: string, recordId: string): MemoryRecord[] {
    ownerValid(ownerScope); repoValid(repositoryId);
    if (!RECORD_ID.test(recordId)) invalid("IDENTIFIER_INVALID");
    const events = this.db.prepare(
      "SELECT snapshot_json FROM events WHERE owner_scope=? AND repository_id=? AND record_id=? ORDER BY seq ASC LIMIT 500",
    ).all(ownerScope,repositoryId,recordId) as Array<{snapshot_json:string}>;
    return events.map(row => JSON.parse(row.snapshot_json) as MemoryRecord);
  }

  /**
   * Lossless archival import into the SAME database, never into another live
   * .codex. Both old surfaces are mandatory; disagreements remain auditable
   * until explicitly classified. This does NOT promote memory authority.
   */
  importLegacySources(
    ownerScope:string,repositoryId:string,documents:readonly LegacyCodexDocument[],
  ): LegacyImportReceipt {
    ownerValid(ownerScope); repoValid(repositoryId);
    if(documents.length!==12) invalid("IMPORT_INCOMPLETE");
    const ordered=[...documents].sort((a,b)=>(
      a.surface+":"+a.filename).localeCompare(b.surface+":"+b.filename));
    const expected=["oracle","windows"].flatMap(surface=>
      LEGACY_CODEX_FILES.map(filename=>surface+":"+filename)).sort();
    if(ordered.some((doc,i)=>doc.surface+":"+doc.filename!==expected[i])) {
      invalid("IMPORT_INCOMPLETE");
    }
    let totalBytes=0;
    for(const doc of ordered) {
      const bytes=Buffer.byteLength(doc.content,"utf8");
      if(bytes<1 || bytes>500_000 ||
          doc.contentSha256!==sha(doc.content)) invalid("IMPORT_SOURCE_MISMATCH");
      totalBytes+=bytes;
    }
    if(totalBytes>3_000_000) invalid("IMPORT_OVERSIZED");
    const importHash=sha(JSON.stringify(ordered.map(doc=>({
      surface:doc.surface,filename:doc.filename,hash:doc.contentSha256,
    }))));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior=this.db.prepare(
        "SELECT import_hash FROM legacy_imports WHERE owner_scope=? AND repository_id=?",
      ).get(ownerScope,repositoryId) as {import_hash:string}|undefined;
      if(prior) {
        if(prior.import_hash!==importHash) invalid("IMPORT_CONFLICT");
        this.db.exec("COMMIT");
        return {repositoryId,importHash,filesImported:12,totalBytes,replayed:true};
      }
      const insert=this.db.prepare(
        "INSERT INTO legacy_sources(owner_scope,repository_id,surface,filename,content,content_sha256) VALUES(?,?,?,?,?,?)",
      );
      for(const doc of ordered) insert.run(ownerScope,repositoryId,
        doc.surface,doc.filename,doc.content,doc.contentSha256);
      this.db.prepare(
        "INSERT INTO legacy_imports(owner_scope,repository_id,import_hash,files_imported,total_bytes,imported_at) VALUES(?,?,?,?,?,?)",
      ).run(ownerScope,repositoryId,importHash,12,totalBytes,new Date().toISOString());
      this.db.exec("COMMIT");
      return {repositoryId,importHash,filesImported:12,totalBytes,replayed:false};
    } catch(error) {this.db.exec("ROLLBACK");throw error;}
  }

  readLegacySource(ownerScope:string,repositoryId:string,
    surface:LegacyCodexDocument["surface"],filename:LegacyCodexDocument["filename"],
  ): {content:string;contentSha256:string}|null {
    ownerValid(ownerScope);repoValid(repositoryId);
    if(!["oracle","windows"].includes(surface) || !LEGACY_CODEX_FILES.includes(filename)) {
      invalid("IMPORT_SOURCE_INVALID");
    }
    const row=this.db.prepare(
      "SELECT content,content_sha256 FROM legacy_sources WHERE owner_scope=? AND repository_id=? AND surface=? AND filename=?",
    ).get(ownerScope,repositoryId,surface,filename) as
      {content:string;content_sha256:string}|undefined;
    if(!row) return null;
    if(sha(row.content)!==row.content_sha256) invalid("IMPORT_CORRUPT");
    return {content:row.content,contentSha256:row.content_sha256};
  }

  /**
   * Disaster recovery only. Rebuild the Oracle authority from a separately
   * verified Edge archive, within ONE transaction and only for an empty scope.
   * Never merge an ambiguous/off-host snapshot into active memory.
   */
  restoreVerifiedEvents(
    ownerScope:string,repositoryId:string,events:readonly RecoverableMemoryEvent[],
    expectedArchiveDigest:string,
  ): {records:number;events:number;archiveDigest:string;replayed:boolean} {
    ownerValid(ownerScope);repoValid(repositoryId);
    if(events.length===0||events.length>50_000) invalid("RESTORE_INPUT_INVALID");
    const bytes=Buffer.byteLength(JSON.stringify(events),"utf8");
    if(bytes>16_000_000) invalid("RESTORE_TOO_LARGE");
    const archiveDigest=sha(JSON.stringify(events));
    if(!/^[0-9a-f]{64}$/u.test(expectedArchiveDigest)||
      archiveDigest!==expectedArchiveDigest) invalid("RESTORE_ARCHIVE_MISMATCH");
    const headById=new Map<string,{revision:number;digest:string;status:MemoryStatus}>();
    const operationIds=new Set<string>();
    for(const entry of events){
      if(entry?.version!==1||!OP_ID.test(entry.operationId)||
        operationIds.has(entry.operationId)||!entry.record||
        entry.record.repositoryId!==repositoryId||
        !RECORD_ID.test(entry.record.recordId)||
        !["decision","context","task","issue","note"].includes(entry.record.kind)||
        !["active","resolved"].includes(entry.record.status)||
        !["user_reported","inferred"].includes(entry.record.confidence)||
        typeof entry.record.title!=="string"||entry.record.title.length<1||
        entry.record.title.length>200||typeof entry.record.content!=="string"||
        entry.record.content.length<1||Buffer.byteLength(entry.record.content,"utf8")>24_000||
        !Array.isArray(entry.record.evidenceRefs)||entry.record.evidenceRefs.length>8||
        entry.record.evidenceRefs.some(x=>typeof x!=="string"||x.length>250)||
        !Number.isSafeInteger(entry.record.revision)||entry.record.revision<1||
        !Number.isFinite(Date.parse(entry.record.updatedAt))) invalid("RESTORE_EVENT_INVALID");
      operationIds.add(entry.operationId);
      const previous=headById.get(entry.record.recordId);
      const requiredRevision=(previous?.revision??0)+1;
      const previousDigest=previous?.digest??"0".repeat(64);
      const recordDigest=sha(JSON.stringify(entry.record));
      const chainDigest=sha(previousDigest+":"+entry.operationId+":"+recordDigest);
      if(previous?.status==="resolved"||entry.record.revision!==requiredRevision||
        entry.previousDigest!==previousDigest||
        entry.recordDigest!==recordDigest||
        entry.chainDigest!==chainDigest||
        (requiredRevision===1&&entry.record.status!=="active")) invalid("RESTORE_EVENT_CORRUPT");
      headById.set(entry.record.recordId,{
        revision:requiredRevision,digest:chainDigest,status:entry.record.status,
      });
    }
    this.db.exec("BEGIN IMMEDIATE");
    try{
      const prior=this.db.prepare(
        "SELECT archive_digest,event_count,record_count FROM recovery_imports WHERE owner_scope=? AND repository_id=?",
      ).get(ownerScope,repositoryId) as {
        archive_digest:string;event_count:number;record_count:number
      }|undefined;
      if(prior){
        if(prior.archive_digest!==archiveDigest||prior.event_count!==events.length||
          prior.record_count!==headById.size) invalid("RESTORE_CONFLICT");
        this.db.exec("COMMIT");
        return {records:headById.size,events:events.length,archiveDigest,replayed:true};
      }
      const present=this.db.prepare(
        "SELECT COUNT(*) AS n FROM events WHERE owner_scope=? AND repository_id=?",
      ).get(ownerScope,repositoryId) as {n:number};
      const rows=this.db.prepare(
        "SELECT COUNT(*) AS n FROM records WHERE owner_scope=? AND repository_id=?",
      ).get(ownerScope,repositoryId) as {n:number};
      if(present.n!==0||rows.n!==0) invalid("RESTORE_SCOPE_NOT_EMPTY");
      const addEvent=this.db.prepare(
        "INSERT INTO events(owner_scope,repository_id,operation_id,record_id,revision,action,snapshot_json,occurred_at) VALUES(?,?,?,?,?,?,?,?)",
      );
      const addRecord=this.db.prepare(
        "INSERT INTO records(owner_scope,repository_id,record_id,kind,status,confidence,title,content,evidence_refs,revision,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) "+
        "ON CONFLICT(owner_scope,repository_id,record_id) DO UPDATE SET kind=excluded.kind,status=excluded.status,"+
        "confidence=excluded.confidence,title=excluded.title,content=excluded.content,"+
        "evidence_refs=excluded.evidence_refs,revision=excluded.revision,updated_at=excluded.updated_at",
      );
      const addReceipt=this.db.prepare(
        "INSERT INTO receipts(owner_scope,operation_id,request_hash,result_json) VALUES(?,?,?,?)",
      );
      for(const event of events){
        const record=event.record;
        const action=record.revision===1?"create":record.status==="resolved"?"resolve":"revise";
        const mutation={
          repositoryId,operationId:event.operationId,action,
          recordId:record.recordId,expectedRevision:record.revision-1,
          ...(action==="resolve"?{}:{
            kind:record.kind,confidence:record.confidence,
            title:record.title,content:record.content,evidenceRefs:record.evidenceRefs,
          }),
        };
        addEvent.run(ownerScope,repositoryId,event.operationId,record.recordId,
          record.revision,action,JSON.stringify(record),record.updatedAt);
        addRecord.run(ownerScope,repositoryId,record.recordId,record.kind,record.status,
          record.confidence,record.title,record.content,JSON.stringify(record.evidenceRefs),
          record.revision,record.updatedAt);
        addReceipt.run(ownerScope,event.operationId,sha(JSON.stringify(mutation)),
          JSON.stringify({record}));
      }
      this.db.prepare(
        "INSERT INTO recovery_imports(owner_scope,repository_id,archive_digest,event_count,record_count,restored_at) VALUES(?,?,?,?,?,?)",
      ).run(ownerScope,repositoryId,archiveDigest,events.length,headById.size,new Date().toISOString());
      this.db.exec("COMMIT");
      return {records:headById.size,events:events.length,archiveDigest,replayed:false};
    }catch(error){this.db.exec("ROLLBACK");throw error;}
  }

  /** Verified consistent backup; an off-host copy and restore proof remain mandatory before cutover. */
  async createVerifiedSnapshot(destination: string): Promise<{sha256:string;bytes:number}> {
    if (!path.isAbsolute(destination) || pathIsPresent(destination)) invalid("BACKUP_PATH_INVALID");
    const directory=path.dirname(destination);
    mkdirSync(directory,{recursive:true,mode:0o700});
    if (realpathSync(directory)!==directory || lstatSync(directory).isSymbolicLink()) {
      invalid("BACKUP_PATH_INVALID");
    }
    const relative=path.relative(this.releaseRoot,destination);
    if (relative==="" || (relative!==".." && !relative.startsWith(".."+path.sep) &&
        !path.isAbsolute(relative))) invalid("BACKUP_INSIDE_RELEASE");
    chmodSync(directory,0o700);
    const temporary=path.join(directory,"."+path.basename(destination)+".tmp-"+randomUUID());
    try {
      await backup(this.db,temporary);
      chmodSync(temporary,0o600);
      const check=new DatabaseSync(temporary,{readOnly:true});
      try {
        const integrity=check.prepare("PRAGMA integrity_check").get() as {integrity_check:string};
        if (integrity.integrity_check!=="ok") invalid("BACKUP_CORRUPT");
      } finally {check.close();}
      const hash=createHash("sha256");
      for await(const chunk of createReadStream(temporary)) hash.update(chunk);
      const bytes=statSync(temporary).size;
      // link is exclusive: even a racing writer cannot replace an existing file.
      linkSync(temporary,destination);
      return {sha256:hash.digest("hex"),bytes};
    } finally {
      if(pathIsPresent(temporary)) unlinkSync(temporary);
    }
  }

  close(): void { this.db.close(); }
}
