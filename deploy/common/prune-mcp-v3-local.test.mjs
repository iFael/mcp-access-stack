import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, writeFile, symlink, readdir, readFile, rm, lstat } from "node:fs/promises";
import { pruneLocalReleases } from "./prune-mcp-v3-local.mjs";

const active = "1.1.0-beta.84";
const previous = "1.1.0-beta.83";
const old = ["1.1.0-beta.81", "1.1.0-beta.82"];
async function fixture(t, withState = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-local-prune-"));
  t.after(async () => rm(root, {recursive:true,force:true}));
  await mkdir(path.join(root,"releases"));
  await mkdir(path.join(root,"state"));
  for(const name of [active,previous,...old]) {
    const dir=path.join(root,"releases",name);
    await mkdir(dir);
    await writeFile(path.join(dir,"mcp-v3-local-manifest.json"),JSON.stringify({releaseId:name}));
  }
  if(withState) {
    await writeFile(path.join(root,"state","lifecycle-state.v1.json"),
      JSON.stringify({active:{releaseId:active},previous:{releaseId:previous},candidate:null}));
  } else {
    await symlink(path.join(root,"releases",active),path.join(root,"current"),
      process.platform==="win32"?"junction":"dir");
  }
  return root;
}
test("plans read-only and removes only old versions after exact-plan CAS",async t=>{
  const root=await fixture(t);
  const input={installationRoot:root,activeReleaseId:active,previousReleaseId:previous,
    processCheck:async()=>false};
  const preview=await pruneLocalReleases(input);
  assert.equal(preview.status,"planned");
  assert.deepEqual(preview.names,old);
  assert.equal((await readdir(path.join(root,"releases"))).length,4);
  const finished=await pruneLocalReleases({...input,dryRun:false,expectedPlanSha256:preview.planSha256});
  assert.equal(finished.status,"completed");
  assert.deepEqual((await readdir(path.join(root,"releases"))).sort(),[active,previous].sort());
  await assert.rejects(lstat(path.join(root,"state","local-release-prune.lock")));
});
test("protects persisted Windows lifecycle and refuses stale state or unknown process",async t=>{
  const root=await fixture(t,true);
  const base={installationRoot:root,activeReleaseId:active,previousReleaseId:previous,
    processCheck:async()=>false};
  const plan=await pruneLocalReleases(base);
  await assert.rejects(pruneLocalReleases({...base,expectedPlanSha256:"0".repeat(64),dryRun:false}),
    /LOCAL_RETENTION_PRECHECK_FAILED/u);
  await assert.rejects(pruneLocalReleases({...base,expectedPlanSha256:plan.planSha256,
    dryRun:false,processCheck:async()=>true}),/LOCAL_RETENTION_PRECHECK_FAILED/u);
  assert.equal((await readdir(path.join(root,"releases"))).length,4);
  assert.equal((await readFile(path.join(root,"state","local-release-prune.lock"),"utf8")).includes("operationId"),true);
});
test("refuses stale plan when another release appears",async t=>{
  const root=await fixture(t);
  const base={installationRoot:root,activeReleaseId:active,previousReleaseId:previous,processCheck:async()=>false};
  const plan=await pruneLocalReleases(base);
  await mkdir(path.join(root,"releases","1.1.0-beta.80"));
  await writeFile(path.join(root,"releases","1.1.0-beta.80","mcp-v3-local-manifest.json"),
    JSON.stringify({releaseId:"1.1.0-beta.80"}));
  await assert.rejects(pruneLocalReleases({...base,dryRun:false,expectedPlanSha256:plan.planSha256}),
    /LOCAL_RETENTION_PRECHECK_FAILED/u);
  assert.deepEqual((await readdir(path.join(root,"releases"))).sort(),
    [active,previous,...old,"1.1.0-beta.80"].sort());
});
test("rejects a candidate symlink without following it",async t=>{
  const root=await fixture(t);
  const external=await mkdtemp(path.join(os.tmpdir(),"mcp-prune-outside-"));
  t.after(async()=>rm(external,{recursive:true,force:true}));
  await rm(path.join(root,"releases",old[0]),{recursive:true});
  await symlink(external,path.join(root,"releases",old[0]),
    process.platform==="win32"?"junction":"dir");
  const base={installationRoot:root,activeReleaseId:active,previousReleaseId:previous,processCheck:async()=>false};
  await assert.rejects(pruneLocalReleases(base), /LOCAL_RETENTION_PRECHECK_FAILED/u);
  assert.equal((await lstat(external)).isDirectory(),true);
});
