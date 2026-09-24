import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  asAppError,
  githubCommitChecksWatchRecordSchema,
  githubGetCommitChecksInputSchema,
  githubGetCommitChecksWatchesInputSchema,
  githubGetCommitChecksWatchesResultSchema,
  githubStartCommitChecksWatchInputSchema,
  githubStartCommitChecksWatchResultSchema,
  githubWaitCommitChecksWatchInputSchema,
  githubWaitCommitChecksWatchResultSchema,
  redactSensitiveText,
  type ErrorCode,
  type GitHubCommitChecksResult,
  type GitHubCommitChecksWatchRecord,
  type GitHubGetCommitChecksInput,
  type GitHubGetCommitChecksWatchesInput,
  type GitHubGetCommitChecksWatchesResult,
  type GitHubStartCommitChecksWatchInput,
  type GitHubStartCommitChecksWatchResult,
  type GitHubWaitCommitChecksWatchInput,
  type GitHubWaitCommitChecksWatchResult,
  type OperationContext,
} from "@vs-code-gpt/shared";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_MAX_ACTIVE_WATCHES = 8;
const OWNER_SCOPE_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const WATCH_FILE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu;

interface PersistedGitHubCommitChecksWatchRecord
  extends GitHubCommitChecksWatchRecord {
  ownerScopeHash?: string;
}

export interface GitHubCommitChecksWatchAccess {
  ownerScope?: string;
}

export interface GitHubCommitChecksWatchManagerOptions {
  stateDirectory: string;
  poll: (
    input: GitHubGetCommitChecksInput,
    context: OperationContext,
  ) => Promise<GitHubCommitChecksResult>;
  pollIntervalMs?: number;
  maxActiveWatches?: number;
  now?: () => Date;
}

