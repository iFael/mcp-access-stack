import { describe, expect, it } from "@jest/globals";
import { bindReleasePruneCleanup, type TypedReleasePrunePort } from "../../src/release-prune-capability.js";
import type { ReleaseRunSnapshot, StepIntent } from "../../src/types.js";

const operationId="123e4567-e89b-42d3-a456-426614174111";
const sha="a".repeat(64), planSha="b".repeat(64);
const run={
  runId:"123e4567-e89b-42d3-a456-426614174100", blueprintId:"mcp-v3-public-release",
  blueprintVersion:1,blueprintSha256:sha,targetRelease:"v1.1.0-beta.90",
  sourceCommitSha:"f".repeat(40),status:"running" as const,
  createdAt:"2026-10-12T18:00:00Z",updatedAt:"2026-10-12T18:00:00Z",lastSeq:1,
  gates:[{gateId:"oracle_healthy",stage:"deployment" as const,status:"passed" as const,
    requiredEvidenceKinds:["oracle_health_report"],evidenceIds:["evidence-1"]}],
  steps:[
    {stepId:"verify_oracle_health",stage:"deployment" as const,action:"verify_oracle_health" as const,
      executionClass:"read_only" as const,status:"succeeded" as const,attemptCount:1,
      operationId:"123e4567-e89b-42d3-a456-426614174109",idempotencyKey:"prev"},
    {stepId:"cleanup_known_temporary_residue",stage:"homologation" as const,
      action:"cleanup_known_temporary_residue" as const,executionClass:"external_effect" as const,
      status:"pending" as const,attemptCount:0,operationId:null,idempotencyKey:null},
  ],
} satisfies ReleaseRunSnapshot;
const intent: StepIntent={
  kind:"intent",runId:run.runId,stepId:"cleanup_known_temporary_residue",
  action:"cleanup_known_temporary_residue",executionClass:"external_effect",
  operationId,idempotencyKey:"cleanup-1",attemptNumber:1,
};
const activeRun:ReleaseRunSnapshot={...run,steps:run.steps.map(step=>
  step.action==="cleanup_known_temporary_residue" ? {
    ...step,status:"outcome_unknown",attemptCount:1,operationId,idempotencyKey:"cleanup-1",
  } : step),
};
function setup() {
  const calls: Array<{operationId:string;dryRun:boolean;selection?:string;reconcile?:boolean}>=[];
  const remaining=Array.from({length:6},(_,i)=>"1.1.0-beta."+String(60+i));
  const receipts=new Map<string,Awaited<ReturnType<TypedReleasePrunePort["pruneReleases"]>>>();
  const prune: TypedReleasePrunePort={
    pruneReleases: async input => {
      calls.push(input);
      if(input.dryRun && !input.reconcile)afterPreview?.();
      if(input.reconcile){
        const result=receipts.get(input.operationId);
        if(!result) throw new Error("no durable receipt");
        return result;
      }
      const names=remaining.slice(0,5);
      const items=names.map(name=>({kind:"release" as const,name,
        status:input.dryRun?"eligible":"deleted"}));
      if(!input.dryRun) remaining.splice(0,names.length);
      const result={
        operationId:input.operationId,status:input.dryRun?"planned" as const:"completed" as const,
        stateSha256:sha,planSha256:planSha,items,
      };
      if(!input.dryRun) receipts.set(input.operationId,result);
      return result;
    },
  };
  let allowed=true;
  let afterPreview:(()=>void)|undefined;
  const binding=bindReleasePruneCleanup({
    workspaceId:"mcp-access-stack",prune,authorized:async()=>allowed,
  });
  return {binding,calls,dropFirstReceipt(){
    const first=receipts.keys().next().value;
    if(first) receipts.delete(first);
  },setAllowed(value:boolean){allowed=value;},
    afterPreview(callback:()=>void){afterPreview=callback;}};
}

