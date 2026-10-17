import {afterEach,describe,expect,it,jest} from "@jest/globals";
import {LocalAgent} from "../../../src/local-agent.js";
import {createFixture,makeWorkspacePolicy,writePolicy,type Fixture}
  from "../../support/helpers.js";

const input={workspaceId:"mcp-access-stack"};
const scope="trusted:oracle-active-state";
const state={workspaceId:"mcp-access-stack",
  state:{version:1,active:null,previous:null,candidate:null,
    updatedAt:"2026-10-17T00:00:00Z"},
  activeBootstrap:{updateScriptPresent:false,cutoverScriptPresent:false}};
let fixture:Fixture|undefined;
afterEach(async()=>{await fixture?.cleanup();fixture=undefined;});

async function harness(enabled:boolean,trusted=true){
  fixture=await createFixture({profile:"full-repo-write"});
  const workspace={...makeWorkspacePolicy(fixture.workspacePath,{
    profile:"full-repo-write",
    confirmationMode:trusted?"trusted-workspace":"standard",
  }),id:"mcp-access-stack",allowShell:["."]};
  await writePolicy(fixture.policyPath,[workspace]);
  const authorizeState=jest.fn(async(owner:string)=>enabled && owner===scope);
  const audit=await LocalAgent.create(fixture.policyPath,{
    oracleActiveRead:{
      authorize:async()=>false,
      authorizeState,
    },
  });
  const getState=jest.fn(async()=>state);
  (audit as unknown as {releaseLifecycleService:{getState:typeof getState}})
    .releaseLifecycleService.getState=getState;
  return {audit,authorizeState,getState};
}

describe("isolated authenticated Oracle active state reader",()=>{
  it("rejects missing or foreign scope without touching native state",async()=>{
    const h=await harness(true);
    await expect(h.audit.oracleInspectActiveState(input,{})).rejects.toThrow();
    await expect(h.audit.oracleInspectActiveState(input,{ownerScope:"candidate:read"}))
      .rejects.toThrow();
    expect(h.getState).not.toHaveBeenCalled();
  });
  it("refuses unenrolled and untrusted readers",async()=>{
    const h=await harness(false);
    await expect(h.audit.oracleInspectActiveState(input,{ownerScope:scope}))
      .rejects.toThrow();
    expect(h.getState).not.toHaveBeenCalled();
  });
  it("revalidates the isolated permission after the native read",async()=>{
    const h=await harness(true);
    h.authorizeState.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(h.audit.oracleInspectActiveState(input,{ownerScope:scope}))
      .rejects.toThrow();
    expect(h.getState).toHaveBeenCalledTimes(1);
  });
  it("permits only trusted scoped reads with a native typed result",async()=>{
    const h=await harness(true);
    expect(await h.audit.oracleInspectActiveState(input,{ownerScope:scope}))
      .toEqual(state);
    expect(h.getState).toHaveBeenCalledTimes(1);
    expect(h.authorizeState).toHaveBeenCalledTimes(2);
  });
});