export class GitHubCommitChecksWatchManager {
  private readonly stateDirectory: string;
  private readonly pollIntervalMs: number;
  private readonly maxActiveWatches: number;
  private readonly now: () => Date;
  private readonly records = new Map<
    string,
    PersistedGitHubCommitChecksWatchRecord
  >();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly polling = new Set<string>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private readonly terminalWaiters = new Map<string, Set<() => void>>();
  private readonly ownerScopes = new Map<string, string>();
  private initializePromise: Promise<void> | undefined;
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: GitHubCommitChecksWatchManagerOptions) {
    this.stateDirectory = path.resolve(options.stateDirectory);
    this.pollIntervalMs = positiveInteger(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.maxActiveWatches = positiveInteger(
      options.maxActiveWatches,
      DEFAULT_MAX_ACTIVE_WATCHES,
      "maxActiveWatches",
    );
    this.now = options.now ?? (() => new Date());
  }

  async recover(): Promise<void> {
    await this.ensureInitialized();
  }

  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  start(
    input: GitHubStartCommitChecksWatchInput,
    context: OperationContext = {},
  ): Promise<GitHubStartCommitChecksWatchResult> {
    const operation = this.startQueue
      .catch(() => undefined)
      .then(() => this.startSerialized(input, context));
    this.startQueue = operation;
    return operation;
  }

  async get(
    input: GitHubGetCommitChecksWatchesInput,
    access: GitHubCommitChecksWatchAccess = {},
  ): Promise<GitHubGetCommitChecksWatchesResult> {
    await this.ensureInitialized();
    const parsed = githubGetCommitChecksWatchesInputSchema.parse(input);
    await this.expireOverdueWatches();
    const ownerScopeHash = hashOwnerScope(access.ownerScope);
    const visible = [...this.records.values()].filter(
      (record) =>
        record.workspaceId === parsed.workspaceId &&
        record.ownerScopeHash === ownerScopeHash &&
        (parsed.state === undefined || record.state === parsed.state),
    );

    if (parsed.ids !== undefined) {
      const byId = new Map(visible.map((record) => [record.id, record]));
      return githubGetCommitChecksWatchesResultSchema.parse({
        watches: parsed.ids
          .map((id) => byId.get(id))
          .filter(
            (
              record,
            ): record is PersistedGitHubCommitChecksWatchRecord =>
              record !== undefined,
          )
          .map(toPublicRecord),
        truncated: false,
      });
    }

    visible.sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt),
    );
    return githubGetCommitChecksWatchesResultSchema.parse({
      watches: visible.slice(0, 50).map(toPublicRecord),
      truncated: visible.length > 50,
    });
  }

  async wait(
    input: GitHubWaitCommitChecksWatchInput,
    access: GitHubCommitChecksWatchAccess = {},
  ): Promise<GitHubWaitCommitChecksWatchResult> {
    await this.ensureInitialized();
    const parsed = githubWaitCommitChecksWatchInputSchema.parse(input);
    await this.expireOverdueWatches();
    let record = this.requireVisibleRecord(
      parsed.workspaceId,
      parsed.id,
      access,
    );
    if (isTerminal(record)) {
      return githubWaitCommitChecksWatchResultSchema.parse({
        watch: toPublicRecord(record),
        timedOut: false,
      });
    }

    let timer: NodeJS.Timeout | undefined;
    let waiter: (() => void) | undefined;
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          waiter = resolve;
          const waiters = this.terminalWaiters.get(parsed.id) ?? new Set();
          waiters.add(resolve);
          this.terminalWaiters.set(parsed.id, waiters);
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, parsed.timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (waiter !== undefined) {
        const waiters = this.terminalWaiters.get(parsed.id);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.terminalWaiters.delete(parsed.id);
      }
    }

    await this.expireOverdueWatches();
    record = this.requireVisibleRecord(parsed.workspaceId, parsed.id, access);
    return githubWaitCommitChecksWatchResultSchema.parse({
      watch: toPublicRecord(record),
      timedOut: !isTerminal(record),
    });
  }

  private async startSerialized(
    input: GitHubStartCommitChecksWatchInput,
    context: OperationContext,
  ): Promise<GitHubStartCommitChecksWatchResult> {
    await this.ensureInitialized();
    const parsed = githubStartCommitChecksWatchInputSchema.parse(input);
    await this.expireOverdueWatches();
    const ownerScopeHash = hashOwnerScope(context.ownerScope);
    const root = parsed.root ?? ".";

    const existing = [...this.records.values()].find(
      (record) =>
        record.state === "watching" &&
        record.workspaceId === parsed.workspaceId &&
        record.root === root &&
        record.owner === parsed.owner &&
        record.repository === parsed.repository &&
        record.commitSha === parsed.commitSha &&
        record.ownerScopeHash === ownerScopeHash,
    );
    if (existing !== undefined) {
      if (context.ownerScope !== undefined) {
        this.ownerScopes.set(existing.id, context.ownerScope);
      }
      return githubStartCommitChecksWatchResultSchema.parse({
        status: "existing",
        watch: toPublicRecord(existing),
      });
    }

    const activeCount = [...this.records.values()].filter(
      (record) => record.state === "watching",
    ).length;
    if (activeCount >= this.maxActiveWatches) {
      throw new AppError(
        "LIMIT_EXCEEDED",
        "Maximum active GitHub commit-check watches reached.",
      );
    }

    const now = this.now();
    const createdAt = now.toISOString();
    const record = validatePersistedRecord({
      id: randomUUID(),
      workspaceId: parsed.workspaceId,
      root,
      owner: parsed.owner,
      repository: parsed.repository,
      commitSha: parsed.commitSha,
      state: "watching",
      createdAt,
      updatedAt: createdAt,
      deadlineAt: new Date(now.getTime() + parsed.timeoutMs).toISOString(),
      pollCount: 0,
      ...(ownerScopeHash === undefined ? {} : { ownerScopeHash }),
    });
    await this.persist(record);
    if (context.ownerScope !== undefined) {
      this.ownerScopes.set(record.id, context.ownerScope);
    }
    await this.pollOnce(record.id, context.ownerScope);

    const current = this.records.get(record.id);
    if (current === undefined) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "GitHub commit-check watch disappeared after start.",
      );
    }
    return githubStartCommitChecksWatchResultSchema.parse({
      status: "started",
      watch: toPublicRecord(current),
    });
  }

  private async ensureInitialized(): Promise<void> {
    this.initializePromise ??= this.initialize();
    await this.initializePromise;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const entries = await readdir(this.stateDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !WATCH_FILE_PATTERN.test(entry.name)) continue;
      const filePath = path.join(this.stateDirectory, entry.name);
      try {
        const record = validatePersistedRecord(
          JSON.parse(await readFile(filePath, "utf8")) as unknown,
        );
        this.records.set(record.id, record);
      } catch {
        await this.quarantine(filePath, entry.name);
      }
    }

    await this.expireOverdueWatches();
    for (const record of this.records.values()) {
      if (record.state === "watching") this.schedule(record.id);
    }
  }

  private async pollOnce(
    id: string,
    ownerScope?: string,
  ): Promise<void> {
    if (this.polling.has(id)) return;
    const record = this.records.get(id);
    if (record === undefined || record.state !== "watching") return;
    this.polling.add(id);
    try {
      if (this.isPastDeadline(record)) {
        await this.completeTimedOut(record);
        return;
      }

      try {
        const checks = await this.options.poll(
          githubGetCommitChecksInputSchema.parse({
            workspaceId: record.workspaceId,
            root: record.root,
            owner: record.owner,
            repository: record.repository,
            commitSha: record.commitSha,
          }),
          ownerScope === undefined ? {} : { ownerScope },
        );
        const updatedAt = this.now().toISOString();
        const pollCount = record.pollCount + 1;

        if (checks.truncated) {
          await this.completeError(
            record,
            "EXECUTION_STATE_INVALID",
            "GitHub commit-check watch cannot determine aggregate state because more than 100 check-runs exist.",
            { checks, pollCount, updatedAt },
          );
          return;
        }

        if (checks.allCompleted) {
          await this.complete(record, checks.passed ? "passed" : "failed", {
            checks,
            pollCount,
            updatedAt,
          });
          return;
        }

        if (this.now().getTime() >= Date.parse(record.deadlineAt)) {
          await this.completeTimedOut(record, {
            checks,
            pollCount,
            updatedAt,
          });
          return;
        }

        await this.persist({
          ...record,
          updatedAt,
          pollCount,
          lastChecks: checks,
          lastError: undefined,
        });
      } catch (error) {
        const appError = asAppError(error);
        const updatedAt = this.now().toISOString();
        const pollCount = record.pollCount + 1;
        const message = redactSensitiveText(appError.message);
        if (
          isTransientPollError(appError.code) &&
          this.now().getTime() < Date.parse(record.deadlineAt)
        ) {
          await this.persist({
            ...record,
            updatedAt,
            pollCount,
            lastError: { code: appError.code, message },
          });
        } else {
          await this.completeError(record, appError.code, message, {
            pollCount,
            updatedAt,
          });
        }
      }
    } finally {
      this.polling.delete(id);
      const current = this.records.get(id);
      if (current?.state === "watching") this.schedule(id);
    }
  }

  private schedule(id: string): void {
    if (this.timers.has(id)) return;
    const record = this.records.get(id);
    if (record === undefined || record.state !== "watching") return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.pollOnce(id, this.ownerScopes.get(id));
    }, this.pollIntervalMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  private async expireOverdueWatches(): Promise<void> {
    const overdue = [...this.records.values()].filter(
      (record) => record.state === "watching" && this.isPastDeadline(record),
    );
    for (const record of overdue) await this.completeTimedOut(record);
  }

  private isPastDeadline(
    record: PersistedGitHubCommitChecksWatchRecord,
  ): boolean {
    return this.now().getTime() >= Date.parse(record.deadlineAt);
  }

  private async complete(
    record: PersistedGitHubCommitChecksWatchRecord,
    state: "passed" | "failed",
    update: {
      checks: GitHubCommitChecksResult;
      pollCount: number;
      updatedAt: string;
    },
  ): Promise<void> {
    await this.persist({
      ...record,
      state,
      updatedAt: update.updatedAt,
      completedAt: update.updatedAt,
      pollCount: update.pollCount,
      lastChecks: update.checks,
      lastError: undefined,
    });
    this.notifyTerminal(record.id);
  }

  private async completeTimedOut(
    record: PersistedGitHubCommitChecksWatchRecord,
    update?: {
      checks?: GitHubCommitChecksResult;
      pollCount?: number;
      updatedAt?: string;
    },
  ): Promise<void> {
    const updatedAt = update?.updatedAt ?? this.now().toISOString();
    await this.persist({
      ...record,
      state: "timed_out",
      updatedAt,
      completedAt: updatedAt,
      pollCount: update?.pollCount ?? record.pollCount,
      ...(update?.checks === undefined ? {} : { lastChecks: update.checks }),
    });
    this.notifyTerminal(record.id);
  }

  private async completeError(
    record: PersistedGitHubCommitChecksWatchRecord,
    code: ErrorCode,
    message: string,
    update: {
      checks?: GitHubCommitChecksResult;
      pollCount: number;
      updatedAt: string;
    },
  ): Promise<void> {
    await this.persist({
      ...record,
      state: "error",
      updatedAt: update.updatedAt,
      completedAt: update.updatedAt,
      pollCount: update.pollCount,
      ...(update.checks === undefined ? {} : { lastChecks: update.checks }),
      lastError: { code, message },
    });
    this.notifyTerminal(record.id);
  }

  private requireVisibleRecord(
    workspaceId: string,
    id: string,
    access: GitHubCommitChecksWatchAccess,
  ): PersistedGitHubCommitChecksWatchRecord {
    const record = this.records.get(id);
    if (
      record === undefined ||
      record.workspaceId !== workspaceId ||
      record.ownerScopeHash !== hashOwnerScope(access.ownerScope)
    ) {
      throw new AppError("TASK_NOT_FOUND", "GitHub commit-check watch was not found.");
    }
    return record;
  }

  private async persist(
    record: PersistedGitHubCommitChecksWatchRecord,
  ): Promise<void> {
    const parsed = validatePersistedRecord(record);
    const previous = this.writes.get(parsed.id) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => writeJsonAtomically(this.watchPath(parsed.id), parsed));
    this.writes.set(parsed.id, write);
    try {
      await write;
      this.records.set(parsed.id, parsed);
    } finally {
      if (this.writes.get(parsed.id) === write) this.writes.delete(parsed.id);
    }
  }

  private watchPath(id: string): string {
    return path.join(this.stateDirectory, `${id}.json`);
  }

  private async quarantine(filePath: string, fileName: string): Promise<void> {
    const directory = path.join(this.stateDirectory, "quarantine");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await rename(
      filePath,
      path.join(directory, `${fileName}.${Date.now()}.${randomBytes(4).toString("hex")}.invalid`),
    ).catch(async () => {
      await rm(filePath, { force: true });
    });
  }

  private notifyTerminal(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.ownerScopes.delete(id);
    const waiters = this.terminalWaiters.get(id);
    if (waiters === undefined) return;
    this.terminalWaiters.delete(id);
    for (const resolve of waiters) resolve();
  }
}

