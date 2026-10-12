import { mkdtempSync,mkdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe,it,expect } from "@jest/globals";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";
import { composeReleaseCapabilities } from "../../src/release-capability-registry.js";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";
import type { VerificationAction } from "../../src/release-verification-capabilities.js";
import type { EffectAction } from "../../src/release-effect-capabilities.js";
import type { EvidenceInput, ReleaseRunSnapshot } from "../../src/types.js";

const sha="a".repeat(40),tag="v1.1.0-beta.90";
const kinds: Record<VerificationAction, string[]> = {
  verify_release_assets:["canonical_ci_run","signed_manifest","release_asset_digest"],
  verify_edge_health:["edge_health_report"],
  validate_oracle_candidate:["oracle_candidate_manifest"],
  validate_windows_candidate:["windows_candidate_manifest"],
  verify_oracle_health:["oracle_active_manifest","oracle_health_report"],
  verify_windows_health:["windows_active_manifest","windows_health_report"],
  reconcile_final_pointers:["pointer_consistency_report"],
  smoke_catalog:["catalog_smoke_report"],
};
const effectKinds:Record<EffectAction,string>={
  build_and_sign_release:"signed_build_receipt",publish_signed_release:"release_publication_receipt",
  deploy_edge:"edge_deployment_receipt",prepare_oracle:"oracle_prepare_receipt",
  prepare_windows:"windows_prepare_receipt",promote_oracle:"oracle_cutover_receipt",
  promote_windows:"windows_cutover_receipt",
};
const evidence=(kind:string):EvidenceInput=>({
  kind,sha256:"b".repeat(64),source:"mcp_v3_verified_oracle",
  observedAt:"2026-10-12T17:00:00.000Z",
});

describe("hermetic full release registry and Oracle ledger",()=>{
  it("can only finish 19 ordered steps when each trusted receipt and health gate is present",async()=>{
    const root=mkdtempSync(path.join(tmpdir(),"oracle-release-all-actions-"));
    mkdirSync(path.join(root,"release"));
    const orchestrator=new ReleaseOrchestrator(SqliteReleaseLedger.open({
      databasePath:path.join(root,"ledger.sqlite"),releaseRoot:path.join(root,"release"),
    }));
    try {
      const started:EffectAction[]=[];
      let cleanup=0, tagDispatches=0;
      const registry=composeReleaseCapabilities({
        sourceControl:{authorizeRead:async()=>true,port:{
          readMainHead:async()=>sha,
          readCommitChecks:async()=>({commitSha:sha,totalCount:1,returnedCount:1,
            pendingCount:0,successfulCount:1,failingCount:0,allCompleted:true,
            truncated:false,passed:true,
            checks:[{id:1,name:"CI",status:"completed",conclusion:"success"}]}),
        }},
        tagBootstrap:{workspaceId:"mcp-access-stack",owner:"iFael",repository:"mcp-access-stack",
          authorized:async()=>true,port:{
            workflowOperation:async(input)=>{
              if(input.mode==="dispatch"){tagDispatches++;return {status:"submitted",operationId:input.operationId};}
              return {status:"observed",operationId:input.operationId,runId:22222,
                state:"completed",conclusion:"success"};
            },
            verifyLightweightTag:async()=>true,
          }},
        verifications:{authorize:async()=>true,port:{
          inspect:async(action,run)=>({action,sourceCommitSha:run.sourceCommitSha,
            releaseTag:run.targetRelease,status:"verified",
            evidence:kinds[action].map(evidence)}),
        }},
        effects:{authorize:async()=>true,port:{
          start:async(input)=>{started.push(input.action);},
          inspect:async(input)=>({...input,status:"completed",evidence:[evidence(effectKinds[input.action])]}),
        }},
        cleanup:{workspaceId:"mcp-access-stack",authorized:async()=>true,prune:{
          pruneReleases:async(input)=>{
            cleanup++;
            return {status:(input.dryRun && !input.reconcile?"planned":"completed") as "planned"|"completed",
              operationId:input.operationId,stateSha256:"b".repeat(64),planSha256:"c".repeat(64),items:[]};
          },
        }},
      });
      expect(registry.ready).toBe(true);
      expect(registry.missingActions).toEqual([]);
      expect(registry.capabilities.size).toBe(beta80ReleaseBlueprint.steps.length);
      const run=orchestrator.createRun({blueprintId:beta80ReleaseBlueprint.id,
        blueprintVersion:1,targetRelease:tag,sourceCommitSha:sha,
        actorId:"test:oracle",idempotencyKey:"test-full-run"}).run;
      const executor=registry.createExecutor(orchestrator);
      let latest:ReleaseRunSnapshot=run;
      for(let i=0;i<40;i++){
        const result=await executor.advance(run.runId,"test:oracle");
        latest=result.run;
        if(result.stop==="succeeded")break;
        expect(["outcome_unknown","blocked_gate","step_limit"]).toContain(result.stop);
      }
      expect(latest.status).toBe("succeeded");
      expect(latest.steps).toHaveLength(19);
      expect(latest.steps.every(s=>s.status==="succeeded")).toBe(true);
      expect(latest.gates.every(g=>g.status==="passed")).toBe(true);
      expect(tagDispatches).toBe(1);
      expect(started).toEqual(Object.keys(effectKinds));
      expect(cleanup).toBe(2); // preview and empty terminal CAS receipt
    } finally {
      orchestrator.close();
      rmSync(root,{recursive:true,force:true});
    }
  });
});
