import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { CompanionUpdateRunner, type CompanionUpdateRequest } from "../../../src/mcp-update/companion-update-runner.js";
import type { ReleaseInstallPort } from "../../../src/mcp-update/release-install.js";
import {
  McpUpdateRunner,
  nextConnectorRelease,
  type McpUpdatePort,
  type McpUpdateRecord,
  type McpUpdateWorkflowCall,
} from "../../../src/mcp-update/mcp-update-runner.js";

const MAIN = "a".repeat(40);
const PLAN = "plan_00000000-0000-4000-8000-000000000001";
const OLD = "9".repeat(64);
const NEW = "1".repeat(64);

let directory: string;
/** The runner the companion answers, as the Edge would relay it. */
let answering: McpUpdateRunner | undefined;
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** An execution node, GitHub, Edge and Windows companion that behave, with knobs to make them not. */
function world(overrides: Partial<McpUpdatePort> = {}) {
  const calls: string[] = [];
  const dispatched: McpUpdateWorkflowCall[] = [];
  const progress: Array<{ title: string; steps: Array<{ text: string; state: string; detail?: string; link?: string }> }> = [];
  const finished: McpUpdateRecord[] = [];
  const state = { active: "1.1.0-beta.102-connector.1" as string | null, candidate: null as string | null };
  const edge = { active: OLD, candidate: null as string | null, toolCount: 119, instance: "before" };
  const windows = { active: "1.1.0-companion.40000" as string | null, candidate: null as string | null };
  const requests: CompanionUpdateRequest[] = [];
  const windowsPort: ReleaseInstallPort = {
    releaseState: async () => ({ ...windows }),
    prepare: async (tag) => {
      calls.push(`windows prepare ${tag}`);
      windows.candidate = tag.slice(1);
      return { status: "started", taskId: "task_w" };
    },
    task: async () => "succeeded",
    promote: async (releaseId) => {
      calls.push(`windows promote ${releaseId}`);
      windows.active = releaseId;
      windows.candidate = null;
      return { status: "handover_started" };
    },
  };
  const companion = new CompanionUpdateRunner({
    stateDirectory: path.join(directory, "companion"), port: () => windowsPort,
    report: (status) => answering?.observeCompanionUpdate(status), sleep: tick, pollMs: 1,
  });
  let runId = 100;
  const runs = new Map<string, number>();
  const port: McpUpdatePort = {
    mainHead: async () => MAIN,
    checks: async () => "passed",
    rolloutTarget: async () => ({ origin: "https://edge.example", previousRevision: OLD, targetRevision: NEW, targetToolCount: 120 }),
    health: async () => ({ activeContractRevision: edge.active, candidateContractRevision: edge.candidate,
      toolCount: edge.toolCount, connectorInstanceId: edge.instance }),
    releaseState: async () => ({ ...state }),
    dispatch: async (call) => {
      calls.push(`dispatch ${call.workflow}`);
      dispatched.push(call);
      runs.set(call.operationId, ++runId);
      if (call.workflow === "edge-catalog-activate.yml") edge.candidate = NEW;
      return { status: "submitted" };
    },
    reconcile: async (call) => {
      const id = runs.get(call.operationId);
      return id === undefined ? { status: "outcome_unknown" }
        : { status: "observed", runId: id, state: "completed", conclusion: "success" };
    },
    prepare: async (tag) => {
      calls.push(`prepare ${tag}`);
      state.candidate = tag.slice(1);
      return { status: "started", taskId: "task_1" };
    },
    task: async () => "succeeded",
    promote: async (releaseId) => {
      calls.push(`promote ${releaseId}`);
      state.active = releaseId;
      state.candidate = null;
      edge.active = NEW;
      edge.candidate = null;
      edge.toolCount = 120;
      edge.instance = "after";
      return { status: "handover_started" };
    },
    ciRun: async () => 4242,
    requestCompanionUpdate: (request) => {
      requests.push(request);
      void companion.handle(request);
    },
    progress: (_planId, title, steps) => progress.push({ title, steps }),
    finished: (record) => finished.push(record),
    ...overrides,
  };
  return { port, calls, dispatched, progress, finished, state, edge, windows, windowsPort, requests };
}

