import {describe,expect,it,jest} from "@jest/globals";
import {ReloadableLocalAgent} from "../../../src/companion/reloadable-local-agent.js";
import type {LocalAgent,OracleReleaseGitHubWorkflowPolicy}
  from "@vs-code-gpt/local-agent";

const sha="a".repeat(40),operationId="11111111-2222-4333-8444-555555555555";
const config={workspaceId:"mcp-access-stack" as const,owner:"octo",repository:"repo",
  ownerScope:"trusted:release-operator"};
const request={workflow:"release-tag-bootstrap.yml" as const,mode:"dispatch" as const,
  tag:"v1.1.0-beta.90",expectedMainSha:sha,operationId};
const allow:OracleReleaseGitHubWorkflowPolicy={
  authorizeWorkflow:async()=>true,authorizeTagRead:async()=>true,
  authorizeDistribution:async()=>true,
};
describe("Oracle workflow reloadable LocalAgent",()=>{
  it("refuses unconfigured agent before any dispatch",async()=>{
    const reloadable=new ReloadableLocalAgent();
    const port=reloadable.oracleWorkflowPort(config,allow);
    await expect(port.workflowOperation(request)).rejects.toThrow("offline");
  });
  it("rejects completion after policy generation changes, without replaying workflow",async()=>{
    const reloadable=new ReloadableLocalAgent();
    let resolve!: (value:{status:"submitted";operationId:string})=>void;
    const pending=new Promise<{status:"submitted";operationId:string}>(ok=>{resolve=ok;});
    const dispatch=jest.fn(async()=>pending);
    const fake:LocalAgent = {githubWorkflowOperation:dispatch, releaseVerifyGitHubLightweightTag:async()=>true} as unknown as LocalAgent;
    const inner=reloadable as unknown as {currentAgent:LocalAgent|null;generation:number};
    inner.currentAgent=fake;inner.generation=1;
    const port=reloadable.oracleWorkflowPort(config,allow);
    const result=port.workflowOperation(request);
    for(let i=0;i<12;i++)await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    inner.currentAgent=null;inner.generation=2;
    resolve({status:"submitted",operationId});
    await expect(result).rejects.toThrow("policy changed");
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(port.workflowOperation(request)).rejects.toThrow("offline");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("checks distinct host-owned gate on dispatch and tag verification",async()=>{
    const reloadable=new ReloadableLocalAgent();
    const dispatch=jest.fn(async()=>({status:"outcome_unknown" as const,operationId}));
    const tag=jest.fn(async()=>true);
    const inner=reloadable as unknown as {currentAgent:LocalAgent|null;generation:number};
    inner.currentAgent={githubWorkflowOperation:dispatch,
      releaseVerifyGitHubLightweightTag:tag} as unknown as LocalAgent;inner.generation=1;
    const denied:OracleReleaseGitHubWorkflowPolicy={
      authorizeWorkflow:async()=>false,authorizeTagRead:async()=>false,
      authorizeDistribution:async()=>false,
    };
    const port=reloadable.oracleWorkflowPort(config,denied);
    await expect(port.workflowOperation(request)).rejects.toThrow("NOT_AUTHORIZED");
    await expect(port.verifyLightweightTag(request.tag,sha)).rejects.toThrow("NOT_AUTHORIZED");
    expect(dispatch).not.toHaveBeenCalled();
    expect(tag).not.toHaveBeenCalled();
  });
});
