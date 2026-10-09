import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DelegatedCampaignLedger, type CampaignAction, type CampaignStep,
  type DelegatedCampaignInput,
} from "../../../src/campaign/delegated-campaign-ledger.js";
import {
  DelegatedCampaignCoordinator, type CampaignInvocation,
  type CampaignObservation, type TypedCampaignCapability,
} from "../../../src/campaign/delegated-campaign-coordinator.js";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const workspaceId = "mcp-access-stack";
let directory = "";
let ledger: DelegatedCampaignLedger;
function step(
  name: string, action: CampaignAction, dependsOn: string[],
  targetResource = "repo:main",
): CampaignStep {
  return {
    id: name, action, dependsOn, targetResource,
    expectedState: "main@" + "1".repeat(40),
    argumentsDigest: createHash("sha256").update("args:" + name).digest("hex"),
  };
}
const plan = (tasks: CampaignStep[]): DelegatedCampaignInput => ({
  campaignId: id, workspaceId,
  objective: "Execute only delegated typed operations with verified CAS.",
  authorizedActions: [...new Set(tasks.map(t => t.action))],
  tasks,
});
type Status = CampaignObservation["state"];
function observation(request: CampaignInvocation, state: Status): CampaignObservation {
  const identity = {
    operationId: request.operationId, targetResource: request.targetResource,
    expectedState: request.expectedState, argumentsDigest: request.argumentsDigest,
  };
  return state === "succeeded" || state === "failed" || state === "not_started"
    ? { ...identity, state, proof: { kind: "verified", reference: "mcp:v3:" + request.operationId } }
    : { ...identity, state };
}
function capability(
  task: CampaignStep,
  execute: (i: CampaignInvocation) => Promise<CampaignObservation>,
  reconcile: (i: CampaignInvocation) => Promise<CampaignObservation> =
    async i => observation(i, "outcome_unknown"),
  verify: (i: CampaignInvocation, receipt: CampaignObservation) => Promise<boolean> =
    async (i, r) => r.operationId === i.operationId,
): TypedCampaignCapability {
  return {
    action: task.action, targetResource: task.targetResource,
    expectedState: task.expectedState, argumentsDigest: task.argumentsDigest,
    execute, reconcile, verify,
  };
}
function registry(
  tasks: CampaignStep[],
  execute: (i: CampaignInvocation) => Promise<CampaignObservation>,
  reconcile?: (i: CampaignInvocation) => Promise<CampaignObservation>,
): Map<string, TypedCampaignCapability> {
  return new Map(tasks.map(t => [t.id, capability(t, execute, reconcile)]));
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "delegated-campaign-coordinator-"));
  ledger = new DelegatedCampaignLedger(directory, "owner:session");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("DelegatedCampaignCoordinator", () => {
  it("executes dependency-ordered, typed operations continuously without a new confirmation", async () => {
    const tasks = [
      step("inspect", "inspect", []),
      step("test", "test", ["inspect"]),
      step("ci", "ci", ["test"]),
    ];
    await ledger.create(plan(tasks));
    const seen: string[] = [];
    const ports = registry(tasks, async request => {
      seen.push(request.taskId);
      expect(request.workspaceId).toBe(workspaceId);
      return observation(request, "succeeded");
    });
    const coordinator = new DelegatedCampaignCoordinator(ledger, ports);
    const result = await coordinator.run(workspaceId, id);
    expect(result.stop).toBe("all_completed");
    expect(result.executed).toBe(3);
    expect(result.reconciled).toBe(0);
    expect(seen).toEqual(["inspect", "test", "ci"]);
    expect(result.campaign.tasks.every(t => t.state === "completed")).toBe(true);
    expect(new Set(result.campaign.tasks.map(t => t.operationId)).size).toBe(3);
  });

  it("rejects changed action, target resource, expected CAS or argument digest before the first claim", async () => {
    const task = step("check", "inspect", [], "repo:main");
    await ledger.create(plan([task]));
    let executed = 0;
    const good = capability(task, async req => {
      executed++;
      return observation(req, "succeeded");
    });
    const variants: TypedCampaignCapability[] = [
      { ...good, action: "deploy" },
      { ...good, targetResource: "repo:production" },
      { ...good, expectedState: "main@" + "f".repeat(40) },
      { ...good, argumentsDigest: "f".repeat(64) },
    ];
    for (const bad of variants) {
      const runner = new DelegatedCampaignCoordinator(ledger, new Map([["check", bad]]));
      await expect(runner.run(workspaceId, id)).rejects.toThrow("CAMPAIGN_BINDING_MISMATCH");
    }
    expect(executed).toBe(0);
    expect((await ledger.get(workspaceId, id))?.tasks[0]?.state).toBe("pending");
  });

  it("keeps a timed-out remote operation unknown, advances an independent resource and reconciles by the SAME ID after restart", async () => {
    const tasks = [
      step("edge", "deploy", []),
      step("edge-followup", "test", [], "repo:main"),
      step("independent", "inspect", [], "repo:docs"),
      step("after-edge", "test", ["edge"]),
    ];
    // Block the same-resource edge-followup while the unknown deploy is unresolved.
    tasks[1]!.targetResource = tasks[0]!.targetResource;
    await ledger.create(plan(tasks));
    let dispatched = 0;
    const firstPorts = registry(tasks, async req => {
      if (req.taskId === "edge") {
        dispatched++;
        throw new Error("response lost after remote dispatch");
      }
      return observation(req, "succeeded");
    });
    const first = await new DelegatedCampaignCoordinator(ledger, firstPorts).run(workspaceId, id);
    expect(first.campaign.tasks.find(t => t.id === "edge")?.state).toBe("outcome_unknown");
    expect(first.campaign.tasks.find(t => t.id === "independent")?.state).toBe("completed");
    expect(first.campaign.tasks.find(t => t.id === "edge-followup")?.state).toBe("pending");
    expect(dispatched).toBe(1);
    const originalId = first.campaign.tasks.find(t => t.id === "edge")?.operationId;
    const seenReconciliation: string[] = [];
    const freshLedger = new DelegatedCampaignLedger(directory, "owner:session");
    const freshPorts = registry(tasks,
      async req => {
        if (req.taskId === "edge") throw new Error("NEVER retry unknown");
        return observation(req, "succeeded");
      },
      async req => {
        seenReconciliation.push(req.operationId);
        return observation(req, "succeeded");
      },
    );
    const second = await new DelegatedCampaignCoordinator(freshLedger, freshPorts).run(workspaceId, id);
    expect(seenReconciliation).toEqual([originalId]);
    expect(second.stop).toBe("all_completed");
    expect(dispatched).toBe(1);
  });

  it("never re-executes a claimed operation when execution died after durable claim", async () => {
    const tasks = [step("first", "commit", []), step("next", "ci", ["first"])];
    await ledger.create(plan(tasks));
    const claim = await ledger.claimNext(workspaceId, id);
    if (claim.disposition !== "claimed") throw new Error("claim failed");
    let firstExecuted = 0;
    const ports = registry(tasks,
      async req => {
        if (req.taskId === "first") firstExecuted++;
        return observation(req, "succeeded");
      },
      async req => observation(req, "succeeded"),
    );
    const result = await new DelegatedCampaignCoordinator(ledger, ports).run(workspaceId, id);
    expect(result.stop).toBe("all_completed");
    expect(result.reconciled).toBe(1);
    expect(firstExecuted).toBe(0);
    expect(result.campaign.tasks[0]?.operationId).toBe(claim.operationId);
  });

  it("fails closed on a forged terminal receipt rather than marking the task completed", async () => {
    const task = step("safe", "merge", []);
    await ledger.create(plan([task]));
    const ports = registry([task], async req => ({
      ...observation(req, "succeeded"),
      operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    }));
    const result = await new DelegatedCampaignCoordinator(ledger, ports).run(workspaceId, id, 3);
    expect(result.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(result.campaign.tasks[0]?.proof).toBeUndefined();
    expect(result.executed).toBe(1);
  });

  it("does not interpret in_progress as permission to retry and reconciles on next run", async () => {
    const task = step("publish", "push", []);
    await ledger.create(plan([task]));
    let executed = 0, checked = 0;
    const cap = capability(task,
      async request => { executed++; return observation(request, "in_progress"); },
      async request => { checked++; return observation(request, "succeeded"); },
    );
    const runner = new DelegatedCampaignCoordinator(ledger, new Map([["publish", cap]]));
    const first = await runner.run(workspaceId, id);
    expect(first.stop).toBe("awaiting_reconciliation");
    expect(first.campaign.tasks[0]?.state).toBe("in_flight");
    const second = await runner.run(workspaceId, id);
    expect(second.stop).toBe("all_completed");
    expect(checked).toBe(1);
    expect(executed).toBe(1);
  });

  it("requires authoritative typed verification before accepting an otherwise matching receipt", async () => {
    const task = step("validate", "ci", []);
    await ledger.create(plan([task]));
    let verifications = 0;
    const port = capability(task,
      async request => observation(request, "succeeded"),
      async request => observation(request, "succeeded"),
      async () => { verifications++; return false; },
    );
    const runner = new DelegatedCampaignCoordinator(ledger, new Map([["validate", port]]));
    const first = await runner.run(workspaceId, id);
    expect(first.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(first.campaign.tasks[0]?.proof).toBeUndefined();
    const second = await runner.run(workspaceId, id);
    expect(second.campaign.tasks[0]?.state).toBe("outcome_unknown");
    expect(verifications).toBe(2);
  });

  it("returns all_completed when the exact budget finishes the last step", async () => {
    const task = step("single", "inspect", []);
    await ledger.create(plan([task]));
    const runner = new DelegatedCampaignCoordinator(ledger,
      registry([task], async request => observation(request, "succeeded")),
    );
    expect((await runner.run(workspaceId, id, 1)).stop).toBe("all_completed");
  });

  it("a second concurrent runner cannot acquire the exclusive campaign run lock", async () => {
    const task = step("slow", "test", []);
    await ledger.create(plan([task]));
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { unblock = resolve; });
    let executions = 0;
    const port = capability(task, async req => {
      executions++;
      entered();
      await wait;
      return observation(req, "succeeded");
    });
    const runner = new DelegatedCampaignCoordinator(ledger, new Map([["slow", port]]));
    const running = runner.run(workspaceId, id);
    await started;
    try {
      const second = new DelegatedCampaignCoordinator(
        new DelegatedCampaignLedger(directory, "owner:session"),
        new Map([["slow", port]]),
      );
      await expect(second.run(workspaceId, id)).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      unblock();
      await running;
    }
    expect(executions).toBe(1);
  });

  it("a terminal not_started reconciliation blocks instead of resubmitting a mutation", async () => {
    const task = step("deploy", "deploy", []);
    await ledger.create(plan([task]));
    const claim = await ledger.claimNext(workspaceId, id);
    if (claim.disposition !== "claimed") throw new Error("claim failed");
    let executed = 0;
    const port = capability(task, async req => { executed++; return observation(req, "succeeded"); },
      async req => observation(req, "not_started"));
    const result = await new DelegatedCampaignCoordinator(ledger, new Map([["deploy", port]])).run(workspaceId, id);
    expect(result.stop).toBe("no_runnable_step");
    expect(result.campaign.tasks[0]?.state).toBe("blocked");
    expect(executed).toBe(0);
    expect(result.campaign.tasks[0]?.operationId).toBe(claim.operationId);
  });

  it("enforces a step budget instead of running an unbounded campaign", async () => {
    const tasks = Array.from({length: 10}, (_, i) =>
      step("step-" + i, "test", i===0?[]:["step-"+(i-1)]),
    );
    await ledger.create(plan(tasks));
    const runner = new DelegatedCampaignCoordinator(ledger, registry(tasks,
      async req => observation(req, "succeeded"),
    ));
    const first = await runner.run(workspaceId, id, 2);
    expect(first.stop).toBe("step_budget");
    expect(first.executed).toBe(2);
    const second = await runner.run(workspaceId, id);
    expect(second.stop).toBe("all_completed");
    expect(second.executed).toBe(8);
  });
});
