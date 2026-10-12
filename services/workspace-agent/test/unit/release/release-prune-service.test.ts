import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { beforeEach, afterEach, describe, expect, it } from "@jest/globals";
import { pruneReleasesInputSchema } from "@vs-code-gpt/shared";
import { ReleasePruneService } from "../../../src/release/release-prune-service.js";

const active = "1.1.0-beta.82";
const previous = "1.1.0-beta.81";
const candidate = "1.1.0-beta.83-oracle.1";
const old = "1.1.0-beta.69";
const stage = "1.1.0-beta.69.Ypf7Wr4j";
const pointer = (releaseId: string) => ({
  releaseId, manifestSha256: "0".repeat(64), materializedAt: "2026-10-07T21:32:12.338Z",
});

describe("ReleasePruneService (isolated physical fixture)", () => {
  let root: string;
  let blocked = false;
  let argumentsText = "";
  let mounts: string[] = [];
  let service: ReleasePruneService;
  const stateFile = () => path.join(root, "state", "lifecycle-state.v1.json");
  const targets = [{kind:"release" as const,name:old},{kind:"staging" as const,name:stage}];
  const makeInput = (dryRun:boolean, sha?:string, operationId=randomUUID()) => ({
    workspaceId:"ws", operationId, dryRun, ...(sha ? {expectedStateSha256:sha}:{}), targets,
  });
  const exists = async (p:string) => lstat(p).then(()=>true,()=>false);
  const state = (candidateValue:null | ReturnType<typeof pointer> = null) => ({
    version:1, active:pointer(active),previous:pointer(previous),candidate:candidateValue,
    updatedAt:"2026-10-07T21:34:40.252Z",
  });
  const writeState = async (v: ReturnType<typeof state>) =>
    writeFile(stateFile(),JSON.stringify(v));

  beforeEach(async()=>{
    root=await realpath(await mkdtemp(path.join(os.tmpdir(),"oracle-prune-")));
    for(const dir of ["releases","staging","state"]) await mkdir(path.join(root,dir));
    for(const name of [active,previous,candidate,old]) await mkdir(path.join(root,"releases",name));
    await mkdir(path.join(root,"staging",stage));
    await symlink(path.join(root,"releases",active),path.join(root,"current"),process.platform==="win32"?"junction":"dir");
    await writeState(state());
    blocked=false;argumentsText="";mounts=[];
    service=new ReleasePruneService({root,activeTasks:async()=>blocked,processes:async()=>argumentsText,mountPoints:async()=>mounts});
  });
  afterEach(async()=>{await rm(root,{recursive:true,force:true})});

  it("plans without altering obsolete directories or writing a lock",async()=>{
    const result=await service.prune(makeInput(true));
    expect(result.status).toBe("planned");
    expect(result.items.map(x=>x.status)).toEqual(["eligible","eligible"]);
    expect(result.stateSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await exists(path.join(root,"releases",old))).toBe(true);
    expect(await exists(path.join(root,"state","release-prune.lock"))).toBe(false);
  });

  it("deletes only planned identities and returns the durable result on a same-operation replay",async()=>{
    const preview=await service.prune(makeInput(true));
    const id=randomUUID();
    const input=makeInput(false,preview.stateSha256,id);
    const result=await service.prune(input);
    expect(result.status).toBe("completed");
    expect(result.items.map(x=>x.status)).toEqual(["deleted","deleted"]);
    expect(await exists(path.join(root,"releases",old))).toBe(false);
    expect(await exists(path.join(root,"staging",stage))).toBe(false);
    expect(await exists(path.join(root,"releases",active))).toBe(true);
    expect(await exists(path.join(root,"releases",previous))).toBe(true);
    expect(await service.prune(input)).toEqual(result);
    expect(await exists(path.join(root,"state","release-prune.lock"))).toBe(false);
  });

  it("protects active, previous and candidate releases and their staging",async()=>{
    await writeState(state(pointer(candidate)));
    for(const name of [active,previous,candidate]){
      await expect(service.prune({...makeInput(true),targets:[{kind:"release",name}]}))
        .rejects.toMatchObject({code:"PERMISSION_DENIED"});
    }
    const protectedStage=candidate+".abcdefgh";
    await mkdir(path.join(root,"staging",protectedStage));
    await expect(service.prune({...makeInput(true),targets:[{kind:"staging",name:protectedStage}]}))
      .rejects.toMatchObject({code:"PERMISSION_DENIED"});
  });

  it("fails closed for stale CAS, invalid names, duplicate targets and no execute-CAS",async()=>{
    const digest=(await service.prune(makeInput(true))).stateSha256;
    await writeState({...state(),updatedAt:"2026-10-08T00:00:00Z"});
    await expect(service.prune(makeInput(false,digest))).rejects.toMatchObject({code:"EXECUTION_STATE_INVALID"});
    for(const name of ["../x","/etc","..","1.1.0-beta.69/../../root"]){
      expect(pruneReleasesInputSchema.safeParse({...makeInput(true),targets:[{kind:"release",name}]}).success).toBe(false);
    }
    expect(pruneReleasesInputSchema.safeParse({...makeInput(false),expectedStateSha256:undefined}).success).toBe(false);
    expect(pruneReleasesInputSchema.safeParse({...makeInput(true),targets:[targets[0],targets[0]]}).success).toBe(false);
  });

  it("blocks running tasks and references from live process command lines",async()=>{
    blocked=true;
    await expect(service.prune(makeInput(true))).rejects.toMatchObject({code:"PERMISSION_DENIED"});
    blocked=false;
    argumentsText="node "+path.join(root,"releases",old,"services","mcp-gateway");
    await expect(service.prune(makeInput(true))).rejects.toMatchObject({code:"PERMISSION_DENIED"});
  });

  it("fails closed on symlink swaps, missing targets and unexpected top-level links",async()=>{
    const original=path.join(root,"releases",old);
    await rm(original,{recursive:true});
    await symlink(path.join(root,"releases",active),original,process.platform==="win32"?"junction":"dir");
    await expect(service.prune(makeInput(true))).rejects.toMatchObject({code:"PERMISSION_DENIED"});
    await rm(original);
    await expect(service.prune(makeInput(true))).rejects.toMatchObject({code:"PERMISSION_DENIED"});
    await mkdir(original);
    await symlink(original,path.join(root,"unknown"),process.platform==="win32"?"junction":"dir");
    await expect(service.prune(makeInput(true))).rejects.toMatchObject({code:"PERMISSION_DENIED"});
  });

  it("refuses mutation with unreconciled lock and does not delete",async()=>{
    const preview=await service.prune(makeInput(true));
    await writeFile(path.join(root,"state","release-prune.lock"),"unreconciled");
    await expect(service.prune(makeInput(false,preview.stateSha256)))
      .rejects.toMatchObject({code:"EXECUTION_STATE_INVALID"});
    expect(await exists(path.join(root,"releases",old))).toBe(true);
  });

  it("protects against operationId reuse with a distinct fingerprint",async()=>{
    const preview=await service.prune(makeInput(true));
    const id=randomUUID();
    await service.prune(makeInput(false,preview.stateSha256,id));
    await expect(service.prune({...makeInput(false,preview.stateSha256,id),
      targets:[{kind:"release" as const,name:"1.1.0-beta.80"}]}))
      .rejects.toMatchObject({code:"EXECUTION_STATE_INVALID"});
  });

  it("blocks mountpoints under stale release trees", async()=>{
    mounts=[path.join(root,"releases",old,"nested-mount")];
    await expect(service.prune(makeInput(true))).rejects.toMatchObject({code:"PERMISSION_DENIED"});
    expect(await exists(path.join(root,"releases",old))).toBe(true);
  });

  it("rejects a symlink replacing the receipt directory without following it", async()=>{
    const external=await mkdtemp(path.join(os.tmpdir(),"receipt-escape-"));
    try {
      await symlink(external,path.join(root,"state","release-prune-receipts"),process.platform==="win32"?"junction":"dir");
      const preview=await service.prune(makeInput(true));
      await expect(service.prune(makeInput(false,preview.stateSha256)))
        .rejects.toMatchObject({code:"PERMISSION_DENIED"});
      expect(await exists(path.join(root,"releases",old))).toBe(true);
    } finally { await rm(external,{recursive:true,force:true}); }
  });

  it("leaves a reconciliation lock after an interrupted multi-target deletion",async()=>{
    let checks=0;
    service=new ReleasePruneService({
      root,
      activeTasks:async()=>false,
      mountPoints:async()=>[],
      processes:async()=>{checks++;if(checks===5)throw new Error("disconnected");return "";},
    });
    const digest=(await service.prune(makeInput(true))).stateSha256;
    await expect(service.prune(makeInput(false,digest))).rejects.toThrow("disconnected");
    expect(await exists(path.join(root,"state","release-prune.lock"))).toBe(true);
    expect(await exists(path.join(root,"releases",old))).toBe(false);
    expect(await exists(path.join(root,"staging",stage))).toBe(true);
  });

  it("cancels before mutation and keeps target intact",async()=>{
    const controller=new AbortController();
    controller.abort();
    service=new ReleasePruneService({root,activeTasks:async()=>false,processes:async()=>"",
      mountPoints:async()=>[],signal:controller.signal});
    await expect(service.prune(makeInput(true))).rejects.toMatchObject({code:"OPERATION_CANCELLED"});
    expect(await exists(path.join(root,"releases",old))).toBe(true);
    expect(await exists(path.join(root,"state","release-prune.lock"))).toBe(false);
  });

  it("selects eligible releases automatically without changing existing explicit pruning",async()=>{
    const preview=await service.prune({
      workspaceId:"ws",operationId:randomUUID(),dryRun:true,selection:"eligible",
    });
    expect(preview.status).toBe("planned");
    expect(preview.items.map(item=>item.name)).toEqual([old,candidate,stage]);
    expect(preview.planSha256).toMatch(/^[a-f0-9]{64}$/);
    const id=randomUUID();
    const input={
      workspaceId:"ws",operationId:id,dryRun:false,selection:"eligible" as const,
      expectedStateSha256:preview.stateSha256,expectedPlanSha256:preview.planSha256!,
    };
    const result=await service.prune(input);
    expect(result.items.every(item=>item.status==="deleted")).toBe(true);
    expect(await service.prune(input)).toEqual(result);
    expect(await exists(path.join(root,"releases",active))).toBe(true);
    expect(await exists(path.join(root,"releases",previous))).toBe(true);
  });

  it("requires the exact automatic plan, protecting drift and candidate identities",async()=>{
    await writeState(state(pointer(candidate)));
    const preview=await service.prune({
      workspaceId:"ws",operationId:randomUUID(),dryRun:true,selection:"eligible",
    });
    expect(preview.items.map(item=>item.name)).toEqual([old,stage]);
    const base={
      workspaceId:"ws",operationId:randomUUID(),dryRun:false,
      selection:"eligible" as const,expectedStateSha256:preview.stateSha256,
    };
    expect(pruneReleasesInputSchema.safeParse(base).success).toBe(false);
    await expect(service.prune({...base,expectedPlanSha256:"0".repeat(64)}))
      .rejects.toMatchObject({code:"EXECUTION_STATE_INVALID"});
    await mkdir(path.join(root,"releases","1.1.0-beta.70"));
    await expect(service.prune({...base,expectedPlanSha256:preview.planSha256}))
      .rejects.toMatchObject({code:"EXECUTION_STATE_INVALID"});
    expect(await exists(path.join(root,"releases",old))).toBe(true);
  });

  it("automated selection has a five-target bound and accepts an empty safe plan",async()=>{
    for(let n=60;n<67;n++) await mkdir(path.join(root,"releases",`1.1.0-beta.${n}`));
    const input={workspaceId:"ws",operationId:randomUUID(),dryRun:true,selection:"eligible" as const};
    const planned=await service.prune(input);
    expect(planned.items).toHaveLength(5);
    expect(planned.items.every(item=>item.status==="eligible")).toBe(true);
    for(const dir of [old,candidate,...Array.from({length:7},(_,i)=>`1.1.0-beta.${i+60}`)]){
      await rm(path.join(root,"releases",dir),{recursive:true});
    }
    await rm(path.join(root,"staging",stage),{recursive:true});
    const empty=await service.prune(input);
    expect(empty.items).toEqual([]);
    const done=await service.prune({
      ...input,dryRun:false,expectedStateSha256:empty.stateSha256,
      expectedPlanSha256:empty.planSha256,
    });
    expect(done.status).toBe("completed");
    expect(done.items).toEqual([]);
  });

  it("never treats staged source as the active release",async()=>{
    const preview=await service.prune({...makeInput(true),targets:[{kind:"staging",name:stage}]});
    expect(preview.items).toHaveLength(1);
  });
});
