import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Publishes MAIN to the execution node by itself: the Edge catalog when the
// contract changes, the connector tag and signed release, then prepare and
// promote of that release here. Each step is the same typed operation an
// agent would call, in a fixed order, with the same one-shot rules: a dispatch
// is never repeated (an uncertain one is only reconciled), prepare and promote
// are each requested once, and any surprise stops the update for the agent.
// The record is written before every effect, so the process that the promote
// replaces is resumed by its successor at the step it reached.

export const MCP_UPDATE_STEPS = [
  "precheck",
  "edge_stage",
  "edge_activate",
  "connector_tag",
  "connector_release",
  "oracle_prepare",
  "oracle_promote",
  "oracle_verify",
] as const;
export type McpUpdateStep = (typeof MCP_UPDATE_STEPS)[number];

const STEP_TEXT: Record<McpUpdateStep, string> = {
  precheck: "Pré-checagem: CI da MAIN, estado da Oracle e do Edge",
  edge_stage: "Catálogo do Edge: stage",
  edge_activate: "Catálogo do Edge: activate",
  connector_tag: "Tag do conector",
  connector_release: "Build e release assinada do conector",
  oracle_prepare: "Prepare na Oracle",
  oracle_promote: "Promote na Oracle",
  oracle_verify: "Conferência da Oracle e do /health",
};

export type McpUpdateStatus = "running" | "succeeded" | "failed" | "needs_confirmation";

export interface McpUpdateWorkflowRun {
  operationId: string;
  runId?: number;
}

export interface McpUpdateRecord {
  version: 1;
  updateId: string;
  workspaceId: string;
  mainSha: string;
  planId?: string;
  createdAt: string;
  updatedAt: string;
  status: McpUpdateStatus;
  step: McpUpdateStep;
  skipped: McpUpdateStep[];
  error?: { code: string; message: string };
  confirmation?: { step: "oracle_prepare" | "oracle_promote"; confirmationId: string; reasons: string[]; expiresAt: string };
  data: {
    activeBefore?: string;
    connectorInstanceBefore?: string;
    catalog?: { origin: string; previousRevision: string; targetRevision: string; targetToolCount: number };
    stage?: McpUpdateWorkflowRun;
    activate?: McpUpdateWorkflowRun;
    tag?: string;
    bootstrap?: McpUpdateWorkflowRun;
    release?: McpUpdateWorkflowRun;
    /** Set before the call: a crash in between leaves an outcome nobody may guess. */
    prepareRequested?: boolean;
    prepareTaskId?: string;
    promoteRequested?: boolean;
    promoteStartedAt?: string;
  };
}

export type McpUpdateWorkflow =
  | "edge-cas-candidate-stage.yml"
  | "edge-catalog-activate.yml"
  | "release-tag-bootstrap.yml"
  | "release.yml";

export interface McpUpdateWorkflowCall {
  workflow: McpUpdateWorkflow;
  expectedMainSha: string;
  operationId: string;
  tag?: string;
  bootstrapOperationId?: string;
  stageRunId?: number;
}

export type McpUpdateWorkflowObservation =
  | { status: "submitted" | "outcome_unknown" }
  | { status: "observed"; runId: number; state: "queued" | "in_progress" | "completed"; conclusion: string | null };

export type McpUpdateConfirmation = {
  status: "confirmation_required";
  confirmationId: string;
  reasons: string[];
  expiresAt: string;
};

export interface McpUpdatePort {
  mainHead(): Promise<string>;
  checks(sha: string): Promise<"passed" | "pending" | "failed">;
  /** tooling/release/edge-catalog-rollout.json at that commit. */
  rolloutTarget(sha: string): Promise<{ origin: string; previousRevision: string; targetRevision: string; targetToolCount: number }>;
  health(origin: string): Promise<{
    activeContractRevision: string;
    candidateContractRevision: string | null;
    toolCount: number | null;
    connectorInstanceId: string | null;
  }>;
  releaseState(): Promise<{ active: string | null; candidate: string | null }>;
  dispatch(call: McpUpdateWorkflowCall): Promise<McpUpdateWorkflowObservation>;
  reconcile(call: McpUpdateWorkflowCall): Promise<McpUpdateWorkflowObservation>;
  prepare(tag: string, confirmationId?: string): Promise<McpUpdateConfirmation | { status: "started"; taskId: string }>;
  task(taskId: string): Promise<"running" | "succeeded" | "failed">;
  promote(releaseId: string, confirmationId?: string): Promise<McpUpdateConfirmation | { status: "handover_started" }>;
  /** The plan card the agent opened, moved to the update's steps. */
  progress?(planId: string, title: string, steps: Array<{ text: string; state: "done" | "doing" | "todo" | "failed" | "skipped" }>): void;
  /** The update stopped: it succeeded, failed or waits for a confirmation. */
  finished?(record: McpUpdateRecord): void;
}

