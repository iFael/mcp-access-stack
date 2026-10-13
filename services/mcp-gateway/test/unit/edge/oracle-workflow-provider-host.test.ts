import {chmodSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach,describe,expect,it,jest} from "@jest/globals";
import {ORACLE_WORKFLOW_CONNECT_PATH} from "@mcp-access-stack/update-control-contract";
import {loadOracleWorkflowProviderFromEnvironment}
  from "../../../src/edge/oracle-workflow-provider-host.js";

const settings={
  MCP_V3_ORACLE_WORKFLOW_PROVIDER_ENABLED:"1",
  MCP_V3_ORACLE_WORKFLOW_PROVIDER_URL:
    "wss://mcp-v3-update-control.workers.dev"+ORACLE_WORKFLOW_CONNECT_PATH,
  MCP_V3_ORACLE_WORKFLOW_PROVIDER_OWNER:"octo",
  MCP_V3_ORACLE_WORKFLOW_PROVIDER_REPOSITORY:"repo",
  MCP_V3_ORACLE_WORKFLOW_PROVIDER_OWNER_SCOPE:"trusted:release-operator",
};
let folder:string|undefined;
afterEach(()=>{if(folder)rmSync(folder,{recursive:true,force:true});folder=undefined;});
function make(mode=0o600){
  folder=mkdtempSync(path.join(tmpdir(),"mcp-oracle-workflow-provider-"));
  const file=path.join(folder,"token");
  writeFileSync(file,"w".repeat(48)+"\n",{mode:0o600});chmodSync(file,mode);
  return {...settings,MCP_V3_ORACLE_WORKFLOW_PROVIDER_TOKEN_FILE:file};
}
const operationId="11111111-2222-4333-8444-555555555555";
const workflow={workspaceId:"mcp-access-stack",owner:"octo",repository:"repo",
  workflow:"release-tag-bootstrap.yml" as const,tag:"v1.1.0-beta.90",
  expectedMainSha:"a".repeat(40),operationId,mode:"dispatch" as const};
describe("Oracle workflow host enrollment and independent release gate",()=>{
  it("is disabled by default, rejects partial enrollment and untrusted URL",async()=>{
    const factory=jest.fn(()=>({
      workflowOperation:async()=>({status:"outcome_unknown" as const,operationId}),
      verifyLightweightTag:async()=>false,
    }));
    expect(await loadOracleWorkflowProviderFromEnvironment({},factory)).toBeUndefined();
    await expect(loadOracleWorkflowProviderFromEnvironment({
      MCP_V3_ORACLE_WORKFLOW_PROVIDER_ENABLED:"1"},factory)).rejects.toThrow();
    if(process.platform==="linux")
      await expect(loadOracleWorkflowProviderFromEnvironment({
        ...make(),MCP_V3_ORACLE_WORKFLOW_PROVIDER_URL:
          "wss://untrusted.example"+ORACLE_WORKFLOW_CONNECT_PATH,
      },factory)).rejects.toThrow("URL invalid");
    expect(factory).not.toHaveBeenCalled();
  });
  it("pins repository, requires separate dispatch opt-in and can revoke it",async()=>{
    if(process.platform!=="linux")return;
    const env=make();
    let gate:Parameters<Parameters<typeof loadOracleWorkflowProviderFromEnvironment>[1]>[1]|undefined;
    const factory=jest.fn((_config:unknown,policy:NonNullable<typeof gate>)=>{
      gate=policy;
      return {workflowOperation:async()=>({status:"outcome_unknown" as const,operationId}),
        verifyLightweightTag:async()=>false};
    });
    const options=await loadOracleWorkflowProviderFromEnvironment(env,factory);
    expect(options?.url.pathname).toBe(ORACLE_WORKFLOW_CONNECT_PATH);
    expect(options?.token).toBe("w".repeat(48));
    expect(factory.mock.calls[0]![0]).toMatchObject({
      workspaceId:"mcp-access-stack",owner:"octo",repository:"repo",
      ownerScope:"trusted:release-operator",
    });
    expect(await gate!.authorizeWorkflow(workflow)).toBe(false);
    expect(await gate!.authorizeWorkflow({...workflow,mode:"reconcile"})).toBe(true);
    expect(await gate!.authorizeTagRead(workflow.tag,workflow.expectedMainSha)).toBe(true);
    const enabled={...env,MCP_V3_ORACLE_WORKFLOW_PROVIDER_DISPATCH_ENABLED:"1"};
    await loadOracleWorkflowProviderFromEnvironment(enabled,factory);
    expect(await gate!.authorizeWorkflow(workflow)).toBe(true);
    enabled.MCP_V3_ORACLE_WORKFLOW_PROVIDER_DISPATCH_ENABLED="0";
    expect(await gate!.authorizeWorkflow(workflow)).toBe(false);
  });
  it("rejects reused or unprotected credentials, symlinks and invalid policy",async()=>{
    if(process.platform!=="linux")return;
    const factory=()=>({workflowOperation:async()=>({status:"outcome_unknown" as const,operationId}),
      verifyLightweightTag:async()=>false});
    const env=make(0o644);
    await expect(loadOracleWorkflowProviderFromEnvironment(env,factory)).rejects.toThrow(
      "credential unavailable");
    chmodSync(env.MCP_V3_ORACLE_WORKFLOW_PROVIDER_TOKEN_FILE,0o600);
    await expect(loadOracleWorkflowProviderFromEnvironment({
      ...env,MCP_V3_ORACLE_SOURCE_PROVIDER_TOKEN_FILE:env.MCP_V3_ORACLE_WORKFLOW_PROVIDER_TOKEN_FILE,
    },factory)).rejects.toThrow("credential reused");
    const symlink=path.join(folder!,"link");
    symlinkSync(env.MCP_V3_ORACLE_WORKFLOW_PROVIDER_TOKEN_FILE,symlink);
    await expect(loadOracleWorkflowProviderFromEnvironment({
      ...env,MCP_V3_ORACLE_WORKFLOW_PROVIDER_TOKEN_FILE:symlink,
    },factory)).rejects.toThrow("credential unavailable");
    await expect(loadOracleWorkflowProviderFromEnvironment({
      ...env,MCP_V3_ORACLE_WORKFLOW_PROVIDER_OWNER_SCOPE:"\nspoof",
    },factory)).rejects.toThrow("host policy is incomplete");
  });
});
