import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {open,realpath,lstat,readFile} from "node:fs/promises";
import {isAbsolute,resolve,sep} from "node:path";

const ID=/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const MAX_STATE=16*1024,MAX_MANIFEST=128*1024;
function object(v:unknown):v is Record<string,unknown>{
  return typeof v==="object" && v!==null && !Array.isArray(v);
}
async function readProtected(file:string,maximum:number):Promise<Buffer>{
  const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await handle.stat();
    if(!before.isFile() || before.size<1 || before.size>maximum)
      throw new Error("ORACLE_HEALTH_FILE_INVALID");
    const data=await handle.readFile();
    const after=await handle.stat();
    if(data.byteLength!==before.size || before.size!==after.size ||
      before.ino!==after.ino || before.mtimeMs!==after.mtimeMs)
      throw new Error("ORACLE_HEALTH_FILE_CHANGED");
    return data;
  }finally{await handle.close();}
}
export interface OracleNativeRuntimeHealth{
  readonly status:"healthy";
  readonly releaseId:string;
  readonly manifestSha256:string;
  readonly processId:number;
  readonly observedAt:string;
}
/** Observe the actual, currently running Linux connector, not a planned
 * process or a generic Oracle read-API heartbeat. No caller-selected paths. */
export async function inspectOracleActiveRuntimeHealth(
  installationRoot:string,entrypoint:string|undefined,pid:number,
):Promise<OracleNativeRuntimeHealth>{
  if(process.platform!=="linux" || !isAbsolute(installationRoot) ||
    !entrypoint || !Number.isSafeInteger(pid) || pid<=0 || pid!==process.pid)
    throw new Error("ORACLE_HEALTH_PROCESS_INVALID");
  const root=await realpath(resolve(installationRoot));
  const statePath=resolve(root,"state","lifecycle-state.v1.json");
  if(await realpath(statePath)!==statePath)
    throw new Error("ORACLE_HEALTH_STATE_SYMLINK");
  const before=await readProtected(statePath,MAX_STATE);
  const state:unknown=JSON.parse(before.toString("utf8"));
  if(!object(state) || state.version!==1 ||
    !object(state.active) || !object(state.previous) ||
    state.candidate!==null ||
    typeof state.active.releaseId!=="string" ||
    !ID.test(state.active.releaseId) || state.active.releaseId.includes("..") ||
    typeof state.active.manifestSha256!=="string" ||
    !DIGEST.test(state.active.manifestSha256) ||
    state.active.releaseId===state.previous.releaseId ||
    typeof state.previous.manifestSha256!=="string" ||
    !DIGEST.test(state.previous.manifestSha256))
    throw new Error("ORACLE_HEALTH_STATE_INVALID");
  const releaseId=state.active.releaseId;
  const manifestSha256=state.active.manifestSha256;
  const folder=resolve(root,"releases",releaseId);
  if(!folder.startsWith(root+sep) || await realpath(folder)!==folder ||
    !(await lstat(folder)).isDirectory() ||
    await realpath(resolve(root,"current"))!==folder)
    throw new Error("ORACLE_HEALTH_CURRENT_MISMATCH");
  const expected=resolve(folder,"services","mcp-gateway","dist","edge-connector-cli.js");
  const entry=await realpath(resolve(entrypoint));
  if(entry!==expected || await realpath(expected)!==expected ||
    !(await lstat(expected)).isFile())
    throw new Error("ORACLE_HEALTH_EXECUTABLE_MISMATCH");
  // procfs pseudo-files report st_size=0: bound the actual bytes instead.
  const procCmd=await readFile("/proc/self/cmdline");
  if(procCmd.byteLength<2 || procCmd.byteLength>16*1024)
    throw new Error("ORACLE_HEALTH_PROCESS_MISMATCH");
  const args=procCmd.toString("utf8").split("\0").filter(Boolean);
  const binaryArgs=args.slice(1).filter(arg=>!arg.startsWith("-"));
  let entryFound=false;
  for(const arg of binaryArgs){
    try{if(await realpath(resolve(arg))===expected){entryFound=true;break;}}
    catch{/* Ignore non-path runtime arguments. */}
  }
  if(!entryFound || !Number.isSafeInteger(process.pid) || process.pid!==pid)
    throw new Error("ORACLE_HEALTH_PROCESS_MISMATCH");
  const manifestPath=resolve(folder,"linux-release-manifest.json");
  if(await realpath(manifestPath)!==manifestPath)
    throw new Error("ORACLE_HEALTH_MANIFEST_SYMLINK");
  const manifestBytes=await readProtected(manifestPath,MAX_MANIFEST);
  if(createHash("sha256").update(manifestBytes).digest("hex")!==manifestSha256)
    throw new Error("ORACLE_HEALTH_MANIFEST_MISMATCH");
  const manifest:unknown=JSON.parse(manifestBytes.toString("utf8"));
  if(!object(manifest) || manifest.releaseId!==releaseId ||
    manifest.tag!=="v"+releaseId || manifest.platform!=="linux")
    throw new Error("ORACLE_HEALTH_MANIFEST_INVALID");
  const after=await readProtected(statePath,MAX_STATE);
  if(!before.equals(after) || await realpath(resolve(root,"current"))!==folder)
    throw new Error("ORACLE_HEALTH_CHANGED_DURING_READ");
  return {status:"healthy",releaseId,manifestSha256,processId:pid,
    observedAt:new Date().toISOString()};
}