export interface McpUpdateRunnerOptions {
  stateDirectory: string;
  workspaceId: string;
  port: McpUpdatePort;
  now?: () => Date;
  newId?: () => string;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long a workflow, the CI or the promote may take before the update stops. */
  stepTimeoutMs?: number;
}

const SHA = /^[0-9a-f]{40}$/u;
const PLAN_ID = /^plan_[0-9a-f-]{36}$/u;
const UPDATE_FILE = /^upd_[0-9a-f-]{36}\.json$/u;
const CONNECTOR_RELEASE = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)-connector\.(\d+)$/u;

class StopUpdate extends Error {
  constructor(readonly code: string, message: string, readonly confirmation?: McpUpdateRecord["confirmation"]) {
    super(message);
  }
}

export class McpUpdateRunner {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly stepTimeoutMs: number;
  private readonly driving = new Set<string>();

  constructor(private readonly options: McpUpdateRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.pollMs = options.pollMs ?? 20_000;
    this.stepTimeoutMs = options.stepTimeoutMs ?? 45 * 60_000;
  }

  /** Picks up an update the previous process left running, usually across its own promote. */
  async recover(): Promise<void> {
    for (const record of await this.list()) {
      if (record.status === "running") this.drive(record.updateId);
    }
  }

  async start(input: { mainSha: string; planId?: string }): Promise<McpUpdateRecord> {
    if (!SHA.test(input.mainSha)) throw new StopUpdate("INVALID_ARGUMENT", "expectedMainSha must be a full commit SHA.");
    if (input.planId !== undefined && !PLAN_ID.test(input.planId)) throw new StopUpdate("INVALID_ARGUMENT", "planId must come from browser_progress.");
    const open = (await this.list()).find((record) => record.status === "running" || record.status === "needs_confirmation");
    if (open) {
      throw new StopUpdate("UPDATE_IN_PROGRESS", `Update ${open.updateId} is ${open.status}; resume or read it instead of starting another.`);
    }
    const at = this.now().toISOString();
    const record: McpUpdateRecord = {
      version: 1,
      updateId: `upd_${this.newId()}`,
      workspaceId: this.options.workspaceId,
      mainSha: input.mainSha,
      ...(input.planId === undefined ? {} : { planId: input.planId }),
      createdAt: at,
      updatedAt: at,
      status: "running",
      step: "precheck",
      skipped: [],
      data: {},
    };
    await this.save(record);
    this.drive(record.updateId);
    return record;
  }

  /** Continues an update that waits for a confirmation, with the confirmationId the user approved. */
  async confirm(updateId: string, confirmationId: string): Promise<McpUpdateRecord> {
    const record = await this.require(updateId);
    if (record.status !== "needs_confirmation" || record.confirmation?.confirmationId !== confirmationId) {
      throw new StopUpdate("CONFIRMATION_MISMATCH", "This update does not wait for that confirmationId.");
    }
    const resumed: McpUpdateRecord = { ...record, status: "running" };
    await this.save(resumed);
    this.drive(updateId);
    return resumed;
  }

  async read(updateId?: string): Promise<McpUpdateRecord | null> {
    if (updateId !== undefined) return this.load(updateId);
    const records = await this.list();
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
  }

  /** Resolves when the update stops driving; for tests and shutdown. */
  async settled(updateId: string): Promise<McpUpdateRecord> {
    while (this.driving.has(updateId)) await new Promise((resolve) => setTimeout(resolve, 1));
    return this.require(updateId);
  }

  private drive(updateId: string): void {
    if (this.driving.has(updateId)) return;
    this.driving.add(updateId);
    void this.run(updateId).finally(() => this.driving.delete(updateId));
  }

