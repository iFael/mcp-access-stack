import { createHash, randomUUID } from "node:crypto";
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
  commandInvocationMetricsSchema,
  commandInvocationRecordSchema,
  type CommandInvocationMetrics,
  type CommandInvocationRecord,
  type CommandInvocationResponse,
  type CommandInvocationState,
} from "@vs-code-gpt/shared";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 4_096;
const RECORD_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u;
const TEMP_FILE_PATTERN = /^[a-f0-9]{64}\.json\.[0-9a-f-]{36}\.tmp$/iu;
const TERMINAL_STATES = new Set<CommandInvocationState>([
  "completed",
  "blocked",
  "outcome_unknown",
]);

const ALLOWED_TRANSITIONS: Record<
  CommandInvocationState,
  ReadonlySet<CommandInvocationState>
> = {
  received: new Set(["qualified", "blocked"]),
  qualified: new Set(["awaiting_confirmation", "executing", "blocked"]),
  awaiting_confirmation: new Set(["executing", "completed", "blocked"]),
  executing: new Set([
    "diagnosed",
    "completed",
    "blocked",
    "outcome_unknown",
  ]),
  diagnosed: new Set(["repaired", "completed", "blocked"]),
  repaired: new Set(["awaiting_confirmation", "executing", "completed", "blocked"]),
  completed: new Set(),
  blocked: new Set(),
  outcome_unknown: new Set(),
};

export interface CommandInvocationRegistryOptions {
  stateDirectory: string;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => Date;
}

export interface CommandInvocationIdentity {
  workspaceId: string;
  invocationId: string;
  planFingerprint: string;
}

export type CommandInvocationAcquireResult =
  | {
      status: "created";
      record: CommandInvocationRecord;
    }
  | {
      status: "active";
      record: CommandInvocationRecord;
    }
  | {
      status: "replay";
      record: CommandInvocationRecord;
      response: CommandInvocationResponse;
    };

export interface CommandInvocationTransitionInput
  extends CommandInvocationIdentity {
  expectedState: CommandInvocationState | CommandInvocationState[];
  nextState: CommandInvocationState;
  response?: CommandInvocationResponse;
}

export class CommandInvocationRegistry {
  private readonly records = new Map<string, CommandInvocationRecord>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private initialization?: Promise<void>;
  private mutationQueue: Promise<void> = Promise.resolve();
  private hits = 0;
  private misses = 0;
  private conflicts = 0;
  private evictions = 0;
  private expirations = 0;
  private recoveries = 0;

