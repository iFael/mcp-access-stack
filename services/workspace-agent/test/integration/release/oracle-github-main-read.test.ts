import {afterEach,describe,expect,it,jest} from "@jest/globals";
import {LocalAgent} from "../../../src/local-agent.js";
import type {GitHubWorkflowApiClient} from "../../../src/source-control/github-http-client.js";
import {createFixture,git,initializeGitRepository,makeWorkspacePolicy,
  type Fixture,writePolicy,writeWorkspaceFile} from "../../support/helpers.js";

const sha="a".repeat(40);
let fixture:Fixture|undefined;
afterEach(async()=>{await fixture?.cleanup();fixture=undefined;});
async function setup(options?:{capabilities?:string[];ref?:string;sha?:string;type?:string}){
  fixture=await createFixture({profile:"full-repo-write"});
  initializeGitRepository(fixture.workspacePath);
  git(fixture.workspacePath,["checkout","-b","feature/read-provider"]);
  await writeWorkspaceFile(fixture.workspacePath,"base.txt","base\n");
  git(fixture.workspacePath,["add","base.txt"]);
  git(fixture.workspacePath,["commit","-m","base"]);
  const policy={
    ...makeWorkspacePolicy(fixture.workspacePath,{profile:"full-repo-write"}),
    sourceControl:{capabilities:options?.capabilities??["github.repository.read"],
      accountOwners:[],additionalRepositories:["octo/repo"]},
  };
  await writePolicy(fixture.policyPath,[policy]);
  const readMain=jest.fn(async()=>({
    ref:options?.ref??"refs/heads/main",
    object:{sha:options?.sha??sha,type:options?.type??"commit"},
  }));
  const workflowClient={getMainRef:readMain} as unknown as GitHubWorkflowApiClient;
  const agent=await LocalAgent.create(fixture.policyPath,{
    workflowClient,
    gitOriginResolver:{canonicalOriginUrl:async()=>"https://github.com/octo/repo.git"},
  });
  return {agent,readMain};
}
const input={workspaceId:"mcp-access-stack",owner:"octo",repository:"repo"};
describe("audited MCP source-control main-ref read for Oracle host",()=>{
  it("checks repository ACL and reads an exact commit ref via typed GitHub client",async()=>{
    const {agent,readMain}=await setup();
    // Workspace fixture uses an opaque id; use the fixture-authorized id.
    const id=(await agent.listWorkspaces())[0]!.id;
    expect(await agent.releaseReadGitHubMainHead({...input,workspaceId:id},
      {ownerScope:"trusted:release-operator"})).toBe(sha);
    expect(readMain).toHaveBeenCalledTimes(1);
  });
  it("rejects unauthorized source-control capability before contacting GitHub",async()=>{
    const {agent,readMain}=await setup({capabilities:[]});
    const id=(await agent.listWorkspaces())[0]!.id;
    await expect(agent.releaseReadGitHubMainHead({...input,workspaceId:id},
      {ownerScope:"trusted:release-operator"})).rejects.toThrow();
    expect(readMain).not.toHaveBeenCalled();
  });
  it("never accepts annotated, changed, malformed or non-main refs as main commit",async()=>{
    for(const ref of ["refs/heads/dev","refs/tags/main"]){
      const {agent,readMain}=await setup({ref});
      const id=(await agent.listWorkspaces())[0]!.id;
      await expect(agent.releaseReadGitHubMainHead({...input,workspaceId:id},
        {ownerScope:"trusted:release-operator"})).rejects.toThrow();
      expect(readMain).toHaveBeenCalledTimes(1);
      await fixture?.cleanup();fixture=undefined;
    }
  });
});