describe("the autonomous MCP update on the execution node", () => {
  let ids = 0;
  const runner = (port: McpUpdatePort, sleep = tick, companionAnswerMs = 60_000) => {
    answering = new McpUpdateRunner({
      stateDirectory: path.join(directory, "node"), workspaceId: "mcp-access-stack", port,
      newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
      sleep, pollMs: 1, stepTimeoutMs: 60_000, companionAnswerMs,
    });
    return answering;
  };

  beforeEach(async () => { directory = await mkdtemp(path.join(os.tmpdir(), "mcp-update-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("publishes MAIN step by step, moves the plan card and wakes the agent once at the end", async () => {
    const env = world();
    const updates = runner(env.port);
    const started = await updates.start({ mainSha: MAIN, planId: PLAN, ownerScope: "user:rafael" });
    const done = await updates.settled(started.updateId);

    expect(done.status).toBe("succeeded");
    // Every workflow is dispatched as the user who started the update, as if they had called it.
    expect(env.dispatched.every((call) => call.ownerScope === "user:rafael")).toBe(true);
    expect(env.calls).toEqual([
      "dispatch edge-cas-candidate-stage.yml",
      "dispatch edge-catalog-activate.yml",
      "dispatch release-tag-bootstrap.yml",
      "dispatch release.yml",
      "prepare v1.1.0-beta.103-connector.1",
      "promote 1.1.0-beta.103-connector.1",
      "dispatch companion-only-distribution.yml",
      "windows prepare v1.1.0-companion.4242",
      "windows promote 1.1.0-companion.4242",
    ]);
    // The activation names the stage's run; the release names the bootstrap's operation.
    expect(env.dispatched[1]).toMatchObject({ stageRunId: done.data.stage!.runId });
    expect(env.dispatched[3]).toMatchObject({ tag: "v1.1.0-beta.103-connector.1", bootstrapOperationId: done.data.bootstrap!.operationId });
    expect(env.dispatched[4]).toMatchObject({ ciRunId: 4242 });
    expect(done).toMatchObject({ data: { companionTag: "v1.1.0-companion.4242" } });
    expect(env.windows).toEqual({ active: "1.1.0-companion.4242", candidate: null });
    expect(new Set(env.dispatched.map((call) => call.operationId)).size).toBe(5);
    expect(env.dispatched.every((call) => call.expectedMainSha === MAIN)).toBe(true);
    expect(env.progress.at(-1)).toMatchObject({ title: "MCP atualizado" });
    expect(env.progress.at(-1)!.steps.every((step) => step.state === "done")).toBe(true);
    expect(env.finished.map((record) => record.status)).toEqual(["succeeded"]);
  });

  it("says on the card what the step waits for and links each workflow to its run", async () => {
    const env = world();
    const seen = new Map<string, number>();
    const reconcile = env.port.reconcile;
    // Each run is queued once, then in progress once, before it completes.
    env.port.reconcile = async (call) => {
      const observed = await reconcile(call);
      const count = (seen.get(call.operationId) ?? 0) + 1;
      seen.set(call.operationId, count);
      if (observed.status !== "observed" || count > 2) return observed;
      return { ...observed, state: count === 1 ? "queued" : "in_progress", conclusion: null };
    };
    const updates = runner(env.port);
    const done = await updates.settled((await updates.start({ mainSha: MAIN, planId: PLAN })).updateId);
    expect(done.status).toBe("succeeded");
    const stage = env.progress.map((entry) => entry.steps[1]!).filter((step) => step.state === "doing");
    expect(stage.map((step) => step.detail)).toEqual(expect.arrayContaining(["Na fila do GitHub", "Rodando no GitHub"]));
    expect(stage.at(-1)!.link).toBe(`https://github.com/iFael/mcp-access-stack/actions/runs/${done.data.stage!.runId}`);
    const last = env.progress.at(-1)!.steps;
    expect(last[4]!.link).toBe(`https://github.com/iFael/mcp-access-stack/actions/runs/${done.data.release!.runId}`);
    expect(last.every((step) => step.detail === undefined)).toBe(true);
    expect(env.progress.some((entry) => entry.steps[9]!.detail === "Instalando no Windows; costuma levar uns 16 min" ||
      entry.steps[9]!.detail === "Esperando o companion do Windows responder")).toBe(true);
  });

  it("skips the Edge catalog when MAIN does not change the contract", async () => {
    const env = world();
    env.edge.active = NEW;
    env.port.rolloutTarget = async () => ({ origin: "https://edge.example", previousRevision: OLD, targetRevision: NEW, targetToolCount: 120 });
    const updates = runner(env.port);
    const done = await updates.settled((await updates.start({ mainSha: MAIN, planId: PLAN })).updateId);
    expect(done.status).toBe("succeeded");
    expect(env.calls[0]).toBe("dispatch release-tag-bootstrap.yml");
    expect(env.progress.at(-1)!.steps.slice(1, 3).map((step) => step.state)).toEqual(["skipped", "skipped"]);
  });

  it("stops before any effect when the state is not the expected one", async () => {
    const cases: Array<[Partial<McpUpdatePort>, string]> = [
      [{ mainHead: async () => "b".repeat(40) }, "MAIN_MOVED"],
      [{ checks: async () => "failed" }, "CI_FAILED"],
      [{ releaseState: async () => ({ active: "1.1.0-beta.102-connector.1", candidate: "1.1.0-beta.103-connector.1" }) }, "CANDIDATE_PENDING"],
      [{ health: async () => ({ activeContractRevision: "2".repeat(64), candidateContractRevision: null, toolCount: 119, connectorInstanceId: "x" }) },
        "EDGE_CONTRACT_MISMATCH"],
    ];
    for (const [override, code] of cases) {
      const env = world(override);
      const updates = runner(env.port);
      const done = await updates.settled((await updates.start({ mainSha: MAIN })).updateId);
      expect(done).toMatchObject({ status: "failed", step: "precheck", error: { code } });
      expect(env.calls).toEqual([]);
      expect(env.finished).toHaveLength(1);
    }
  });

  it("stops on a failed workflow and never dispatches it again", async () => {
    const env = world();
    env.port.reconcile = async (call) => call.workflow === "release.yml"
      ? { status: "observed", runId: 7, state: "completed", conclusion: "failure" }
      : { status: "observed", runId: 5, state: "completed", conclusion: "success" };
    const updates = runner(env.port);
    const done = await updates.settled((await updates.start({ mainSha: MAIN, planId: PLAN })).updateId);
    expect(done).toMatchObject({ status: "failed", step: "connector_release", error: { code: "WORKFLOW_FAILED" } });
    expect(env.calls.filter((call) => call === "dispatch release.yml")).toHaveLength(1);
    expect(env.progress.at(-1)!.title).toBe("Atualização do MCP parou");
    expect(env.progress.at(-1)!.steps[4]!.state).toBe("failed");
  });

  it("waits for the user's confirmation and goes on with it, without a second unconfirmed prepare", async () => {
    const env = world();
    const prepare = env.port.prepare;
    let asked = 0;
    env.port.prepare = async (tag, confirmationId) => {
      if (confirmationId === undefined) {
        asked += 1;
        return { status: "confirmation_required", confirmationId: "cnf_1", reasons: ["new major"], expiresAt: "2026-10-29T04:00:00.000Z" };
      }
      expect(confirmationId).toBe("cnf_1");
      return prepare(tag);
    };
    const updates = runner(env.port);
    const waiting = await updates.settled((await updates.start({ mainSha: MAIN })).updateId);
    expect(waiting).toMatchObject({ status: "needs_confirmation", step: "oracle_prepare", confirmation: { confirmationId: "cnf_1", reasons: ["new major"] } });
    expect(env.finished.map((record) => record.status)).toEqual(["needs_confirmation"]);
    await expect(updates.confirm(waiting.updateId, "cnf_other")).rejects.toThrow("does not wait");

    await updates.confirm(waiting.updateId, "cnf_1");
    const done = await updates.settled(waiting.updateId);
    expect(done.status).toBe("succeeded");
    expect(asked).toBe(1);
    expect(env.calls.filter((call) => call.startsWith("dispatch"))).toHaveLength(5);
  });

  it("is resumed by the next process after its own promote, and only waits", async () => {
    const env = world();
    let promotes = 0;
    env.port.promote = async () => {
      promotes += 1;
      return { status: "handover_started" };
    };
    // The old process is replaced while it waits: it never wakes again.
    const first = runner(env.port, () => new Promise(() => undefined));
    const started = await first.start({ mainSha: MAIN });
    for (let tries = 0; tries < 1_000; tries += 1) {
      const record = await first.read(started.updateId);
      if (record?.step === "oracle_promote" && record.data.promoteRequested) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    env.state.active = "1.1.0-beta.103-connector.1";
    env.state.candidate = null;
    Object.assign(env.edge, { active: NEW, candidate: null, toolCount: 120, instance: "after" });

    const second = runner(env.port);
    await second.recover();
    const done = await second.settled(started.updateId);
    expect(done.status).toBe("succeeded");
    expect(promotes).toBe(1);
  });

  it("calls a return to the old release a rollback", async () => {
    const env = world();
    env.port.promote = async () => {
      env.state.candidate = null;
      return { status: "handover_started" };
    };
    const updates = runner(env.port);
    const done = await updates.settled((await updates.start({ mainSha: MAIN })).updateId);
    expect(done).toMatchObject({ status: "failed", step: "oracle_promote", error: { code: "ROLLED_BACK" } });
  });

  it("checks /health after the promote", async () => {
    const env = world();
    const promote = env.port.promote;
    env.port.promote = async (releaseId) => {
      const result = await promote(releaseId);
      env.edge.toolCount = 119;
      return result;
    };
    const updates = runner(env.port);
    const done = await updates.settled((await updates.start({ mainSha: MAIN })).updateId);
    expect(done).toMatchObject({ status: "failed", step: "oracle_verify", error: { code: "HEALTH_MISMATCH" } });
    expect(done.error!.message).toContain("toolCount 119");
  });

  it("keeps one update at a time and names the next connector release", async () => {
    const env = world({ checks: async () => "pending" });
    const updates = new McpUpdateRunner({ stateDirectory: path.join(directory, "node"), workspaceId: "mcp-access-stack", port: env.port,
      sleep: () => new Promise(() => undefined), pollMs: 1 });
    await updates.start({ mainSha: MAIN });
    await expect(updates.start({ mainSha: MAIN })).rejects.toThrow(/is running/u);
    expect(nextConnectorRelease("1.1.0-beta.102-connector.1")).toBe("1.1.0-beta.103-connector.1");
    expect(() => nextConnectorRelease("1.1.0-companion.4")).toThrow();
  });

  it("asks the Windows companion for the user's confirmation and passes it on, without a second unconfirmed prepare", async () => {
    const env = world();
    const prepare = env.windowsPort.prepare;
    const asked: Array<string | undefined> = [];
    env.windowsPort.prepare = async (tag, confirmationId) => {
      asked.push(confirmationId);
      return confirmationId === undefined
        ? { status: "confirmation_required", confirmationId: "cnf_w", reasons: ["companion"], expiresAt: "2026-10-29T04:00:00.000Z" }
        : prepare(tag);
    };
    const updates = runner(env.port);
    const waiting = await updates.settled((await updates.start({ mainSha: MAIN })).updateId);
    expect(waiting).toMatchObject({ status: "needs_confirmation", step: "windows_prepare",
      confirmation: { step: "windows_prepare", confirmationId: "cnf_w", reasons: ["companion"] } });
    expect(env.finished.map((record) => record.status)).toEqual(["needs_confirmation"]);

    await updates.confirm(waiting.updateId, "cnf_w");
    const done = await updates.settled(waiting.updateId);
    expect(done.status).toBe("succeeded");
    expect(asked).toEqual([undefined, "cnf_w"]);
    expect(env.calls.filter((call) => call.startsWith("windows promote"))).toHaveLength(1);
  });

  it("stops with the companion's own error, and when no companion answers", async () => {
    const pending = world();
    pending.windows.candidate = "1.1.0-companion.39999";
    const updates = runner(pending.port);
    const failed = await updates.settled((await updates.start({ mainSha: MAIN })).updateId);
    expect(failed).toMatchObject({ status: "failed", step: "windows_prepare", error: { code: "CANDIDATE_PENDING" } });
    expect(failed.error!.message).toContain("1.1.0-companion.39999");

    const silent = world({ requestCompanionUpdate: () => undefined });
    const quiet = runner(silent.port, tick, 20);
    const unanswered = await quiet.settled((await quiet.start({ mainSha: MAIN })).updateId);
    expect(unanswered).toMatchObject({ status: "failed", step: "windows_prepare", error: { code: "COMPANION_NOT_ANSWERING" } });
  });
});