  constructor(private readonly options: CommandInvocationRegistryOptions) {
    if (!path.isAbsolute(options.stateDirectory)) {
      throw new AppError(
        "POLICY_INVALID",
        "Command invocation registry stateDirectory must be absolute.",
      );
    }
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? (() => new Date());
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new AppError(
        "POLICY_INVALID",
        "Command invocation registry ttlMs must be a positive integer.",
      );
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries <= 0) {
      throw new AppError(
        "POLICY_INVALID",
        "Command invocation registry maxEntries must be a positive integer.",
      );
    }
  }

  async acquire(
    identity: CommandInvocationIdentity,
  ): Promise<CommandInvocationAcquireResult> {
    await this.ensureInitialized();
    return this.serialize(async () => {
      await this.pruneExpired();
      const storageKey = invocationStorageKey(identity.invocationId);
      const existing = this.records.get(storageKey);
      if (existing) {
        this.assertIdentity(existing, identity);
        this.hits += 1;
        const record = cloneRecord(existing);
        return record.response
          ? { status: "replay", record, response: record.response }
          : { status: "active", record };
      }

      await this.ensureCapacity();
      const now = this.timestamp();
      const record = commandInvocationRecordSchema.parse({
        version: 1,
        invocationId: identity.invocationId,
        workspaceId: identity.workspaceId,
        idempotencyKey: commandInvocationIdempotencyKey(
          identity.invocationId,
          identity.planFingerprint,
        ),
        planFingerprint: identity.planFingerprint,
        state: "received",
        sequence: 0,
        createdAt: now,
        updatedAt: now,
      });
      await this.persist(record);
      this.records.set(storageKey, record);
      this.misses += 1;
      return { status: "created", record: cloneRecord(record) };
    });
  }

  async get(
    invocationId: string,
  ): Promise<CommandInvocationRecord | null> {
    await this.ensureInitialized();
    return this.serialize(async () => {
      await this.pruneExpired();
      const record = this.records.get(invocationStorageKey(invocationId));
      return record ? cloneRecord(record) : null;
    });
  }

  async list(): Promise<CommandInvocationRecord[]> {
    await this.ensureInitialized();
    return this.serialize(async () => {
      await this.pruneExpired();
      return [...this.records.values()]
        .map(cloneRecord)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    });
  }

  async transition(
    input: CommandInvocationTransitionInput,
  ): Promise<CommandInvocationRecord> {
    await this.ensureInitialized();
    return this.serialize(async () => {
      const storageKey = invocationStorageKey(input.invocationId);
      const existing = this.records.get(storageKey);
      if (!existing) {
        throw new AppError(
          "EXECUTION_NOT_FOUND",
          "Command invocation was not found.",
        );
      }
      this.assertIdentity(existing, input);
      const expectedStates = Array.isArray(input.expectedState)
        ? input.expectedState
        : [input.expectedState];
      if (!expectedStates.includes(existing.state)) {
        throw new AppError(
          "EXECUTION_STATE_INVALID",
          "Command invocation is not in the expected state.",
        );
      }
      if (!ALLOWED_TRANSITIONS[existing.state].has(input.nextState)) {
        throw new AppError(
          "EXECUTION_STATE_INVALID",
          "Command invocation transition is not allowed.",
        );
      }

      const updated = this.buildTransition(existing, input);
      await this.persist(updated);
      this.records.set(storageKey, updated);
      return cloneRecord(updated);
    });
  }

  async replaceAwaitingConfirmation(
    identity: CommandInvocationIdentity,
    response: CommandInvocationResponse,
  ): Promise<CommandInvocationRecord> {
    await this.ensureInitialized();
    return this.serialize(async () => {
      const storageKey = invocationStorageKey(identity.invocationId);
      const existing = this.records.get(storageKey);
      if (!existing) {
        throw new AppError(
          "EXECUTION_NOT_FOUND",
          "Command invocation was not found.",
        );
      }
      this.assertIdentity(existing, identity);
      if (
        existing.state !== "awaiting_confirmation" ||
        response.kind !== "result" ||
        response.value.status !== "confirmation_required"
      ) {
        throw new AppError(
          "EXECUTION_STATE_INVALID",
          "Only an awaiting confirmation response can be replaced.",
        );
      }
      const updated = commandInvocationRecordSchema.parse({
        ...existing,
        sequence: existing.sequence + 1,
        updatedAt: this.timestamp(),
        response,
      });
      await this.persist(updated);
      this.records.set(storageKey, updated);
      return cloneRecord(updated);
    });
  }

  async snapshot(): Promise<CommandInvocationMetrics> {
    await this.ensureInitialized();
    return this.serialize(async () => {
      await this.pruneExpired();
      const values = [...this.records.values()];
      return commandInvocationMetricsSchema.parse({
        entries: values.length,
        active: values.filter((record) => !TERMINAL_STATES.has(record.state))
          .length,
        replayable: values.filter((record) => record.response !== undefined)
          .length,
        outcomeUnknown: values.filter(
          (record) => record.state === "outcome_unknown",
        ).length,
        hits: this.hits,
        misses: this.misses,
        conflicts: this.conflicts,
        evictions: this.evictions,
        expirations: this.expirations,
        recoveries: this.recoveries,
      });
    });
  }

  private async ensureInitialized(): Promise<void> {
    this.initialization ??= this.initialize();
    await this.initialization;
  }

  private async initialize(): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true });
    await mkdir(this.quarantineDirectory(), { recursive: true });
    const entries = await readdir(this.options.stateDirectory, {
      withFileTypes: true,
    });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(this.options.stateDirectory, entry.name);
      if (TEMP_FILE_PATTERN.test(entry.name)) {
        await rm(filePath, { force: true });
        continue;
      }
      if (!RECORD_FILE_PATTERN.test(entry.name)) continue;
      try {
        const record = commandInvocationRecordSchema.parse(
          JSON.parse(await readFile(filePath, "utf8")),
        );
        if (recordFileName(record.invocationId) !== entry.name) {
          throw new Error("Command invocation file name does not match its record.");
        }
        this.records.set(invocationStorageKey(record.invocationId), record);
      } catch {
        await this.quarantine(filePath, entry.name);
      }
    }

    for (const [storageKey, record] of this.records) {
      if (record.state !== "executing") continue;
      const recovered = this.outcomeUnknownRecord(record);
      await this.persist(recovered);
      this.records.set(storageKey, recovered);
      this.recoveries += 1;
    }

    await this.pruneExpired();
    await this.trimTerminalEntriesToCapacity();
  }

  private buildTransition(
    existing: CommandInvocationRecord,
    input: CommandInvocationTransitionInput,
  ): CommandInvocationRecord {
    const updatedAt = this.timestamp();
    const {
      response: _response,
      recovery: _recovery,
      expiresAt: _expiresAt,
      ...base
    } = existing;

    if (input.nextState === "outcome_unknown") {
      return this.outcomeUnknownRecord({
        ...base,
        state: "executing",
        updatedAt,
      });
    }

    return commandInvocationRecordSchema.parse({
      ...base,
      state: input.nextState,
      sequence: existing.sequence + 1,
      updatedAt,
      ...(TERMINAL_STATES.has(input.nextState)
        ? { expiresAt: this.expiresAt(updatedAt) }
        : {}),
      ...(input.response === undefined ? {} : { response: input.response }),
    });
  }

  private outcomeUnknownRecord(
    existing: CommandInvocationRecord,
  ): CommandInvocationRecord {
    const recoveredAt = this.timestamp();
    const {
      response: _response,
      recovery: _recovery,
      expiresAt: _expiresAt,
      ...base
    } = existing;
    return commandInvocationRecordSchema.parse({
      ...base,
      state: "outcome_unknown",
      sequence: existing.sequence + 1,
      updatedAt: recoveredAt,
      expiresAt: this.expiresAt(recoveredAt),
      response: {
        kind: "error",
        sanitized: true,
        value: {
          code: "EXECUTION_OUTCOME_UNKNOWN",
          message:
            "The Agent recovered a command invocation that may have executed without a durable outcome.",
        },
      },
      recovery: {
        code: "EXECUTION_OUTCOME_UNKNOWN",
        priorState: "executing",
        recoveredAt,
      },
    });
  }

  private assertIdentity(
    existing: CommandInvocationRecord,
    identity: CommandInvocationIdentity,
  ): void {
    if (
      existing.invocationId === identity.invocationId &&
      existing.workspaceId === identity.workspaceId &&
      existing.planFingerprint === identity.planFingerprint &&
      existing.idempotencyKey ===
        commandInvocationIdempotencyKey(
          identity.invocationId,
          identity.planFingerprint,
        )
    ) {
      return;
    }
    this.conflicts += 1;
    throw new AppError(
      "IDEMPOTENCY_KEY_CONFLICT",
      "The command invocation ID is already associated with a different workspace or plan fingerprint.",
    );
  }

  private async ensureCapacity(): Promise<void> {
    if (this.records.size < this.maxEntries) return;
    await this.evictOldestTerminal();
    if (this.records.size < this.maxEntries) return;
    throw new AppError(
      "LIMIT_EXCEEDED",
      "The command invocation registry is at capacity with active invocations.",
    );
  }

  private async trimTerminalEntriesToCapacity(): Promise<void> {
    while (this.records.size > this.maxEntries) {
      const removed = await this.evictOldestTerminal();
      if (!removed) return;
    }
  }

  private async evictOldestTerminal(): Promise<boolean> {
    const candidate = [...this.records.entries()]
      .filter(([, record]) => TERMINAL_STATES.has(record.state))
      .sort(([, left], [, right]) =>
        left.updatedAt.localeCompare(right.updatedAt),
      )[0];
    if (!candidate) return false;
    const [storageKey] = candidate;
    await this.deleteRecord(storageKey);
    this.evictions += 1;
    return true;
  }

  private async pruneExpired(): Promise<void> {
    const now = this.now().getTime();
    for (const [storageKey, record] of this.records) {
      if (!TERMINAL_STATES.has(record.state) || !record.expiresAt) continue;
      if (Date.parse(record.expiresAt) > now) continue;
      await this.deleteRecord(storageKey);
      this.expirations += 1;
    }
  }

  private async deleteRecord(storageKey: string): Promise<void> {
    this.records.delete(storageKey);
    await rm(path.join(this.options.stateDirectory, `${storageKey}.json`), {
      force: true,
    });
  }

  private async persist(record: CommandInvocationRecord): Promise<void> {
    const parsed = commandInvocationRecordSchema.parse(record);
    await writeJsonAtomically(
      path.join(this.options.stateDirectory, recordFileName(parsed.invocationId)),
      parsed,
    );
  }

  private async quarantine(filePath: string, fileName: string): Promise<void> {
    const destination = path.join(
      this.quarantineDirectory(),
      `${fileName}.${Date.now()}.${randomUUID()}.invalid`,
    );
    await rename(filePath, destination);
  }

  private quarantineDirectory(): string {
    return path.join(this.options.stateDirectory, "quarantine");
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(value.getTime())) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Command invocation registry clock returned an invalid date.",
      );
    }
    return value.toISOString();
  }

  private expiresAt(updatedAt: string): string {
    return new Date(Date.parse(updatedAt) + this.ttlMs).toISOString();
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function commandInvocationIdempotencyKey(
  invocationId: string,
  planFingerprint: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "qualified-command-invocation-v1",
        invocationId,
        planFingerprint,
      }),
    )
    .digest("hex");
}

function invocationStorageKey(invocationId: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: "qualified-command-invocation-storage-v1",
        invocationId,
      }),
    )
    .digest("hex");
}

function recordFileName(invocationId: string): string {
  return `${invocationStorageKey(invocationId)}.json`;
}

function cloneRecord(record: CommandInvocationRecord): CommandInvocationRecord {
  return structuredClone(record);
}

async function writeJsonAtomically(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
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
    await rm(temporaryPath, { force: true });
  }
}
