import {describe,expect,it} from "@jest/globals";
import {loadOracleCandidateReadEnrollment}
  from "../../../src/edge/oracle-candidate-read-host.js";
const flags={
  MCP_V3_ORACLE_CANDIDATE_READ_ENABLED:"1",
  MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE:"trusted:oracle-candidate-reader",
};
describe("Oracle candidate read enrollment is opt-in and isolated",()=>{
  it("is absent by default, fails closed on incomplete enrollment",()=>{
    expect(loadOracleCandidateReadEnrollment({})).toBeUndefined();
    expect(()=>loadOracleCandidateReadEnrollment({
      MCP_V3_ORACLE_CANDIDATE_READ_ENABLED:"1",
    })).toThrow("host policy invalid");
    expect(()=>loadOracleCandidateReadEnrollment({
      MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE:flags.MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE,
    })).toThrow("host policy invalid");
  });
  it("requires its own exact owner scope, never workflow or source principal",()=>{
    if(process.platform!=="linux")return;
    expect(()=>loadOracleCandidateReadEnrollment({
      ...flags,MCP_V3_ORACLE_WORKFLOW_PROVIDER_OWNER_SCOPE:
        flags.MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE,
    })).toThrow("host policy invalid");
    expect(()=>loadOracleCandidateReadEnrollment({
      ...flags,MCP_V3_ORACLE_SOURCE_PROVIDER_OWNER_SCOPE:
        flags.MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE,
    })).toThrow("host policy invalid");
    expect(()=>loadOracleCandidateReadEnrollment({
      ...flags,MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE:"\nspoofed",
    })).toThrow("host policy invalid");
  });
  it("validates tag, source commit and principal on every read, including revocation",async()=>{
    if(process.platform!=="linux")return;
    const settings={...flags};
    const reader=loadOracleCandidateReadEnrollment(settings)!;
    expect(reader.host).toEqual({workspaceId:"mcp-access-stack",
      ownerScope:settings.MCP_V3_ORACLE_CANDIDATE_READ_OWNER_SCOPE});
    expect(await reader.policy.authorize("v1.1.0-beta.90","a".repeat(40),
      reader.host.ownerScope)).toBe(true);
    expect(await reader.policy.authorize("v1.1.0-beta.90","a".repeat(40),
      "trusted:workflow")).toBe(false);
    expect(await reader.policy.authorize("../escape","a".repeat(40),
      reader.host.ownerScope)).toBe(false);
    expect(await reader.policy.authorize("v1.1.0-beta.90","bad",
      reader.host.ownerScope)).toBe(false);
    settings.MCP_V3_ORACLE_CANDIDATE_READ_ENABLED="0";
    expect(await reader.policy.authorize("v1.1.0-beta.90","a".repeat(40),
      reader.host.ownerScope)).toBe(false);
  });
});
