import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,open,realpath} from "node:fs/promises";
import {isAbsolute,resolve,sep} from "node:path";

const SHA=/^[0-9a-f]{40}$/u;
const DIGEST=/^[0-9a-f]{64}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const MAX_STATE=16*1024, MAX_MANIFEST=128*1024, MAX_ARTIFACT=512*1024*1024;
function record(x:unknown):x is Record<string,unknown>{
  return !!x && typeof x==="object" && !Array.isArray(x);
}
function inside(root:string,path:string):boolean{return path.startsWith(root+sep);}
async function readBounded(path:string,limit:number):Promise<Buffer>{
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const info=await handle.stat();
    if(!info.isFile() || info.size<1 || info.size>limit)
      throw new Error("ORACLE_CANDIDATE_FILE_INVALID");
    const bytes=await handle.readFile();
    if(bytes.length!==info.size || bytes.length>limit)
      throw new Error("ORACLE_CANDIDATE_FILE_CHANGED");
    return bytes;
  }finally{await handle.close();}
}
async function verifiedHash(path:string):Promise<string>{
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await handle.stat();
    if(!before.isFile() || before.size<1 || before.size>MAX_ARTIFACT)
      throw new Error("ORACLE_CANDIDATE_ASSET_INVALID");
    const hash=createHash("sha256"),buffer=Buffer.allocUnsafe(128*1024);
    let pos=0;
    while(pos<before.size){
      const n=await handle.read(buffer,0,
        Math.min(buffer.length,before.size-pos),pos);
      if(n.bytesRead<=0)throw new Error("ORACLE_CANDIDATE_ASSET_TRUNCATED");
      hash.update(buffer.subarray(0,n.bytesRead));pos+=n.bytesRead;
    }
    const after=await handle.stat();
    if(before.size!==after.size || before.mtimeMs!==after.mtimeMs ||
      before.ino!==after.ino)
      throw new Error("ORACLE_CANDIDATE_ASSET_CHANGED");
    return hash.digest("hex");
  }finally{await handle.close();}
}
/** Typed, bounded receipt. Never returns file bytes, paths, secrets or raw JSON. */
export interface OracleCandidateReadResult {
  readonly releaseTag:string;
  readonly sourceCommitSha:string;
  readonly manifestSha256:string;
  readonly verifiedArtifactCount:number;
}
/** Executes only in the installed MCP execution-node's authorized identity.
 * The caller provides a tag and SHA, never a path, command, URL or workspace root.
 * Privilege separation from the Oracle SQLite ledger is preserved. */
export async function inspectExecutionNodeCandidate(
  installationRoot:string,releaseTag:string,sourceCommitSha:string,
):Promise<OracleCandidateReadResult>{
  if(process.platform!=="linux" || !isAbsolute(installationRoot) || !TAG.test(releaseTag) ||
    releaseTag.includes("..") || !SHA.test(sourceCommitSha))
    throw new Error("ORACLE_CANDIDATE_INPUT_INVALID");
  const root=await realpath(resolve(installationRoot));
  const releases=resolve(root,"releases");
  if(!inside(root,releases) || await realpath(releases)!==releases)
    throw new Error("ORACLE_CANDIDATE_ROOT_INVALID");
  const releaseId=releaseTag.slice(1),folder=resolve(releases,releaseId);
  if(!inside(releases,folder) || await realpath(folder)!==folder ||
    !(await lstat(folder)).isDirectory())
    throw new Error("ORACLE_CANDIDATE_RELEASE_INVALID");
  const statePath=resolve(root,"state","lifecycle-state.v1.json");
  if(await realpath(statePath)!==statePath)
    throw new Error("ORACLE_CANDIDATE_STATE_SYMLINK");
  const before=await readBounded(statePath,MAX_STATE);
  const state:unknown=JSON.parse(before.toString("utf8"));
  if(!record(state) || state.version!==1 || !record(state.candidate) ||
    state.candidate.releaseId!==releaseId ||
    typeof state.candidate.manifestSha256!=="string" ||
    !DIGEST.test(state.candidate.manifestSha256))
    throw new Error("ORACLE_CANDIDATE_STATE_MISMATCH");
  const manifestPath=resolve(folder,"linux-release-manifest.json");
  if(!inside(folder,manifestPath) || await realpath(manifestPath)!==manifestPath)
    throw new Error("ORACLE_CANDIDATE_MANIFEST_SYMLINK");
  const manifestBytes=await readBounded(manifestPath,MAX_MANIFEST);
  const digest=createHash("sha256").update(manifestBytes).digest("hex");
  if(state.candidate.manifestSha256!==digest)
    throw new Error("ORACLE_CANDIDATE_MANIFEST_DIGEST_MISMATCH");
  const manifest:unknown=JSON.parse(manifestBytes.toString("utf8"));
  if(!record(manifest) || manifest.releaseId!==releaseId ||
    manifest.tag!==releaseTag || manifest.commit!==sourceCommitSha ||
    manifest.platform!=="linux" || !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length<1 || manifest.artifacts.length>64)
    throw new Error("ORACLE_CANDIDATE_MANIFEST_INVALID");
  const paths=new Set<string>();
  for(const entry of manifest.artifacts as unknown[]){
    if(!record(entry) || typeof entry.path!=="string" ||
      entry.path.length>256 || !/^[A-Za-z0-9._/-]+$/u.test(entry.path) ||
      entry.path.split("/").some(s=>!s || s==="." || s==="..") ||
      paths.has(entry.path) ||
      typeof entry.sha256!=="string" || !DIGEST.test(entry.sha256))
      throw new Error("ORACLE_CANDIDATE_ARTIFACT_INVALID");
    paths.add(entry.path);
    const file=resolve(folder,entry.path);
    if(!inside(folder,file) || await realpath(file)!==file ||
      await verifiedHash(file)!==entry.sha256)
      throw new Error("ORACLE_CANDIDATE_ARTIFACT_DIGEST_MISMATCH");
  }
  const after=await readBounded(statePath,MAX_STATE);
  if(!before.equals(after))
    throw new Error("ORACLE_CANDIDATE_STATE_CHANGED");
  return {releaseTag,sourceCommitSha,manifestSha256:digest,
    verifiedArtifactCount:paths.size};
}
