import {describe,expect,it,jest} from "@jest/globals";
import {createOracleActiveReadPort} from "../../../src/release/oracle-active-host-port.js";
import type {LocalAgent} from "../../../src/local-agent.js";
const tag="v1.1.0-beta.90",sha="a".repeat(40),digest="b".repeat(64);
const config={workspaceId:"mcp-access-stack" as const,ownerScope:"trusted:oracle-active-read"};
const pointers={version:1,active:{releaseId:tag.slice(1),manifestSha256:digest},
  previous:{releaseId:"1.1.0-beta.89",manifestSha256:"c".repeat(64)},
  candidate:null};
type ActiveHost=Pick<LocalAgent,"oracleInspectActive"|"oracleInspectActiveState">;
describe("private audited active-artifact host port",()=>{
  it("pins workspace, ownerScope, tag and commit for a real agent read",async()=>{
    const reader=jest.fn(async(_input:unknown,_context:unknown)=>({
      releaseTag:tag,sourceCommitSha:sha,manifestSha256:digest,
      verifiedArtifactCount:13,
    }));
    const stateReader=jest.fn(async(_input:unknown,_context:unknown)=>({state:pointers}));
    const port=createOracleActiveReadPort({
      oracleInspectActive:reader,oracleInspectActiveState:stateReader,
    } as unknown as ActiveHost,config);
    expect(await port.inspectActive(tag,sha)).toMatchObject({
      releaseTag:tag,sourceCommitSha:sha,manifestSha256:digest,
      verifiedArtifactCount:13,
    });
    expect(reader).toHaveBeenCalledWith({
      workspaceId:config.workspaceId,tag,commitSha:sha,
    },{ownerScope:config.ownerScope});
    expect(await port.getState()).toEqual({
      active:pointers.active,previous:pointers.previous,candidate:null,
    });
    expect(stateReader).toHaveBeenCalledWith(
      {workspaceId:config.workspaceId},{ownerScope:config.ownerScope});
  });
  it("rejects forged or incomplete receipts, and caller paths",async()=>{
    const reader=jest.fn(async(_input:unknown,_context:unknown)=>({
      releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:"invalid",verifiedArtifactCount:13,
    }));
    const stateReader=jest.fn(async(_input:unknown,_context:unknown)=>({state:pointers}));
    const port=createOracleActiveReadPort({
      oracleInspectActive:reader,oracleInspectActiveState:stateReader,
    } as unknown as ActiveHost,config);
    await expect(port.inspectActive(tag,sha)).rejects.toThrow("RECEIPT_INVALID");
    await expect(port.inspectActive("../private",sha)).rejects.toThrow("REQUEST_INVALID");
    expect(reader).toHaveBeenCalledTimes(1);
  });
  it("rejects forged native pointer observations and absent state reader",async()=>{
    const inspect=async()=>({releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:digest,verifiedArtifactCount:13});
    const invalid=createOracleActiveReadPort({
      oracleInspectActive:inspect,
      oracleInspectActiveState:async()=>({state:{...pointers,
        active:{...pointers.active,manifestSha256:"invalid"}}}),
    } as unknown as ActiveHost,config);
    await expect(invalid.getState()).rejects.toThrow("ORACLE_ACTIVE_STATE_INVALID");
    expect(()=>createOracleActiveReadPort({
      oracleInspectActive:inspect,
    } as unknown as ActiveHost,config)).toThrow("ORACLE_ACTIVE_HOST_INVALID");
  });
  it("does not accept the generic lifecycle reader in place of active policy",()=>{
    const host={oracleInspectActive:async()=>({
      releaseTag:tag,sourceCommitSha:sha,manifestSha256:digest,
      verifiedArtifactCount:13,
    }),getReleaseState:async()=>({state:pointers})} as unknown as ActiveHost;
    expect(()=>createOracleActiveReadPort(host,config))
      .toThrow("ORACLE_ACTIVE_HOST_INVALID");
  });
  it("fails closed on invalid or caller-selected host identity",()=>{
    const reader=async()=>({releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:digest,verifiedArtifactCount:13});
    const host={oracleInspectActive:reader,
      oracleInspectActiveState:async()=>({state:pointers})} as unknown as ActiveHost;
    expect(()=>createOracleActiveReadPort(host,{...config,
      workspaceId:"untrusted" as "mcp-access-stack"})).toThrow("HOST_INVALID");
    expect(()=>createOracleActiveReadPort(host,{...config,
      ownerScope:"invalid\nscope"})).toThrow("HOST_INVALID");
  });
});
