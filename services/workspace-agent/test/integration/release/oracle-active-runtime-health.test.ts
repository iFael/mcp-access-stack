import {execFile} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync,
  unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve,join,dirname} from "node:path";
import {pathToFileURL} from "node:url";
import {promisify} from "node:util";
import {afterEach,describe,expect,it} from "@jest/globals";

const run=promisify(execFile);
const id="1.1.0-beta.90",tag="v"+id,sha="a".repeat(40);
const dirs:string[]=[];
const nativeModule=pathToFileURL(resolve(
  "services/workspace-agent/dist/release/oracle-active-runtime-health.js")).href;
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"oracle-runtime-health-"));
  dirs.push(root);
  const folder=join(root,"releases",id);
  const entry=join(folder,"services","mcp-gateway","dist","edge-connector-cli.js");
  mkdirSync(dirname(entry),{recursive:true});
  mkdirSync(join(root,"state"),{recursive:true});
  const child=`import {inspectOracleActiveRuntimeHealth} from "${nativeModule}";
try{
  console.log(JSON.stringify(await inspectOracleActiveRuntimeHealth(
    process.argv[2],process.argv[1],process.pid)));
}catch(err){console.error(err instanceof Error?err.message:String(err));
  process.exitCode=2;}
`;
  writeFileSync(entry,child);
  const entryDigest=createHash("sha256").update(child).digest("hex");
  const manifest={schemaVersion:1,releaseId:id,tag,commit:sha,platform:"linux",
    artifacts:[{path:"services/mcp-gateway/dist/edge-connector-cli.js",sha256:entryDigest}]};
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(folder,"linux-release-manifest.json"),manifestBytes);
  const manifestSha256=createHash("sha256").update(manifestBytes).digest("hex");
  const state={version:1,active:{releaseId:id,manifestSha256,
    materializedAt:"2026-10-18T03:00:00Z"},previous:{
    releaseId:"1.1.0-beta.89",manifestSha256:"b".repeat(64),
    materializedAt:"2026-10-17T03:00:00Z"},candidate:null,
    updatedAt:"2026-10-18T03:00:00Z"};
  const statePath=join(root,"state","lifecycle-state.v1.json");
  writeFileSync(statePath,JSON.stringify(state));
  symlinkSync(folder,join(root,"current"));
  return {root,folder,entry,state,statePath,manifestSha256,
    manifestPath:join(folder,"linux-release-manifest.json")};
}
async function child(root:string,entry:string){
  return run(process.execPath,[entry,root],{timeout:12_000,maxBuffer:4096});
}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
describe("real Oracle runtime process attestation",()=>{
  it("attests a genuinely executing Node entrypoint against the active pointer",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    const {stdout,stderr}=await child(f.root,f.entry);
    expect(stderr).toBe("");
    const result=JSON.parse(stdout.trim()) as Record<string,unknown>;
    expect(result).toMatchObject({
      status:"healthy",releaseId:id,manifestSha256:f.manifestSha256,
    });
    expect(typeof result.processId).toBe("number");
    expect(Number(result.processId)).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(String(result.observedAt)))).toBe(true);
  });
  it("refuses a digest mismatch and a stale current symlink",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    writeFileSync(f.statePath,JSON.stringify({...f.state,
      active:{...f.state.active,manifestSha256:"e".repeat(64)}}));
    await expect(child(f.root,f.entry)).rejects.toThrow();
    writeFileSync(f.statePath,JSON.stringify(f.state));
    unlinkSync(join(f.root,"current"));
    const foreign=join(f.root,"releases","foreign");
    mkdirSync(foreign);
    symlinkSync(foreign,join(f.root,"current"));
    await expect(child(f.root,f.entry)).rejects.toThrow();
  });
  it("refuses a symlinked state file and tampered manifest bytes",async()=>{
    if(process.platform!=="linux")return;
    const f=fixture();
    const stateBackup=f.statePath+".real";
    const stateString=JSON.stringify(f.state);
    unlinkSync(f.statePath);
    writeFileSync(stateBackup,stateString);
    symlinkSync(stateBackup,f.statePath);
    await expect(child(f.root,f.entry)).rejects.toThrow();
    unlinkSync(f.statePath);
    writeFileSync(f.statePath,stateString);
    writeFileSync(f.manifestPath,"{broken}");
    await expect(child(f.root,f.entry)).rejects.toThrow();
  });
});
