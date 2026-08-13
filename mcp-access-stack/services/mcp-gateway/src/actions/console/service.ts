import { randomBytes } from "node:crypto";
import { AppError, asAppError } from "@vs-code-gpt/shared";

export {
  consoleApprovalKindValues,
  consoleApprovalStateValues,
  consoleFileStateValues,
  consoleOutcomeValues,
  consoleRunStatusValues,
  consoleStageValues,
  consoleValidationStateValues,
} from "./model.js";
import { renderConsole, stageLabel, validationStateLabel } from "./renderer.js";
import {
  operationCompletionLabel,
  operationLabel,
  projectConsoleOperation,
  stageForOperation,
} from "./operation-projection.js";
export type {
  ConsoleApprovalKind,
  ConsoleApprovalSnapshot,
  ConsoleApprovalState,
  ConsoleApprovalUpdate,
  ConsoleEvent,
  ConsoleEventsResult,
  ConsoleFileSnapshot,
  ConsoleFileState,
  ConsoleFileUpdate,
  ConsoleOutcome,
  ConsoleRunSnapshot,
  ConsoleRunStatus,
  ConsoleStage,
  ConsoleValidationSnapshot,
  ConsoleValidationState,
  ConsoleValidationUpdate,
  FinishConsoleRunInput,
  StartConsoleRunInput,
  UpdateConsoleRunInput,
} from "./model.js";
import {
  consoleStageValues,
  type ConsoleApprovalSnapshot,
  type ConsoleApprovalUpdate,
  type ConsoleEvent,
  type ConsoleEventsResult,
  type ConsoleFileSnapshot,
  type ConsoleFileState,
  type ConsoleFileUpdate,
  type ConsoleRunSnapshot,
  type ConsoleStage,
  type ConsoleValidationSnapshot,
  type ConsoleValidationUpdate,
  type FinishConsoleRunInput,
  type MutableConsoleRun,
  type StartConsoleRunInput,
  type UpdateConsoleRunInput,
} from "./model.js";

export interface GptActionConsoleOptions {
  now?: (() => number) | undefined;
  ttlMs?: number | undefined;
  maxRuns?: number | undefined;
  maxEventsPerRun?: number | undefined;
}

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1_000;
const DEFAULT_MAX_RUNS = 50;
const DEFAULT_MAX_EVENTS_PER_RUN = 200;
const SNAPSHOT_EVENT_LIMIT = 20;
const EVENT_PAGE_LIMIT = 100;
const MAX_TRACKED_FILES = 200;
const MAX_TRACKED_VALIDATIONS = 50;
const STAGE_RANK = new Map<ConsoleStage, number>(
  consoleStageValues.map((stage, index) => [stage, index]),
);

export class GptActionConsole {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxRuns: number;
  private readonly maxEventsPerRun: number;
  private readonly runs = new Map<string, MutableConsoleRun>();

  constructor(options: GptActionConsoleOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.maxEventsPerRun = options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN;
  }

  start(input: StartConsoleRunInput): ConsoleRunSnapshot {
    this.pruneExpired();
    this.ensureCapacity();
    const now = this.now();
    const run: MutableConsoleRun = {
      runId: this.createRunId(now),
      workspaceId: input.workspaceId,
      root: normalizePath(input.root),
      objective: sanitizeText(input.objective, 500),
      ...(input.expectedBranch === undefined
        ? {}
        : { expectedBranch: sanitizeText(input.expectedBranch, 200) }),
      status: "running",
      stage: "preparation",
      progress: 5,
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + this.ttlMs,
      nextSequence: 1,
      files: new Map(),
      validations: new Map(),
      approvals: new Map(),
      events: [],
    };
    this.runs.set(run.runId, run);
    this.appendEvent(run, {
      kind: "run_started",
      status: "completed",
      label: "Execução iniciada",
    });
    return this.snapshot(run);
  }

  get(runId: string): ConsoleRunSnapshot {
    return this.snapshot(this.requireRun(runId));
  }

