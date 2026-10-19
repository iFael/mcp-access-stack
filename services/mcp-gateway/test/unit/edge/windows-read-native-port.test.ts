import {describe,expect,it,jest} from "@jest/globals";
import {WindowsNativeReadPort} from "../../../src/edge/windows-read-native-port.js";

const tag="v1.1.0-beta.90",sha="a".repeat(40);
const digest="b".repeat(64),previousDigest="c".repeat(64);
const runId="11111111-2222-4333-8444-555555555551";
const operationId="11111111-2222-4333-8444-555555555552";
const prepareOperationId="11111111-2222-4333-8444-555555555553";
const candidate={releaseId:tag.slice(1),manifestSha256:digest};
const previous={releaseId:"1.1.0-beta.89",manifestSha256:previousDigest};
const candidateState={active:previous,previous:null,candidate};
const activeState={active:candidate,previous,candidate:null};
const journal={kind:"local_candidate_prepare",runId,prepareOperationId,
  releaseId:candidate.releaseId,manifestSha256:digest};
const observedCandidate={platform:"windows",kind:"candidate",
  scope:"local_hash_integrity_only",state:candidateState,
  releaseTag:tag,sourceCommitSha:sha,manifestSha256:digest,
  verifiedArtifactCount:9,localPrepareWitness:journal};
const observedActive={platform:"windows",kind:"active",
  scope:"local_hash_integrity_only",state:activeState,
  releaseTag:tag,sourceCommitSha:sha,manifestSha256:digest,
  verifiedArtifactCount:9};
const observedState={platform:"windows",kind:"state",
  scope:"local_hash_integrity_only",state:candidateState};

function makeHost(value:unknown=observedCandidate,allowed=true){
  const observe=jest.fn(async(_input:unknown)=>value);
  const authorize=jest.fn(async(_owner:string,_op:string)=>allowed);
  const host=new WindowsNativeReadPort({platform:"win32",
    invoker:{observe},policy:{ownerScope:"trusted:windows-read",authorize}});
  return {host,observe,authorize};
}
describe("Windows fixed native observation projection (no script execution)",()=>{
  it("accepts only scoped candidate hashes with exact prepare IDs",async()=>{
    const {host,observe,authorize}=makeHost();
    const proof=await host.inspectCandidate(tag,sha,runId,operationId,prepareOperationId);
    expect(proof).toMatchObject({scope:"local_hash_integrity_only",
      state:candidateState,
      localPrepareWitness:{runId,prepareOperationId,releaseId:tag.slice(1)}});
    expect(proof).not.toHaveProperty("operationId");
    expect(observe).toHaveBeenCalledWith({mode:"Candidate",
      expectedTag:tag,expectedCommit:sha,
      expectedRunId:runId,expectedPrepareOperationId:prepareOperationId});
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(authorize).toHaveBeenCalledWith("trusted:windows-read","candidate");
  });
  it("requires a separate authorization before and after observation",async()=>{
    const {host,observe}=makeHost(observedCandidate,false);
    await expect(host.inspectCandidate(tag,sha,runId,operationId,prepareOperationId))
      .rejects.toThrow("UNAUTHORIZED");
    expect(observe).not.toHaveBeenCalled();
    let calls=0;
    const authorize=jest.fn(async()=>++calls===1);
    const unlocked=new WindowsNativeReadPort({platform:"win32",
      invoker:{observe:async()=>observedCandidate},
      policy:{ownerScope:"trusted:windows-read",authorize}});
    await expect(unlocked.inspectCandidate(tag,sha,runId,operationId,prepareOperationId))
      .rejects.toThrow("AUTH_REVOKED");
  });
  it("validates state and active data without inventing a remote health signal",async()=>{
    const {host:stateHost,observe:stateObs}=makeHost(observedState);
    expect(await stateHost.getState()).toEqual(candidateState);
    expect(stateObs).toHaveBeenCalledWith({mode:"State"});
    const {host:activeHost,observe:activeObs}=makeHost(observedActive);
    const active=await activeHost.inspectActive(tag,sha);
    expect(active).toMatchObject({scope:"local_hash_integrity_only",
      state:activeState});
    expect(active).not.toHaveProperty("localPrepareWitness");
    expect(activeObs).toHaveBeenCalledWith({mode:"Active",
      expectedTag:tag,expectedCommit:sha});
    expect("getHealth" in activeHost).toBe(false);
  });
  it("fails closed for mismatched manifest, forged scope and extra fields",async()=>{
    const forged=[
      {...observedCandidate,scope:"remotely_authenticated"},
      {...observedCandidate,operationReceipt:"fake"},
      {...observedCandidate,verifiedArtifactCount:0},
      {...observedCandidate,localPrepareWitness:{...journal,
        prepareOperationId:operationId}},
      {...observedCandidate,manifestSha256:"d".repeat(64)},
      {...observedCandidate,state:{...candidateState,candidate:null}},
      {...observedCandidate,localPrepareWitness:{...journal,
        sourcePath:"C:\\temp"}},
    ];
    for(const value of forged){
      const {host}=makeHost(value);
      await expect(host.inspectCandidate(tag,sha,runId,operationId,prepareOperationId))
        .rejects.toThrow();
    }
  });
  it("never trusts caller-selected execution paths or malformed inputs",async()=>{
    const {host,observe}=makeHost();
    await expect(host.inspectCandidate("v1.1.0..bad",sha,runId,operationId,
      prepareOperationId)).rejects.toThrow();
    await expect(host.inspectCandidate(tag,sha,runId,"bad",prepareOperationId))
      .rejects.toThrow();
    expect(observe).not.toHaveBeenCalled();
    expect(()=>new WindowsNativeReadPort({platform:"linux",
      invoker:{observe},policy:{ownerScope:"trusted:windows-read",
        authorize:async()=>true}})).toThrow("NOT_ENROLLED");
    const {host:badPayload}=makeHost("x".repeat(4096));
    await expect(badPayload.getState()).rejects.toThrow("OVERSIZE");
  });
});
