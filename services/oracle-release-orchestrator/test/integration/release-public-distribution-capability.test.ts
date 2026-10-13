import { mkdtempSync,mkdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach,beforeEach,describe,expect,it } from "@jest/globals";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";
import { ReleaseWorkflowExecutor } from "../../src/release-workflow-executor.js";
import { bindReleaseTagBootstrap } from "../../src/release-tag-bootstrap-capability.js";
import { bindReleasePublicDistribution, type PublicDistributionProof,
  type PublicWorkflowRequest } from "../../src/release-public-distribution-capability.js";
import { bindReleaseSourceControlReads } from "../../src/release-source-control-read-capabilities.js";
import { composeReleaseCapabilities } from "../../src/release-capability-registry.js";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";
import type { ReleaseAction, ReleaseRunSnapshot } from "../../src/types.js";
import type { ReleaseStepCapability } from "../../src/release-workflow-executor.js";

const sha="a".repeat(40),tag="v1.1.0-beta.90",actor="test:oracle-signed";
describe("Oracle ledger public signing linked to original bootstrap operation",()=>{
  let dir:string;
  let orchestrator:ReleaseOrchestrator;
  beforeEach(()=>{
    dir=mkdtempSync(path.join(tmpdir(),"oracle-signed-"));
    mkdirSync(path.join(dir,"release"));
    orchestrator=new ReleaseOrchestrator(SqliteReleaseLedger.open({
      databasePath:path.join(dir,"ledger.sqlite"),releaseRoot:path.join(dir,"release"),
    }));
  });
  afterEach(()=>{orchestrator.close();rmSync(dir,{recursive:true,force:true});});
  function setup(){
    const run=orchestrator.createRun({blueprintId:beta80ReleaseBlueprint.id,
      blueprintVersion:beta80ReleaseBlueprint.version,targetRelease:tag,
      sourceCommitSha:sha,actorId:actor,idempotencyKey:"test-signed-public"}).run;
    const operations:PublicWorkflowRequest[]=[];
    let dispatches=0,integrityVerified=true,releasePublished=true;
    const dist={
      workspaceId:"mcp-access-stack",owner:"iFael",repository:"mcp-access-stack",
      authorized:async()=>true,
      port:{
        workflowOperation:async(input:PublicWorkflowRequest)=>{
          operations.push(input);
          if(input.mode==="dispatch"){
            dispatches++;
            return {status:"submitted" as const,operationId:input.operationId};
          }
          return {status:"observed" as const,operationId:input.operationId,
            runId:777,state:"completed" as const,conclusion:"success"};
        },
        inspectDistribution:async(runId:number):Promise<PublicDistributionProof>=>({
          workflowRunId:runId,sourceCommitSha:sha,releaseTag:tag,
          integrityVerified,releasePublished,
          manifestSha256:"b".repeat(64),assetDigestSha256:"c".repeat(64),
        }),
      },
    };
    const bootstrap=bindReleaseTagBootstrap({
      workspaceId:"mcp-access-stack",owner:"iFael",repository:"mcp-access-stack",
      authorized:async()=>true,
      port:{workflowOperation:async input=>input.mode==="dispatch"
        ? {status:"submitted" as const,operationId:input.operationId}
        : {status:"observed" as const,operationId:input.operationId,runId:776,
          state:"completed" as const,conclusion:"success"},
        verifyLightweightTag:async()=>true},
    });
    const reads=bindReleaseSourceControlReads({authorizeRead:async()=>true,port:{
      readMainHead:async()=>sha,
      readCommitChecks:async()=>({commitSha:sha,totalCount:1,returnedCount:1,
        pendingCount:0,successfulCount:1,failingCount:0,allCompleted:true,
        truncated:false,passed:true,
        checks:[{id:1,name:"CI",status:"completed",conclusion:"success"}]}),
    }});
    const capabilities=new Map<ReleaseAction,ReleaseStepCapability>(reads);
    capabilities.set("publish_release_tag",bootstrap);
    for(const [action,capability] of bindReleasePublicDistribution(dist)){
      capabilities.set(action,capability);
    }
    const executor=new ReleaseWorkflowExecutor(orchestrator,capabilities);
    return {run,executor,operations,dispatches:()=>dispatches,
      setIntegrity:(value:boolean)=>{integrityVerified=value;},
      setPublished:(value:boolean)=>{releasePublished=value;},dist};
  }
  it("uses two independent UUIDs and never POSTs twice for signature and publication",async()=>{
    const f=setup();
    expect((await f.executor.advance(f.run.runId,actor)).stop).toBe("outcome_unknown");
    const result=await f.executor.advance(f.run.runId,actor);
    expect(result.stop).toBe("outcome_unknown");
    const bootstrapId=result.run.steps[2]!.operationId;
    const signingId=result.run.steps[3]!.operationId;
    expect(bootstrapId).not.toBe(signingId);
    expect(f.dispatches()).toBe(1);
    expect(f.operations[0]).toMatchObject({mode:"dispatch",operationId:signingId,
      bootstrapOperationId:bootstrapId,workflow:"release.yml"});
    const next=await f.executor.advance(f.run.runId,actor);
    expect(next.stop).toBe("outcome_unknown");
    expect(next.run.steps[3]?.status).toBe("succeeded");
    expect(next.run.steps[4]?.status).toBe("outcome_unknown");
    const done=await f.executor.advance(f.run.runId,actor);
    expect(done.stop).toBe("blocked_missing_capability");
    expect(done.run.steps[4]?.status).toBe("succeeded");
    expect(f.dispatches()).toBe(1);
    expect(f.operations.every(op=>op.bootstrapOperationId===bootstrapId &&
      op.operationId===signingId)).toBe(true);
  });
  it("holds the same operation when signature or publication is not independently verified",async()=>{
    const f=setup();
    await f.executor.advance(f.run.runId,actor);
    await f.executor.advance(f.run.runId,actor);
    f.setIntegrity(false);
    const waiting=await f.executor.advance(f.run.runId,actor);
    expect(waiting.stop).toBe("outcome_unknown");
    expect(waiting.run.steps[3]?.status).toBe("outcome_unknown");
    expect(f.dispatches()).toBe(1);
    f.setIntegrity(true);f.setPublished(false);
    await f.executor.advance(f.run.runId,actor);
    const unpublished=await f.executor.advance(f.run.runId,actor);
    expect(unpublished.run.steps[4]?.status).toBe("outcome_unknown");
    expect(f.dispatches()).toBe(1);
    f.setPublished(true);
    expect((await f.executor.advance(f.run.runId,actor)).run.steps[4]?.status).toBe("succeeded");
  });
  it("refuses duplicate signing implementations in one canonical registry",()=>{
    const f=setup();
    const registry=composeReleaseCapabilities({publicDistribution:f.dist});
    expect(registry.capabilities.has("build_and_sign_release")).toBe(true);
    expect(registry.capabilities.has("publish_signed_release")).toBe(true);
    expect(registry.ready).toBe(false);
    const remaining=composeReleaseCapabilities({publicDistribution:f.dist,effects:{
      actions:["deploy_edge","prepare_oracle","prepare_windows","promote_oracle","promote_windows"],
      authorize:async()=>true,port:{start:async()=>{},
        inspect:async input=>({...input,status:"pending" as const,evidence:[]})},
    }});
    expect(remaining.capabilities.size).toBe(7);
    expect(remaining.missingActions).not.toContain("build_and_sign_release");
    expect(remaining.missingActions).not.toContain("publish_signed_release");
    expect(remaining.missingActions).not.toContain("promote_windows");
    expect(()=>composeReleaseCapabilities({publicDistribution:f.dist,effects:{
      authorize:async()=>true,port:{start:async()=>{},
        inspect:async input=>({...input,status:"pending" as const,evidence:[]})},
    }})).toThrow("RELEASE_CAPABILITY_DUPLICATE");
  });
});