  private async run(updateId: string): Promise<void> {
    let record = await this.require(updateId);
    this.report(record);
    try {
      while (record.status === "running") {
        record = await this.advance(record);
        this.report(record);
      }
    } catch (error) {
      const stop = error instanceof StopUpdate
        ? error
        : new StopUpdate("UPDATE_STEP_ERROR", error instanceof Error ? error.message : String(error));
      // The step may have saved what it requested before it stopped.
      const { confirmation: _confirmation, error: _error, ...latest } = (await this.load(updateId)) ?? record;
      record = {
        ...latest,
        status: stop.confirmation ? "needs_confirmation" : "failed",
        ...(stop.confirmation ? { confirmation: stop.confirmation } : { error: { code: stop.code, message: stop.message } }),
      };
      await this.save(record);
      this.report(record);
    }
    if (record.status !== "running") this.options.port.finished?.(record);
  }

  private async advance(record: McpUpdateRecord): Promise<McpUpdateRecord> {
    const { confirmation: _confirmation, ...current } = record;
    const next = await this.runStep(current, record.confirmation?.step === record.step ? record.confirmation.confirmationId : undefined);
    const index = MCP_UPDATE_STEPS.indexOf(next.step);
    const done = index === MCP_UPDATE_STEPS.length - 1;
    const advanced: McpUpdateRecord = done
      ? { ...next, status: "succeeded" }
      : { ...next, step: MCP_UPDATE_STEPS[index + 1]! };
    await this.save(advanced);
    return advanced;
  }