  update(input: UpdateConsoleRunInput): ConsoleRunSnapshot {
    const run = this.requireRun(input.runId);
    this.assertMutable(run);

    if (input.stage !== undefined) {
      run.stage = input.stage;
      this.appendEvent(run, {
        kind: "stage_updated",
        status: "completed",
        label: `Etapa atualizada: ${stageLabel(input.stage)}`,
      });
    }
    if (input.status !== undefined) {
      run.status = input.status;
    }
    if (input.progress !== undefined) {
      run.progress = clampProgress(input.progress);
    }
    if (input.summary !== undefined) {
      run.summary = sanitizeText(input.summary, 500);
    }
    if (input.branch !== undefined) {
      run.branch = sanitizeText(input.branch, 200);
    }

    for (const file of input.files ?? []) {
      this.updateFile(run, file);
    }
    for (const validation of input.validations ?? []) {
      this.updateValidation(run, validation);
    }
    if (input.approval !== undefined) {
      this.updateApproval(run, input.approval);
    }

    this.touch(run);
    return this.snapshot(run);
  }

  finish(input: FinishConsoleRunInput): ConsoleRunSnapshot {
    const run = this.requireRun(input.runId);
    this.assertMutable(run);
    run.status = input.outcome;
    run.stage = "completed";
    run.progress = input.outcome === "completed" ? 100 : run.progress;
    if (input.summary !== undefined) {
      run.summary = sanitizeText(input.summary, 500);
    }
    this.appendEvent(run, {
      kind: "run_finished",
      status: input.outcome === "completed" ? "completed" : "failed",
      label:
        input.outcome === "completed"
          ? "Execução concluída"
          : input.outcome === "cancelled"
            ? "Execução cancelada"
            : "Execução encerrada com falha",
    });
    this.touch(run);
    return this.snapshot(run);
  }

  listEvents(runId: string, afterSequence = 0): ConsoleEventsResult {
    const run = this.requireRun(runId);
    const firstAvailableSequence = run.events[0]?.sequence ?? run.nextSequence;
    const historyWasPruned = afterSequence < firstAvailableSequence - 1;
    const matches = run.events.filter((event) => event.sequence > afterSequence);
    const events = matches.slice(0, EVENT_PAGE_LIMIT);
    return {
      runId: run.runId,
      afterSequence,
      nextSequence: events.at(-1)?.sequence ?? afterSequence,
      truncated: historyWasPruned || matches.length > events.length,
      events: events.map((event) => ({ ...event })),
      consoleMarkdown: renderConsole(run),
    };
  }

