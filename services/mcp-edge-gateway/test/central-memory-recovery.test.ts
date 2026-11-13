import { describe,expect,it } from "@jest/globals";
import { CentralMemoryRecovery, exportCentralMemoryRecovery, mirrorMemoryUpdateResponse, mirrorLegacyActivationResponse, mirrorNativeCheckpointResponse, markNativeCheckpointDeferred, verifyLegacyCutoverRecovery, type RecoveryRecord } from "../src/control-plane/central-memory-recovery.js";
import { CentralMemoryLegacyArchive } from "../src/control-plane/central-memory-legacy-archive.js";
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
  it("blocks cutover until the off-host legacy copy and curated event ledger both verify",async()=>{
    const storage=new MemoryStorage();
    const hash=async(value:string)=>{
      const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
      return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
    };
    const names=["CURRENT_TASK.md","DECISIONS.md","HANDOFF.md","KNOWN_ISSUES.md",
      "NEXT_STEPS.md","PROJECT_CONTEXT.md"] as const;
    const docs=await Promise.all((["oracle","windows"] as const).flatMap(surface=>
      names.map(async filename=>{
        const content=surface+":"+filename+"\nA preserved source";
        return {surface,filename,content,contentSha256:await hash(content)};
      })));
    const sorted=[...docs].sort((a,b)=>
      (a.surface+":"+a.filename).localeCompare(b.surface+":"+b.filename));
    const importHash=await hash(JSON.stringify(sorted.map(d=>({
      surface:d.surface,filename:d.filename,hash:d.contentSha256,
    }))));
    const storageBackup=new CentralMemoryLegacyArchive(storage);
    const backupDigest="a".repeat(64);
    await expect(verifyLegacyCutoverRecovery(storage,user,repo,importHash,backupDigest))
      .rejects.toThrow("MEMORY_ARCHIVE_MISSING");
    const bytes=docs.reduce((total,d)=>total+new TextEncoder().encode(d.content).length,0);
    await storageBackup.persist(user,repo,docs,importHash,bytes);
    await expect(verifyLegacyCutoverRecovery(storage,user,repo,importHash,backupDigest))
      .rejects.toThrow("MEMORY_RECOVERY_ARCHIVE_INCOMPLETE");
    const ledger=new CentralMemoryRecovery(storage);
    await ledger.append(user,repo,"memory:update:0001",0,record());
    const archiveDigest=(await ledger.exportVerified(user,repo)).archiveDigest;
    await expect(verifyLegacyCutoverRecovery(storage,user,repo,importHash,"f".repeat(64)))
      .rejects.toThrow("MEMORY_RECOVERY_CUTOVER_BACKUP_MISMATCH");
    await expect(verifyLegacyCutoverRecovery(storage,user,repo,
      "f".repeat(64),archiveDigest)).rejects.toThrow("MEMORY_RECOVERY_CUTOVER_BACKUP_MISMATCH");
    await expect(verifyLegacyCutoverRecovery(storage,user,repo,importHash,archiveDigest))
      .resolves.toBeUndefined();
  });

  it("preserves an authenticated activation receipt independently of Oracle across later updates",async()=>{
    const storage=new MemoryStorage();
    const digest=async(value:string)=>{
      const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));
      return [...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,"0")).join("");
    };
    const names=["CURRENT_TASK.md","DECISIONS.md","HANDOFF.md","KNOWN_ISSUES.md",
      "NEXT_STEPS.md","PROJECT_CONTEXT.md"] as const;
    const docs=await Promise.all((["oracle","windows"] as const).flatMap(surface=>
      names.map(async filename=>{
        const content=surface+":"+filename;
        return {surface,filename,content,contentSha256:await digest(content)};
      })));
    const sorted=[...docs].sort((a,b)=>
      (a.surface+":"+a.filename).localeCompare(b.surface+":"+b.filename));
    const importHash=await digest(JSON.stringify(sorted.map(d=>({
      surface:d.surface,filename:d.filename,hash:d.contentSha256,
    }))));
    await new CentralMemoryLegacyArchive(storage).persist(user,repo,docs,importHash,
      docs.reduce((n,d)=>n+new TextEncoder().encode(d.content).length,0));
    const ledger=new CentralMemoryRecovery(storage);
    await ledger.append(user,repo,"memory:update:0001",0,record());
    const archiveDigest=(await ledger.exportVerified(user,repo)).archiveDigest;
    const args={action:"activate_legacy",repositoryId:repo,
      operationId:"memory:activate:001",importHash,archiveDigest};
    const response=(activatedAt:string)=>new Response(JSON.stringify({
      jsonrpc:"2.0",id:1,result:{structuredContent:{
        repositoryId:repo,importHash,archiveDigest,activatedAt,replayed:false,
      }},
    }));
    expect(await mirrorLegacyActivationResponse(storage,user,args,
      response("2026-11-12T21:00:00.000Z"))).toBe("persisted");
    await ledger.append(user,repo,"memory:update:0002",1,
      record({revision:2,updatedAt:"2026-11-12T22:00:00.000Z"}));
    const exported=await exportCentralMemoryRecovery(storage,user,repo,{kind:"events"});
    expect(exported).toMatchObject({totalEvents:2,
      activation:{operationId:args.operationId,importHash,archiveDigest,
        activatedAt:"2026-11-12T21:00:00.000Z"}});
    await expect(verifyLegacyCutoverRecovery(storage,user,repo,importHash,archiveDigest))
      .resolves.toBeUndefined();
    // An independently rebuilt Oracle authority may reuse the same operationId
    // with a different local timestamp; the original off-host receipt is immutable.
    expect(await mirrorLegacyActivationResponse(storage,user,args,
      response("2026-11-13T01:00:00.000Z"))).toBe("persisted");
    await expect(mirrorLegacyActivationResponse(storage,user,
      {...args,operationId:"memory:activate:other"},
      response("2026-11-13T02:00:00.000Z")))
      .rejects.toThrow("MEMORY_RECOVERY_ACTIVATION_CONFLICT");
  });

  it("exports hash-chained events without using Oracle after its loss",async()=>{
    const storage=new MemoryStorage(),writer=new CentralMemoryRecovery(storage);
    await writer.append(user,repo,"memory:update:0001",0,record());
    const output=await exportCentralMemoryRecovery(storage,user,repo,{
      kind:"events",offset:0,limit:1,
    });
    expect(output).toMatchObject({kind:"events",repositoryId:repo,totalEvents:1,
      truncated:false,events:[{record:{title:"Single Oracle authority"}}]});
    expect(output.archiveDigest).toMatch(/^[a-f0-9]{64}$/u);
    await expect(exportCentralMemoryRecovery(storage,another,repo,{kind:"events"}))
      .rejects.toThrow("MEMORY_RECOVERY_ARCHIVE_INCOMPLETE");
    await expect(exportCentralMemoryRecovery(storage,user,repo,{kind:"events",limit:6}))
      .rejects.toThrow("MEMORY_RECOVERY_INPUT_INVALID");
  });

  it("mirrors trusted native tool checkpoints without repeating a completed release",async()=>{
    const storage=new MemoryStorage();
    const key="io.github.ifael/mcp-memory-checkpoint";
    const metadata={version:1,tool:"mcp_update",operationId:"native:mcp_update:001",
      expectedRevision:0,record:record()};
    const response=(value:unknown)=>new Response(JSON.stringify({
      jsonrpc:"2.0",id:1,result:{content:[{type:"text",text:"Update succeeded"}],
        _meta:{[key]:value}},
    }),{headers:{"content-type":"application/json"}});
    const allow=async(id:string)=>id===repo;
    expect(await mirrorNativeCheckpointResponse(storage,user,"mcp_update",
      response(metadata),allow)).toBe("persisted");
    expect(await mirrorNativeCheckpointResponse(storage,user,"mcp_update",
      response(metadata),allow)).toBe("persisted");
    expect((await new CentralMemoryRecovery(storage).verifyRecord(
      user,repo,"decision:single-memory")).length).toBe(1);
    await expect(mirrorNativeCheckpointResponse(storage,user,"github_merge_pull_request",
      response(metadata),allow)).rejects.toThrow("MEMORY_RECOVERY_RECEIPT_INVALID");
    await expect(mirrorNativeCheckpointResponse(storage,user,"mcp_update",
      response(metadata),async()=>false)).rejects.toThrow("MEMORY_RECOVERY_RECEIPT_UNAUTHORIZED");
    const absent=new Response(JSON.stringify({jsonrpc:"2.0",id:2,result:{
      content:[{type:"text",text:"No checkpoint"}]}}));
    expect(await mirrorNativeCheckpointResponse(storage,user,"mcp_update",absent,allow))
      .toBe("none");
    const marked=await markNativeCheckpointDeferred(response(metadata));
    const result=await marked.json() as {result:{content:unknown[];_meta:Record<string,unknown>}};
    expect(result.result.content).toEqual([{type:"text",text:"Update succeeded"}]);
    expect(result.result._meta["io.github.ifael/mcp-memory-warning"]).toBe("recovery_deferred");
    expect(result.result._meta[key]).toEqual(metadata);
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
