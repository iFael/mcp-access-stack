import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync,renameSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "@jest/globals";
import {inspectExecutionNodeCandidate}
  from "../../../src/release/oracle-candidate-read.js";

const version="1.1.0-beta.90",tag="v"+version,sha="a".repeat(40);
const roots:string[]=[];
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"mcp-v3-oracle-candidate-"));
  roots.push(root);
  mkdirSync(join(root,"state"));
  const folder=join(root,"releases",version);
  mkdirSync(folder,{recursive:true});
  const payload=Buffer.from("verified release bytes");
  writeFileSync(join(folder,"payload.dat"),payload);
  const base={schemaVersion:1,releaseId:version,tag,commit:sha,platform:"linux",
    artifacts:[{path:"payload.dat",
      sha256:createHash("sha256").update(payload).digest("hex")}]};
  const manifestPath=join(folder,"linux-release-manifest.json");
  const statePath=join(root,"state","lifecycle-state.v1.json");
  const writeManifest=(data:unknown)=>{
    const raw=Buffer.from(JSON.stringify(data));
    writeFileSync(manifestPath,raw);
    return createHash("sha256").update(raw).digest("hex");
  };
  const writeState=(manifestSha256:string,candidateId:string|null=version)=>{
    writeFileSync(statePath,JSON.stringify({version:1,active:null,previous:null,
      candidate:candidateId===null?null:
        {releaseId:candidateId,manifestSha256,materializedAt:"2026-10-17T00:00:00Z"}}));
  };
  const digest=writeManifest(base);
  writeState(digest);
  return {root,folder,base,digest,manifestPath,statePath,writeManifest,writeState};
}
afterEach(()=>{for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true});});
describe("bounded authenticated execution-node candidate reader",()=>{
  it("verifies genuine manifest and every artifact without exposing their bytes",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    expect(await inspectExecutionNodeCandidate(f.root,tag,sha)).toEqual({
      releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:f.digest,verifiedArtifactCount:1,
    });
  });
  it("rejects missing candidate, stale candidate identity and tampered digest",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    f.writeState(f.digest,null);
    await expect(inspectExecutionNodeCandidate(f.root,tag,sha)).rejects.toThrow();
    f.writeState(f.digest,"1.1.0-beta.89");
    await expect(inspectExecutionNodeCandidate(f.root,tag,sha)).rejects.toThrow();
    f.writeState("b".repeat(64));
    await expect(inspectExecutionNodeCandidate(f.root,tag,sha)).rejects.toThrow();
  });
  it("rejects path traversal, duplicate paths, changed payload and spoofed commit",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    const original=await inspectExecutionNodeCandidate(f.root,tag,sha);
    expect(original.verifiedArtifactCount).toBe(1);
    writeFileSync(join(f.folder,"payload.dat"),"tampered");
    await expect(inspectExecutionNodeCandidate(f.root,tag,sha)).rejects.toThrow();
    const hostile=f.writeManifest({...f.base,artifacts:[{
      path:"../state/lifecycle-state.v1.json",sha256:"b".repeat(64)}]});
    f.writeState(hostile);
    await expect(inspectExecutionNodeCandidate(f.root,tag,sha)).rejects.toThrow();
    const duplicate=f.writeManifest({...f.base,artifacts:[
      f.base.artifacts[0],f.base.artifacts[0]]});
    f.writeState(duplicate);
    await expect(inspectExecutionNodeCandidate(f.root,tag,sha)).rejects.toThrow();
    await expect(inspectExecutionNodeCandidate(f.root,tag,"c".repeat(40))).rejects.toThrow();
    await expect(inspectExecutionNodeCandidate(f.root,tag+"../x",sha)).rejects.toThrow();
  });
  it("rejects symlinked manifest and payload even with a matching digest",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    renameSync(f.manifestPath,f.manifestPath+".original");
    symlinkSync(f.manifestPath+".original",f.manifestPath);
    await expect(inspectExecutionNodeCandidate(f.root,tag,sha)).rejects.toThrow();
    rmSync(f.manifestPath);
    renameSync(f.manifestPath+".original",f.manifestPath);
    renameSync(join(f.folder,"payload.dat"),join(f.folder,"payload.original"));
    symlinkSync(join(f.folder,"payload.original"),join(f.folder,"payload.dat"));
    await expect(inspectExecutionNodeCandidate(f.root,tag,sha)).rejects.toThrow();
  });
  it("refuses noncanonical root, malformed tags and missing release directories",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    await expect(inspectExecutionNodeCandidate("relative",tag,sha)).rejects.toThrow();
    await expect(inspectExecutionNodeCandidate(f.root,"v../../etc",sha)).rejects.toThrow();
    await expect(inspectExecutionNodeCandidate(f.root,"v1.1.0-beta.91",sha)).rejects.toThrow();
  });
});
