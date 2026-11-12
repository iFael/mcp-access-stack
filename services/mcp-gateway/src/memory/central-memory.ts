import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";

export type MemoryKind = "decision" | "context" | "task" | "issue" | "note";
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
}

const REPO_ID = /^repo_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OP_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/u;
const RECORD_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u;
const OWNER = /^user:[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const schema = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY CHECK (version = 1), checksum TEXT NOT NULL
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
CREATE TRIGGER IF NOT EXISTS immutable_event_update
  BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'MEMORY_EVENT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS immutable_event_delete
  BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'MEMORY_EVENT_IMMUTABLE'); END;
`;

function invalid(reason: string): never { throw new Error("MEMORY_" + reason); }
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
    if (existsSync(databasePath) && (lstatSync(databasePath).isSymbolicLink() ||
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
      db.exec(schema);
      const checksum = sha(schema);
      const versions = db.prepare("SELECT version,checksum FROM schema_version").all() as
        Array<{version:number;checksum:string}>;
      if (versions.length > 1 ||
          versions.some(row => row.version !== 1 || row.checksum !== checksum)) invalid("SCHEMA_MISMATCH");
      if (!versions.length) db.prepare("INSERT INTO schema_version(version,checksum) VALUES(1,?)").run(checksum);
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
    return {repositoryId,records:records.map(asRecord),totalActive:total.n};
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

  /** Verified consistent backup; an off-host copy and restore proof remain mandatory before cutover. */
  async createVerifiedSnapshot(destination: string): Promise<{sha256:string;bytes:number}> {
    if (!path.isAbsolute(destination) || existsSync(destination)) invalid("BACKUP_PATH_INVALID");
    const directory=path.dirname(destination);
    mkdirSync(directory,{recursive:true,mode:0o700});
    if (realpathSync(directory)!==directory || lstatSync(directory).isSymbolicLink()) {
      invalid("BACKUP_PATH_INVALID");
    }
    const relative=path.relative(this.releaseRoot,destination);
    if (relative==="" || (relative!==".." && !relative.startsWith(".."+path.sep) &&
        !path.isAbsolute(relative))) invalid("BACKUP_INSIDE_RELEASE");
    chmodSync(directory,0o700);
    await backup(this.db,destination);
    chmodSync(destination,0o600);
    const check=new DatabaseSync(destination,{readOnly:true});
    try {
      const integrity=check.prepare("PRAGMA integrity_check").get() as {integrity_check:string};
      if (integrity.integrity_check!=="ok") invalid("BACKUP_CORRUPT");
    } finally {check.close();}
    return {sha256:createHash("sha256").update(readFileSync(destination)).digest("hex"),bytes:statSync(destination).size};
  }

  close(): void { this.db.close(); }
}
