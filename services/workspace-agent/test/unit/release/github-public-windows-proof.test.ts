import {createHash} from "node:crypto";
import {describe,expect,it,jest} from "@jest/globals";
import {inspectGitHubPublicReleaseAssets}
  from "../../../src/release/github-public-distribution-inspection.js";
import type {GitHubWorkflowApiClient}
  from "../../../src/source-control/github-http-client.js";

const tag="v1.1.0-beta.90",sha="a".repeat(40),runId=555;
const checksum=(name:string)=>"a".repeat(64)+" *"+name+"\n";
const hash=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex");
const proofBytes=Buffer.from(JSON.stringify({tag,sha,runId}),"utf8");
const signatureBytes=new Uint8Array([1,2,3,4,5]);
const suffixes=["windows-x64.zip","linux-x64.tar.gz","linux-arm64.tar.gz",
  "linux-amd64.deb","linux-arm64.deb"];
const assets=suffixes.flatMap((suffix,i)=>[
  {id:i*2+1,name:tag+"-"+suffix,size:900,
    digest:"sha256:"+"a".repeat(64),state:"uploaded"},
  {id:i*2+2,name:tag+"-"+suffix+".sha256",
    size:Buffer.byteLength(checksum(tag+"-"+suffix)),
    digest:"sha256:"+hash(checksum(tag+"-"+suffix)),state:"uploaded"},
]);
const all=[...assets,
  {id:11,name:tag+"-windows-x64.proof.json",size:proofBytes.byteLength,
    digest:"sha256:"+hash(proofBytes),state:"uploaded"},
  {id:12,name:tag+"-windows-x64.proof.json.sig",size:signatureBytes.byteLength,
    digest:"sha256:"+hash(signatureBytes),state:"uploaded"},
];
function makeClient(options:{proof?:Uint8Array;sig?:Uint8Array;assets?:typeof all;
  method?:boolean}={}){
  const getReleaseAssetBytes=jest.fn(async(_owner:string,_repo:string,id:number,limit:number)=>{
    expect(limit).toBe(id===11?4096:8192);
    return id===11?(options.proof??proofBytes):(options.sig??signatureBytes);
  });
  const client={
    getWorkflowRun:async()=>({id:runId,workflow_id:1,name:"Public release",
      path:"octo/repo/.github/workflows/release.yml@refs/heads/main",
      head_sha:sha,head_branch:"main",event:"workflow_dispatch",
      status:"completed",conclusion:"success",run_attempt:1,
      display_title:"mcp-release-11111111-2222-4333-8444-555555555555"}),
    getReleaseByTag:async()=>({tag_name:tag,draft:false,
      published_at:"2026-10-12T21:00:00Z",assets:options.assets??all}),
    getTagRef:async()=>({ref:"refs/tags/"+tag,object:{type:"commit",sha}}),
    getReleaseAssetChecksum:async(_owner:string,_repo:string,id:number)=>{
      const item=assets.find(x=>x.id===id)!;
      return checksum(item.name.slice(0,-7));
    },
    ...(options.method===false?{}:{getReleaseAssetBytes}),
  };
  return {client:client as unknown as GitHubWorkflowApiClient,getReleaseAssetBytes};
}
const args=["octo","repo",runId,tag,sha] as const;
describe("detached Windows proof attached to authenticated publication inspection",()=>{
  it("validates both GitHub asset digests before invoking host-owned RSA verifier",async()=>{
    const {client,getReleaseAssetBytes}=makeClient();
    const verify=jest.fn((input:unknown)=>{
      expect(input).toMatchObject({
        expectedTag:tag,expectedCommitSha:sha,expectedRunId:runId,
        expectedWindowsAssetSha256:"a".repeat(64),
        signatureBytes,proofBytes,
      });
      return {signatureVerified:true as const,windowsAssetSha256:"a".repeat(64),
        sourceCommitSha:sha,workflowRunId:runId,releaseTag:tag,
        signerCertificateSha256:
          "a9177136662887555dfe0e59d11b48e670d0f63cf4b340bf3b20e1d8a1541408"};
    });
    const observed=await inspectGitHubPublicReleaseAssets(
      client,...args,undefined,{certificateBytes:new Uint8Array([1]),verify});
    expect(observed).toMatchObject({windowsDetachedProofAvailable:true,
      windowsDetachedProofVerified:true,signatureVerified:false,releasePublished:true});
    expect(getReleaseAssetBytes).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
  });
  it("fails closed before crypto on altered proof bytes or missing source API",async()=>{
    const verify=jest.fn(()=>{throw new Error("unreachable");});
    const {client}=makeClient({proof:Buffer.from("tampered", "utf8")});
    await expect(inspectGitHubPublicReleaseAssets(client,...args,undefined,
      {certificateBytes:new Uint8Array([1]),verify})).rejects.toThrow(
      "GITHUB_PUBLIC_WINDOWS_PROOF_DIGEST_MISMATCH");
    expect(verify).not.toHaveBeenCalled();
    const {client:unavailable}=makeClient({method:false});
    await expect(inspectGitHubPublicReleaseAssets(unavailable,...args,undefined,
      {certificateBytes:new Uint8Array([1]),verify})).rejects.toThrow(
      "GITHUB_PUBLIC_WINDOWS_PROOF_UNAVAILABLE");
    expect(verify).not.toHaveBeenCalled();
  });
  it("never converts signature errors into success",async()=>{
    const {client}=makeClient();
    await expect(inspectGitHubPublicReleaseAssets(client,...args,undefined,
      {certificateBytes:new Uint8Array([1])})).rejects.toThrow(
      "WINDOWS_PROOF_CERTIFICATE_MISMATCH");
  });
});
