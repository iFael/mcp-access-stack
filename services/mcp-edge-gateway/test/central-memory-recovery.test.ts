import { describe,expect,it } from "@jest/globals";
import { CentralMemoryRecovery, CentralMemoryLegacyBackup, mirrorMemoryUpdateResponse, mirrorLegacyImportResponse, type RecoveryRecord } from "../src/control-plane/central-memory-recovery.js";
import type { CloudAuditStorage, CloudAuditTransaction } from "../src/control-plane/cloud-audit-store.js";

class MemoryStorage implements CloudAuditStorage {
  readonly data=new Map<string,unknown>();
  failWrites=false;
  async get<T>(key:string):Promise<T|undefined>{return this.data.get(key) as T|undefined;}
  async put(key:string,value:unknown):Promise<void>{this.data.set(key,structuredClone(value));}
  async delete(key:string):Promise<boolean>{return this.data.delete(key);}
  async list<T>({prefix,limit}:{prefix:string;limit?:number}):Promise<Map<string,T>>{
    return new Map([...this.data.entries()].filter(([key])=>key.startsWith(prefix))
      .sort(([a],[b])=>a.localeCompare(b)).slice(0,limit).map(([key,value])=>[key,value as T]));
  }
  async transaction<T>(callback:(txn:CloudAuditTransaction)=>Promise<T>):Promise<T>{
    const staging=new Map(this.data);
    const txn:CloudAuditTransaction={
      get:async<T>(key:string)=>staging.get(key) as T|undefined,
      put:async(key:string,value:unknown)=>{
        if(this.failWrites) throw new Error("STORAGE_FAILURE");
        staging.set(key,structuredClone(value));
      },
      delete:async(key:string)=>staging.delete(key),
    };
    const result=await callback(txn);
    this.data.clear();
    for(const [key,value] of staging)this.data.set(key,value);
    return result;
  }
}
const user="usr_11111111-1111-4111-8111-111111111111";
const another="usr_22222222-2222-4222-8222-222222222222";
const repo="repo_a3c7aaa6-9fb9-4d06-ba79-29f3c4cf1767";
const otherRepo="repo_cacd044a-ba77-4d94-b483-b63c60391f0a";
const record=(changes:Partial<RecoveryRecord>={}):RecoveryRecord=>({
  repositoryId:repo,recordId:"decision:single-memory",revision:1,
  kind:"decision",status:"active",confidence:"user_reported",
  title:"Single Oracle authority",content:"Central Memory is authoritative.",
  evidenceRefs:["chat:decision:1"],updatedAt:"2026-11-12T17:00:00.000Z",
  ...changes,
});