  private async runStep(record: McpUpdateRecord, confirmationId: string | undefined): Promise<McpUpdateRecord> {
    const port = this.options.port;
    switch (record.step) {
      case "precheck": {
        if ((await port.mainHead()) !== record.mainSha) throw new StopUpdate("MAIN_MOVED", "main is no longer the MAIN this update was asked for.");
        await this.until("CI_NOT_GREEN", "MAIN's CI", async () => {
          const checks = await port.checks(record.mainSha);
          if (checks === "failed") throw new StopUpdate("CI_FAILED", "A check failed on MAIN.");
          return checks === "passed";
        });
        const release = await port.releaseState();
        if (release.candidate !== null) throw new StopUpdate("CANDIDATE_PENDING", `The execution node already has candidate ${release.candidate}.`);
        if (release.active === null || !CONNECTOR_RELEASE.test(release.active)) {
          throw new StopUpdate("UNEXPECTED_ACTIVE_RELEASE", `The active release ${release.active ?? "(none)"} is not a connector release.`);
        }
        const catalog = await port.rolloutTarget(record.mainSha);
        const health = await port.health(catalog.origin);
        if (health.candidateContractRevision !== null) {
          throw new StopUpdate("EDGE_CANDIDATE_PENDING", `The Edge already has candidate ${health.candidateContractRevision}.`);
        }
        const unchanged = health.activeContractRevision === catalog.targetRevision;
        if (!unchanged && health.activeContractRevision !== catalog.previousRevision) {
          throw new StopUpdate("EDGE_CONTRACT_MISMATCH",
            `The Edge runs ${health.activeContractRevision}; MAIN's rollout expects ${catalog.previousRevision} before ${catalog.targetRevision}.`);
        }
        return {
          ...record,
          skipped: unchanged ? ["edge_stage", "edge_activate"] : [],
          data: {
            ...record.data,
            activeBefore: release.active,
            ...(health.connectorInstanceId === null ? {} : { connectorInstanceBefore: health.connectorInstanceId }),
            catalog,
            tag: `v${nextConnectorRelease(release.active)}`,
          },
        };
      }
      case "edge_stage": {
        if (record.skipped.includes("edge_stage")) return record;
        const stage = await this.workflow(record, "stage", { workflow: "edge-cas-candidate-stage.yml" });
        return { ...record, data: { ...record.data, stage } };
      }
      case "edge_activate": {
        if (record.skipped.includes("edge_activate")) return record;
        const activate = await this.workflow(record, "activate", {
          workflow: "edge-catalog-activate.yml",
          stageRunId: record.data.stage!.runId!,
        });
        const catalog = record.data.catalog!;
        await this.until("EDGE_CANDIDATE_MISSING", "the Edge candidate", async () =>
          (await port.health(catalog.origin)).candidateContractRevision === catalog.targetRevision);
        return { ...record, data: { ...record.data, activate } };
      }
      case "connector_tag": {
        const bootstrap = await this.workflow(record, "bootstrap", { workflow: "release-tag-bootstrap.yml", tag: record.data.tag! });
        return { ...record, data: { ...record.data, bootstrap } };
      }
      case "connector_release": {
        const release = await this.workflow(record, "release", {
          workflow: "release.yml",
          tag: record.data.tag!,
          bootstrapOperationId: record.data.bootstrap!.operationId,
        });
        return { ...record, data: { ...record.data, release } };
      }
      case "oracle_prepare": {
        const releaseId = record.data.tag!.slice(1);
        let taskId = record.data.prepareTaskId;
        if (taskId === undefined) {
          if (record.data.prepareRequested && confirmationId === undefined) {
            throw new StopUpdate("PREPARE_OUTCOME_UNKNOWN", "prepare_release was requested but its answer was lost; read get_release_state, never prepare again.");
          }
          await this.save({ ...record, data: { ...record.data, prepareRequested: true } });
          const prepared = await port.prepare(record.data.tag!, confirmationId);
          if (prepared.status === "confirmation_required") {
            throw new StopUpdate("CONFIRMATION_REQUIRED", "prepare_release asks for confirmation.", {
              step: "oracle_prepare", confirmationId: prepared.confirmationId, reasons: prepared.reasons, expiresAt: prepared.expiresAt,
            });
          }
          taskId = prepared.taskId;
          await this.save({ ...record, data: { ...record.data, prepareRequested: true, prepareTaskId: taskId } });
        }
        await this.until("PREPARE_TIMEOUT", "prepare_release", async () => {
          const state = await port.task(taskId!);
          if (state === "failed") throw new StopUpdate("PREPARE_FAILED", `The prepare_release task ${taskId} failed.`);
          return state === "succeeded";
        });
        const state = await port.releaseState();
        if (state.candidate !== releaseId) throw new StopUpdate("CANDIDATE_MISSING", `prepare_release ended without candidate ${releaseId}.`);
        return { ...record, data: { ...record.data, prepareRequested: true, prepareTaskId: taskId } };
      }
      case "oracle_promote": {
        const releaseId = record.data.tag!.slice(1);
        let promoted = record;
        if (!record.data.promoteRequested || confirmationId !== undefined) {
          promoted = { ...record, data: { ...record.data, promoteRequested: true, promoteStartedAt: this.now().toISOString() } };
          await this.save(promoted);
          const result = await port.promote(releaseId, confirmationId);
          if (result.status === "confirmation_required") {
            throw new StopUpdate("CONFIRMATION_REQUIRED", "promote_release asks for confirmation.", {
              step: "oracle_promote", confirmationId: result.confirmationId, reasons: result.reasons, expiresAt: result.expiresAt,
            });
          }
        }
        // This process is usually replaced here; its successor resumes the wait.
        await this.until("PROMOTE_TIMEOUT", "the promote", async () => {
          const state = await port.releaseState();
          if (state.active === releaseId) return true;
          if (state.active === record.data.activeBefore && state.candidate === null) {
            throw new StopUpdate("ROLLED_BACK", `The execution node went back to ${state.active}.`);
          }
          return false;
        }, promoted.data.promoteStartedAt);
        return promoted;
      }
      case "oracle_verify": {
        const catalog = record.data.catalog!;
        const health = await port.health(catalog.origin);
        const problems = [
          health.activeContractRevision !== catalog.targetRevision ? `activeContractRevision ${health.activeContractRevision}` : null,
          health.candidateContractRevision !== null ? `candidateContractRevision ${health.candidateContractRevision}` : null,
          health.toolCount !== catalog.targetToolCount ? `toolCount ${health.toolCount ?? "(none)"}` : null,
          health.connectorInstanceId !== null && health.connectorInstanceId === record.data.connectorInstanceBefore
            ? "the same connectorInstanceId" : null,
        ].filter((problem): problem is string => problem !== null);
        if (problems.length > 0) throw new StopUpdate("HEALTH_MISMATCH", `/health after the promote shows ${problems.join(", ")}.`);
        return record;
      }
    }
  }

