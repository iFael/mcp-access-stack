import {describe,expect,it,jest} from "@jest/globals";
import {createOracleActiveReadPort} from "../../../src/release/oracle-active-host-port.js";
import type {LocalAgent} from "../../../src/local-agent.js";
const tag="v1.1.0-beta.90",sha="a".repeat(40),digest="b".repeat(64);
const config={workspaceId:"mcp-access-stack" as const,ownerScope:"trusted:oracle-active-read"};
describe("private audited active-artifact host port",()=>{
  it("pins workspace, ownerScope, tag and commit for a real agent read",async()=>{
    const reader=jest.fn(async(_input:unknown,_context:unknown)=>({
      releaseTag:tag,sourceCommitSha:sha,manifestSha256:digest,
      verifiedArtifactCount:13,
    }));
    const port=createOracleActiveReadPort({
      oracleInspectActive:reader,
    } as unknown as Pick<LocalAgent,"oracleInspectActive">,config);
    expect(await port.inspectActive(tag,sha)).toMatchObject({
      releaseTag:tag,sourceCommitSha:sha,manifestSha256:digest,
      verifiedArtifactCount:13,
    });
    expect(reader).toHaveBeenCalledWith({
      workspaceId:config.workspaceId,tag,commitSha:sha,
    },{ownerScope:config.ownerScope});
  });
  it("rejects forged or incomplete receipts, and caller paths",async()=>{
    const reader=jest.fn(async(_input:unknown,_context:unknown)=>({
      releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:"invalid",verifiedArtifactCount:13,
    }));
    const port=createOracleActiveReadPort({
      oracleInspectActive:reader,
    } as unknown as Pick<LocalAgent,"oracleInspectActive">,config);
    await expect(port.inspectActive(tag,sha)).rejects.toThrow("RECEIPT_INVALID");
    await expect(port.inspectActive("../private",sha)).rejects.toThrow("REQUEST_INVALID");
    expect(reader).toHaveBeenCalledTimes(1);
  });
  it("fails closed on invalid or caller-selected host identity",()=>{
    const reader=async()=>({releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:digest,verifiedArtifactCount:13});
    const host={oracleInspectActive:reader} as Pick<LocalAgent,"oracleInspectActive">;
    expect(()=>createOracleActiveReadPort(host,{...config,
      workspaceId:"untrusted" as "mcp-access-stack"})).toThrow("HOST_INVALID");
    expect(()=>createOracleActiveReadPort(host,{...config,
      ownerScope:"invalid\nscope"})).toThrow("HOST_INVALID");
  });
});
