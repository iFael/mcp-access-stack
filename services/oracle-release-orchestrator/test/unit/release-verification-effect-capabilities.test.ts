import { describe,expect,it } from "@jest/globals";
import { bindReleaseVerificationReads, type VerificationAction } from "../../src/release-verification-capabilities.js";
import { bindReleaseEffects, type EffectAction, type ReleaseEffectRequest } from "../../src/release-effect-capabilities.js";
import { composeReleaseCapabilities } from "../../src/release-capability-registry.js";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";
import type { ReleaseRunSnapshot, StepIntent, EvidenceInput } from "../../src/types.js";

const tag="v1.1.0-beta.90",sha="a".repeat(40),operationId="11111111-2222-4333-8444-555555555555";
const required:Record<VerificationAction,string[]>={
  verify_release_assets:["canonical_ci_run","signed_manifest","release_asset_digest"],
  verify_edge_health:["edge_health_report"],
  validate_oracle_candidate:["oracle_candidate_manifest"],
  validate_windows_candidate:["windows_candidate_manifest"],
  verify_oracle_health:["oracle_active_manifest","oracle_health_report"],
  verify_windows_health:["windows_active_manifest","windows_health_report"],
  reconcile_final_pointers:["pointer_consistency_report"],
  smoke_catalog:["catalog_smoke_report"],
};
const effects:Record<EffectAction,string>={
  build_and_sign_release:"signed_build_receipt",
  publish_signed_release:"release_publication_receipt",
  deploy_edge:"edge_deployment_receipt",
  prepare_oracle:"oracle_prepare_receipt",
  prepare_windows:"windows_prepare_receipt",
  promote_oracle:"oracle_cutover_receipt",
  promote_windows:"windows_cutover_receipt",
};
function evidence(kind:string):EvidenceInput {
  return {kind,source:"mcp_v3_verified_oracle",sha256:"b".repeat(64),
    observedAt:"2026-10-12T16:00:00.000Z"};
}
function runFor(action:VerificationAction|EffectAction):{run:ReleaseRunSnapshot;intent:StepIntent} {
  const definition=beta80ReleaseBlueprint.steps.find(step=>step.action===action)!;
  const intent:StepIntent={kind:"intent",runId:operationId,stepId:definition.id,
    action,operationId,idempotencyKey:"test-receipt",attemptNumber:1,
    executionClass:definition.executionClass};
  const run={
    runId:operationId,status:"running" as const,sourceCommitSha:sha,targetRelease:tag,
    steps:[{stepId:definition.id,action,operationId,status:"outcome_unknown" as const,
      stage:definition.stage,executionClass:definition.executionClass,attemptCount:1,
      idempotencyKey:"test-receipt"}],
    gates:[],
    blueprintId:beta80ReleaseBlueprint.id,blueprintVersion:1,
    blueprintSha256:"c".repeat(64),createdAt:"2026-10-12T16:00:00.000Z",
    updatedAt:"2026-10-12T16:00:00.000Z",lastSeq:1,
  } satisfies ReleaseRunSnapshot;
  return {run,intent};
}
describe("read-only authenticated release witness bindings",()=>{
  it("registers exactly eight existing read-only actions, with all required health evidence",async()=>{
    const bindings=bindReleaseVerificationReads({
      authorize:async()=>true,
      port:{inspect:async(action,run)=>({action,sourceCommitSha:run.sourceCommitSha,
        releaseTag:run.targetRelease,status:"verified",
        evidence:required[action]!.map(evidence)})},
    });
    expect(bindings.size).toBe(8);
    for(const [action,capability] of bindings){
      expect(capability.executionClass).toBe("read_only");
      const {run,intent}=runFor(action);
      expect(await capability.execute(intent,run)).toMatchObject({
        state:"succeeded",evidence:required[action]!.map(e=>({kind:e})),
      });
      expect(await capability.reconcile(intent,run)).toMatchObject({outcome:"applied"});
    }
  });
  it("supports explicit typed verifier subset, preventing duplicate asset verification",()=>{
    const binding={authorize:async()=>true,port:{
      inspect:async(action:VerificationAction,run:ReleaseRunSnapshot)=>({
        action,sourceCommitSha:run.sourceCommitSha,
        releaseTag:run.targetRelease,status:"verified" as const,
        evidence:required[action].map(evidence),
      }),
    }};
    const remaining=Object.keys(required).filter(action=>
      action!=="verify_release_assets") as VerificationAction[];
    expect(bindReleaseVerificationReads({...binding,actions:remaining}).size).toBe(7);
    expect(()=>bindReleaseVerificationReads({...binding,actions:[]})).toThrow("ACTION_SET_INVALID");
    expect(()=>bindReleaseVerificationReads({...binding,
      actions:["verify_edge_health","verify_edge_health"]})).toThrow("ACTION_SET_INVALID");
    expect(()=>bindReleaseVerificationReads({...binding,
      actions:["arbitrary_shell" as never]})).toThrow("ACTION_SET_INVALID");
  });
  it("rejects stale SHA, missing signature, invalid digest and disabled host authorization",async()=>{
    let enabled=true,shaValue=sha,missing=false,source="mcp_v3_verified_oracle";
    const binding=bindReleaseVerificationReads({authorize:async()=>enabled,
      port:{inspect:async(action)=>({action,sourceCommitSha:shaValue,
        releaseTag:tag,status:"verified",evidence:missing
          ? [] : [{...evidence(required[action]![0]!),source}]})},
    }).get("verify_edge_health")!;
    const {run,intent}=runFor("verify_edge_health");
    expect((await binding.execute(intent,run)).state).toBe("succeeded");
    shaValue="c".repeat(40);
    expect((await binding.execute(intent,run)).state).toBe("outcome_unknown");
    shaValue=sha;missing=true;
    expect((await binding.reconcile(intent,run)).outcome).toBe("still_unknown");
    missing=false;source="untrusted_external";
    expect((await binding.execute(intent,run)).state).toBe("outcome_unknown");
    enabled=false;source="mcp_v3_verified_oracle";
    expect((await binding.execute(intent,run)).state).toBe("outcome_unknown");
  });
});

