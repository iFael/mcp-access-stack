import {describe,expect,it,jest} from "@jest/globals";
import type {LocalAgent} from "../../../src/local-agent.js";
import {createOracleReleaseGitHubWorkflowPort} from "../../../src/release/oracle-github-workflow-port.js";

const sha="a".repeat(40);
const operationId="11111111-2222-4333-8444-555555555555";
const config={workspaceId:"mcp-access-stack" as const,owner:"octo",repository:"repo",
  ownerScope:"trusted:release-operator"};
const base={workspaceId:"mcp-access-stack",owner:"octo",repository:"repo",tag:"v1.1.0-beta.90",
  expectedMainSha:sha,operationId};

describe("host-owned typed Oracle GitHub workflow adapter",()=>{
  function setup(){
    const operation=jest.fn(async(input:{operationId:string},_context:{ownerScope:string})=>({
      status:"observed" as const,operationId:input.operationId,runId:123,
      state:"completed" as const,conclusion:"success",
    }));
    const verify=jest.fn(async(_repo:{workspaceId:string;owner:string;repository:string},
      _tag:string,_sha:string,_context:{ownerScope:string})=>true);
    const host={githubWorkflowOperation:operation,
      releaseVerifyGitHubLightweightTag:verify} as unknown as Pick<LocalAgent,
      "githubWorkflowOperation"|"releaseVerifyGitHubLightweightTag">;
    let authorized=true;
    const policy={authorizeWorkflow:jest.fn(async()=>authorized),
      authorizeTagRead:jest.fn(async()=>authorized)};
    return {port:createOracleReleaseGitHubWorkflowPort(host,config,policy),operation,verify,
      setAuthorized:(value:boolean)=>{authorized=value;},policy,host};
  }
  it("delegates only pinned tag-bootstrap and public release operations with trusted owner scope",async()=>{
    const f=setup();
    const bootstrap={...base,workflow:"release-tag-bootstrap.yml" as const,mode:"reconcile" as const};
    expect(await f.port.workflowOperation(bootstrap)).toMatchObject({
      status:"observed",operationId,runId:123,
    });
    expect(f.operation).toHaveBeenCalledWith(bootstrap,{ownerScope:config.ownerScope});
    const publish={...bootstrap,workflow:"release.yml" as const,
      mode:"dispatch" as const,bootstrapOperationId:operationId};
    await f.port.workflowOperation(publish);
    expect(f.operation).toHaveBeenCalledWith(publish,{ownerScope:config.ownerScope});
    expect(await f.port.verifyLightweightTag(base.tag,sha)).toBe(true);
    expect(f.verify).toHaveBeenCalledWith({
      workspaceId:config.workspaceId,owner:config.owner,repository:config.repository,
    },base.tag,sha,{ownerScope:config.ownerScope});
  });
  it("rejects spoofed repo, workflow, tag, SHA and bootstrap identity without host execution",async()=>{
    const f=setup();
    for(const input of [
      {...base,workflow:"arbitrary.yml",mode:"dispatch"},
      {...base,workflow:"release.yml",mode:"dispatch"},
      {...base,workflow:"release-tag-bootstrap.yml",mode:"dispatch",owner:"attacker"},
      {...base,workflow:"release-tag-bootstrap.yml",mode:"dispatch",root:"../other"},
      {...base,workflow:"release-tag-bootstrap.yml",mode:"dispatch",tag:"v1.0.0-oracle.2"},
      {...base,workflow:"release-tag-bootstrap.yml",mode:"dispatch",expectedMainSha:"bad"},
    ]){
      await expect(f.port.workflowOperation(input as never)).rejects.toThrow();
    }
    await expect(f.port.verifyLightweightTag("../ref",sha)).rejects.toThrow();
    expect(f.operation).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });
  it("checks independent host policy on every dispatch, reconcile and tag read",async()=>{
    const f=setup();
    f.setAuthorized(false);
    const op={...base,workflow:"release-tag-bootstrap.yml" as const,mode:"dispatch" as const};
    await expect(f.port.workflowOperation(op)).rejects.toThrow("NOT_AUTHORIZED");
    await expect(f.port.verifyLightweightTag(base.tag,sha)).rejects.toThrow("NOT_AUTHORIZED");
    expect(f.operation).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    f.setAuthorized(true);
    await f.port.workflowOperation(op);
    expect(f.operation).toHaveBeenCalledTimes(1);
    f.setAuthorized(false);
    await expect(f.port.workflowOperation({...op,mode:"reconcile"})).rejects.toThrow("NOT_AUTHORIZED");
    expect(f.operation).toHaveBeenCalledTimes(1);
    expect(()=>createOracleReleaseGitHubWorkflowPort(f.host,config,null as never)).toThrow("POLICY_REQUIRED");
  });
  it("fails closed on wrong host receipt operation and invalid host identity",async()=>{
    const f=setup();
    f.operation.mockImplementation(async()=>({
      status:"observed",operationId:"11111111-2222-4333-8444-555555555556",
      runId:123,state:"completed",conclusion:"success",
    }));
    await expect(f.port.workflowOperation({...base,workflow:"release-tag-bootstrap.yml",
      mode:"reconcile"})).rejects.toThrow("MISMATCH");
    const host={githubWorkflowOperation:f.operation,
      releaseVerifyGitHubLightweightTag:f.verify} as unknown as Pick<LocalAgent,
      "githubWorkflowOperation"|"releaseVerifyGitHubLightweightTag">;
    expect(()=>createOracleReleaseGitHubWorkflowPort(host,{...config,ownerScope:"\nspoofed"},
      f.policy)).toThrow();
  });
});
