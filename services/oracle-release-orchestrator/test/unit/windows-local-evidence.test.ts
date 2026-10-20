import {describe,expect,it} from "@jest/globals";
import {parseWindowsLocalEvidence} from "../../src/windows-local-evidence.js";

const tag="v1.1.0-beta.90",commit="a".repeat(40);
const runId="11111111-2222-4333-8444-555555555550";
const prepareOperationId="11111111-2222-4333-8444-555555555551";
const candidate={releaseId:tag.slice(1),manifestSha256:"b".repeat(64)};
const previous={releaseId:"1.1.0-beta.89",manifestSha256:"c".repeat(64)};
const state={active:previous,candidate,previous:null};
const witness={kind:"local_candidate_prepare",runId,prepareOperationId,
  releaseId:candidate.releaseId,manifestSha256:candidate.manifestSha256};
const evidence={platform:"windows",scope:"local_hash_integrity_only",
  kind:"candidate",state,releaseTag:tag,sourceCommitSha:commit,
  manifestSha256:candidate.manifestSha256,verifiedArtifactCount:9,
  localPrepareWitness:witness};
const request={mode:"candidate" as const,tag,commit,runId,prepareOperationId};
describe("untrusted Windows local evidence boundary",()=>{
  it("projects exact candidate and original local operation IDs without promotion to remote receipt",()=>{
    const result=parseWindowsLocalEvidence(evidence,request);
    expect(result).toMatchObject(evidence);
    expect(result.scope).toBe("local_hash_integrity_only");
    expect("platformReceipt" in result).toBe(false);
  });
  it("accepts only a schema-exact state projection",()=>{
    const input={platform:"windows",scope:"local_hash_integrity_only",
      kind:"state",state};
    expect(parseWindowsLocalEvidence(input,{mode:"state"})).toEqual(input);
    expect(()=>parseWindowsLocalEvidence({...input,installationRoot:"C:\\secrets"},
      {mode:"state"})).toThrow();
  });
  it("rejects forged scope, identity, operation mismatch and extra paths",()=>{
    for(const change of [
      {scope:"remote_verified"},
      {platform:"oracle"},
      {releaseTag:"v9.9.9"},
      {sourceCommitSha:"d".repeat(40)},
      {manifestSha256:"e".repeat(64)},
      {verifiedArtifactCount:0},
      {privatePath:"C:\\secret"},
      {localPrepareWitness:{...witness,prepareOperationId:"f".repeat(36)}},
      {localPrepareWitness:{...witness,debugPath:"C:\\secret"}},
    ])expect(()=>parseWindowsLocalEvidence({...evidence,...change},request)).toThrow();
  });
  it("fails closed on swapped candidate, active/candidate conflict, and missing journal",()=>{
    expect(()=>parseWindowsLocalEvidence({...evidence,
      state:{...state,candidate:previous}},request)).toThrow();
    expect(()=>parseWindowsLocalEvidence({...evidence,
      state:{...state,active:candidate}},request)).toThrow();
    expect(()=>parseWindowsLocalEvidence({...evidence,
      localPrepareWitness:undefined},request)).toThrow();
    expect(()=>parseWindowsLocalEvidence(evidence,{...request,
      prepareOperationId:"11111111-2222-4333-8444-555555555552"})).toThrow();
  });
  it("supports active only when no candidate and rollback pointer exists",()=>{
    const active={...evidence,kind:"active",
      state:{active:candidate,previous,candidate:null}};
    delete (active as {localPrepareWitness?:unknown}).localPrepareWitness;
    expect(parseWindowsLocalEvidence(active,{mode:"active",tag,commit}))
      .toMatchObject({kind:"active",manifestSha256:candidate.manifestSha256});
    expect(()=>parseWindowsLocalEvidence(active,{...request,mode:"active"})).toThrow();
  });
});