describe("typed release side effects never infer completion from dispatch",()=>{
  it("all seven actions submit exactly once per durable intent and require terminal correlated receipts",async()=>{
    const started:EffectAction[]=[];
    let terminal=false,corrupt=false;
    const bindings=bindReleaseEffects({authorize:async()=>true,port:{
      start:async input=>{started.push(input.action);},
      inspect:async input=>({...input,status:terminal?"completed":"pending",
        evidence:[{...evidence(effects[input.action]),...(corrupt?{sha256:"invalid"}:{})}]})},
    });
    expect(bindings.size).toBe(7);
    for(const [action,binding] of bindings){
      expect(binding.executionClass).toBe("external_effect");
      const {run,intent}=runFor(action);
      expect((await binding.execute(intent,run)).state).toBe("outcome_unknown");
      expect((await binding.reconcile(intent,run)).outcome).toBe("still_unknown");
      terminal=true;
      expect((await binding.reconcile(intent,run)).outcome).toBe("applied");
      corrupt=true;
      expect((await binding.reconcile(intent,run)).outcome).toBe("still_unknown");
      terminal=false;corrupt=false;
    }
    expect(started).toEqual(Object.keys(effects));
  });
  it("never starts an effect when host gate is denied or the original operation identity mismatches",async()=>{
    let count=0;
    const binding=bindReleaseEffects({
      authorize:async()=>false,
      port:{start:async()=>{count++;},inspect:async input=>({
        ...input,status:"completed",evidence:[evidence(effects[input.action])],
      })},
    }).get("promote_windows")!;
    const {run,intent}=runFor("promote_windows");
    expect((await binding.execute(intent,run)).state).toBe("outcome_unknown");
    expect(count).toBe(0);
    expect((await binding.reconcile({...intent,operationId:"different"},run)).outcome)
      .toBe("still_unknown");
  });
  it("rejects unknown, duplicate or empty effect subsets without inventing actions",()=>{
    const binding={authorize:async()=>true,port:{
      start:async()=>{},inspect:async (input:ReleaseEffectRequest)=>({...input,status:"pending" as const,evidence:[]}),
    }};
    expect(()=>bindReleaseEffects({...binding,actions:[]})).toThrow("RELEASE_EFFECT_ACTION_SET_INVALID");
    expect(()=>bindReleaseEffects({...binding,
      actions:["deploy_edge","deploy_edge"]})).toThrow("RELEASE_EFFECT_ACTION_SET_INVALID");
    expect(()=>bindReleaseEffects({...binding,
      actions:["execute_arbitrary_shell" as never]})).toThrow("RELEASE_EFFECT_ACTION_SET_INVALID");
  });

  it("covers 19 blueprint actions only with explicit trusted ports, never invents the 20th",()=>{
    const registry=composeReleaseCapabilities({
      effects:{authorize:async()=>false,port:{
        start:async()=>{},inspect:async input=>({...input,status:"pending",evidence:[]}),
      }},
      verifications:{authorize:async()=>false,port:{
        inspect:async(action,run)=>({action,sourceCommitSha:run.sourceCommitSha,
          releaseTag:run.targetRelease,status:"pending",evidence:[]}),
      }},
    });
    expect(registry.capabilities.size).toBe(15);
    expect(registry.missingActions).toEqual([
      "resolve_main_commit","verify_canonical_ci","publish_release_tag",
      "cleanup_known_temporary_residue",
    ]);
    expect(registry.ready).toBe(false);
  });
});
