import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DelegatedCampaignLedger, type CampaignAction, type CampaignStep,
  type DelegatedCampaignInput,
} from "../../../src/campaign/delegated-campaign-ledger.js";

const campaignId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let directory = "";
let ledger: DelegatedCampaignLedger;

function step(
  id: string, action: CampaignAction, dependsOn: string[],
  targetResource = "repo:main",
): CampaignStep {
  return {
    id, action, dependsOn, targetResource,
    expectedState: "main@" + "1".repeat(40),
    argumentsDigest: createHash("sha256").update(id + ":" + action).digest("hex"),
  };
}

const objective = (): DelegatedCampaignInput => ({
  campaignId,
  workspaceId: "mcp-access-stack",
  objective: "Conclude the delegated release preparation without altering production.",
  authorizedActions: ["inspect", "test", "commit", "ci"],
  tasks: [
    step("diagnose", "inspect", []),
    step("check", "test", ["diagnose"]),
    step("independent", "inspect", [], "repo:docs"),
    step("commit", "commit", ["check"]),
    step("ci", "ci", ["commit"]),
  ],
});

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "delegated-campaign-"));
  ledger = new DelegatedCampaignLedger(directory, "owner:session-a");
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("DelegatedCampaignLedger", () => {
  it("persists the exact authorization and reuses a matching campaign ID without restarting", async () => {
    const created = await ledger.create(objective());
    expect(created.revision).toBe(0);
    const first = await ledger.claimNext("mcp-access-stack", campaignId);
    expect(first.disposition).toBe("claimed");
    if (first.disposition !== "claimed") throw new Error("claim absent");
    expect(first.taskId).toBe("diagnose");
    const reloaded = new DelegatedCampaignLedger(directory, "owner:session-a");
    expect((await reloaded.create(objective())).tasks[0]?.operationId).toBe(first.operationId);
    // An in-flight action is never duplicated or paralleled by default.
    expect((await reloaded.claimNext("mcp-access-stack", campaignId)).disposition)
      .toBe("no_runnable_step");
    await reloaded.transition("mcp-access-stack", campaignId, first.taskId, first.operationId,"outcome_unknown");
    const next = await reloaded.claimNext("mcp-access-stack", campaignId);
    expect(next.disposition).toBe("claimed");
    if (next.disposition === "claimed") expect(next.taskId).toBe("independent");
    const stored = await reloaded.get("mcp-access-stack", campaignId);
    expect(stored?.tasks.filter(t => t.state === "in_flight")).toHaveLength(1);
    const text = await readFile(path.join(directory, "delegated-campaigns", (await readdir(path.join(directory, "delegated-campaigns"))).find(f=>f.endsWith(".json"))!),"utf8");
    expect(text).not.toContain("owner:session-a");
  });

  it("prevents a reused campaignId from broadening authority or changing the objective", async () => {
    await ledger.create(objective());
    await expect(ledger.create({ ...objective(), authorizedActions: [...objective().authorizedActions, "deploy"] }))
      .rejects.toThrow("campaignId reused");
    await expect(ledger.create({ ...objective(), objective: "Deploy now." }))
      .rejects.toThrow("campaignId reused");
    const changed = objective();
    changed.tasks[0]!.targetResource = "repo:production";
    await expect(ledger.create(changed)).rejects.toThrow("campaignId reused");
    const differentParameters = objective();
    differentParameters.tasks[0]!.argumentsDigest = "f".repeat(64);
    await expect(ledger.create(differentParameters)).rejects.toThrow("campaignId reused");
  });

  it("rejects cycles, out-of-scope actions, missing dependency and duplicate task IDs", async () => {
    await expect(ledger.create({ ...objective(), tasks: [
      step("a","test",["b"]), step("b","test",["a"]),
    ] })).rejects.toThrow("dependency cycle");
    await expect(ledger.create({ ...objective(), tasks: [step("unsafe", "deploy", [])] }))
      .rejects.toThrow("task outside delegated authorization");
    await expect(ledger.create({ ...objective(), tasks: [step("bad", "inspect", ["none"])] }))
      .rejects.toThrow("missing/self dependency");
    await expect(ledger.create({ ...objective(), tasks: [
      step("same","test",[]), step("same","test",[]),
    ] })).rejects.toThrow("invalid/duplicate task id");
  });

  it("requires verified evidence for completion and gates dependents on completed tasks", async () => {
    await ledger.create(objective());
    const first = await ledger.claimNext("mcp-access-stack", campaignId);
    if (first.disposition !== "claimed") throw new Error("missing claim");
    await expect(ledger.transition("mcp-access-stack", campaignId, first.taskId, first.operationId, "completed"))
      .rejects.toThrow("verified evidence");
    await expect(ledger.transition("mcp-access-stack", campaignId, first.taskId, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "completed", {kind:"verified",reference:"check:1"}))
      .rejects.toThrow("operation identity mismatch");
    await ledger.transition("mcp-access-stack", campaignId, first.taskId, first.operationId, "completed", {kind:"verified",reference:"mcp-check:diagnose"});
    const second = await ledger.claimNext("mcp-access-stack", campaignId);
    expect(second.disposition).toBe("claimed");
    if (second.disposition === "claimed") expect(second.taskId).toBe("check");
  });

  it("never restarts outcome_unknown and continues independent pending work", async () => {
    await ledger.create(objective());
    const first = await ledger.claimNext("mcp-access-stack", campaignId);
    if (first.disposition !== "claimed") throw new Error("missing");
    await ledger.transition("mcp-access-stack", campaignId, first.taskId, first.operationId, "outcome_unknown");
    const reload = new DelegatedCampaignLedger(directory,"owner:session-a");
    const independent = await reload.claimNext("mcp-access-stack", campaignId);
    if (independent.disposition !== "claimed") throw new Error("independent missing");
    expect(independent.taskId).toBe("independent");
    const idle = await reload.claimNext("mcp-access-stack", campaignId);
    expect(idle.disposition).toBe("no_runnable_step");
    expect((await reload.get("mcp-access-stack",campaignId))?.tasks[0]?.operationId).toBe(first.operationId);
    await expect(reload.transition("mcp-access-stack", campaignId, first.taskId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc","completed",{kind:"verified",reference:"bad"}))
      .rejects.toThrow("operation identity mismatch");
    await expect(reload.transition("mcp-access-stack", campaignId, first.taskId, first.operationId, "failed")).rejects.toThrow("verified evidence");
    await reload.transition("mcp-access-stack", campaignId, first.taskId, first.operationId,"completed",{kind:"verified",reference:"same run reconciled"});
    const next = await reload.claimNext("mcp-access-stack", campaignId);
    if (next.disposition === "claimed") expect(next.taskId).toBe("check");
  });

  it("isolates owner scope and refuses a stale exclusive lock instead of executing", async () => {
    await ledger.create(objective());
    const stranger = new DelegatedCampaignLedger(directory, "different-owner");
    expect(await stranger.get("mcp-access-stack", campaignId)).toBeUndefined();
    const base = path.join(directory, "delegated-campaigns");
    const name = (await readdir(base)).find(s=>s.endsWith(".json"));
    if (!name) throw new Error("receipt absent");
    await writeFile(path.join(base,name+".lock"),"locked");
    await expect(ledger.claimNext("mcp-access-stack",campaignId)).rejects.toMatchObject({code:"EEXIST"});
    await rm(path.join(base,name+".lock"));
    const result = await ledger.claimNext("mcp-access-stack",campaignId);
    expect(result.disposition).toBe("claimed");
  });

  it("fails closed on a tampered persisted operation ID without replacing the file", async () => {
    await ledger.create(objective());
    const first = await ledger.claimNext("mcp-access-stack",campaignId);
    if (first.disposition !== "claimed") throw new Error("missing");
    const base = path.join(directory,"delegated-campaigns");
    const file = (await readdir(base)).find(f=>f.endsWith(".json"));
    if (!file) throw new Error("missing record");
    const p = path.join(base,file);
    const stored = JSON.parse(await readFile(p,"utf8")) as Record<string,unknown>;
    const tasks = stored.tasks as Record<string,unknown>[];
    tasks[0]!.operationId = "../escape";
    await writeFile(p,JSON.stringify(stored));
    await expect(ledger.get("mcp-access-stack",campaignId)).rejects.toThrow("missing operation identity");
    tasks[0]!.operationId = first.operationId;
    stored.authorizedActions = ["inspect", "test", "commit", "ci", "deploy"];
    await writeFile(p,JSON.stringify(stored));
    await expect(ledger.get("mcp-access-stack",campaignId)).rejects.toThrow("digest mismatch");
  });
});
