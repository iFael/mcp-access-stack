import { describe,expect,it } from "@jest/globals";
import { CentralMemoryLegacyArchive,mirrorLegacyImportResponse,type LegacyDocument }
  from "../src/control-plane/central-memory-legacy-archive.js";
import type { CloudAuditStorage,CloudAuditTransaction } from "../src/control-plane/cloud-audit-store.js";

class Storage implements CloudAuditStorage {
  readonly data=new Map<string,unknown>();
  failWrites=false;
  async get<T>(key:string):Promise<T|undefined>{return this.data.get(key) as T|undefined;}
  async put(key:string,value:unknown):Promise<void>{this.data.set(key,structuredClone(value));}
  async delete(key:string):Promise<boolean>{return this.data.delete(key);}
  async transaction<T>(call:(txn:CloudAuditTransaction)=>Promise<T>):Promise<T>{
    const snapshot=new Map(this.data);
    const txn:CloudAuditTransaction={
      get:async<T>(key:string)=>snapshot.get(key) as T|undefined,
      put:async(key:string,value:unknown)=>{
        if(this.failWrites)throw new Error("DO_WRITE_FAILED");
        snapshot.set(key,structuredClone(value));
      },
      delete:async(key:string)=>snapshot.delete(key),
    };
    const result=await call(txn);
    this.data.clear();
    for(const [key,value] of snapshot)this.data.set(key,value);
    return result;
  }
}
const user="usr_11111111-1111-4111-8111-111111111111";
const repo="repo_a3c7aaa6-9fb9-4d06-ba79-29f3c4cf1767";
const names=["CURRENT_TASK.md","DECISIONS.md","HANDOFF.md","KNOWN_ISSUES.md",
  "NEXT_STEPS.md","PROJECT_CONTEXT.md"] as const;
async function sha(text:string){
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
async function fixture(){
  const docs:LegacyDocument[]=[];
  for(const surface of ["oracle","windows"] as const)for(const filename of names){
    const content=surface==="oracle"&&filename==="HANDOFF.md"
      ?"á😀".repeat(35_000)+"END"
      :"# "+filename+" / "+surface+"\n";
    docs.push({surface,filename,content,contentSha256:await sha(content)});
  }
  docs.sort((a,b)=>(a.surface+":"+a.filename).localeCompare(b.surface+":"+b.filename));
  const importHash=await sha(JSON.stringify(docs.map(d=>({
    surface:d.surface,filename:d.filename,hash:d.contentSha256,
  }))));
  const totalBytes=docs.reduce((n,d)=>n+new TextEncoder().encode(d.content).length,0);
  return {docs,importHash,totalBytes};
}

describe("Legacy source recovery outside Oracle",()=>{
  it("archives and restores both divergent six-file surfaces byte-identically",async()=>{
    const {docs,importHash,totalBytes}=await fixture();
    const store=new Storage();
    const archive=new CentralMemoryLegacyArchive(store);
    expect(await archive.persist(user,repo,docs,importHash,totalBytes))
      .toMatchObject({importHash,replayed:false,totalBytes});
    expect(await archive.persist(user,repo,docs,importHash,totalBytes))
      .toMatchObject({importHash,replayed:true});
    expect(await new CentralMemoryLegacyArchive(store).exportVerified(user,repo))
      .toEqual({importHash,totalBytes,documents:docs});
    expect([...store.data.values()].filter(x=>typeof x==="string")
      .every(x=>new TextEncoder().encode(x).length<131072)).toBe(true);
  });

  it("rejects changed hashes, missing chunks and partial transactions",async()=>{
    const {docs,importHash,totalBytes}=await fixture();
    const store=new Storage(),archive=new CentralMemoryLegacyArchive(store);
    await expect(archive.persist(user,repo,docs,"0".repeat(64),totalBytes))
      .rejects.toThrow("MEMORY_ARCHIVE_RECEIPT_MISMATCH");
    store.failWrites=true;
    await expect(archive.persist(user,repo,docs,importHash,totalBytes))
      .rejects.toThrow("DO_WRITE_FAILED");
    expect(store.data.size).toBe(0);
    store.failWrites=false;
    await archive.persist(user,repo,docs,importHash,totalBytes);
    const key=[...store.data.keys()].find(x=>x.includes(":chunk:"))!;
    store.data.delete(key);
    await expect(archive.exportVerified(user,repo)).rejects.toThrow("MEMORY_ARCHIVE_INCOMPLETE");
    await expect(archive.exportVerified("usr_22222222-2222-4222-8222-222222222222",repo))
      .rejects.toThrow("MEMORY_ARCHIVE_MISSING");
  });

  it("mirrors only a verified Oracle receipt, remaining idempotent",async()=>{
    const {docs,importHash,totalBytes}=await fixture(),store=new Storage();
    const args={workspaceId:"mcp-access-stack",repositoryId:repo,
      operationId:"import:legacy:0001",action:"import_legacy",documents:docs};
    const response=(hash:string,error=false)=>new Response(JSON.stringify({
      jsonrpc:"2.0",id:1,result:{isError:error,structuredContent:{
        repositoryId:repo,importHash:hash,totalBytes,filesImported:12,replayed:false,
      }},
    }),{headers:{"content-type":"application/json"}});
    expect(await mirrorLegacyImportResponse(store,user,args,response(importHash)))
      .toBe("persisted");
    expect(await mirrorLegacyImportResponse(store,user,args,response(importHash)))
      .toBe("persisted");
    expect(await new CentralMemoryLegacyArchive(store).exportVerified(user,repo))
      .toMatchObject({importHash,totalBytes});
    await expect(mirrorLegacyImportResponse(store,user,args,response("0".repeat(64))))
      .rejects.toThrow("MEMORY_ARCHIVE_RECEIPT_MISMATCH");
    expect(await mirrorLegacyImportResponse(store,user,args,response(importHash,true)))
      .toBe("upstream_error");
  });
});
