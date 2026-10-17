import {describe,expect,it,jest} from "@jest/globals";
import {ReloadableLocalAgent} from "../../../src/companion/reloadable-local-agent.js";
import {loadOracleActiveReadEnrollment}
  from "../../../src/edge/oracle-active-read-host.js";
import type {LocalAgent} from "@vs-code-gpt/local-agent";
const tag="v1.1.0-beta.90",sha="a".repeat(40);
const receipt={releaseTag:tag,sourceCommitSha:sha,
  manifestSha256:"b".repeat(64),verifiedArtifactCount:13};
const flags={
  MCP_V3_ORACLE_ACTIVE_READ_ENABLED:"1",
  MCP_V3_ORACLE_ACTIVE_READ_OWNER_SCOPE:"trusted:oracle-active",
};
function harness(fake:Partial<LocalAgent>|null){
  const reloadable=new ReloadableLocalAgent();
  const state=reloadable as unknown as {currentAgent:LocalAgent|null;generation:number};
  state.currentAgent=fake as LocalAgent|null;
  state.generation=1;
  return {reloadable,state};
}
describe("Oracle active-artifact host requires independent enrollment",()=>{
  it("remains disabled by default and rejects invalid/candidate-shared scope",()=>{
    expect(loadOracleActiveReadEnrollment({})).toBeUndefined();
    expect(()=>loadOracleActiveReadEnrollment({
      MCP_V3_ORACLE_ACTIVE_READ_ENABLED:"1",
    })).toThrow("policy invalid");
    if(process.platform!=="linux")return;
    expect(()=>loadOracleActiveReadEnrollment({...flags,
      MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE:
        flags.MCP_V3_ORACLE_ACTIVE_READ_OWNER_SCOPE})).toThrow("policy invalid");
    expect(()=>loadOracleActiveReadEnrollment({...flags,
      MCP_V3_ORACLE_ACTIVE_READ_OWNER_SCOPE:"invalid\nscope"}))
      .toThrow("policy invalid");
  });
  it("checks tag, SHA, scope and revocation every time",async()=>{
    if(process.platform!=="linux")return;
    const env={...flags};
    const policy=loadOracleActiveReadEnrollment(env)!;
    expect(await policy.policy.authorize(tag,sha,policy.host.ownerScope)).toBe(true);
    expect(await policy.policy.authorize(tag,sha,"trusted:oracle-candidate"))
      .toBe(false);
    expect(await policy.policy.authorize("../etc",sha,policy.host.ownerScope))
      .toBe(false);
    expect(await policy.policy.authorizeState(policy.host.ownerScope)).toBe(true);
    expect(await policy.policy.authorizeState("trusted:oracle-candidate")).toBe(false);
    env.MCP_V3_ORACLE_ACTIVE_READ_ENABLED="0";
    expect(await policy.policy.authorizeState(policy.host.ownerScope)).toBe(false);
    expect(await policy.policy.authorize(tag,sha,policy.host.ownerScope))
      .toBe(false);
  });
  it("rejects a completed read after the policy generation changes",async()=>{
    const enrollment={workspaceId:"mcp-access-stack" as const,
      ownerScope:"trusted:oracle-active"};
    let settle!: (v:typeof receipt)=>void;
    const pending=new Promise<typeof receipt>(resolve=>{settle=resolve;});
    const read=jest.fn(async(_input:unknown,_ctx:unknown)=>pending);
    const {reloadable,state}=harness({oracleInspectActive:read} as Partial<LocalAgent>);
    const port=reloadable.oracleActiveReadPort(enrollment);
    const operation=port.inspectActive(tag,sha);
    await Promise.resolve();
    state.currentAgent=null;state.generation++;
    settle(receipt);
    await expect(operation).rejects.toThrow("policy changed");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("discards native pointer observations after a policy reload",async()=>{
    let settle!: (value:unknown)=>void;
    const pending=new Promise<unknown>(resolve=>{settle=resolve;});
    const readState=jest.fn(async()=>pending);
    const {reloadable,state}=harness({
      oracleInspectActive:async()=>receipt,oracleInspectActiveState:readState,
    } as Partial<LocalAgent>);
    const port=reloadable.oracleActiveReadPort({
      workspaceId:"mcp-access-stack",ownerScope:"trusted:oracle-active",
    });
    const operation=port.getState();
    await Promise.resolve();
    state.currentAgent=null;state.generation++;
    settle({state:{version:1,active:null,previous:null,candidate:null}});
    await expect(operation).rejects.toThrow("policy changed");
    expect(readState).toHaveBeenCalledTimes(1);
  });
  it("rejects the generic getReleaseState as an active policy substitute",async()=>{
    const read=jest.fn(async()=>({
      workspaceId:"mcp-access-stack",installationRoot:"/unused",
      state:{version:1 as const,active:null,previous:null,candidate:null,
        updatedAt:"2026-10-17T00:00:00Z"},
      activeBootstrap:{updateScriptPresent:false,cutoverScriptPresent:false},
    }));
    const {reloadable}=harness({
      oracleInspectActive:async()=>receipt,getReleaseState:read,
    } as Partial<LocalAgent>);
    await expect(reloadable.oracleActiveReadPort({
      workspaceId:"mcp-access-stack",ownerScope:"trusted:oracle-active",
    }).getState()).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
  it("does not inherit candidate-read permission when its host is absent",async()=>{
    const {reloadable}=harness({oracleInspectCandidate:async()=>receipt} as Partial<LocalAgent>);
    await expect(reloadable.oracleActiveReadPort({
      workspaceId:"mcp-access-stack",ownerScope:"trusted:oracle-active",
    }).inspectActive(tag,sha)).rejects.toThrow();
  });
});
