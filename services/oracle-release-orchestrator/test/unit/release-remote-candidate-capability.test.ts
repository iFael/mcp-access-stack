import {describe,expect,it,jest} from "@jest/globals";
import {bindReleaseRemoteCandidate}
  from "../../src/release-remote-candidate-capability.js";
import type {ReleaseRunSnapshot,StepIntent} from "../../src/types.js";
const tag="v1.1.0-beta.90",sha="a".repeat(40);
const runId="11111111-2222-4333-8444-555555555555";
const operationId="11111111-2222-4333-8444-555555555556";
const run={runId,targetRelease:tag,sourceCommitSha:sha,status:"running",
  steps:[{stepId:"validate_oracle_candidate",action:"validate_oracle_candidate",
    executionClass:"read_only",operationId,status:"outcome_unknown"}],
} as unknown as ReleaseRunSnapshot;
const intent={runId,action:"validate_oracle_candidate",
  stepId:"validate_oracle_candidate",operationId,executionClass:"read_only",
} as unknown as StepIntent;
const receipt={releaseTag:tag,sourceCommitSha:sha,
  manifestSha256:"b".repeat(64),verifiedArtifactCount:5,runId,operationId};
describe("Oracle remote candidate ledger evidence",()=>{
  it("ties an independently verified candidate to the original step and run",async()=>{
    const inspect=jest.fn(async(_tag:string,_sha:string,_runId:string,_op:string)=>receipt);
    const cap=bindReleaseRemoteCandidate({port:{inspect},authorize:async()=>true});
    expect(await cap.execute(intent,run)).toMatchObject({state:"succeeded",
      evidence:[{kind:"oracle_candidate_manifest",
        source:"mcp_v3_verified_oracle",sha256:receipt.manifestSha256}]});
    expect(inspect).toHaveBeenCalledWith(tag,sha,runId,operationId);
    expect(await cap.reconcile(intent,run)).toMatchObject({outcome:"applied"});
    expect(inspect).toHaveBeenCalledTimes(2);
  });
  it("fails closed on wrong operation, revocation and forged receipt",async()=>{
    let allowed=false;
    const inspect=jest.fn(async()=>receipt);
    const cap=bindReleaseRemoteCandidate({
      port:{inspect},authorize:async()=>allowed,
    });
    expect((await cap.execute(intent,run)).state).toBe("outcome_unknown");
    expect(inspect).not.toHaveBeenCalled();
    allowed=true;
    const forged=bindReleaseRemoteCandidate({
      port:{inspect:async()=>({...receipt,runId:operationId})},
      authorize:async()=>true,
    });
    expect((await forged.execute(intent,run)).state).toBe("outcome_unknown");
    expect((await cap.execute({...intent,operationId:runId},run)).state)
      .toBe("outcome_unknown");
  });
});
