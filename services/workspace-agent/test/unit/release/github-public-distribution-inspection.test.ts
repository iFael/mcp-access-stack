import {createHash} from "node:crypto";
import {describe,expect,it,jest} from "@jest/globals";
import {inspectGitHubPublicReleaseAssets}
  from "../../../src/release/github-public-distribution-inspection.js";
import type {GitHubWorkflowApiClient}
  from "../../../src/source-control/github-http-client.js";
const tag="v1.1.0-beta.90",sha="a".repeat(40),runId=555;
const suffixes=["windows-x64.zip","linux-x64.tar.gz","linux-arm64.tar.gz",
  "linux-amd64.deb","linux-arm64.deb"];
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
const checksum=(name:string)=>"a".repeat(64)+" *"+name+"\n";
const assets=suffixes.flatMap((suffix,index)=>[
  {id:index*2+1,name:tag+"-"+suffix,size:1000,digest:"sha256:"+"a".repeat(64),
    state:"uploaded"},
  {id:index*2+2,name:tag+"-"+suffix+".sha256",size:checksum(tag+"-"+suffix).length,
    digest:"sha256:"+hash(checksum(tag+"-"+suffix)),
    state:"uploaded"},
]);
const baseRun={id:runId,workflow_id:10,name:"Public release",
  path:"octo/repo/.github/workflows/release.yml@refs/heads/main",
  head_sha:sha,head_branch:"main",event:"workflow_dispatch",
  status:"completed",conclusion:"success",run_attempt:1,
  display_title:"mcp-release-11111111-2222-4333-8444-555555555555"};
const release={tag_name:tag,draft:false,published_at:"2026-10-12T21:00:00Z",
  assets,prerelease:true};
function client(overrides:{
  run?:Record<string,unknown>;release?:Record<string,unknown>;
  ref?:Record<string,unknown>;checksum?:string;
}={}){
  return {
    getWorkflowRun:jest.fn(async()=>({...baseRun,...overrides.run})),
    getReleaseByTag:jest.fn(async()=>({...release,...overrides.release})),
    getTagRef:jest.fn(async()=>overrides.ref??{
      ref:"refs/tags/"+tag,object:{type:"commit",sha},
    }),
    getReleaseAssetSha256:jest.fn(async()=> "a".repeat(64)),
    getReleaseAssetChecksum:jest.fn(async(_owner:string,_repo:string,id:number)=>{
      const asset=assets.find(a=>a.id===id)!;
      return overrides.checksum??checksum(asset.name.slice(0,-7));
    }),
  };
}
describe("authenticated GitHub release asset integrity inspector",()=>{
  it("binds exact workflow run, tag ref, published release and checksum sidecars",async()=>{
    const api=client();
    const proof=await inspectGitHubPublicReleaseAssets(api as unknown as GitHubWorkflowApiClient,
      "octo","repo",runId,tag,sha);
    expect(proof).toMatchObject({sourceCommitSha:sha,releaseTag:tag,
      workflowRunId:runId,releasePublished:true,integrityVerified:true,
      verifiedAssetCount:5});
    expect(proof.assetInventorySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(api.getReleaseAssetChecksum).toHaveBeenCalledTimes(5);
    expect(api.getReleaseAssetSha256).toHaveBeenCalledTimes(5);
  });
  it.each([
    ["wrong sha",{run:{head_sha:"b".repeat(40)}}],
    ["wrong workflow",{run:{path:"octo/repo/.github/workflows/evil.yml@refs/heads/main"}}],
    ["run rerun",{run:{run_attempt:2}}],
    ["status",{run:{conclusion:"failure"}}],
    ["draft",{release:{draft:true}}],
    ["missing asset",{release:{assets:assets.slice(1)}}],
    ["duplicate asset",{release:{assets:[...assets,assets[0]]}}],
    ["tag drift",{ref:{ref:"refs/tags/"+tag,object:{type:"commit",sha:"b".repeat(40)}}}],
    ["annotated",{ref:{ref:"refs/tags/"+tag,object:{type:"tag",sha}}}],
    ["checksum mismatch",{checksum:"c".repeat(64)+" *"+tag+"-windows-x64.zip\n"}],
  ])("fails closed on %s",async(_name,override)=>{
    const api=client(override as never);
    await expect(inspectGitHubPublicReleaseAssets(api as unknown as GitHubWorkflowApiClient,
      "octo","repo",runId,tag,sha)).rejects.toThrow();
  });
});