function isTerminal(
  record: PersistedGitHubCommitChecksWatchRecord,
): boolean {
  return record.state !== "watching";
}

function isTransientPollError(code: string): boolean {
  return (
    code === "AGENT_UNAVAILABLE" ||
    code === "AGENT_TIMEOUT" ||
    code === "RELAY_PROTOCOL_ERROR"
  );
}

function hashOwnerScope(ownerScope: string | undefined): string | undefined {
  if (ownerScope === undefined) return undefined;
  return createHash("sha256").update(ownerScope).digest("hex");
}

function validatePersistedRecord(
  value: unknown,
): PersistedGitHubCommitChecksWatchRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid persisted GitHub commit-check watch record.");
  }
  const raw = value as Record<string, unknown>;
  const ownerScopeHash = raw.ownerScopeHash;
  if (
    ownerScopeHash !== undefined &&
    (typeof ownerScopeHash !== "string" ||
      !OWNER_SCOPE_HASH_PATTERN.test(ownerScopeHash))
  ) {
    throw new Error("Invalid persisted GitHub commit-check watch owner scope.");
  }
  const { ownerScopeHash: _ownerScopeHash, ...publicValue } = raw;
  const record = githubCommitChecksWatchRecordSchema.parse(publicValue);
  return ownerScopeHash === undefined
    ? record
    : { ...record, ownerScopeHash };
}

function toPublicRecord(
  record: PersistedGitHubCommitChecksWatchRecord,
): GitHubCommitChecksWatchRecord {
  const { ownerScopeHash: _ownerScopeHash, ...publicRecord } = record;
  return githubCommitChecksWatchRecordSchema.parse(publicRecord);
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return resolved;
}

async function writeJsonAtomically(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporaryPath =
    `${targetPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      await rename(temporaryPath, targetPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      await rm(targetPath, { force: true });
      await rename(temporaryPath, targetPath);
    }
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
