import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach,describe,expect,it} from "@jest/globals";
import {bindOracleLocalCandidate} from "../../src/oracle-local-candidate-capability.js";
import type {ReleaseRunSnapshot,StepIntent} from "../../src/types.js";

const commit="a".repeat(40),version="1.1.0-beta.90",tag="v"+version;
const op="123e4567-e89b-42d3-a456-426614174000";
const run={runId:"123e4567-e89b-42d3-a456-426614174001",targetRelease:tag,
  sourceCommitSha:commit,status:"running",
  steps:[{action:"validate_oracle_candidate",stepId:"validate_oracle_candidate",
    operationId:op,status:"outcome_unknown",executionClass:"read_only"}]} as unknown as ReleaseRunSnapshot;
const intent={runId:run.runId,stepId:"validate_oracle_candidate",action:"validate_oracle_candidate",
  operationId:op,executionClass:"read_only"} as unknown as StepIntent;
const owned:string[]=[];
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"oracle-candidate-test-"));owned.push(root);
  mkdirSync(join(root,"state"));mkdirSync(join(root,"releases"));
  const directory=join(root,"releases",version);
  mkdirSync(directory);
  const manifest=join(directory,"linux-release-manifest.json");
  const artifactPath=join(directory,"payload.txt");
  const payload=Buffer.from("genuine executable payload");
  writeFileSync(artifactPath,payload);
  const base={releaseId:version,tag,commit,platform:"linux",schemaVersion:1,
    artifacts:[{path:"payload.txt",
      sha256:createHash("sha256").update(payload).digest("hex")}]};
  const writeManifest=(data:unknown)=>{
    const bytes=Buffer.from(JSON.stringify(data));writeFileSync(manifest,bytes);
    return createHash("sha256").update(bytes).digest("hex");
  };
  const sha=writeManifest(base);
  const state=join(root,"state","lifecycle-state.v1.json");
  const writeState=(candidate:unknown)=>writeFileSync(state,JSON.stringify({
    version:1,active:null,previous:null,candidate,updatedAt:new Date().toISOString(),
  }));
  writeState({releaseId:version,manifestSha256:sha,materializedAt:new Date().toISOString()});
  let allowed=true;const cap=bindOracleLocalCandidate({
    installationRoot:root,authorize:async()=>allowed,
  });
  return {cap,manifest,artifactPath,state,directory,sha,base,writeManifest,writeState,
    deny:()=>{allowed=false;}};
}
afterEach(()=>{for(const d of owned.splice(0))rmSync(d,{recursive:true,force:true});});
describe("Oracle local real candidate manifest",()=>{
  it("inspects the actual Linux manifest and state using read-only operations",async()=>{
    const f=fixture();
    const result=await f.cap.execute(intent,run);
    expect(result).toMatchObject({state:"succeeded",evidence:[{
      source:"mcp_v3_verified_oracle",kind:"oracle_candidate_manifest",sha256:f.sha,
    }]});
    expect(await f.cap.reconcile(intent,{...run,status:"paused_outcome_unknown"}))
      .toMatchObject({outcome:"applied",evidence:[{sha256:f.sha}]});
  });
  it("never validates an unauthorized, mismatched or replayed ledger intent",async()=>{
    const f=fixture();f.deny();
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
    expect((await f.cap.reconcile(intent,run)).outcome).toBe("still_unknown");
    const other=fixture();
    expect((await other.cap.execute({...intent,operationId:op.replace("000","111")},run)).state)
      .toBe("outcome_unknown");
    expect((await other.cap.execute(intent,{...run,sourceCommitSha:"b".repeat(40)})).state)
      .toBe("outcome_unknown");
  });
  it("rejects a mismatched candidate and incorrect manifest digest",async()=>{
    const f=fixture();
    f.writeState({releaseId:"1.1.0-beta.89",manifestSha256:f.sha});
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
    f.writeState({releaseId:version,manifestSha256:"b".repeat(64)});
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
  });
  it("rejects manifest tampering even when its new bytes have a matching state digest",async()=>{
    const f=fixture();
    const tampered=f.writeManifest({...f.base,commit:"b".repeat(40)});
    f.writeState({releaseId:version,manifestSha256:tampered});
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
  });
  it("rejects changed payload bytes and traversal paths even with a refreshed manifest digest",async()=>{
    const f=fixture();
    writeFileSync(f.artifactPath,"altered");
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
    const hostile=f.writeManifest({...f.base,artifacts:[{
      path:"../state/lifecycle-state.v1.json",sha256:"c".repeat(64)}]});
    f.writeState({releaseId:version,manifestSha256:hostile});
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
  });
  it("fails closed when the manifest or release directory is a symlink",async()=>{
    if(process.platform==="win32")return;
    const f=fixture();
    const original=f.manifest+".original";
    const {renameSync}=await import("node:fs");
    renameSync(f.manifest,original);symlinkSync(original,f.manifest);
    expect((await f.cap.execute(intent,run)).state).toBe("outcome_unknown");
  });
});