  startOperation(
    runId: string | undefined,
    operation: string,
    workspaceId: string | undefined,
  ): number | undefined {
    if (runId === undefined) return undefined;
    const run = this.requireRun(runId);
    this.assertMutable(run);
    if (workspaceId !== undefined && workspaceId !== run.workspaceId) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Console execution belongs to a different workspace.",
      );
    }
    const stage = stageForOperation(operation);
    this.advanceStage(run, stage);
    const event = this.appendEvent(run, {
      kind: "operation_started",
      status: "running",
      operation,
      label: `${operationLabel(operation)} em execução`,
    });
    this.touch(run);
    return event.sequence;
  }

  completeOperation(
    runId: string | undefined,
    sequence: number | undefined,
    operation: string,
    result: unknown,
  ): void {
    if (runId === undefined || sequence === undefined) return;
    const run = this.requireRun(runId);
    this.applyOperationResult(run, operation, result);
    this.appendEvent(run, {
      kind: "operation_completed",
      status:
        run.status === "waiting_confirmation"
          ? "waiting_confirmation"
          : "completed",
      operation,
      label: operationCompletionLabel(operation, result),
    });
    this.touch(run);
  }

  failOperation(
    runId: string | undefined,
    sequence: number | undefined,
    operation: string,
    error: unknown,
  ): void {
    if (runId === undefined || sequence === undefined) return;
    const run = this.requireRun(runId);
    const appError = asAppError(error);
    this.appendEvent(run, {
      kind: "operation_failed",
      status: "failed",
      operation,
      label: `${operationLabel(operation)} falhou (${appError.code})`,
    });
    this.touch(run);
  }

  private applyOperationResult(
    run: MutableConsoleRun,
    operation: string,
    result: unknown,
  ): void {
    const projection = projectConsoleOperation(operation, result, run.status);
    if (projection.branch !== undefined) {
      run.branch = sanitizeText(projection.branch, 200);
    }
    if (projection.status !== undefined) {
      run.status = projection.status;
    }
    for (const file of projection.files) {
      this.updateFile(run, file, false);
    }
    for (const validation of projection.validations) {
      this.updateValidation(run, validation, false);
    }
    if (projection.approval !== undefined) {
      this.updateApproval(run, projection.approval, false);
    }
    if (projection.minProgress !== undefined) {
      run.progress = Math.max(run.progress, projection.minProgress);
    }
    if (projection.stage !== undefined) {
      this.advanceStage(run, projection.stage);
    }
  }

  private updateFile(
    run: MutableConsoleRun,
    file: ConsoleFileUpdate,
    addEvent = true,
  ): void {
    const now = this.now();
    const normalized: ConsoleFileSnapshot = {
      path: normalizePath(file.path),
      state: file.state,
      ...(file.additions === undefined ? {} : { additions: nonNegative(file.additions) }),
      ...(file.deletions === undefined ? {} : { deletions: nonNegative(file.deletions) }),
      updatedAt: iso(now),
    };
    evictOldestMapEntry(run.files, normalized.path, MAX_TRACKED_FILES);
    run.files.set(normalized.path, normalized);
    if (addEvent) {
      this.appendEvent(run, {
        kind: "file_updated",
        status: "completed",
        label: `${fileStateLabel(file.state)}: ${normalized.path}`,
      });
    }
  }

  private updateValidation(
    run: MutableConsoleRun,
    validation: ConsoleValidationUpdate,
    addEvent = true,
  ): void {
    const now = this.now();
    const normalized: ConsoleValidationSnapshot = {
      name: sanitizeText(validation.name, 100),
      state: validation.state,
      ...(validation.summary === undefined
        ? {}
        : { summary: sanitizeText(validation.summary, 300) }),
      updatedAt: iso(now),
    };
    evictOldestMapEntry(
      run.validations,
      normalized.name,
      MAX_TRACKED_VALIDATIONS,
    );
    run.validations.set(normalized.name, normalized);
    if (addEvent) {
      this.appendEvent(run, {
        kind: "validation_updated",
        status: validation.state === "failed" ? "failed" : "completed",
        label: `${normalized.name}: ${validationStateLabel(validation.state)}`,
      });
    }
  }

  private updateApproval(
    run: MutableConsoleRun,
    approval: ConsoleApprovalUpdate,
    addEvent = true,
  ): void {
    const now = this.now();
    const normalized: ConsoleApprovalSnapshot = {
      kind: approval.kind,
      state: approval.state,
      label: sanitizeText(approval.label, 300),
      updatedAt: iso(now),
    };
    run.approvals.set(normalized.kind, normalized);
    if (approval.state === "required") {
      run.status = "waiting_confirmation";
    } else if (
      run.status === "waiting_confirmation" &&
      [...run.approvals.values()].every((item) => item.state !== "required")
    ) {
      run.status = "running";
    }
    if (addEvent) {
      this.appendEvent(run, {
        kind: "approval_updated",
        status:
          approval.state === "required"
            ? "waiting_confirmation"
            : approval.state === "rejected"
              ? "failed"
              : "completed",
        label: normalized.label,
      });
    }
  }

  private appendEvent(
    run: MutableConsoleRun,
    input: Omit<ConsoleEvent, "sequence" | "timestamp" | "stage">,
  ): ConsoleEvent {
    const event: ConsoleEvent = {
      sequence: run.nextSequence,
      timestamp: iso(this.now()),
      kind: input.kind,
      stage: run.stage,
      status: input.status,
      ...(input.operation === undefined ? {} : { operation: input.operation }),
      label: sanitizeText(input.label, 300),
    };
    run.nextSequence += 1;
    run.events.push(event);
    if (run.events.length > this.maxEventsPerRun) {
      run.events.splice(0, run.events.length - this.maxEventsPerRun);
    }
    return event;
  }

  private snapshot(run: MutableConsoleRun): ConsoleRunSnapshot {
    return {
      runId: run.runId,
      workspaceId: run.workspaceId,
      root: run.root,
      objective: run.objective,
      ...(run.expectedBranch === undefined ? {} : { expectedBranch: run.expectedBranch }),
      ...(run.branch === undefined ? {} : { branch: run.branch }),
      status: run.status,
      stage: run.stage,
      progress: run.progress,
      ...(run.summary === undefined ? {} : { summary: run.summary }),
      createdAt: iso(run.createdAtMs),
      updatedAt: iso(run.updatedAtMs),
      expiresAt: iso(run.expiresAtMs),
      files: [...run.files.values()].sort((left, right) => left.path.localeCompare(right.path)),
      validations: [...run.validations.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      approvals: [...run.approvals.values()],
      events: run.events.slice(-SNAPSHOT_EVENT_LIMIT).map((event) => ({ ...event })),
      consoleMarkdown: renderConsole(run),
    };
  }

  private requireRun(runId: string): MutableConsoleRun {
    this.pruneExpired();
    const run = this.runs.get(runId);
    if (!run) {
      throw new AppError("EXECUTION_NOT_FOUND", "Console execution was not found or expired.");
    }
    return run;
  }

  private assertMutable(run: MutableConsoleRun): void {
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Console execution is already finished.",
      );
    }
  }

  private touch(run: MutableConsoleRun): void {
    const now = this.now();
    run.updatedAtMs = now;
    run.expiresAtMs = now + this.ttlMs;
  }

  private advanceStage(run: MutableConsoleRun, stage: ConsoleStage): void {
    const currentRank = STAGE_RANK.get(run.stage) ?? 0;
    const nextRank = STAGE_RANK.get(stage) ?? 0;
    if (nextRank > currentRank && run.stage !== "completed") {
      run.stage = stage;
    }
  }

  private createRunId(now: number): string {
    const date = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const suffix = randomBytes(8).toString("hex").toUpperCase();
      const runId = `MT-${date}-${suffix}`;
      if (!this.runs.has(runId)) return runId;
    }
    throw new AppError("INTERNAL_ERROR", "Unable to allocate a console execution id.");
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [runId, run] of this.runs) {
      if (run.expiresAtMs <= now) this.runs.delete(runId);
    }
  }

  private ensureCapacity(): void {
    if (this.runs.size < this.maxRuns) return;
    const candidates = [...this.runs.values()].sort(
      (left, right) => left.updatedAtMs - right.updatedAtMs,
    );
    const terminal = candidates.find((run) =>
      ["completed", "failed", "cancelled"].includes(run.status),
    );
    const eviction = terminal ?? candidates[0];
    if (eviction !== undefined) this.runs.delete(eviction.runId);
  }
}

function fileStateLabel(state: ConsoleFileState): string {
  const labels: Record<ConsoleFileState, string> = {
    read: "Arquivo lido",
    modified: "Arquivo alterado",
    created: "Arquivo criado",
    deleted: "Arquivo removido",
  };
  return labels[state];
}

function evictOldestMapEntry<T extends { updatedAt: string }>(
  values: Map<string, T>,
  incomingKey: string,
  limit: number,
): void {
  if (values.has(incomingKey) || values.size < limit) return;
  let oldestKey: string | undefined;
  let oldestTimestamp = Number.POSITIVE_INFINITY;
  for (const [key, value] of values) {
    const timestamp = Date.parse(value.updatedAt);
    if (timestamp < oldestTimestamp) {
      oldestTimestamp = timestamp;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) values.delete(oldestKey);
}

function sanitizeText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizePath(value: string): string {
  const normalized = sanitizeText(value, 500).replaceAll("\\", "/");
  return normalized.replace(/^\.\//u, "") || ".";
}

function clampProgress(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function nonNegative(value: number): number {
  return Math.max(0, Math.round(value));
}

function iso(value: number): string {
  return new Date(value).toISOString();
}
