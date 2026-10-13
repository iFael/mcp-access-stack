import {createHash} from "node:crypto";
import type {OperationContext} from "@vs-code-gpt/shared";
import type {GitHubWorkflowApiClient} from "../source-control/github-http-client.js";

const SHA=/^[a-f0-9]{40}$/u;
const DIGEST=/^[a-f0-9]{64}$/u;
const TAG=/^v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/u;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const ASSET_SUFFIXES=[
  "windows-x64.zip","linux-x64.tar.gz","linux-arm64.tar.gz",
  "linux-amd64.deb","linux-arm64.deb",
] as const;
const hash=(data:string)=>createHash("sha256").update(data,"utf8").digest("hex");

export interface GitHubPublicDistributionInspection {
  readonly sourceCommitSha:string;
  readonly releaseTag:string;
  readonly workflowRunId:number;
  /** Independently observed GitHub Release publication, not signature proof. */
  readonly releasePublished:true;
  /** No cryptographic Authenticode/Sigstore verifier on this host. */
  readonly signatureVerified:false;
  readonly verifiedAssetCount:number;
  readonly assetInventorySha256:string;
  /** Presence is metadata only, not cryptographic verification. */
  readonly windowsDetachedProofAvailable:boolean;
}

/** Authenticated GitHub metadata and small checksum sidecars are verified
 * without shell, downloads of unbounded binaries or blind trust in CI status.
 * This does NOT constitute independent signature verification and therefore
 * MUST NOT be supplied as PublicDistributionProof or enable Oracle release.
 */
export async function inspectGitHubPublicReleaseAssets(
  client:Pick<GitHubWorkflowApiClient,
    "getWorkflowRun"|"getReleaseByTag"|"getTagRef"|"getReleaseAssetChecksum">,
  owner:string,repository:string,runId:number,tag:string,commitSha:string,
  context?:OperationContext,
):Promise<GitHubPublicDistributionInspection>{
  if(!/^[A-Za-z0-9-]{1,100}$/u.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(repository) ||
    !Number.isSafeInteger(runId) || runId<1 || !TAG.test(tag) ||
    tag.length>128 || tag.includes("-oracle.") || tag.includes("-companion.") ||
    !SHA.test(commitSha))
    throw new Error("GITHUB_PUBLIC_INSPECTION_IDENTITY_INVALID");
  if(!client.getWorkflowRun || !client.getReleaseByTag ||
    !client.getTagRef || !client.getReleaseAssetChecksum)
    throw new Error("GITHUB_PUBLIC_INSPECTION_UNAVAILABLE");

  const [run,release,ref]=await Promise.all([
    client.getWorkflowRun(owner,repository,runId,context),
    client.getReleaseByTag(owner,repository,tag,context),
    client.getTagRef(owner,repository,tag,context),
  ]);
  if(run.id!==runId || !Number.isSafeInteger(run.workflow_id) || run.workflow_id<1 ||
    run.name!=="Public release" ||
    run.path!==owner+"/"+repository+"/.github/workflows/release.yml@refs/heads/main" ||
    run.head_sha!==commitSha || run.head_branch!=="main" ||
    run.event!=="workflow_dispatch" || run.run_attempt!==1 ||
    run.status!=="completed" || run.conclusion!=="success" ||
    !/^mcp-release-/u.test(run.display_title) ||
    !UUID.test(run.display_title.slice("mcp-release-".length)) ||
    ref.ref!=="refs/tags/"+tag || ref.object.type!=="commit" ||
    ref.object.sha!==commitSha ||
    release.tag_name!==tag || release.draft!==false ||
    !release.published_at || !Number.isFinite(Date.parse(release.published_at)))
    throw new Error("GITHUB_PUBLIC_INSPECTION_PROVENANCE_UNVERIFIED");

  const baseAssets=ASSET_SUFFIXES.flatMap(suffix=>[tag+"-"+suffix,tag+"-"+suffix+".sha256"]);
  const proofAssets=[tag+"-windows-x64.proof.json",tag+"-windows-x64.proof.json.sig"];
  const hasDetachedProof=Array.isArray(release.assets) &&
    release.assets.length===baseAssets.length+proofAssets.length;
  const wanted=hasDetachedProof?[...baseAssets,...proofAssets]:baseAssets;
  if(!Array.isArray(release.assets) || release.assets.length!==wanted.length)
    throw new Error("GITHUB_PUBLIC_INSPECTION_ASSET_SET_INVALID");
  const assetByName=new Map<string,{id:number;name:string;size:number;digest:string;state:string}>();
  const usedIds=new Set<number>();
  for(const asset of release.assets){
    if(!wanted.includes(asset.name) ||
      assetByName.has(asset.name) || usedIds.has(asset.id) ||
      !Number.isSafeInteger(asset.id) || asset.id<1 ||
      !Number.isSafeInteger(asset.size) || asset.size<=0 ||
      asset.state!=="uploaded" ||
      typeof asset.digest!=="string" || !asset.digest.startsWith("sha256:") ||
      !DIGEST.test(asset.digest.slice(7)))
      throw new Error("GITHUB_PUBLIC_INSPECTION_ASSET_INVALID");
    usedIds.add(asset.id);
    assetByName.set(asset.name,{id:asset.id,name:asset.name,size:asset.size,
      digest:asset.digest,state:asset.state});
  }

  const inventory:string[]=[];
  for(const suffix of ASSET_SUFFIXES){
    const filename=tag+"-"+suffix;
    const artifact=assetByName.get(filename);
    const sidecar=assetByName.get(filename+".sha256");
    if(!artifact || !sidecar || sidecar.size>512)
      throw new Error("GITHUB_PUBLIC_INSPECTION_ASSET_MISSING");
    const body=await client.getReleaseAssetChecksum(owner,repository,sidecar.id,context);
    // Byte-accurate SHA of the sidecar itself (GitHub's reported asset digest)
    // and the published checksum's asserted package SHA must both match.
    if(typeof body!=="string" || Buffer.byteLength(body,"utf8")>512 ||
      hash(body)!==sidecar.digest.slice(7))
      throw new Error("GITHUB_PUBLIC_INSPECTION_SIDECAR_DIGEST_MISMATCH");
    const line=body.endsWith("\n")?body.slice(0,-1):body;
    const prefix=artifact.digest.slice(7);
    if(!line.startsWith(prefix+" ") ||
      ![prefix+" *"+filename,prefix+"  "+filename].includes(line))
      throw new Error("GITHUB_PUBLIC_INSPECTION_PACKAGE_DIGEST_MISMATCH");
    inventory.push(filename+":"+prefix);
  }
  if(hasDetachedProof){
    const proof=assetByName.get(proofAssets[0]!);
    const signature=assetByName.get(proofAssets[1]!);
    if(!proof || !signature || proof.size>4096 || signature.size>8192)
      throw new Error("GITHUB_PUBLIC_INSPECTION_SIGNED_PROOF_ASSET_INVALID");
    // These metadata digests are included in inventory; only a separate RSA
    // verification with the pinned public certificate can claim authenticity.
    inventory.push(proof.name+":"+proof.digest.slice(7));
    inventory.push(signature.name+":"+signature.digest.slice(7));
  }
  return {sourceCommitSha:commitSha,releaseTag:tag,workflowRunId:runId,
    releasePublished:true,signatureVerified:false,verifiedAssetCount:ASSET_SUFFIXES.length,
    assetInventorySha256:hash(inventory.join("\n")),
    windowsDetachedProofAvailable:hasDetachedProof};
}
