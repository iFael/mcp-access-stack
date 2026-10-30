import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { CompanionUpdateRequest, CompanionUpdateStatus } from "./companion-update-runner.js";
import {
  prepareOnce,
  promoteOnce,
  releaseIdOf,
  saveRecord,
  StopUpdate,
  type ReleaseConfirmation,
  type ReleaseInstallContext,
  type ReleaseInstallData,
  type ReleaseInstallPort,
} from "./release-install.js";

// Publishes MAIN to the execution node by itself: the Edge catalog when the
// contract changes, the connector tag and signed release, then prepare and
// promote of that release here, then the Windows companion's release, which
// the user's companion installs when the node asks it through the Edge. Each
// step is the same typed operation an agent would call, in a fixed order,
// with the same one-shot rules: a dispatch is never repeated (an uncertain one
// is only reconciled), prepare and promote are each requested once, and any
// surprise stops the update for the agent. The record is written before every
// effect, so the process that the promote replaces is resumed by its
// successor at the step it reached.

export const MCP_UPDATE_STEPS = [
  "precheck",
  "edge_stage",
  "edge_activate",
  "connector_tag",
  "connector_release",
  "oracle_prepare",
  "oracle_promote",
  "oracle_verify",
  "companion_release",
  "windows_prepare",
  "windows_promote",
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
  companion_release: "Build e release do companion Windows",
  windows_prepare: "Prepare no Windows",
  windows_promote: "Promote no Windows (a tarefa de 5 minutos aplica a troca)",
};

// The workflow each step runs, whose GitHub page the card links to.
const STEP_RUN: Partial<Record<McpUpdateStep, "stage" | "activate" | "bootstrap" | "release" | "companion">> = {
  edge_stage: "stage",
  edge_activate: "activate",
  connector_tag: "bootstrap",
  connector_release: "release",
  companion_release: "companion",
};
const RUN_URL = "https://github.com/iFael/mcp-access-stack/actions/runs/";

const CONFIRMABLE_STEPS = ["oracle_prepare", "oracle_promote", "windows_prepare", "windows_promote"] as const;

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
  /** Who started it: the workflows it dispatches are theirs, as if they had called them. */
  ownerScope?: string;
  createdAt: string;
  updatedAt: string;
  status: McpUpdateStatus;
  step: McpUpdateStep;
  skipped: McpUpdateStep[];
  error?: { code: string; message: string };
  confirmation?: {
    step: (typeof CONFIRMABLE_STEPS)[number];
    confirmationId: string;
    reasons: string[];
    expiresAt: string;
  };
  data: ReleaseInstallData & {
    connectorInstanceBefore?: string;
    catalog?: { origin: string; previousRevision: string; targetRevision: string; targetToolCount: number };
    stage?: McpUpdateWorkflowRun;
    activate?: McpUpdateWorkflowRun;
    tag?: string;
    bootstrap?: McpUpdateWorkflowRun;
    release?: McpUpdateWorkflowRun;
    /** The successful push CI of MAIN that built the companion. */
    companionCiRunId?: number;
    companion?: McpUpdateWorkflowRun;
    companionTag?: string;
    /** Raised by each resume at a Windows step. */
    windowsAttempt?: number;
  };
}

export type McpUpdateWorkflow =
  | "edge-cas-candidate-stage.yml"
  | "edge-catalog-activate.yml"
  | "release-tag-bootstrap.yml"
  | "release.yml"
  | "companion-only-distribution.yml";

export interface McpUpdateWorkflowCall {
  workflow: McpUpdateWorkflow;
  expectedMainSha: string;
  operationId: string;
  tag?: string;
  bootstrapOperationId?: string;
  stageRunId?: number;
  ciRunId?: number;
  ownerScope?: string;
}

export type McpUpdateWorkflowObservation =
  | { status: "submitted" | "outcome_unknown" }
  | { status: "observed"; runId: number; state: "queued" | "in_progress" | "completed"; conclusion: string | null };

