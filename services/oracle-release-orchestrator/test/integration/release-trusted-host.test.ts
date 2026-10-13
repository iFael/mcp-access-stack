import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { ReleaseOrchestrator } from "../../src/engine/release-orchestrator.js";
import { SqliteReleaseLedger } from "../../src/storage/sqlite-release-ledger.js";
import { createOracleReleaseReadApi } from "../../src/read-api.js";
import { composeReleaseCapabilities } from "../../src/release-capability-registry.js";
import { createTrustedOracleReleaseHost, type TrustedReleasePrincipal } from "../../src/release-trusted-host.js";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";

const SHA = "a".repeat(40);
const READ_TOKEN = "read-only-credential-not-for-mutation".padEnd(48,"x");
const principal:TrustedReleasePrincipal={
  workspaceId:"mcp-access-stack",authenticatedActorId:"mcp:v3-operator",
  ownerScope:"trusted:release-operator",
};

describe("trusted Oracle one-writer in-process boundary",()=>{
  let directory:string;
  let orchestrator:ReleaseOrchestrator;
  beforeEach(()=>{
    directory=mkdtempSync(path.join(tmpdir(),"oracle-trusted-host-"));
    mkdirSync(path.join(directory,"releases"));
    orchestrator=new ReleaseOrchestrator(SqliteReleaseLedger.open({
      databasePath:path.join(directory,"ledger.sqlite"),
      releaseRoot:path.join(directory,"releases"),
    }));
  });
  afterEach(()=>{
    orchestrator.close();
    rmSync(directory,{recursive:true,force:true});
  });
  function planned(){
    return orchestrator.createRun({
      blueprintId:beta80ReleaseBlueprint.id,blueprintVersion:beta80ReleaseBlueprint.version,
      targetRelease:"v1.1.0-beta.90",sourceCommitSha:SHA,
      actorId:"test:setup",idempotencyKey:"test-trusted-host",
    }).run;
  }
  const fullRegistry=()=>composeReleaseCapabilities({other:beta80ReleaseBlueprint.steps.map(s=>({
    action:s.action,executionClass:s.executionClass,
    authorize:async()=>true,
    execute:async()=>({state:"outcome_unknown" as const}),
    reconcile:async()=>({outcome:"still_unknown" as const}),
  }))});
  const request=(run:ReturnType<typeof planned>)=>({
    runId:run.runId,expectedSourceSha:run.sourceCommitSha,
    expectedLastSeq:run.lastSeq,
  });

  it("rejects absent complete capabilities before any state mutation",async()=>{
    const run=planned();
    const host=createTrustedOracleReleaseHost(orchestrator,{
      workspaceId:"mcp-access-stack",
      capabilities:composeReleaseCapabilities({}),
      authorize:async()=>true,
    });
    await expect(host.advance(request(run),principal)).rejects.toThrow("RELEASE_CAPABILITY_INCOMPLETE");
    expect(orchestrator.getRun(run.runId)).toMatchObject({status:"planned",lastSeq:run.lastSeq});
  });

  it("rejects invalid identity and independent host-policy denial without touching the run",async()=>{
    const run=planned();
    let policies=0;
    const host=createTrustedOracleReleaseHost(orchestrator,{
      workspaceId:"mcp-access-stack",capabilities:fullRegistry(),
      authorize:async()=>{policies++;return false;},
    });
    await expect(host.advance(request(run),{...principal,workspaceId:"other"}))
      .rejects.toThrow("ORACLE_TRUSTED_HOST_ARGUMENT_INVALID");
    await expect(host.advance({...request(run),expectedSourceSha:"b".repeat(40)},principal))
      .rejects.toThrow("ORACLE_TRUSTED_HOST_EXPECTED_STATE_MISMATCH");
    await expect(host.advance(request(run),principal)).rejects.toThrow("ORACLE_TRUSTED_HOST_PERMISSION_DENIED");
    expect(policies).toBe(1);
    expect(orchestrator.getRun(run.runId)).toMatchObject({status:"planned",lastSeq:run.lastSeq});
  });

  it("advances the SAME ledger under policy, enforces expected sequence and leaves GET-only API immutable",async()=>{
    const run=planned();
    const host=createTrustedOracleReleaseHost(orchestrator,{
      workspaceId:"mcp-access-stack",capabilities:fullRegistry(),
      authorize:async()=>true,
    });
    const api=createOracleReleaseReadApi({orchestrator,bearerToken:READ_TOKEN});
    const denied=await api(new Request("http://127.0.0.1/internal/v1/runs",{
      method:"POST",headers:{authorization:"Bearer "+READ_TOKEN},
    }));
    expect(denied.status).toBe(405);
    const result=await host.advance(request(run),principal);
    expect(result.stop).toBe("outcome_unknown");
    const snapshot=orchestrator.getRun(run.runId);
    expect(snapshot.status).toBe("paused_outcome_unknown");
    expect(snapshot.lastSeq).toBeGreaterThan(run.lastSeq);
    const read=await api(new Request("http://127.0.0.1/internal/v1/runs/"+run.runId,{
      headers:{authorization:"Bearer "+READ_TOKEN},
    }));
    expect(read.status).toBe(200);
    await expect(host.advance(request(run),principal))
      .rejects.toThrow("ORACLE_TRUSTED_HOST_EXPECTED_STATE_MISMATCH");
  });

  it("rejects concurrent host calls to one run and rechecks CAS after asynchronous policy",async()=>{
    const run=planned();
    let releaseGate:(allow:boolean)=>void=()=>{};
    const gate=new Promise<boolean>(resolve=>{releaseGate=resolve;});
    const host=createTrustedOracleReleaseHost(orchestrator,{
      workspaceId:"mcp-access-stack",capabilities:fullRegistry(),
      authorize:async()=>gate,
    });
    const first=host.advance(request(run),principal);
    await expect(host.advance(request(run),principal))
      .rejects.toThrow("ORACLE_RELEASE_OPERATION_IN_PROGRESS");
    // A distinct actor moved the canonical ledger while policy was pending.
    orchestrator.startRun(run.runId,"test:concurrent-writer");
    releaseGate(true);
    await expect(first).rejects.toThrow("ORACLE_TRUSTED_HOST_EXPECTED_STATE_MISMATCH");
    expect(orchestrator.getRun(run.runId).steps.every(s=>s.operationId===null)).toBe(true);
  });
});
