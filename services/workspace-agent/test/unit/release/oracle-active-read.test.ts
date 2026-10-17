import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync,
  renameSync,unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "@jest/globals";
import {inspectExecutionNodeActive,inspectExecutionNodeCandidate}
  from "../../../src/release/oracle-candidate-read.js";
const version="1.1.0-beta.90",tag="v"+version,commit="a".repeat(40);
const roots:string[]=[];
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"mcp-v3-oracle-active-"));
  roots.push(root);
  const dir=join(root,"releases",version);
  mkdirSync(dir,{recursive:true});mkdirSync(join(root,"state"));
  const file=join(dir,"payload.dat");
  const bytes=Buffer.from("release bytes verified at runtime");
  writeFileSync(file,bytes);
  const manifestPath=join(dir,"linux-release-manifest.json");
  const manifest={schemaVersion:1,releaseId:version,tag,commit,
    platform:"linux",artifacts:[{path:"payload.dat",
      sha256:createHash("sha256").update(bytes).digest("hex")}]};
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  writeFileSync(manifestPath,manifestBytes);
  const digest=createHash("sha256").update(manifestBytes).digest("hex");
  const previous={releaseId:"1.1.0-beta.89",
    manifestSha256:"b".repeat(64),materializedAt:"2026-10-17T00:00:00Z"};
  const active={releaseId:version,manifestSha256:digest,
    materializedAt:"2026-10-17T00:00:00Z"};
  const lifecycle={version:1,active,previous,candidate:null};
  const statePath=join(root,"state","lifecycle-state.v1.json");
  const writeState=(next:unknown)=>writeFileSync(statePath,JSON.stringify(next));
  writeState(lifecycle);
  const pointer=join(root,"current");
  symlinkSync(dir,pointer);
  return {root,dir,file,manifestPath,pointer,statePath,
    digest,active,previous,lifecycle,writeState};
}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
describe("Oracle active release attestation uses actual bytes and immutable slot",()=>{
  it("verifies all deployed artifacts and rejects candidate substitution",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    expect(await inspectExecutionNodeActive(f.root,tag,commit)).toEqual({
      releaseTag:tag,sourceCommitSha:commit,
      manifestSha256:f.digest,verifiedArtifactCount:1,
    });
    await expect(inspectExecutionNodeCandidate(f.root,tag,commit)).rejects.toThrow();
  });
  it("refuses an active release without rollback, or with a pending candidate",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    f.writeState({...f.lifecycle,previous:null});
    await expect(inspectExecutionNodeActive(f.root,tag,commit)).rejects.toThrow();
    f.writeState({...f.lifecycle,candidate:f.active});
    await expect(inspectExecutionNodeActive(f.root,tag,commit)).rejects.toThrow();
  });
  it("rejects a mismatched current pointer and a tampered active manifest",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    unlinkSync(f.pointer);
    const other=join(f.root,"releases","other");
    mkdirSync(other);symlinkSync(other,f.pointer);
    await expect(inspectExecutionNodeActive(f.root,tag,commit)).rejects.toThrow();
    unlinkSync(f.pointer);symlinkSync(f.dir,f.pointer);
    writeFileSync(f.file,"tampered");
    await expect(inspectExecutionNodeActive(f.root,tag,commit)).rejects.toThrow();
    await expect(inspectExecutionNodeActive(f.root,tag,"c".repeat(40))).rejects.toThrow();
  });
  it("rejects a symlinked manifest even when state digest still matches",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    renameSync(f.manifestPath,f.manifestPath+".real");
    symlinkSync(f.manifestPath+".real",f.manifestPath);
    await expect(inspectExecutionNodeActive(f.root,tag,commit)).rejects.toThrow();
  });
});
