import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "@jest/globals";
import { CentralMemoryStore, LEGACY_CODEX_FILES, type MemoryMutation } from "../../../src/memory/central-memory.js";

const repo = "repo_a3c7aaa6-9fb9-4d06-ba79-29f3c4cf1767";
const secondRepo = "repo_211ade70-85c8-409b-90ce-a0bb0f18dc8a";
const owner = "user:alice";
const folders: string[] = [];
const create = () => {
  const root = mkdtempSync(path.join(os.tmpdir(),"memory-test-"));
  folders.push(root);
  const releaseRoot = path.join(root,"releases");
  mkdirSync(releaseRoot);
  const databasePath = path.join(root,"state","central-memory.sqlite");
  const db = CentralMemoryStore.open(databasePath,releaseRoot);
  return {db,databasePath,releaseRoot,root};
};
afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir,{recursive:true,force:true});
});
const mutation = (overrides: Partial<MemoryMutation> = {}): MemoryMutation => ({
  repositoryId:repo,operationId:"operation:0001",action:"create",recordId:"record:1",
  expectedRevision:0,kind:"decision",confidence:"user_reported",
  title:"Use official MCP",content:"The user authorized native-only operations",
  evidenceRefs:["chat:decision:1"],...overrides,
});

describe("Oracle Central Memory store", () => {
  it("imports both six-file legacy surfaces losslessly in one transaction",()=>{
    const {db,databasePath,releaseRoot}=create();
    const documents=(["oracle","windows"] as const).flatMap(surface=>
      LEGACY_CODEX_FILES.map(filename=>{
        const content=surface+":"+filename+"\\n# preserved\\n";
        return {surface,filename,content,
          contentSha256:createHash("sha256").update(content).digest("hex")};
      }));
    expect(()=>db.importLegacySources(owner,repo,documents.slice(0,11)))
      .toThrow("MEMORY_IMPORT_INCOMPLETE");
    expect(db.readLegacySource(owner,repo,"oracle","DECISIONS.md")).toBeNull();
    const imported=db.importLegacySources(owner,repo,documents);
    expect(imported).toMatchObject({filesImported:12,replayed:false});
    expect(db.importLegacySources(owner,repo,documents)).toMatchObject({
      importHash:imported.importHash,replayed:true,
    });
    const changed=documents.map(doc=>doc.filename==="DECISIONS.md" && doc.surface==="windows"
      ? {...doc,content:"altered",contentSha256:createHash("sha256").update("altered").digest("hex")}
      : doc);
    expect(()=>db.importLegacySources(owner,repo,changed))
      .toThrow("MEMORY_IMPORT_CONFLICT");
    const tampered=documents.map((doc,i)=>i===0?{...doc,contentSha256:"0".repeat(64)}:doc);
    expect(()=>db.importLegacySources(owner,repo,tampered))
      .toThrow("MEMORY_IMPORT_SOURCE_MISMATCH");
    expect(db.readLegacySource(owner,repo,"windows","DECISIONS.md")).toEqual({
      content:"windows:DECISIONS.md\\n# preserved\\n",
      contentSha256:documents.find(doc=>doc.surface==="windows"&&doc.filename==="DECISIONS.md")!.contentSha256,
    });
    expect(db.readLegacySource("user:bob",repo,"windows","DECISIONS.md")).toBeNull();
    db.close();
    const reopened=CentralMemoryStore.open(databasePath,releaseRoot);
    expect(reopened.readLegacySource(owner,repo,"oracle","CURRENT_TASK.md")?.content)
      .toContain("preserved");
    reopened.close();
  });

  it("reconstructs a fresh Oracle authority from off-host hash-chained events",()=>{
    const origin=create();
    const firstMutation=mutation();
    const first=origin.db.update(owner,firstMutation);
    const secondMutation=mutation({
      action:"revise",expectedRevision:1,operationId:"operation:0002",
      title:"Version two",content:"The source of truth is the Oracle database",
    });
    const second=origin.db.update(owner,secondMutation);
    const event=(record:typeof first.record,operationId:string,previousDigest:string)=>{
      const recordDigest=createHash("sha256").update(JSON.stringify(record)).digest("hex");
      const chainDigest=createHash("sha256").update(
        previousDigest+":"+operationId+":"+recordDigest).digest("hex");
      return {version:1 as const,operationId,record,recordDigest,previousDigest,chainDigest};
    };
    const one=event(first.record,firstMutation.operationId,"0".repeat(64));
    const two=event(second.record,secondMutation.operationId,one.chainDigest);
    const restored=create();
    const archiveDigest=createHash("sha256").update(JSON.stringify([one,two])).digest("hex");
    const receipt=restored.db.restoreVerifiedEvents(owner,repo,[one,two],archiveDigest);
    expect(receipt).toMatchObject({events:2,records:1,replayed:false});
    expect(restored.db.restoreVerifiedEvents(owner,repo,[one,two],archiveDigest))
      .toMatchObject({...receipt,replayed:true});
    expect(restored.db.context(owner,repo).records)
      .toEqual(origin.db.context(owner,repo).records);
    expect(restored.db.history(owner,repo,"record:1"))
      .toEqual(origin.db.history(owner,repo,"record:1"));
    expect(restored.db.update(owner,firstMutation)).toEqual({...first,replayed:true});
    expect(restored.db.update(owner,secondMutation)).toEqual({...second,replayed:true});
    origin.db.close();restored.db.close();
  });

  it("never partially restores a corrupt or incomplete archive",()=>{
    const source=create();
    const first=source.db.update(owner,mutation());
    const digest=createHash("sha256").update(JSON.stringify(first.record)).digest("hex");
    const entry={version:1 as const,operationId:"operation:0001",record:first.record,
      recordDigest:digest,previousDigest:"0".repeat(64),
      chainDigest:createHash("sha256").update("0".repeat(64)+":operation:0001:"+digest).digest("hex")};
    const target=create();
    const incorrect=[{...entry,record:{...entry.record,content:"tampered"}}];
    const incorrectDigest=createHash("sha256").update(JSON.stringify(incorrect)).digest("hex");
    expect(()=>target.db.restoreVerifiedEvents(owner,repo,incorrect,incorrectDigest))
      .toThrow("MEMORY_RESTORE_EVENT_CORRUPT");
    expect(target.db.context(owner,repo).records).toEqual([]);
    expect(target.db.history(owner,repo,"record:1")).toEqual([]);
    const digestOfArchive=createHash("sha256").update(JSON.stringify([entry])).digest("hex");
    expect(()=>target.db.restoreVerifiedEvents(owner,repo,[entry],"0".repeat(64)))
      .toThrow("MEMORY_RESTORE_ARCHIVE_MISMATCH");
    expect(target.db.restoreVerifiedEvents(owner,repo,[entry],digestOfArchive))
      .toMatchObject({records:1});
    const changed=[{...entry,operationId:"operation:9999"}];
    expect(()=>target.db.restoreVerifiedEvents(owner,repo,changed,
      createHash("sha256").update(JSON.stringify(changed)).digest("hex")))
      .toThrow("MEMORY_RESTORE_EVENT_CORRUPT");
    source.db.close();target.db.close();
  });

  it("persists across reopen, revisions, history and idempotent retries", () => {
    const {db,databasePath,releaseRoot} = create();
    const first=db.update(owner,mutation());
    expect(first).toMatchObject({replayed:false,record:{revision:1,status:"active"}});
    expect(db.update(owner,mutation())).toEqual({...first,replayed:true});
    expect(() => db.update(owner,mutation({title:"changed"}))).toThrow("MEMORY_IDEMPOTENCY_CONFLICT");
    expect(() => db.update(owner,mutation({operationId:"operation:0002"}))).toThrow("MEMORY_CAS_CONFLICT");
    const second=db.update(owner,mutation({
      action:"revise",expectedRevision:1,operationId:"operation:0003",
      title:"Native operations",content:"New approved decision",
    }));
    expect(second.record.revision).toBe(2);
    db.close();
    const reopened=CentralMemoryStore.open(databasePath,releaseRoot);
    expect(reopened.context(owner,repo)).toMatchObject({
      totalActive:1,records:[{revision:2,title:"Native operations"}],
    });
    const closed=reopened.update(owner,{
      repositoryId:repo,operationId:"operation:0004",action:"resolve",
      recordId:"record:1",expectedRevision:2,
    });
    expect(closed.record.status).toBe("resolved");
    expect(reopened.context(owner,repo).totalActive).toBe(0);
    expect(reopened.history(owner,repo,"record:1").map(v=>v.revision)).toEqual([1,2,3]);
    expect(() => reopened.update(owner,mutation({
      operationId:"operation:0005",action:"revise",expectedRevision:3,
    }))).toThrow("MEMORY_ALREADY_RESOLVED");
    reopened.close();
  });

  it("isolates users and repositories, and treats wildcard text literally", () => {
    const {db}=create();
    db.update(owner,mutation({title:"100% complete"}));
    expect(db.context("user:bob",repo).records).toEqual([]);
    expect(db.context(owner,secondRepo).records).toEqual([]);
    expect(db.context(owner,repo,"100%").records).toHaveLength(1);
    expect(db.context(owner,repo,"%").records).toHaveLength(1);
    expect(db.context(owner,repo,"___").records).toHaveLength(0);
    expect(() => db.context("session:anonymous",repo)).toThrow("MEMORY_IDENTITY_REQUIRED");
    expect(() => db.context(owner,"repo_not_valid")).toThrow("MEMORY_REPOSITORY_INVALID");
    db.close();
  });

  it("rejects invalid CAS, partial records, fake verified status and unsafe identifiers", () => {
    const {db}=create();
    expect(() => db.update(owner,mutation({confidence:"verified" as never})))
      .toThrow("MEMORY_CONTENT_INVALID");
    expect(() => db.update(owner,mutation({content:""}))).toThrow("MEMORY_CONTENT_INVALID");
    expect(() => db.update(owner,mutation({operationId:"x"}))).toThrow("MEMORY_IDENTIFIER_INVALID");
    expect(() => db.update(owner,mutation({expectedRevision:1}))).toThrow("MEMORY_REVISION_INVALID");
    expect(() => db.update(owner,mutation({
      action:"resolve",expectedRevision:1,title:"must not change",operationId:"operation:resolve",
    }))).toThrow("MEMORY_RESOLVE_FIELDS_INVALID");
    expect(db.context(owner,repo).records).toEqual([]);
    db.close();
  });

  it("refuses dangling symlink DB paths and snapshot destinations",async()=>{
    const {db,root,releaseRoot}=create();
    const dangling=path.join(root,"state","dangling.sqlite");
    const escaped=path.join(root,"escaped.sqlite");
    symlinkSync(escaped,dangling);
    expect(()=>CentralMemoryStore.open(dangling,releaseRoot)).toThrow("MEMORY_PATH_INVALID");
    expect(existsSync(escaped)).toBe(false);
    const output=path.join(root,"outside-snapshot.sqlite");
    symlinkSync(escaped,output);
    await expect(db.createVerifiedSnapshot(output)).rejects.toThrow("MEMORY_BACKUP_PATH_INVALID");
    expect(existsSync(escaped)).toBe(false);
    db.close();
  });

  it("does not adopt an unversioned database or a database with missing audit triggers",()=>{
    const {db,root,releaseRoot}=create();
    db.close();
    const unversioned=path.join(root,"state","unversioned.sqlite");
    const initial=new DatabaseSync(unversioned);
    initial.exec("CREATE TABLE unknown_secret (value TEXT NOT NULL)");
    initial.close();
    expect(()=>CentralMemoryStore.open(unversioned,releaseRoot))
      .toThrow("MEMORY_UNVERSIONED_DB");
    const after=new DatabaseSync(unversioned);
    const names=after.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as
      Array<{name:string}>;
    expect(names.map(x=>x.name)).toEqual(["unknown_secret"]);
    after.close();
    const knownPath=path.join(root,"state","central-memory.sqlite");
    const removed=new DatabaseSync(knownPath);
    removed.exec("DROP TRIGGER immutable_event_delete");
    removed.close();
    expect(()=>CentralMemoryStore.open(knownPath,releaseRoot))
      .toThrow("MEMORY_SCHEMA_MISMATCH");
  });

  it("fails closed for symlinks, release tree, and unknown schema versions", () => {
    const {db,databasePath,releaseRoot,root}=create();
    db.close();
    const unsafe=path.join(root,"state","redirect.sqlite");
    symlinkSync(databasePath,unsafe);
    expect(() => CentralMemoryStore.open(unsafe,releaseRoot)).toThrow("MEMORY_PATH_INVALID");
    expect(() => CentralMemoryStore.open(path.join(releaseRoot,"inside.sqlite"),releaseRoot))
      .toThrow("MEMORY_PATH_INSIDE_RELEASE");
    const sqlite=new DatabaseSync(databasePath);
    sqlite.prepare("UPDATE schema_version SET checksum=? WHERE version=1").run("bad");
    sqlite.close();
    expect(() => CentralMemoryStore.open(databasePath,releaseRoot))
      .toThrow("MEMORY_SCHEMA_MISMATCH");
  });

  it("exports a consistent, restorable snapshot with its exact digest", async () => {
    const {db,root,releaseRoot}=create();
    db.update(owner,mutation());
    const backupPath=path.join(root,"offload","snapshot.sqlite");
    const receipt=await db.createVerifiedSnapshot(backupPath);
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt.bytes).toBeGreaterThan(0);
    expect(() => db.createVerifiedSnapshot(backupPath)).rejects.toThrow("MEMORY_BACKUP_PATH_INVALID");
    db.close();
    const restored=CentralMemoryStore.open(backupPath,releaseRoot);
    expect(restored.context(owner,repo).records).toMatchObject([{title:"Use official MCP",revision:1}]);
    restored.close();
  });

  it("preserves evidence history in append-only table", () => {
    const {db,databasePath}=create();
    db.update(owner,mutation());
    const external=new DatabaseSync(databasePath);
    expect(() => external.exec("DELETE FROM events")).toThrow("MEMORY_EVENT_IMMUTABLE");
    external.close();
    expect(db.history(owner,repo,"record:1")).toHaveLength(1);
    db.close();
  });
});