describe("typed canonical prune capability for the Oracle release ledger",()=>{
  it("does not authorize cleanup until all prior health gates and explicit host approval pass",async()=>{
    const {binding,setAllowed}=setup();
    expect(await binding.authorize(run.steps[1]!,run)).toBe(true);
    setAllowed(false);
    expect(await binding.authorize(run.steps[1]!,run)).toBe(false);
    setAllowed(true);
    expect(await binding.authorize(run.steps[1]!,{...run,gates:run.gates.map(g=>({...g,status:"pending" as const}))})).toBe(false);
    expect(await binding.authorize(run.steps[1]!,{...run,steps:run.steps.map(s=>({...s,status:"pending" as const}))})).toBe(false);
  });

  it("drains six releases in three bounded batches, with durable deterministic IDs",async()=>{
    const {binding,calls}=setup();
    expect(await binding.reconcile(intent,activeRun)).toEqual({outcome:"still_unknown"});
    const observed=await binding.execute(intent,activeRun);
    expect(observed.state).toBe("succeeded");
    if(observed.state!=="succeeded") throw new Error("expected success");
    expect(observed.evidence[0]?.kind).toBe("cleanup_receipt");
    expect(calls).toHaveLength(7);
    const ids=new Set<string>();
    for(let i=0;i<3;i++){
      const preview=calls[1+2*i]!, execution=calls[2+2*i]!;
      expect(preview).toMatchObject({dryRun:true,selection:"eligible"});
      expect(execution).toMatchObject({dryRun:false,selection:"eligible",
        expectedStateSha256:sha,expectedPlanSha256:planSha});
      expect(preview.operationId).toBe(execution.operationId);
      ids.add(preview.operationId);
    }
    expect(ids.size).toBe(3);
    const recovered=await binding.reconcile(intent,{
      ...activeRun,status:"paused_outcome_unknown",
    });
    expect(recovered.outcome).toBe("applied");
    expect(calls).toHaveLength(10);
    expect(calls.slice(7).map(c=>c.operationId)).toEqual([...ids]);
    expect(calls.slice(7).every(c=>c.dryRun && c.reconcile)).toBe(true);
  });

  it("never infers completion when one batch receipt is missing",async()=>{
    const {binding,dropFirstReceipt}=setup();
    expect((await binding.execute(intent,activeRun)).state).toBe("succeeded");
    dropFirstReceipt();
    expect(await binding.reconcile(intent,activeRun)).toEqual({outcome:"still_unknown"});
  });

  it("rechecks host authorization after preview before the first destructive batch",async()=>{
    const {binding,calls,setAllowed,afterPreview}=setup();
    afterPreview(()=>setAllowed(false));
    const result=await binding.execute(intent,activeRun);
    expect(result.state).toBe("outcome_unknown");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({dryRun:true,selection:"eligible"});
  });

  it("refuses a mismatched or revoked original operation during reconciliation",async()=>{
    const {binding,calls,setAllowed}=setup();
    const invalid={...intent,operationId:"123e4567-e89b-42d3-a456-426614174112"};
    expect(await binding.execute(invalid,activeRun)).toMatchObject({state:"outcome_unknown"});
    expect(await binding.reconcile(invalid,activeRun)).toEqual({outcome:"still_unknown"});
    setAllowed(false);
    expect(await binding.reconcile(intent,activeRun)).toEqual({outcome:"still_unknown"});
    expect(calls).toHaveLength(0);
    setAllowed(true);
    expect(await binding.execute(intent,{...activeRun,gates:[]}))
      .toMatchObject({state:"outcome_unknown"});
    expect(calls).toHaveLength(0);
  });

  it("refuses unauthorized execution without any prune request",async()=>{
    const {binding,setAllowed,calls}=setup();
    setAllowed(false);
    const outcome=await binding.execute(intent,activeRun);
    expect(outcome.state).toBe("outcome_unknown");
    expect(calls).toHaveLength(0);
  });
});
