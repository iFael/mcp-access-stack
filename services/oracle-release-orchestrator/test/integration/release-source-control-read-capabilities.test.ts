import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { bindReleaseSourceControlReads } from "../../src/release-source-control-read-capabilities.js";
import { ReleaseWorkflowExecutor } from "../../src/release-workflow-executor.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";

const sha = "a".repeat(40), actor = "test:release-source";
const checks = () => ({
  commitSha: sha, totalCount: 2, returnedCount: 2, pendingCount: 0,
  successfulCount: 2, failingCount: 0, allCompleted: true,
  truncated: false, passed: true,
  checks: [
    {id: 101,name:"validate",status:"completed",conclusion:"success"},
    {id: 102,name:"platform-linux",status:"completed",conclusion:"success"},
  ],
});
describe("ReleaseWorkflowExecutor typed source control reads", () => {
  let root:string;
  let service:ReleaseOrchestrator;
  let originalChecks = checks();
  let main = sha;
  let authorized = true;
  let reads = 0;
  let checkReads = 0;
  let driftOnSecondMainRead = false;

  beforeEach(()=>{
    root=mkdtempSync(path.join(tmpdir(),"release-source-"));
    const releaseRoot=path.join(root,"release");
    mkdirSync(releaseRoot);
    service=new ReleaseOrchestrator(SqliteReleaseLedger.open({
      databasePath:path.join(root,"state","ledger.sqlite"),releaseRoot,
    }));
    originalChecks=checks();main=sha;authorized=true;reads=0;checkReads=0;
    driftOnSecondMainRead=false;
  });
  afterEach(()=>{service.close();rmSync(root,{recursive:true,force:true});});

  function setup() {
    const run=service.createRun({
      blueprintId:beta80ReleaseBlueprint.id,
      blueprintVersion:beta80ReleaseBlueprint.version,
      targetRelease:"v1.1.0-beta.90",sourceCommitSha:sha,
      actorId:actor,idempotencyKey:"exact-main-source-check",
    }).run;
    const caps=bindReleaseSourceControlReads({
      authorizeRead:async()=>authorized,
      port:{
        readMainHead:async()=> {
          reads++;
          if(driftOnSecondMainRead && reads > 2) main="b".repeat(40);
          return main;
        },
        readCommitChecks:async commitSha=>{
          checkReads++;
          expect(commitSha).toBe(sha);
          return originalChecks;
        },
      },
    });
    return {run,executor:new ReleaseWorkflowExecutor(service,caps)};
  }

  it("executes only typed main and CI reads, with stable exact SHA, then blocks on missing publish capability",async()=>{
    const {run,executor}=setup();
    const observed=await executor.advance(run.runId,actor);
    expect(observed.stop).toBe("blocked_missing_capability");
    expect(observed.executed).toBe(2);
    expect(observed.run.steps[0]?.status).toBe("succeeded");
    expect(observed.run.steps[1]?.status).toBe("succeeded");
    expect(observed.run.steps[2]?.status).toBe("pending");
    expect(checkReads).toBe(1);
    expect((await executor.advance(run.runId,actor)).executed).toBe(0);
  });

  it("does not persist an intent without host authorization",async()=>{
    const {run,executor}=setup();
    authorized=false;
    const result=await executor.advance(run.runId,actor);
    expect(result.stop).toBe("blocked_unauthorized");
    expect(result.executed).toBe(0);
    expect(reads).toBe(0);
    expect(result.run.steps[0]?.operationId).toBeNull();
  });

  it("fails closed when the GitHub main ref differs from the run's immutable source SHA",async()=>{
    const {run,executor}=setup();
    main="b".repeat(40);
    const result=await executor.advance(run.runId,actor);
    expect(result.stop).toBe("failed");
    expect(result.executed).toBe(1);
    expect(checkReads).toBe(0);
  });

  it("never approves incomplete, truncated, missing or mismatched CI",async()=>{
    for(const overrides of [
      {totalCount:0,returnedCount:0,checks:[],successfulCount:0,allCompleted:false,passed:false},
      {truncated:true},
      {commitSha:"b".repeat(40)},
      {failingCount:1,successfulCount:1,passed:false},
      {checks:[{id:101,name:"validate",status:"completed",conclusion:"success"},
        {id:101,name:"duplicate",status:"completed",conclusion:"success"}]},
    ]) {
      originalChecks={...checks(),...overrides};
      const {run,executor}=setup();
      const result=await executor.advance(run.runId,actor);
      const transient = ("totalCount" in overrides && overrides.totalCount === 0) ||
        ("truncated" in overrides && overrides.truncated === true);
      expect(result.stop).toBe(transient ? "outcome_unknown" : "failed");
      expect(result.run.steps[1]?.status).toBe(transient ? "outcome_unknown" : "failed");
      if (transient) {
        const operationId=result.run.steps[1]?.operationId;
        originalChecks=checks(); // the SAME CI/SHA subsequently becomes terminal
        const settled=await executor.advance(run.runId,actor);
        expect(settled.stop).toBe("blocked_missing_capability");
        expect(settled.reconciled).toBe(1);
        expect(settled.run.steps[1]?.operationId).toBe(operationId);
        expect(settled.run.steps[1]?.status).toBe("succeeded");
      }
      // Recreate the isolated durable ledger for the next input.
      service.close();
      rmSync(path.join(root,"state"),{recursive:true,force:true});
      service=new ReleaseOrchestrator(SqliteReleaseLedger.open({
        databasePath:path.join(root,"state","ledger.sqlite"),
        releaseRoot:path.join(root,"release"),
      }));
    }
  });

  it("reconciles an uncertain exact-main observation using the original operation only",async()=>{
    const {run,executor}=setup();
    service.startRun(run.runId,actor);
    const intent=service.beginStepAttempt(run.runId,"resolve_main_commit","resume-once",actor);
    expect(intent.kind).toBe("intent");
    expect(service.recoverInterruptedOperations(actor)).toBe(1);
    const result=await executor.advance(run.runId,actor);
    expect(result.reconciled).toBe(1);
    expect(result.run.steps[0]?.operationId).toBe(intent.operationId);
    expect(result.run.steps[0]?.status).toBe("succeeded");
    expect(result.executed).toBe(1); // only next CI read
    expect(checkReads).toBe(1);
  });
});