export type McpUpdateConfirmation = ReleaseConfirmation;

export interface McpUpdatePort extends ReleaseInstallPort {
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
  dispatch(call: McpUpdateWorkflowCall): Promise<McpUpdateWorkflowObservation>;
  reconcile(call: McpUpdateWorkflowCall): Promise<McpUpdateWorkflowObservation>;
  /** The successful push run of the CI workflow on that main commit, or null. */
  ciRun(sha: string): Promise<number | null>;
  /** That companion release is on GitHub with its archive and checksum. */
  companionReleased(tag: string): Promise<boolean>;
  /** Asks the user's companions, through the Edge, to install the Windows release; repeated while waiting. */
  requestCompanionUpdate(request: CompanionUpdateRequest): void;
  /** The plan card the agent opened, moved to the update's steps. */
  progress?(planId: string, title: string, steps: Array<{
    text: string;
    state: "done" | "doing" | "todo" | "failed" | "skipped";
    detail?: string;
    link?: string;
  }>): void;
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
  /** How long the companions may stay silent before the update says none can install it. */
  companionAnswerMs?: number;
}

const SHA = /^[0-9a-f]{40}$/u;
const PLAN_ID = /^plan_[0-9a-f-]{36}$/u;
const UPDATE_FILE = /^upd_[0-9a-f-]{36}\.json$/u;
const CONNECTOR_RELEASE = /^(\d+)\.(\d+)\.(\d+)-beta\.(\d+)-connector\.(\d+)$/u;

export class McpUpdateRunner {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollMs: number;
  private readonly stepTimeoutMs: number;
  private readonly companionAnswerMs: number;
  private readonly driving = new Set<string>();
  /** The latest answer of the companion for each update; it answers again whenever asked. */
  private readonly companionStatus = new Map<string, CompanionUpdateStatus>();
  /** What the step in progress waits for, shown under it on the card; not kept across restarts. */
  private readonly waiting = new Map<string, { step: McpUpdateStep; detail: string; runId?: number }>();

