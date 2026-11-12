import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "@jest/globals";
import { CentralMemoryStore, type MemoryMutation } from "../../../src/memory/central-memory.js";

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
