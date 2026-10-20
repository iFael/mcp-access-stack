import {describe,expect,it,jest} from "@jest/globals";
import {createOracleCandidateReadPort} from "../../../src/release/oracle-candidate-host-port.js";
import type {LocalAgent} from "../../../src/local-agent.js";
const tag="v1.1.0-beta.90",sha="a".repeat(40),digest="b".repeat(64);
const config={workspaceId:"mcp-access-stack" as const,ownerScope:"trusted:oracle-candidate-read"};
describe("private execution-node Oracle candidate read port",()=>{
  it("calls the typed audited local-agent method with a pinned host identity",async()=>{
    const read=jest.fn(async(_input:unknown,_context:unknown)=>({releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:digest,verifiedArtifactCount:13}));
    const port=createOracleCandidateReadPort({
      oracleInspectCandidate:read,
    } as unknown as Pick<LocalAgent,"oracleInspectCandidate">,config);
    expect(await port.readCandidate(tag,sha)).toEqual({
      releaseTag:tag,sourceCommitSha:sha,manifestSha256:digest,verifiedArtifactCount:13,
    });
    expect(read).toHaveBeenCalledWith({
      workspaceId:"mcp-access-stack",tag,commitSha:sha,
    },{ownerScope:config.ownerScope});
  });
  it("refuses an untrusted scope or caller-selected workspace",()=>{
    const host={oracleInspectCandidate:async()=>({releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:digest,verifiedArtifactCount:1})} as Pick<LocalAgent,"oracleInspectCandidate">;
    expect(()=>createOracleCandidateReadPort(host,{
      ...config,ownerScope:"spoofed\nscope",
    })).toThrow("HOST_INVALID");
    expect(()=>createOracleCandidateReadPort(host,{
      ...config,workspaceId:"foreign" as "mcp-access-stack",
    })).toThrow("HOST_INVALID");
  });
  it("rejects forged digests, mismatched release identity and unsafe tag",async()=>{
    const read=jest.fn(async()=>({releaseTag:tag,sourceCommitSha:sha,
      manifestSha256:"invalid",verifiedArtifactCount:13}));
    const port=createOracleCandidateReadPort({
      oracleInspectCandidate:read,
    } as unknown as Pick<LocalAgent,"oracleInspectCandidate">,config);
    await expect(port.readCandidate(tag,sha)).rejects.toThrow("RECEIPT_INVALID");
    read.mockImplementation(async()=>({releaseTag:"v1.1.0-beta.91",sourceCommitSha:sha,
      manifestSha256:digest,verifiedArtifactCount:13}));
    await expect(port.readCandidate(tag,sha)).rejects.toThrow("RECEIPT_INVALID");
    await expect(port.readCandidate("../state/file",sha)).rejects.toThrow("REQUEST_INVALID");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