  constructor(private readonly options: McpUpdateRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms).unref()));
    this.pollMs = options.pollMs ?? 20_000;
    this.stepTimeoutMs = options.stepTimeoutMs ?? 45 * 60_000;
    this.companionAnswerMs = options.companionAnswerMs ?? 10 * 60_000;
  }

  /** A companion's answer, relayed by the Edge. */
  observeCompanionUpdate(status: CompanionUpdateStatus): void {
    this.companionStatus.set(status.updateId, status);
  }

  /** Picks up an update the previous process left running, usually across its own promote. */
  async recover(): Promise<void> {
    for (const record of await this.list()) {
      if (record.status === "running") this.drive(record.updateId);
    }
  }

  async start(input: { mainSha: string; planId?: string; ownerScope?: string }): Promise<McpUpdateRecord> {
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
      ...(input.ownerScope === undefined ? {} : { ownerScope: input.ownerScope }),
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

  /**
   * Continues a failed update from the step that failed, once the agent fixed
   * its cause. A workflow that ended in failure is dispatched again; what the
   * steps saved before keeps them from redoing anything else.
   */
  async resume(updateId: string): Promise<McpUpdateRecord> {
    const record = await this.require(updateId);
    if (record.status !== "failed") throw new StopUpdate("UPDATE_NOT_FAILED", `Update ${updateId} is ${record.status}; only a failed update resumes.`);
    const open = (await this.list()).find((other) => other.status === "running" || other.status === "needs_confirmation");
    if (open) throw new StopUpdate("UPDATE_IN_PROGRESS", `Update ${open.updateId} is ${open.status}.`);
    const { error, ...rest } = record;
    const run = STEP_RUN[record.step];
    const data = { ...rest.data };
    if (run !== undefined && error?.code === "WORKFLOW_FAILED") delete data[run];
    // The companion tries a failed install again only for a higher attempt.
    if (record.step === "windows_prepare" || record.step === "windows_promote") data.windowsAttempt = (data.windowsAttempt ?? 0) + 1;
    this.companionStatus.delete(updateId);
    const resumed: McpUpdateRecord = { ...rest, status: "running", data };
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
    void this.run(updateId).finally(() => {
      this.driving.delete(updateId);
      this.waiting.delete(updateId);
    });
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
      const step = latest.step as (typeof CONFIRMABLE_STEPS)[number];
      const confirmation = stop.confirmation && CONFIRMABLE_STEPS.includes(step) ? { step, ...stop.confirmation } : undefined;
      record = {
        ...latest,
        status: confirmation ? "needs_confirmation" : "failed",
        ...(confirmation ? { confirmation } : { error: { code: stop.code, message: stop.message } }),
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
        this.wait(record, "Esperando o CI da MAIN");
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
        const data = await prepareOnce(this.install(record, confirmationId), record.data.tag!, record.data);
        return { ...record, data: { ...record.data, ...data } };
      }
      case "oracle_promote": {
        // This process is usually replaced here; its successor resumes the wait.
        const data = await promoteOnce(this.install(record, confirmationId), releaseIdOf(record.data.tag!), record.data);
        return { ...record, data: { ...record.data, ...data } };
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
      case "companion_release": {
        let current = record;
        if (current.data.companionCiRunId === undefined) {
          const ciRunId = await port.ciRun(current.mainSha);
          if (ciRunId === null) throw new StopUpdate("CI_RUN_MISSING", "MAIN has no successful push CI run to publish the companion from.");
          // Its release id: the version of the connector tag just made on MAIN, then the CI run.
          const version = releaseIdOf(current.data.tag!).split("-")[0]!;
          current = { ...current, data: { ...current.data, companionCiRunId: ciRunId, companionTag: `v${version}-companion.${ciRunId}` } };
          await this.save(current);
        }
        // Published before, by hand or by an earlier run: the workflow refuses to publish it twice.
        const tag = current.data.companionTag!;
        if (current.data.companion === undefined && await port.companionReleased(tag)) return current;
        try {
          const companion = await this.workflow(current, "companion", {
            workflow: "companion-only-distribution.yml",
            ciRunId: current.data.companionCiRunId!,
          });
          return { ...current, data: { ...current.data, companion } };
        } catch (error) {
          if (error instanceof StopUpdate && error.code === "WORKFLOW_FAILED" && await port.companionReleased(tag)) return current;
          throw error;
        }
      }
      case "windows_prepare":
        await this.windows(record, confirmationId, (status) => status.phase === "promote" || status.state === "succeeded");
        return record;
      case "windows_promote":
        await this.windows(record, confirmationId, (status) => status.state === "succeeded");
        return record;
    }
  }

  private install(record: McpUpdateRecord, confirmationId: string | undefined): ReleaseInstallContext {
    return {
      port: this.options.port,
      save: (data) => this.save({ ...record, data: { ...record.data, ...data } }),
      until: (code, what, done, since) => this.until(code, what, done, since),
      now: this.now,
      confirmationId,
      ownerScope: record.ownerScope,
    };
  }

  /** Asks the companions again on every poll and follows the answer of the one that installs it. */
  private async windows(record: McpUpdateRecord, confirmationId: string | undefined,
    done: (status: CompanionUpdateStatus) => boolean): Promise<void> {
    const request: CompanionUpdateRequest = {
      updateId: record.updateId,
      tag: record.data.companionTag!,
      ...(confirmationId === undefined ? {} : { confirmationId }),
      ...(record.data.windowsAttempt === undefined ? {} : { attempt: record.data.windowsAttempt }),
    };
    const askedSince = this.now().getTime();
    await this.until("WINDOWS_TIMEOUT", "the Windows companion", async () => {
      this.options.port.requestCompanionUpdate(request);
      const status = this.companionStatus.get(record.updateId);
      this.wait(record, status === undefined ? "Esperando o companion do Windows responder"
        : status.phase === "promote" ? "Esperando a tarefa de 5 minutos aplicar a troca"
          : "Instalando no Windows; costuma levar uns 16 min");
      if (status === undefined) {
        if (this.now().getTime() - askedSince >= this.companionAnswerMs) {
          throw new StopUpdate("COMPANION_NOT_ANSWERING",
            "No Windows companion that installs updates answered; install it by hand (get_operation_guide topic=companion).");
        }
        return false;
      }
      if (status.state === "failed") {
        throw new StopUpdate(status.error?.code ?? "WINDOWS_FAILED", `Windows: ${status.error?.message ?? "the install failed."}`);
      }
      if (done(status)) return true;
      // A confirmation the user already approved is still in the last answer until the companion answers again.
      if (status.state === "needs_confirmation" && status.confirmation !== undefined &&
          status.confirmation.confirmationId !== confirmationId) {
        throw new StopUpdate("CONFIRMATION_REQUIRED", `Windows: ${status.phase}_release asks for confirmation.`, status.confirmation);
      }
      return false;
    });
  }

  /** Dispatches once (the operationId is saved first) and follows the run to success. */
  private async workflow(
    record: McpUpdateRecord,
    key: "stage" | "activate" | "bootstrap" | "release" | "companion",
    call: Omit<McpUpdateWorkflowCall, "expectedMainSha" | "operationId">,
  ): Promise<McpUpdateWorkflowRun> {
    const port = this.options.port;
    let run = record.data[key];
    const full = (operationId: string): McpUpdateWorkflowCall => ({ ...call, expectedMainSha: record.mainSha, operationId,
      ...(record.ownerScope === undefined ? {} : { ownerScope: record.ownerScope }) });
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
      if (observed.status !== "observed") {
        this.wait(record, "Esperando o GitHub mostrar o run");
        return false;
      }
      runId = observed.runId;
      if (observed.state !== "completed") {
        this.wait(record, observed.state === "queued" ? "Na fila do GitHub" : "Rodando no GitHub", observed.runId);
        return false;
      }
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

  /** Says on the card what the step in progress waits for, when that changes. */
  private wait(record: McpUpdateRecord, detail: string, runId?: number): void {
    const before = this.waiting.get(record.updateId);
    if (before?.step === record.step && before.detail === detail && before.runId === runId) return;
    this.waiting.set(record.updateId, { step: record.step, detail, ...(runId === undefined ? {} : { runId }) });
    this.report(record);
  }

  private report(record: McpUpdateRecord): void {
    if (record.planId === undefined || !this.options.port.progress) return;
    const at = MCP_UPDATE_STEPS.indexOf(record.step);
    const waiting = this.waiting.get(record.updateId);
    const steps = MCP_UPDATE_STEPS.map((step, index) => {
      const state = record.skipped.includes(step) ? "skipped" as const
        : index < at || record.status === "succeeded" ? "done" as const
          : index > at ? "todo" as const
            : record.status === "failed" ? "failed" as const
              : "doing" as const;
      const run = STEP_RUN[step];
      const runId = (run === undefined ? undefined : record.data[run]?.runId) ??
        (waiting?.step === step ? waiting.runId : undefined);
      const detail = state === "failed" ? record.error?.message.slice(0, 160)
        : state === "doing" && waiting?.step === step ? waiting.detail : undefined;
      return {
        text: STEP_TEXT[step],
        state,
        ...(detail === undefined ? {} : { detail }),
        ...(runId === undefined ? {} : { link: `${RUN_URL}${runId}` }),
      };
    });
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
    const saved = { ...record, updatedAt: this.now().toISOString() };
    await saveRecord(this.file(record.updateId), `${JSON.stringify(saved, null, 2)}\n`);
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
