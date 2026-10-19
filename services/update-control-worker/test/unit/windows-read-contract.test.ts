import {describe,expect,it} from "@jest/globals";
import {
  parseWindowsReadCommand,parseWindowsReadResult,
  windowsReadCanonicalBytes,signWindowsReadRequest,
  WINDOWS_READ_DISPATCH_PATH,WINDOWS_READ_SCOPE,
  ORACLE_ACTIVE_DISPATCH_PATH,
} from "@mcp-access-stack/update-control-contract";
const requestId="11111111-2222-4333-8444-555555555553";
const runId="11111111-2222-4333-8444-555555555550";
const operationId="11111111-2222-4333-8444-555555555552";
const prepareOperationId="11111111-2222-4333-8444-555555555551";
const tag="v1.1.0-beta.90",commit="a".repeat(40),hash="b".repeat(64);
const command={method:"inspect_candidate" as const,arguments:{
  requestId,tag,commitSha:commit,runId,operationId,prepareOperationId,
}};
const pointer={releaseId:tag.slice(1),manifestSha256:hash};
const state={active:null,previous:null,candidate:pointer};
const proof={scope:"local_hash_integrity_only",releaseTag:tag,
  sourceCommitSha:commit,manifestSha256:hash,verifiedArtifactCount:9,
  state,localPrepareWitness:{
    kind:"local_candidate_prepare",runId,prepareOperationId,
    releaseId:tag.slice(1),manifestSha256:hash,
  }};
describe("unactivated independent Windows read protocol",()=>{
  it("keeps distinct path, scope and canonical HMAC domain",()=>{
    expect(WINDOWS_READ_SCOPE).not.toContain("oracle");
    expect(WINDOWS_READ_DISPATCH_PATH).not.toBe(ORACLE_ACTIVE_DISPATCH_PATH);
    const canonical=windowsReadCanonicalBytes("f".repeat(64),"1800000000");
    expect(new TextDecoder().decode(canonical)).toContain("mcp-v3:windows-read:v1");
    expect(new TextDecoder().decode(canonical)).toContain(WINDOWS_READ_DISPATCH_PATH);
  });
  it("signs bounded exact intent without accepting caller paths",async()=>{
    const signed=await signWindowsReadRequest(command,"d".repeat(64),1800000000);
    expect(JSON.parse(signed.body)).toEqual(command);
    expect(signed.authorization).toMatch(/^HMAC-SHA256 windows-read-v1=1800000000\.[a-f0-9]{64}$/u);
    expect(parseWindowsReadCommand(command)).toEqual(command);
    expect(()=>parseWindowsReadCommand({...command,arguments:{
      ...command.arguments,scriptPath:"C:\\secrets"}})).toThrow();
    expect(()=>parseWindowsReadCommand({...command,arguments:{
      ...command.arguments,prepareOperationId:"other"}})).toThrow();
    expect(()=>parseWindowsReadCommand({method:"execute_script",
      arguments:{requestId}})).toThrow();
    expect(()=>windowsReadCanonicalBytes("not-sha","1800000000")).toThrow();
  });
  it("retains local-only scope and exact request+operation binding",()=>{
    const result={method:"inspect_candidate",requestId,proof};
    expect(parseWindowsReadResult(command,result)).toEqual(result);
    expect(()=>parseWindowsReadResult(command,{...result,requestId:runId})).toThrow();
    expect(()=>parseWindowsReadResult(command,{...result,proof:{
      ...proof,scope:"remote_verified"}})).toThrow();
    expect(()=>parseWindowsReadResult(command,{...result,proof:{
      ...proof,localPrepareWitness:{...proof.localPrepareWitness,
        prepareOperationId:operationId}}})).toThrow();
    expect(()=>parseWindowsReadResult(command,{...result,proof:{
      ...proof,localPrepareWitness:{...proof.localPrepareWitness,
        privatePath:"C:\\secret"}}})).toThrow();
    expect(()=>parseWindowsReadResult(command,{...result,proof:{
      ...proof,receipt:"windows_prepare_receipt"}})).toThrow();
  });
  it("rejects forged cross-release state and malformed state response",()=>{
    expect(()=>parseWindowsReadResult(command,{
      method:"inspect_candidate",requestId,proof:{...proof,state:{
        ...state,candidate:{releaseId:"1.1.0-other",manifestSha256:hash},
      }},
    })).toThrow();
    const stateCommand={method:"get_state" as const,arguments:{requestId}};
    expect(parseWindowsReadResult(stateCommand,{method:"get_state",requestId,
      scope:"local_hash_integrity_only",state})).toMatchObject({state});
    expect(()=>parseWindowsReadResult(stateCommand,{method:"get_state",requestId,
      scope:"local_hash_integrity_only",state,installationRoot:"D:\\secret"})).toThrow();
  });
});
