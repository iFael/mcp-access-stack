import { describe, expect, it } from "@jest/globals";
import { composeReleaseCapabilities } from "../../src/release-capability-registry.js";
import { beta80ReleaseBlueprint } from "../../src/workflows/beta80-sequence.v1.js";
import type { ReleaseStepCapability } from "../../src/release-workflow-executor.js";

const source = {
  authorizeRead: async()=>true,
  port:{
    readMainHead:async()=> "a".repeat(40),
    readCommitChecks:async(commitSha:string)=>({
      commitSha,totalCount:1,returnedCount:1,pendingCount:0,
      successfulCount:1,failingCount:0,allCompleted:true,truncated:false,passed:true,
      checks:[{id:1,name:"CI",status:"completed",conclusion:"success"}],
    }),
  },
};
const cleanup = {
  workspaceId:"mcp-access-stack",
  authorized:async()=>true,
  prune:{pruneReleases:async()=>({
    operationId:"00000000-0000-4000-8000-000000000000",status:"completed" as const,
    stateSha256:"a".repeat(64),planSha256:"b".repeat(64),items:[],
  })},
};
const mutation: ReleaseStepCapability={
  action:"publish_release_tag",executionClass:"external_effect",
  authorize:async()=>false,
  execute:async()=>({state:"outcome_unknown"}),
  reconcile:async()=>({outcome:"still_unknown"}),
};
describe("single canonical release capability registry",()=>{
  it("reports absent abilities without inventing adapters or starting workflows",()=>{
    const registry=composeReleaseCapabilities({sourceControl:source,cleanup});
    expect(registry.ready).toBe(false);
    expect(registry.capabilities.size).toBe(3);
    expect(registry.missingActions).toHaveLength(beta80ReleaseBlueprint.steps.length-3);
    expect(registry.missingActions).toContain("publish_release_tag");
    expect(registry.missingActions).not.toContain("verify_canonical_ci");
    expect(registry.missingActions).not.toContain("cleanup_known_temporary_residue");
    expect(() => registry.createExecutor(null as never)).toThrow("RELEASE_CAPABILITY_INCOMPLETE");
  });
  it("rejects duplicates, unknown or wrong-class capabilities",()=>{
    expect(()=>composeReleaseCapabilities({sourceControl:source,
      other:[{...mutation,action:"verify_canonical_ci",executionClass:"read_only"}]}))
      .toThrow("RELEASE_CAPABILITY_DUPLICATE");
    expect(()=>composeReleaseCapabilities({other:[{...mutation,executionClass:"read_only"}]}))
      .toThrow("RELEASE_CAPABILITY_CLASS_MISMATCH");
    expect(()=>composeReleaseCapabilities({other:[{...mutation,action:"arbitrary_shell" as never}]}))
      .toThrow("RELEASE_CAPABILITY_UNRECOGNIZED");
  });
  it("wires real Edge health once and rejects a duplicate generic health binding",()=>{
    const edgeHealth={endpoint:"https://mcp-access-stack.workers.dev/health",
      authorize:async()=>true};
    const registry=composeReleaseCapabilities({sourceControl:source,edgeHealth});
    expect(registry.capabilities.has("verify_edge_health")).toBe(true);
    expect(registry.ready).toBe(false);
    expect(registry.missingActions).not.toContain("verify_edge_health");
    expect(()=>composeReleaseCapabilities({edgeHealth,verifications:{
      actions:["verify_edge_health"],authorize:async()=>true,
      port:{inspect:async()=>({
        action:"verify_edge_health" as const,sourceCommitSha:"a".repeat(40),
        releaseTag:"v1.1.0-beta.90",status:"pending" as const,evidence:[],
      })},
    }})).toThrow("RELEASE_CAPABILITY_DUPLICATE");
  });
  it("registers two independently authenticated pointer readers without starting a cutover",()=>{
    const state={active:{releaseId:"1.1.0-beta.90",manifestSha256:"a".repeat(64)},
      previous:{releaseId:"1.1.0-beta.89",manifestSha256:"b".repeat(64)},
      candidate:null};
    const pointerReconciliation={oracle:{getState:async()=>state},
      windows:{getState:async()=>state},authorize:async()=>true};
    const registry=composeReleaseCapabilities({pointerReconciliation});
    expect([...registry.capabilities.keys()]).toEqual(["reconcile_final_pointers"]);
    expect(registry.ready).toBe(false);
    expect(()=>registry.createExecutor(null as never)).toThrow("RELEASE_CAPABILITY_INCOMPLETE");
  });
  it("registers exact Oracle and Windows active health verifiers, no duplicate owners",()=>{
    const state={active:{releaseId:"1.1.0-beta.90",manifestSha256:"a".repeat(64)},
      previous:{releaseId:"1.1.0-beta.89",manifestSha256:"b".repeat(64)},
      candidate:null};
    const port={
      inspectActive:async()=>({releaseTag:"v1.1.0-beta.90",
        sourceCommitSha:"a".repeat(40),manifestSha256:"a".repeat(64),
        verifiedArtifactCount:1}),
      getState:async()=>state,
      getHealth:async()=>({status:"healthy" as const,
        releaseId:"1.1.0-beta.90",manifestSha256:"a".repeat(64),
        processId:100,observedAt:"2026-10-17T18:00:00Z"}),
    };
    const binding={port,authorize:async()=>true};
    const registry=composeReleaseCapabilities({
      oracleActiveHealth:binding,windowsActiveHealth:binding,
    });
    expect([...registry.capabilities.keys()]).toEqual([
      "verify_oracle_health","verify_windows_health"]);
    expect(registry.missingActions).not.toContain("verify_oracle_health");
    expect(registry.missingActions).not.toContain("verify_windows_health");
    expect(registry.ready).toBe(false);
    expect(()=>composeReleaseCapabilities({
      oracleActiveHealth:binding,
      verifications:{actions:["verify_oracle_health"],authorize:async()=>true,
        port:{inspect:async()=>({action:"verify_oracle_health" as const,
          sourceCommitSha:"a".repeat(40),releaseTag:"v1.1.0-beta.90",
          status:"pending" as const,evidence:[]})}},
    })).toThrow("RELEASE_CAPABILITY_DUPLICATE");
  });
  it("permits full registration only with exact typed actions",()=>{
    const actions=new Map(beta80ReleaseBlueprint.steps.map(step => [
      step.action,step,
    ] as const));
    const registry=composeReleaseCapabilities({sourceControl:source,cleanup,
      other:beta80ReleaseBlueprint.steps.filter(step=>![
        "resolve_main_commit","verify_canonical_ci","cleanup_known_temporary_residue"
      ].includes(step.action)).map(step=>({
        action:step.action,executionClass:step.executionClass,
        authorize:mutation.authorize,execute:mutation.execute,reconcile:mutation.reconcile,
      })),
    });
    expect(registry.ready).toBe(true);
    expect(registry.capabilities.size).toBe(actions.size);
    expect(registry.missingActions).toEqual([]);
  });
});
