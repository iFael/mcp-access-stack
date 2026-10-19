import {describe,expect,it,jest} from "@jest/globals";
import {createOracleReleaseGitHubReadPort} from "../../../src/release/oracle-github-read-port.js";
import type {LocalAgent} from "../../../src/local-agent.js";

const sha="a".repeat(40);
const config={workspaceId:"mcp-access-stack" as const,owner:"octo",repository:"repo",
  ownerScope:"trusted:release-operator"};
const checks={
  owner:"octo",repository:"repo",commitSha:sha,
  totalCount:1,returnedCount:1,pendingCount:0,successfulCount:1,failingCount:0,
  allCompleted:true,truncated:false,passed:true,
  checks:[{id:9,name:"validate",status:"completed" as const,conclusion:"success" as const,
    detailsUrl:null,startedAt:null,completedAt:null}],
};
describe("MCP V3 authenticated GitHub source-control release read port",()=>{
  it("forwards only typed GitHub GETs to the authorized host and maps verified checks",async()=>{
    const main=jest.fn(async(_input:unknown,_context:unknown)=>sha);
    const getChecks=jest.fn(async(_input:unknown,_context:unknown)=>checks);
    const port=createOracleReleaseGitHubReadPort({
      releaseReadGitHubMainHead:main,
      githubGetCommitChecks:getChecks,
    } as unknown as Pick<LocalAgent,"releaseReadGitHubMainHead"|"githubGetCommitChecks">,config);
    expect(await port.readMainHead()).toBe(sha);
    const result=await port.readCommitChecks(sha);
    expect(result.commitSha).toBe(sha);
    expect(result.checks).toEqual([{id:9,name:"validate",status:"completed",conclusion:"success"}]);
    expect(main).toHaveBeenCalledWith({
      workspaceId:"mcp-access-stack",owner:"octo",repository:"repo",
    },{ownerScope:"trusted:release-operator"});
    expect(getChecks).toHaveBeenCalledWith({
      workspaceId:"mcp-access-stack",owner:"octo",repository:"repo",commitSha:sha,
    },{ownerScope:"trusted:release-operator"});
  });
  it("rejects invalid host identity, outside workspace and uncontrolled repository name",()=>{
    const host={releaseReadGitHubMainHead:async()=>sha,
      githubGetCommitChecks:async()=>checks} as unknown as Pick<LocalAgent,"releaseReadGitHubMainHead"|"githubGetCommitChecks">;
    expect(()=>createOracleReleaseGitHubReadPort(host,{...config,workspaceId:"other" as "mcp-access-stack"})).toThrow();
    expect(()=>createOracleReleaseGitHubReadPort(host,{...config,repository:"../evil"})).toThrow();
    expect(()=>createOracleReleaseGitHubReadPort(host,{...config,ownerScope:"\nspoofed"})).toThrow();
  });
  it("fails closed on mismatched, truncated or spoofed remote observations",async()=>{
    const getMain=jest.fn(async()=>sha);
    const getChecks=jest.fn(async()=>({...checks,commitSha:"b".repeat(40)}));
    const host={releaseReadGitHubMainHead:getMain,githubGetCommitChecks:getChecks} as unknown as Pick<LocalAgent,"releaseReadGitHubMainHead"|"githubGetCommitChecks">;
    const port=createOracleReleaseGitHubReadPort(host,config);
    await expect(port.readCommitChecks(sha)).rejects.toThrow("UNVERIFIED");
    getChecks.mockImplementation(async()=>({...checks,truncated:true}));
    await expect(port.readCommitChecks(sha)).rejects.toThrow("UNVERIFIED");
    await expect(port.readCommitChecks("wrong")).rejects.toThrow("SHA_INVALID");
    getMain.mockImplementation(async()=>"wrong");
    await expect(port.readMainHead()).rejects.toThrow("UNVERIFIED");
  });
});
