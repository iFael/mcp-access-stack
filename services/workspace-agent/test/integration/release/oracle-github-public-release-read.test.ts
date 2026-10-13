import {createHash} from "node:crypto";
import {afterEach,describe,expect,it,jest} from "@jest/globals";
import {LocalAgent} from "../../../src/local-agent.js";
import type {GitHubWorkflowApiClient} from "../../../src/source-control/github-http-client.js";
import {createFixture,git,initializeGitRepository,makeWorkspacePolicy,
  type Fixture,writePolicy,writeWorkspaceFile} from "../../support/helpers.js";

const tag="v1.1.0-beta.90",sha="a".repeat(40),runId=555;
let fixture:Fixture|undefined;
afterEach(async()=>{await fixture?.cleanup();fixture=undefined;});
async function setup(capabilities:string[]){
  fixture=await createFixture({profile:"full-repo-write"});
  initializeGitRepository(fixture.workspacePath);
  git(fixture.workspacePath,["checkout","-b","feature/release-read"]);
  await writeWorkspaceFile(fixture.workspacePath,"base.txt","base\n");
  git(fixture.workspacePath,["add","base.txt"]);
  git(fixture.workspacePath,["commit","-m","base"]);
  await writePolicy(fixture.policyPath,[{
    ...makeWorkspacePolicy(fixture.workspacePath,{profile:"full-repo-write"}),
    sourceControl:{capabilities,accountOwners:[],additionalRepositories:["octo/repo"]},
  }]);
  const called=jest.fn(async()=>({id:runId,workflow_id:42,name:"Public release",
    path:"octo/repo/.github/workflows/release.yml@refs/heads/main",head_sha:sha,
    head_branch:"main",event:"workflow_dispatch",status:"completed",conclusion:"success",
    run_attempt:1,display_title:"mcp-release-11111111-2222-4333-8444-555555555555",
  }));
  const workflowClient={getWorkflowRun:called} as unknown as GitHubWorkflowApiClient;
  const agent=await LocalAgent.create(fixture.policyPath,{
    workflowClient,gitOriginResolver:{canonicalOriginUrl:async()=>"https://github.com/octo/repo.git"},
  });
  return {agent,called,workflowClient};
}
describe("audited MCP GitHub distribution inspection",()=>{
  it("rejects unauthorized signed proof before any authenticated GitHub read",async()=>{
    const {agent,called}=await setup([]);
    const workspaceId=(await agent.listWorkspaces())[0]!.id;
    await expect(agent.releaseVerifyGitHubWindowsProof({
      workspaceId,owner:"octo",repository:"repo",
    },runId,tag,sha,{ownerScope:"trusted:release-operator"})).rejects.toThrow();
    expect(called).not.toHaveBeenCalled();
  });
  it("requires complete authenticated proof-capable client",async()=>{
    const {agent,called}=await setup(["github.repository.read"]);
    const workspaceId=(await agent.listWorkspaces())[0]!.id;
    await expect(agent.releaseVerifyGitHubWindowsProof({
      workspaceId,owner:"octo",repository:"repo",
    },runId,tag,sha,{ownerScope:"trusted:release-operator"})).rejects.toThrow();
    expect(called).not.toHaveBeenCalled();
  });
  it("downloads bounded proof bytes after ACL and rejects forged pinned RSA",async()=>{
    const {agent,called,workflowClient}=await setup(["github.repository.read"]);
    const suffixes=["windows-x64.zip","linux-x64.tar.gz","linux-arm64.tar.gz",
      "linux-amd64.deb","linux-arm64.deb"];
    const checksum=(name:string)=>"a".repeat(64)+" *"+name+"\n";
    const digest=(x:string|Uint8Array)=>createHash("sha256").update(x).digest("hex");
    const assets=suffixes.flatMap((suffix,i)=>[
      {id:i*2+1,name:tag+"-"+suffix,size:1000,
        digest:"sha256:"+"a".repeat(64),state:"uploaded"},
      {id:i*2+2,name:tag+"-"+suffix+".sha256",
        size:Buffer.byteLength(checksum(tag+"-"+suffix)),
        digest:"sha256:"+digest(checksum(tag+"-"+suffix)),state:"uploaded"},
    ]);
    const certificateSha="a9177136662887555dfe0e59d11b48e670d0f63cf4b340bf3b20e1d8a1541408";
    const proofBytes=Buffer.from(JSON.stringify({
      schemaVersion:1,product:"mcp-access-stack",purpose:"mcp-public-windows-zip-v1",
      releaseTag:tag,sourceCommitSha:sha,workflowRunId:runId,
      windowsAssetName:tag+"-windows-x64.zip",windowsAssetSha256:"a".repeat(64),
      signerCertificateSha256:certificateSha,
    }));
    const signatureBytes=Buffer.alloc(256,0);
    const withProof=[...assets,
      {id:11,name:tag+"-windows-x64.proof.json",size:proofBytes.byteLength,
        digest:"sha256:"+digest(proofBytes),state:"uploaded"},
      {id:12,name:tag+"-windows-x64.proof.json.sig",size:signatureBytes.byteLength,
        digest:"sha256:"+digest(signatureBytes),state:"uploaded"},
    ];
    workflowClient.getReleaseByTag=async()=>({
      tag_name:tag,draft:false,published_at:"2026-10-12T21:00:00Z",assets:withProof,
    });
    workflowClient.getTagRef=async()=>({ref:"refs/tags/"+tag,object:{sha,type:"commit"}});
    workflowClient.getReleaseAssetChecksum=async(_owner,_repo,id)=>{
      const found=assets.find(a=>a.id===id)!;
      return checksum(found.name.slice(0,-7));
    };
    const bytes=jest.fn(async(_owner:string,_repo:string,id:number)=>id===11
      ?proofBytes:signatureBytes);
    workflowClient.getReleaseAssetBytes=bytes;
    const workspaceId=(await agent.listWorkspaces())[0]!.id;
    await expect(agent.releaseVerifyGitHubWindowsProof({
      workspaceId,owner:"octo",repository:"repo",
    },runId,tag,sha,{ownerScope:"trusted:release-operator"})).rejects.toThrow();
    expect(called).toHaveBeenCalledTimes(1);
    expect(bytes).toHaveBeenCalledTimes(2);
  });
  it("uses authenticated repository ACL and returns published integrity without signature claim",async()=>{
    const {agent,called,workflowClient}=await setup(["github.repository.read"]);
    const suffixes=["windows-x64.zip","linux-x64.tar.gz","linux-arm64.tar.gz",
      "linux-amd64.deb","linux-arm64.deb"];
    const checksum=(name:string)=>"a".repeat(64)+" *"+name+"\n";
    const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
    const assets=suffixes.flatMap((suffix,index)=>[
      {id:index*2+1,name:tag+"-"+suffix,size:1000,digest:"sha256:"+"a".repeat(64),
        state:"uploaded"},
      {id:index*2+2,name:tag+"-"+suffix+".sha256",
        size:checksum(tag+"-"+suffix).length,
        digest:"sha256:"+digest(checksum(tag+"-"+suffix)),state:"uploaded"},
    ]);
    workflowClient.getReleaseByTag=async()=>({
      tag_name:tag,draft:false,published_at:"2026-10-12T21:00:00Z",assets,
    });
    workflowClient.getTagRef=async()=>({ref:"refs/tags/"+tag,
      object:{sha,type:"commit"}});
    workflowClient.getReleaseAssetChecksum=async(_owner,_repository,id)=>{
      const found=assets.find(a=>a.id===id)!;
      return checksum(found.name.slice(0,-7));
    };
    const workspaceId=(await agent.listWorkspaces())[0]!.id;
    const result=await agent.releaseInspectGitHubPublicDistribution({
      workspaceId,owner:"octo",repository:"repo",
    },runId,tag,sha,{ownerScope:"trusted:release-operator"});
    expect(result).toMatchObject({releasePublished:true,signatureVerified:false,
      verifiedAssetCount:5,sourceCommitSha:sha});
    expect(called).toHaveBeenCalledTimes(1);
  });
  it("rejects an unauthorized repository read before any GitHub requests",async()=>{
    const {agent,called}=await setup([]);
    const workspaceId=(await agent.listWorkspaces())[0]!.id;
    await expect(agent.releaseInspectGitHubPublicDistribution({
      workspaceId,owner:"octo",repository:"repo",
    },runId,tag,sha,{ownerScope:"trusted:release-operator"})).rejects.toThrow();
    expect(called).not.toHaveBeenCalled();
  });
  it("does not invent signed proof when the authenticated API lacks release asset methods",async()=>{
    const {agent,called}=await setup(["github.repository.read"]);
    const workspaceId=(await agent.listWorkspaces())[0]!.id;
    await expect(agent.releaseInspectGitHubPublicDistribution({
      workspaceId,owner:"octo",repository:"repo",
    },runId,tag,sha,{ownerScope:"trusted:release-operator"})).rejects.toThrow(
      "Authenticated GitHub public release inspection unavailable.");
    expect(called).not.toHaveBeenCalled();
  });
});