  /** Dispatches once (the operationId is saved first) and follows the run to success. */
  private async workflow(
    record: McpUpdateRecord,
    key: "stage" | "activate" | "bootstrap" | "release",
    call: Omit<McpUpdateWorkflowCall, "expectedMainSha" | "operationId">,
  ): Promise<McpUpdateWorkflowRun> {
    const port = this.options.port;
    let run = record.data[key];
    const full = (operationId: string): McpUpdateWorkflowCall => ({ ...call, expectedMainSha: record.mainSha, operationId });
    if (run === undefined) {
      run = { operationId: this.newId() };
      await this.save({ ...record, data: { ...record.data, [key]: run } });
      const dispatched = await port.dispatch(full(run.operationId));
      if (dispatched.status === "observed" && dispatched.state === "completed" && dispatched.conclusion !== "success") {
        throw new StopUpdate("WORKFLOW_FAILED", `${call.workflow} ended ${dispatched.conclusion}.`);
      }
    }
    const operationId = run.operationId;
    let runId: number | undefined;
    await this.until("WORKFLOW_TIMEOUT", call.workflow, async () => {
      const observed = await port.reconcile(full(operationId));
      if (observed.status !== "observed") return false;
      runId = observed.runId;
      if (observed.state !== "completed") return false;
      if (observed.conclusion !== "success") {
        throw new StopUpdate("WORKFLOW_FAILED", `${call.workflow} run ${observed.runId} ended ${observed.conclusion}.`);
      }
      return true;
    });
    return { operationId, runId: runId! };
  }

  private async until(code: string, what: string, done: () => Promise<boolean>, since?: string): Promise<void> {
    const deadline = (since === undefined ? this.now().getTime() : Date.parse(since)) + this.stepTimeoutMs;
    for (;;) {
      if (await done()) return;
      if (this.now().getTime() >= deadline) throw new StopUpdate(code, `Gave up waiting for ${what}.`);
      await this.sleep(this.pollMs);
    }
  }

  private report(record: McpUpdateRecord): void {
    if (record.planId === undefined || !this.options.port.progress) return;
    const at = MCP_UPDATE_STEPS.indexOf(record.step);
    const steps = MCP_UPDATE_STEPS.map((step, index) => ({
      text: STEP_TEXT[step],
      state: record.skipped.includes(step) ? "skipped" as const
        : index < at || record.status === "succeeded" ? "done" as const
          : index > at ? "todo" as const
            : record.status === "failed" ? "failed" as const
              : "doing" as const,
    }));
    const title = record.status === "succeeded" ? "MCP atualizado"
      : record.status === "failed" ? "Atualização do MCP parou"
        : record.status === "needs_confirmation" ? "Atualização do MCP: falta uma confirmação"
          : "Atualizando o MCP";
    this.options.port.progress(record.planId, title, steps);
  }

  private file(updateId: string): string {
    return path.join(this.options.stateDirectory, `${updateId}.json`);
  }

  private async save(record: McpUpdateRecord): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true });
    const saved = { ...record, updatedAt: this.now().toISOString() };
    const target = this.file(record.updateId);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  private async load(updateId: string): Promise<McpUpdateRecord | null> {
    if (!UPDATE_FILE.test(`${updateId}.json`)) return null;
    try {
      return JSON.parse(await readFile(this.file(updateId), "utf8")) as McpUpdateRecord;
    } catch {
      return null;
    }
  }

  private async require(updateId: string): Promise<McpUpdateRecord> {
    const record = await this.load(updateId);
    if (!record) throw new StopUpdate("NOT_FOUND", `No update ${updateId}.`);
    return record;
  }

  private async list(): Promise<McpUpdateRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.options.stateDirectory);
    } catch {
      return [];
    }
    const records: McpUpdateRecord[] = [];
    for (const name of names.filter((entry) => UPDATE_FILE.test(entry))) {
      const record = await this.load(name.slice(0, -".json".length));
      if (record) records.push(record);
    }
    return records;
  }
}

/** 1.1.0-beta.102-connector.1 → 1.1.0-beta.103-connector.1 */
export function nextConnectorRelease(active: string): string {
  const match = CONNECTOR_RELEASE.exec(active);
  if (!match) throw new StopUpdate("UNEXPECTED_ACTIVE_RELEASE", `Cannot derive the next tag from ${active}.`);
  return `${match[1]}.${match[2]}.${match[3]}-beta.${Number(match[4]) + 1}-connector.1`;
}

export { StopUpdate as McpUpdateError };
