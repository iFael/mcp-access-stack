import { mkdtempSync,mkdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach,beforeEach,describe,expect,it } from "@jest/globals";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";
import { bindReleaseSourceControlReads } from "../../src/release-source-control-read-capabilities.js";
import { bindReleaseTagBootstrap, type ReleaseTagBootstrapBinding } from "../../src/release-tag-bootstrap-capability.js";
import { ReleaseWorkflowExecutor } from "../../src/release-workflow-executor.js";
import { composeReleaseCapabilities } from "../../src/release-capability-registry.js";
import type { ReleaseAction } from "../../src/types.js";
import type { ReleaseStepCapability } from "../../src/release-workflow-executor.js";

const sha="a".repeat(40),actor="test:tag-bootstrap",tag="v1.1.0-beta.90";
describe("Oracle single-ledger bootstrap via existing typed MCP workflow operation",()=>{
  let dir:string;
  let service:ReleaseOrchestrator|undefined;
  beforeEach(()=>{dir=mkdtempSync(path.join(tmpdir(),"release-tag-"));mkdirSync(path.join(dir,"release"));});
  afterEach(()=>{service?.close();service=undefined;rmSync(dir,{recursive:true,force:true});});
  function setup(){
    service=new ReleaseOrchestrator(SqliteReleaseLedger.open({
      databasePath:path.join(dir,"state","ledger.sqlite"),
      releaseRoot:path.join(dir,"release"),
    }));
    const run=service.createRun({blueprintId:beta80ReleaseBlueprint.id,
      blueprintVersion:beta80ReleaseBlueprint.version,targetRelease:tag,
      sourceCommitSha:sha,actorId:actor,idempotencyKey:"release-tag-test"}).run;
    let dispatches=0;
    let terminal=false;
    let verifiedTag=false;
    let authorize=true;
    let wrongOperation=false;
    const operations:string[]=[];
    const binding:ReleaseTagBootstrapBinding={
      workspaceId:"mcp-access-stack",owner:"iFael",repository:"mcp-access-stack",
      authorized:async()=>authorize,
      port:{
        workflowOperation:async input=>{
          expect(input.workspaceId).toBe("mcp-access-stack");
          expect(input.workflow).toBe("release-tag-bootstrap.yml");
          expect(input.tag).toBe(tag);
          expect(input.expectedMainSha).toBe(sha);
          operations.push(input.operationId);
          if(input.mode==="dispatch"){
            dispatches++;
            return {status:"submitted" as const,operationId:input.operationId};
          }
          if(!terminal)return {status:"outcome_unknown" as const,operationId:input.operationId};
          return {status:"observed" as const,
            operationId:wrongOperation?"11111111-2222-4333-8444-555555555555":input.operationId,
            runId:382031,
            state:"completed" as const,conclusion:"success"};
        },
        verifyLightweightTag:async(tagRef,commit)=>{
          expect(tagRef).toBe(tag);expect(commit).toBe(sha);
          return verifiedTag;
        },
      },
    };
    const reads=bindReleaseSourceControlReads({
      authorizeRead:async()=>true,
      port:{
        readMainHead:async()=>sha,
        readCommitChecks:async()=>({
          commitSha:sha,totalCount:1,returnedCount:1,pendingCount:0,
          successfulCount:1,failingCount:0,allCompleted:true,truncated:false,
          passed:true,checks:[{id:1,name:"main-ci",status:"completed",conclusion:"success"}],
        }),
      },
    });
    const caps=new Map<ReleaseAction,ReleaseStepCapability>(reads);
    caps.set("publish_release_tag",bindReleaseTagBootstrap(binding));
    const executor=new ReleaseWorkflowExecutor(service,caps);
    return {run,executor,binding,dispatches:()=>dispatches,operations,
      setTerminal:(v:boolean)=>{terminal=v;},
      setVerifiedTag:(v:boolean)=>{verifiedTag=v;},
      setAuthorized:(v:boolean)=>{authorize=v;},
      setWrongOperation:(v:boolean)=>{wrongOperation=v;}};
  }

  it("dispatches once, pauses the SAME release operation, and reconciles terminal tag evidence",async()=>{
    const f=setup();
    const first=await f.executor.advance(f.run.runId,actor);
    expect(first.stop).toBe("outcome_unknown");
    expect(first.executed).toBe(3);
    expect(f.dispatches()).toBe(1);
    const original=first.run.steps[2]?.operationId;
    expect(original).toMatch(/^[0-9a-f-]{36}$/);
    expect((await f.executor.advance(f.run.runId,actor)).stop).toBe("outcome_unknown");
    expect(f.dispatches()).toBe(1);
    f.setTerminal(true);
    // Successful run is not enough: require independently verified tag ref.
    expect((await f.executor.advance(f.run.runId,actor)).stop).toBe("outcome_unknown");
    f.setVerifiedTag(true);
    const completed=await f.executor.advance(f.run.runId,actor);
    expect(completed.stop).toBe("blocked_missing_capability");
    expect(completed.reconciled).toBe(1);
    expect(completed.run.steps[2]?.status).toBe("succeeded");
    expect(completed.run.steps[2]?.operationId).toBe(original);
    expect(completed.run.steps[3]?.status).toBe("pending");
    expect(f.dispatches()).toBe(1);
    expect(new Set(f.operations).size).toBe(1);
  });

  it("does not start a bootstrap without trusted host authorization",async()=>{
    const f=setup();
    f.setAuthorized(false);
    const result=await f.executor.advance(f.run.runId,actor);
    expect(result.stop).toBe("blocked_unauthorized");
    expect(result.run.steps[2]?.operationId).toBeNull();
    expect(f.dispatches()).toBe(0);
  });

  it("rejects a receipt for the wrong operationId and never redispatches",async()=>{
    const f=setup();
    const first=await f.executor.advance(f.run.runId,actor);
    expect(first.stop).toBe("outcome_unknown");
    f.setTerminal(true);f.setVerifiedTag(true);f.setWrongOperation(true);
    const second=await f.executor.advance(f.run.runId,actor);
    expect(second.stop).toBe("outcome_unknown");
    expect(second.run.steps[2]?.status).toBe("outcome_unknown");
    expect(f.dispatches()).toBe(1);
  });

  it("registers existing typed bootstrap without another ledger; missing release actions remain NO-GO",async()=>{
    const f=setup();
    const registry=composeReleaseCapabilities({tagBootstrap:f.binding});
    expect(registry.capabilities.has("publish_release_tag")).toBe(true);
    expect(registry.missingActions).not.toContain("publish_release_tag");
    expect(registry.missingActions).toContain("build_and_sign_release");
    expect(registry.ready).toBe(false);
    expect(()=>registry.createExecutor(service!)).toThrow("RELEASE_CAPABILITY_INCOMPLETE");
  });
});