describe("Cloudflare off-host central memory recovery",()=>{
  it("persists twelve divergent .codex documents off-host in bounded chunks",async()=>{
    const storage=new MemoryStorage(),archive=new CentralMemoryLegacyBackup(storage);
    const names=["CURRENT_TASK.md","DECISIONS.md","HANDOFF.md","KNOWN_ISSUES.md",
      "NEXT_STEPS.md","PROJECT_CONTEXT.md"] as const;
    const documents=await Promise.all((["oracle","windows"] as const).flatMap(surface=>
      names.map(async filename=>{
        const content=surface+":"+filename+"\n"+"á😀".repeat(filename==="HANDOFF.md"?60_000:500);
        const digestBytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(content));
        const contentSha256=[...new Uint8Array(digestBytes)]
          .map(x=>x.toString(16).padStart(2,"0")).join("");
        return {surface,filename,content,contentSha256};
      })));
    const sorted=[...documents].sort((a,b)=>
      (a.surface+":"+a.filename).localeCompare(b.surface+":"+b.filename));
    const digestBytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(
      JSON.stringify(sorted.map(d=>({surface:d.surface,filename:d.filename,hash:d.contentSha256})))));
    const importHash=[...new Uint8Array(digestBytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
    const totalBytes=documents.reduce((a,d)=>a+new TextEncoder().encode(d.content).length,0);
    const receipt=await archive.archive(user,repo,"memory:legacy:20261112",documents,importHash,totalBytes);
    expect(receipt).toMatchObject({importHash,replayed:false});
    expect(await archive.archive(user,repo,"memory:legacy:20261112",documents,importHash,totalBytes))
      .toMatchObject({replayed:true});
    const recovered=await new CentralMemoryLegacyBackup(storage).restore(user,repo);
    expect(recovered.documents).toEqual(sorted);
    expect(recovered.totalBytes).toBe(totalBytes);
    const chunks=[...storage.data.entries()].filter(([k])=>k.includes(":legacy:chunk:"));
    expect(chunks.length).toBeGreaterThan(12);
    for(const [,content] of chunks)expect(JSON.stringify(content).length).toBeLessThan(131072);
    const key=chunks[0]![0];
    storage.data.set(key,"Zm9v");
    await expect(new CentralMemoryLegacyBackup(storage).restore(user,repo))
      .rejects.toThrow("MEMORY_RECOVERY_LEGACY_CORRUPT");
  });

  it("refuses invalid import receipts or partial archive writes",async()=>{
    const storage=new MemoryStorage();
    const response=new Response(JSON.stringify({result:{structuredContent:{
      repositoryId:repo,importHash:"0".repeat(64),totalBytes:10,filesImported:12,
    }}}));
    await expect(mirrorLegacyImportResponse(storage,user,{
      repositoryId:repo,operationId:"memory:legacy:bad",action:"import_legacy",documents:[],
    },response)).rejects.toThrow("MEMORY_RECOVERY_LEGACY_INPUT_INVALID");
    expect(storage.data.size).toBe(0);
  });

  it("mirrors only successful Oracle mutation receipts after validating the request identity",async()=>{
    const storage=new MemoryStorage();
    const args={repositoryId:repo,operationId:"memory:update:0001",recordId:"decision:single-memory",
      action:"create",expectedRevision:0,kind:"decision",confidence:"user_reported",
      title:"Single Oracle authority",content:"Central Memory is authoritative.",
      evidenceRefs:["chat:decision:1"]};
    const response=(entry:unknown,isError=false)=>new Response(JSON.stringify({
      jsonrpc:"2.0",id:1,result:{isError,structuredContent:{record:entry}},
    }),{headers:{"content-type":"application/json"}});
    expect(await mirrorMemoryUpdateResponse(storage,user,args,response(record())))
      .toBe("persisted");
    expect(await mirrorMemoryUpdateResponse(storage,user,args,response(record())))
      .toBe("persisted");
    expect((await new CentralMemoryRecovery(storage).verifyRecord(
      user,repo,"decision:single-memory")).length).toBe(1);
    await expect(mirrorMemoryUpdateResponse(storage,user,{...args,recordId:"other"},
      response(record()))).rejects.toThrow("MEMORY_RECOVERY_RECEIPT_INVALID");
    await expect(mirrorMemoryUpdateResponse(storage,user,args,
      response(record({content:"forged"})))).rejects.toThrow("MEMORY_RECOVERY_RECEIPT_INVALID");
    const before=storage.data.size;
    expect(await mirrorMemoryUpdateResponse(storage,user,args,
      response(record(),true))).toBe("upstream_error");
    expect(storage.data.size).toBe(before);
  });

  it("stores idempotent immutable revisions and reconstructs after a cold reopen",async()=>{
    const storage=new MemoryStorage();
    const ledger=new CentralMemoryRecovery(storage);
    const first=await ledger.append(user,repo,"memory:update:0001",0,record());
    expect(first).toMatchObject({replayed:false});
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(await ledger.append(user,repo,"memory:update:0001",0,record()))
      .toEqual({...first,replayed:true});
    const revised=record({revision:2,content:"The authority has been deployed.",updatedAt:"2026-11-12T18:00:00.000Z"});
    await ledger.append(user,repo,"memory:update:0002",1,revised);
    const recovered=new CentralMemoryRecovery(storage);
    const events=await recovered.verifyRecord(user,repo,"decision:single-memory");
    expect(events.map(e=>e.record.revision)).toEqual([1,2]);
    expect(events[1]?.previousDigest).toBe(events[0]?.chainDigest);
    expect(events[1]?.record.content).toBe(revised.content);
    const snapshot=await recovered.exportVerified(user,repo);
    expect(snapshot.events).toEqual(events);
    expect(snapshot.archiveDigest).toMatch(/^[a-f0-9]{64}$/u);
    const manifestKey=[...storage.data.keys()].find(k=>k.endsWith(":manifest"))!;
    const originalManifest=storage.data.get(manifestKey);
    storage.data.set(manifestKey,{records:1,events:1});
    await expect(recovered.exportVerified(user,repo)).rejects.toThrow("MEMORY_RECOVERY_ARCHIVE_INCOMPLETE");
    storage.data.set(manifestKey,originalManifest);
    expect(await recovered.verifyRecord(another,repo,"decision:single-memory")).toEqual([]);
    expect(await recovered.verifyRecord(user,otherRepo,"decision:single-memory")).toEqual([]);
  });

  it("fails closed on out-of-order revision, conflicting replay or injected record",async()=>{
    const storage=new MemoryStorage(),ledger=new CentralMemoryRecovery(storage);
    expect(ledger.append(user,repo,"memory:update:0002",1,record({revision:2})))
      .rejects.toThrow("MEMORY_RECOVERY_CAS_MISMATCH");
    expect(ledger.append(user,repo,"memory:update:0001",0,record({repositoryId:otherRepo})))
      .rejects.toThrow("MEMORY_RECOVERY_RECORD_INVALID");
    expect(ledger.append(user,repo,"memory:update:0001",0,record({content:""})))
      .rejects.toThrow("MEMORY_RECOVERY_RECORD_INVALID");
    await ledger.append(user,repo,"memory:update:0001",0,record());
    expect(ledger.append(user,repo,"memory:update:0001",0,record({content:"tamper"})))
      .rejects.toThrow("MEMORY_RECOVERY_REPLAY_CONFLICT");
    expect(ledger.append(user,repo,"memory:update:0002",0,record()))
      .rejects.toThrow("MEMORY_RECOVERY_CAS_MISMATCH");
    expect(ledger.append("invalid",repo,"memory:update:0003",1,record({revision:2})))
      .rejects.toThrow("MEMORY_RECOVERY_INPUT_INVALID");
  });

  it("does not partially commit when off-host persistence fails",async()=>{
    const storage=new MemoryStorage(),ledger=new CentralMemoryRecovery(storage);
    storage.failWrites=true;
    await expect(ledger.append(user,repo,"memory:update:0001",0,record()))
      .rejects.toThrow("STORAGE_FAILURE");
    expect(storage.data.size).toBe(0);
    storage.failWrites=false;
    expect(await ledger.append(user,repo,"memory:update:0001",0,record()))
      .toMatchObject({replayed:false});
  });

  it("detects tampering and missing or out-of-order recovery events",async()=>{
    const storage=new MemoryStorage(),ledger=new CentralMemoryRecovery(storage);
    await ledger.append(user,repo,"memory:update:0001",0,record());
    const key=[...storage.data.keys()].find(x=>x.includes(":event:"))!;
    const changed=structuredClone(storage.data.get(key)) as {record:RecoveryRecord};
    changed.record.content="tampered";
    storage.data.set(key,changed);
    await expect(ledger.verifyRecord(user,repo,"decision:single-memory"))
      .rejects.toThrow("MEMORY_RECOVERY_EVENT_CORRUPT");
  });
});
