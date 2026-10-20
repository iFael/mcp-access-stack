import {createHash} from "node:crypto";
import {lstatSync,readFileSync,realpathSync} from "node:fs";
import {isAbsolute,join,resolve,sep} from "node:path";
import type {EvidenceInput,ReleaseRunSnapshot,StepIntent} from "./types.js";
import type {ReleaseStepCapability} from "./release-workflow-executor.js";

const SHA=/^[0-9a-f]{40}$/u;
const DIGEST=/^[0-9a-f]{64}$/u;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID=/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?$/u;
const MAX_STATE_BYTES=16*1024,MAX_MANIFEST_BYTES=128*1024;

type JSONRecord=Record<string,unknown>;
function record(value:unknown):value is JSONRecord {
  return typeof value==="object" && value!==null && !Array.isArray(value);
}
/** Only host-configured absolute paths, never a release-supplied path/URL. */
export interface OracleLocalCandidateBinding {
  readonly installationRoot:string;
  readonly authorize:(run:ReleaseRunSnapshot)=>Promise<boolean>;
}
function safeFile(path:string,maxBytes:number):Buffer {
  const info=lstatSync(path);
  if(!info.isFile() || info.isSymbolicLink() || info.size<1 || info.size>maxBytes)
    throw new Error("ORACLE_CANDIDATE_FILE_INVALID");
  const body=readFileSync(path);
  if(body.length<1 || body.length>maxBytes)
    throw new Error("ORACLE_CANDIDATE_FILE_BOUNDS");
  return body;
}
function bound(intent:StepIntent,run:ReleaseRunSnapshot):boolean {
  return intent.action==="validate_oracle_candidate" &&
    intent.executionClass==="read_only" && intent.runId===run.runId &&
    UUID.test(intent.operationId) &&
    run.steps.some(step=>step.action==="validate_oracle_candidate" &&
      step.stepId===intent.stepId && step.operationId===intent.operationId &&
      (step.status==="in_progress" || step.status==="outcome_unknown"));
}
function inspect(root:string,run:ReleaseRunSnapshot):EvidenceInput|null {
  if(!SHA.test(run.sourceCommitSha) || !/^v[0-9]/u.test(run.targetRelease))
    return null;
  const releaseId=run.targetRelease.slice(1);
  if(!ID.test(releaseId) || releaseId==="." || releaseId==="..")return null;
  const canonicalRoot=realpathSync(root);
  const releaseDir=join(canonicalRoot,"releases");
  const canonicalReleases=realpathSync(releaseDir);
  if(canonicalReleases!==releaseDir ||
    !canonicalReleases.startsWith(canonicalRoot+sep))
    return null;
  const statePath=join(canonicalRoot,"state","lifecycle-state.v1.json");
  const first=safeFile(statePath,MAX_STATE_BYTES);
  const state:unknown=JSON.parse(first.toString("utf8"));
  if(!record(state) || state.version!==1 || !record(state.candidate))
    return null;
  const candidate=state.candidate;
  if(candidate.releaseId!==releaseId ||
    typeof candidate.manifestSha256!=="string" ||
    !DIGEST.test(candidate.manifestSha256))return null;
  const candidateDir=join(canonicalReleases,releaseId);
  if(!lstatSync(candidateDir).isDirectory() ||
    realpathSync(candidateDir)!==candidateDir)
    return null;
  const path=join(candidateDir,"linux-release-manifest.json");
  if(resolve(path)!==path || !path.startsWith(canonicalReleases+sep))
    return null;
  const manifestBytes=safeFile(path,MAX_MANIFEST_BYTES);
  const digest=createHash("sha256").update(manifestBytes).digest("hex");
  if(candidate.manifestSha256!==digest)return null;
  const manifest:unknown=JSON.parse(manifestBytes.toString("utf8"));
  if(!record(manifest) || manifest.releaseId!==releaseId ||
    manifest.tag!==run.targetRelease ||
    manifest.commit!==run.sourceCommitSha ||
    manifest.platform!=="linux" || !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length<1 || manifest.artifacts.length>64)return null;
  const knownPaths=new Set<string>();
  for(const item of manifest.artifacts as unknown[]){
    if(!record(item) || typeof item.path!=="string" ||
      item.path.length>256 || !/^[A-Za-z0-9._/-]+$/u.test(item.path) ||
      item.path.startsWith("/") || item.path.split("/").some(s=>s==="." || s===".." || s==="") ||
      knownPaths.has(item.path) || typeof item.sha256!=="string" ||
      !DIGEST.test(item.sha256))return null;
    knownPaths.add(item.path);
    const artifact=resolve(candidateDir,item.path);
    if(!artifact.startsWith(candidateDir+sep) ||
      realpathSync(artifact)!==artifact)return null;
    const bytes=safeFile(artifact,16*1024*1024);
    if(createHash("sha256").update(bytes).digest("hex")!==item.sha256)
      return null;
  }
  // A concurrent prepare may have switched the candidate during the read.
  const final=safeFile(statePath,MAX_STATE_BYTES);
  if(!first.equals(final))return null;
  return {kind:"oracle_candidate_manifest",source:"mcp_v3_verified_oracle",
    sha256:digest,observedAt:new Date().toISOString()};
}

/** Real candidate inspection in the Oracle single-writer host; never prepares,
 * promotes or infers readiness from a workflow acceptance or a mock receipt. */
export function bindOracleLocalCandidate(
  options:OracleLocalCandidateBinding,
):ReleaseStepCapability {
  if(!isAbsolute(options.installationRoot) ||
    typeof options.authorize!=="function")
    throw new Error("ORACLE_CANDIDATE_HOST_INVALID");
  const root=resolve(options.installationRoot);
  const check=async(intent:StepIntent,run:ReleaseRunSnapshot) => {
    if(!bound(intent,run) || !await options.authorize(run))return null;
    try{return inspect(root,run);}catch{return null;}
  };
  return {
    action:"validate_oracle_candidate",executionClass:"read_only",
    authorize:(_step,run)=>options.authorize(run),
    execute:async(intent,run)=>{
      const evidence=await check(intent,run);
      return evidence?{state:"succeeded",evidence:[evidence]}:
        {state:"outcome_unknown"};
    },
    reconcile:async(intent,run)=>{
      const evidence=await check(intent,run);
      return evidence?{outcome:"applied",evidence:[evidence]}:
        {outcome:"still_unknown"};
    },
  };
}
