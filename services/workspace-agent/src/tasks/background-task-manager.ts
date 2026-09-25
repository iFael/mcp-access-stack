import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  abortSignalError,
  backgroundTaskRecordSchema,
  createOperationDeadline,
  createOperationLifecycle,
  redactSensitiveText,
  startBackgroundTaskInputSchema,
  type BackgroundTaskLogsResult,
  type BackgroundTaskRecord,
  type BackgroundTaskWaitResult,
  type BackgroundTaskState,
  type BackgroundTaskOutputResult,
  type BackgroundTaskStdinResult,
  type DirectRunCommandInput,
  type RunCommandResult,
  type StartBackgroundTaskInput,
} from "@vs-code-gpt/shared";

export {
  BACKGROUND_TASK_STATES,
  redactSensitiveText,
  type BackgroundTaskLogsResult,
  type BackgroundTaskRecord,
  type BackgroundTaskWaitResult,
  type BackgroundTaskState,
  type StartBackgroundTaskInput,
} from "@vs-code-gpt/shared";

export interface BackgroundTaskStdinControl {
  write(value: string): Promise<number>;
  close(): Promise<void>;
  isClosed(): boolean;
}

export interface BackgroundTaskExecutionContext {
  stdoutPath: string;
  stderrPath: string;
  onPid: (pid: number) => void;
  interactive: boolean;
  onStdinControl: (control: BackgroundTaskStdinControl) => void;
  transformOutput?: (value: string) => string;
}

export interface BackgroundTaskRunner {
  start(
    input: DirectRunCommandInput,
    signal: AbortSignal,
    context: BackgroundTaskExecutionContext,
  ): Promise<RunCommandResult>;
  terminate?(pid: number): Promise<void>;
}

export interface BackgroundTaskManagerOptions {
  stateDirectory: string;
  runner: BackgroundTaskRunner;
  now?: () => Date;
  terminalRetentionMs?: number;
  maxRetainedTerminalTasks?: number;
}

export interface BackgroundTaskAccessContext {
  ownerScope?: string;
}

type PersistedBackgroundTaskRecord = BackgroundTaskRecord & {
  ownerScopeHash?: string;
};

const ACTIVE_STATES = new Set<BackgroundTaskState>(["starting", "running"]);
const BACKGROUND_WAIT_POLL_MS = 100;
const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TASK_STATE_FILE_PATTERN = new RegExp(`^(${TASK_ID_PATTERN.source.slice(1, -1)})\\.json$`, "iu");
const MAX_LOG_BYTES = 1_000_000;
const DEFAULT_TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_RETAINED_TERMINAL_TASKS = 500;
const OWNER_SCOPE_HASH_PATTERN = /^[a-f0-9]{64}$/u;

export class BackgroundTaskManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly stdinControls = new Map<string, BackgroundTaskStdinControl>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly records = new Map<string, PersistedBackgroundTaskRecord>();
  private startQueue: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;
  private readonly now: () => Date;
  private readonly terminalRetentionMs: number;
  private readonly maxRetainedTerminalTasks: number;

  constructor(private readonly options: BackgroundTaskManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.terminalRetentionMs = positiveIntegerOption(
      options.terminalRetentionMs,
      DEFAULT_TERMINAL_RETENTION_MS,
      "terminalRetentionMs",
    );
    this.maxRetainedTerminalTasks = positiveIntegerOption(
      options.maxRetainedTerminalTasks,
      DEFAULT_MAX_RETAINED_TERMINAL_TASKS,
      "maxRetainedTerminalTasks",
    );
  }

  async start_background_task(
    input: StartBackgroundTaskInput,
    access: BackgroundTaskAccessContext = {},
  ): Promise<BackgroundTaskRecord> {
    await this.ensureInitialized();
    const normalized = normalizeStartInput(input);
    const ownerScopeHash = hashOwnerScope(access.ownerScope);
    let releaseQueue!: () => void;
    const previousStart = this.startQueue;
    this.startQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousStart;

    try {
      const existing = await this.list_background_tasks(
        { workspaceId: normalized.workspaceId },
        access,
      );
      const duplicate = existing.find(
        (task) =>
          task.commandHash === normalized.commandHash &&
          ACTIVE_STATES.has(task.state),
      );
      if (duplicate) return duplicate;

      await this.pruneTerminalRecords();

      const record: PersistedBackgroundTaskRecord = {
        version: 1,
        id: randomUUID(),
        workspaceId: normalized.workspaceId,
        operation: normalized.operation,
        commandHash: normalized.commandHash,
        command: redactSensitiveText(normalized.command),
        shell: normalized.shell,
        cwd: normalized.cwd,
        state: "starting",
        createdAt: this.now().toISOString(),
        timeoutMs: normalized.timeoutMs,
        ...(normalized.interactive ? { interactive: true as const } : {}),
        ...(ownerScopeHash === undefined ? {} : { ownerScopeHash }),
      };
      await this.initializeTaskFiles(record.id);
      await this.persist(record);

      const controller = new AbortController();
      this.controllers.set(record.id, controller);
      const execution = this.execute(record, controller, normalized.command);
      this.executions.set(record.id, execution);
      void execution
        .finally(() => {
          if (this.executions.get(record.id) === execution) {
            this.executions.delete(record.id);
          }
        })
        .catch(() => undefined);
      return toPublicRecord(record);
    } finally {
      releaseQueue();
    }
  }

  async get_background_task(
    id: string,
    access: BackgroundTaskAccessContext = {},
  ): Promise<BackgroundTaskRecord | null> {
    const record = await this.getAccessibleRecord(id, access);
    return record ? toPublicRecord(record) : null;
  }

  async list_background_tasks(
    filter: { workspaceId?: string; state?: BackgroundTaskState } = {},
    access: BackgroundTaskAccessContext = {},
  ): Promise<BackgroundTaskRecord[]> {
    await this.ensureInitialized();
    await Promise.all(this.writes.values());
    const records = await Promise.all(
      [...this.records.values()]
        .filter((record) => canAccessRecord(record, access))
        .map((record) => this.refreshRecoveredTask(record)),
    );
    return records
      .filter(
        (record) =>
          filter.workspaceId === undefined ||
          record.workspaceId === filter.workspaceId,
      )
      .filter(
        (record) =>
          filter.state === undefined || record.state === filter.state,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(toPublicRecord);
  }

  async cancel_background_task(
    id: string,
    access: BackgroundTaskAccessContext = {},
  ): Promise<BackgroundTaskRecord | null> {
    const record = await this.getAccessibleRecord(id, access);
    if (!record || !ACTIVE_STATES.has(record.state)) {
      return record ? toPublicRecord(record) : null;
    }

    const completedAt = this.now();
    const cancelled: PersistedBackgroundTaskRecord = {
      ...record,
      state: "cancelled",
      completedAt: completedAt.toISOString(),
      lifecycle: createOperationLifecycle(
        deadlineForTask(record),
        taskStartedAt(record),
        {
          layer: "background_task_manager",
          reason: "cancelled",
          diagnostic: "The persisted background task was explicitly cancelled.",
        },
        completedAt.getTime(),
      ),
    };
    await this.persist(cancelled);

    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      await this.executions.get(id);
    } else if (record.pid && this.options.runner.terminate) {
      await this.options.runner.terminate(record.pid);
    }

    await this.writes.get(id);
    const latest = await this.getAccessibleRecord(id, access);
    return latest ? toPublicRecord(latest) : toPublicRecord(cancelled);
  }

  async read_background_task_logs(
    id: string,
    maxBytes = 100_000,
    access: BackgroundTaskAccessContext = {},
  ): Promise<BackgroundTaskLogsResult | null> {
    const record = await this.getAccessibleRecord(id, access);
    if (!record) return null;
    const effectiveMaxBytes = Math.min(Math.max(maxBytes, 1), MAX_LOG_BYTES);
    const [stdout, stderr] = await Promise.all([
      readLogFile(this.stdoutPath(id), effectiveMaxBytes),
      readLogFile(this.stderrPath(id), effectiveMaxBytes),
    ]);
    return {
      id,
      stdout: redactSensitiveText(stdout.content),
      stderr: redactSensitiveText(stderr.content),
      stdoutBytes: stdout.totalBytes,
      stderrBytes: stderr.totalBytes,
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  async write_background_task_stdin(
    id: string,
    input: string,
    close: boolean,
    access: BackgroundTaskAccessContext = {},
  ): Promise<BackgroundTaskStdinResult> {
    const record = await this.getAccessibleRecord(id, access);
    if (!record) {
      return { task: null, bytesWritten: 0, stdinClosed: false };
    }
    if (record.interactive !== true) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Background task was not started in interactive mode.",
      );
    }
    if (!ACTIVE_STATES.has(record.state)) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Interactive background task is no longer active.",
      );
    }
    const control = this.stdinControls.get(id);
    if (!control) {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Interactive stdin is unavailable for this recovered task.",
      );
    }
    const bytesWritten = input.length > 0 ? await control.write(input) : 0;
    if (close) await control.close();
    const latest = await this.getAccessibleRecord(id, access);
    return {
      task: latest ? toPublicRecord(latest) : null,
      bytesWritten,
      stdinClosed: control.isClosed(),
    };
  }

  async read_background_task_output(
    id: string,
    options: { stdoutOffset: number; stderrOffset: number; maxBytes: number },
    access: BackgroundTaskAccessContext = {},
  ): Promise<BackgroundTaskOutputResult> {
    const record = await this.getAccessibleRecord(id, access);
    if (!record) return { task: null, stdout: null, stderr: null };
    const [stdout, stderr] = await Promise.all([
      readLogChunk(this.stdoutPath(id), options.stdoutOffset, options.maxBytes),
      readLogChunk(this.stderrPath(id), options.stderrOffset, options.maxBytes),
    ]);
    return { task: toPublicRecord(record), stdout, stderr };
  }

  async wait_background_task(
    id: string,
    options: {
      timeoutMs: number;
      maxBytes: number;
      signal?: AbortSignal;
    },
    access: BackgroundTaskAccessContext = {},
  ): Promise<BackgroundTaskWaitResult> {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1, Math.trunc(options.timeoutMs));

    while (true) {
      if (options.signal?.aborted) {
        throw abortSignalError(options.signal, "Background task wait was cancelled.");
      }

      const persisted = await this.getAccessibleRecord(id, access);
      if (!persisted) {
        return {
          task: null,
          logs: null,
          timedOut: false,
          elapsedMs: Date.now() - startedAt,
        };
      }

      const task = toPublicRecord(persisted);
      if (!ACTIVE_STATES.has(task.state)) {
        return {
          task,
          logs: await this.read_background_task_logs(
            id,
            options.maxBytes,
            access,
          ),
          timedOut: false,
          elapsedMs: Date.now() - startedAt,
        };
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          task,
          logs: await this.read_background_task_logs(
            id,
            options.maxBytes,
            access,
          ),
          timedOut: true,
          elapsedMs: Date.now() - startedAt,
        };
      }

      await waitForBackgroundProgress(
        this.executions.get(id),
        Math.min(remainingMs, BACKGROUND_WAIT_POLL_MS),
        options.signal,
      );
    }
  }
  private async execute(
    initial: PersistedBackgroundTaskRecord,
    controller: AbortController,
    command: string,
  ): Promise<void> {
    let current: PersistedBackgroundTaskRecord = {
      ...initial,
      state: "running",
      startedAt: this.now().toISOString(),
    };
    await this.persist(current);

    try {
      const rawResult = await this.options.runner.start(
        {
          workspaceId: current.workspaceId,
          command,
          shell: current.shell,
          cwd: current.cwd,
          elevated: false,
          timeoutMs: current.timeoutMs,
        },
        controller.signal,
        {
          stdoutPath: this.stdoutPath(current.id),
          stderrPath: this.stderrPath(current.id),
          onPid: (pid) => {
            current = { ...current, pid };
            void this.persist(current);
          },
          interactive: current.interactive === true,
          onStdinControl: (control) => {
            this.stdinControls.set(current.id, control);
          },
          transformOutput: redactSensitiveText,
        },
      );
      await this.sanitizeTaskLogs(current.id);
      const latest = await this.readPersistedRecord(current.id);
      if (latest?.state === "cancelled") return;

      if (rawResult.status !== "executed") {
        throw new Error(
          "Background tasks cannot enter an interactive confirmation flow.",
        );
      }
      const result = sanitizeRunCommandResult(rawResult);
      const completedAt = this.now();
      const succeeded = result.exitCode === 0 && !result.timedOut;
      current = {
        ...current,
        state: succeeded ? "succeeded" : "failed",
        completedAt: completedAt.toISOString(),
        result,
        lifecycle:
          result.lifecycle ??
          createOperationLifecycle(
            deadlineForTask(current),
            taskStartedAt(current),
            succeeded
              ? undefined
              : {
                  layer: "child_process",
                  reason: result.timedOut ? "timeout" : "process_failed",
                  diagnostic: result.timedOut
                    ? "The background child process exceeded its configured timeout."
                    : "The background child process exited unsuccessfully.",
                },
            completedAt.getTime(),
          ),
      };
      await this.persistResult(current.id, result);
      await this.persist(current);
    } catch (error) {
      await this.sanitizeTaskLogs(current.id);
      const latest = await this.readPersistedRecord(current.id);
      if (latest?.state === "cancelled") return;
      const completedAt = this.now();
      await this.persist({
        ...current,
        state: "failed",
        completedAt: completedAt.toISOString(),
        error: redactSensitiveText(
          error instanceof Error ? error.message : String(error),
        ),
        lifecycle:
          error instanceof AppError && error.lifecycle
            ? error.lifecycle
            : createOperationLifecycle(
                deadlineForTask(current),
                taskStartedAt(current),
                {
                  layer: "background_task_manager",
                  reason: "process_failed",
                  diagnostic: "The background task runner failed before producing a valid result.",
                },
                completedAt.getTime(),
              ),
      });
    } finally {
      this.controllers.delete(current.id);
      this.stdinControls.delete(current.id);
    }
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
    const loaded = await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && TASK_STATE_FILE_PATTERN.test(entry.name),
        )
        .map(async (entry) => {
          const filePath = path.join(this.options.stateDirectory, entry.name);
          try {
            return parsePersistedRecord(await readFile(filePath, "utf8"));
          } catch {
            const quarantinePath = path.join(
              this.quarantineDirectory(),
              `${entry.name}.${Date.now()}.${randomUUID()}.invalid`,
            );
            await rename(filePath, quarantinePath);
            return null;
          }
        }),
    );
    for (const record of loaded) {
      if (record) this.records.set(record.id, record);
    }
    await this.pruneTerminalRecords();
  }

  private async refreshRecoveredTask(
    record: PersistedBackgroundTaskRecord,
  ): Promise<PersistedBackgroundTaskRecord> {
    if (
      !ACTIVE_STATES.has(record.state) ||
      this.executions.has(record.id) ||
      this.controllers.has(record.id)
    ) {
      return record;
    }
    if (record.pid && processExists(record.pid)) {
      return record;
    }
    const completedAt = record.completedAt ?? this.now().toISOString();
    const interrupted: PersistedBackgroundTaskRecord = {
      ...record,
      state: "failed",
      completedAt,
      error:
        record.error ?? "Background task was interrupted before Agent recovery.",
      lifecycle:
        record.lifecycle ??
        createOperationLifecycle(
          deadlineForTask(record),
          taskStartedAt(record),
          {
            layer: "background_task_manager",
            reason: "process_failed",
            diagnostic: "The Agent recovered a persisted active task without a live owned process.",
          },
          Date.parse(completedAt),
        ),
    };
    await this.persist(interrupted);
    return interrupted;
  }

  private async readPersistedRecord(
    id: string,
  ): Promise<PersistedBackgroundTaskRecord | null> {
    await this.ensureInitialized();
    await this.writes.get(id);
    return this.records.get(id) ?? null;
  }

  private async getAccessibleRecord(
    id: string,
    access: BackgroundTaskAccessContext,
  ): Promise<PersistedBackgroundTaskRecord | null> {
    const record = await this.readPersistedRecord(id);
    if (!record || !canAccessRecord(record, access)) return null;
    return this.refreshRecoveredTask(record);
  }

  private async pruneTerminalRecords(): Promise<void> {
    const nowMs = this.now().getTime();
    const terminalRecords = [...this.records.values()].filter(
      (record) => !ACTIVE_STATES.has(record.state),
    );
    const expiredIds = new Set(
      terminalRecords
        .filter(
          (record) =>
            nowMs - terminalRecordTime(record) > this.terminalRetentionMs,
        )
        .map((record) => record.id),
    );
    const retainedByAge = terminalRecords
      .filter((record) => !expiredIds.has(record.id))
      .sort((left, right) => terminalRecordTime(right) - terminalRecordTime(left));
    const victimIds = new Set([
      ...expiredIds,
      ...retainedByAge
        .slice(this.maxRetainedTerminalTasks)
        .map((record) => record.id),
    ]);

    for (const id of victimIds) {
      const current = this.records.get(id);
      if (!current || ACTIVE_STATES.has(current.state)) continue;
      await this.removeTaskArtifacts(id);
    }
  }

  private async removeTaskArtifacts(id: string): Promise<void> {
    await rm(this.stdoutPath(id), { force: true });
    await rm(this.stderrPath(id), { force: true });
    await rm(this.resultPath(id), { force: true });
    await rm(this.taskPath(id), { force: true });
    this.records.delete(id);
  }

  private taskPath(id: string): string {
    assertTaskId(id);
    return path.join(this.options.stateDirectory, `${id}.json`);
  }

  private stdoutPath(id: string): string {
    assertTaskId(id);
    return path.join(this.options.stateDirectory, `${id}.stdout.log`);
  }

  private stderrPath(id: string): string {
    assertTaskId(id);
    return path.join(this.options.stateDirectory, `${id}.stderr.log`);
  }

  private resultPath(id: string): string {
    assertTaskId(id);
    return path.join(this.options.stateDirectory, `${id}.result.json`);
  }

  private quarantineDirectory(): string {
    return path.join(this.options.stateDirectory, "quarantine");
  }

  private async initializeTaskFiles(id: string): Promise<void> {
    try {
      await Promise.all([
        writeFile(this.stdoutPath(id), "", { flag: "wx" }),
        writeFile(this.stderrPath(id), "", { flag: "wx" }),
      ]);
    } catch (error) {
      await Promise.all([
        rm(this.stdoutPath(id), { force: true }),
        rm(this.stderrPath(id), { force: true }),
      ]);
      throw error;
    }
  }

  private async persist(record: PersistedBackgroundTaskRecord): Promise<void> {
    const parsed = validatePersistedRecord(record);
    const previous = this.writes.get(parsed.id) ?? Promise.resolve();
    const write = previous.then(() =>
      writeJsonAtomically(this.taskPath(parsed.id), parsed),
    );
    this.writes.set(parsed.id, write);
    try {
      await write;
      this.records.set(parsed.id, parsed);
    } finally {
      if (this.writes.get(parsed.id) === write) {
        this.writes.delete(parsed.id);
      }
    }
  }

  private async persistResult(
    id: string,
    result: RunCommandResult,
  ): Promise<void> {
    await writeJsonAtomically(this.resultPath(id), result);
  }

  private async sanitizeTaskLogs(id: string): Promise<void> {
    await Promise.all([
      sanitizeLogFile(this.stdoutPath(id)),
      sanitizeLogFile(this.stderrPath(id)),
    ]);
  }
}

function positiveIntegerOption(
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

function terminalRecordTime(record: PersistedBackgroundTaskRecord): number {
  const value = Date.parse(record.completedAt ?? record.createdAt);
  return Number.isFinite(value) ? value : 0;
}

function normalizeStartInput(input: StartBackgroundTaskInput): {
  workspaceId: string;
  operation: string;
  command: string;
  shell: DirectRunCommandInput["shell"];
  cwd: string;
  timeoutMs: number;
  interactive: boolean;
  commandHash: string;
} {
  const parsed = startBackgroundTaskInputSchema.parse(input);
  const command = parsed.command;
  const cwd = parsed.cwd ?? ".";
  const commandHash = createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: parsed.workspaceId,
        shell: parsed.shell,
        cwd,
        command,
        interactive: parsed.interactive,
      }),
    )
    .digest("hex");
  return {
    workspaceId: parsed.workspaceId,
    operation: parsed.operation,
    command,
    shell: parsed.shell,
    cwd,
    timeoutMs: parsed.timeoutMs,
    interactive: parsed.interactive,
    commandHash,
  };
}

function parsePersistedRecord(raw: string): PersistedBackgroundTaskRecord {
  return validatePersistedRecord(JSON.parse(raw));
}

function validatePersistedRecord(value: unknown): PersistedBackgroundTaskRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid persisted background task record.");
  }
  const raw = value as Record<string, unknown>;
  const ownerScopeHash = raw.ownerScopeHash;
  if (
    ownerScopeHash !== undefined &&
    (typeof ownerScopeHash !== "string" ||
      !OWNER_SCOPE_HASH_PATTERN.test(ownerScopeHash))
  ) {
    throw new Error("Invalid persisted background task owner scope.");
  }
  const {
    ownerScopeHash: _ownerScopeHash,
    ...publicValue
  } = raw;
  const record = backgroundTaskRecordSchema.parse(publicValue);
  return ownerScopeHash === undefined
    ? record
    : { ...record, ownerScopeHash };
}

function toPublicRecord(
  record: PersistedBackgroundTaskRecord,
): BackgroundTaskRecord {
  const { ownerScopeHash: _ownerScopeHash, ...publicRecord } = record;
  return backgroundTaskRecordSchema.parse(publicRecord);
}

function hashOwnerScope(ownerScope: string | undefined): string | undefined {
  if (ownerScope === undefined) return undefined;
  return createHash("sha256").update(ownerScope).digest("hex");
}

function canAccessRecord(
  record: PersistedBackgroundTaskRecord,
  access: BackgroundTaskAccessContext,
): boolean {
  return record.ownerScopeHash === hashOwnerScope(access.ownerScope);
}

async function readPersistedRecord(
  filePath: string,
): Promise<PersistedBackgroundTaskRecord> {
  return parsePersistedRecord(await readFile(filePath, "utf8"));
}

function assertTaskId(id: string): void {
  if (!TASK_ID_PATTERN.test(id)) {
    throw new Error("Invalid background task id.");
  }
}

async function writeJsonAtomically(
  targetPath: string,
  value: unknown,
): Promise<void> {
  await writeTextAtomically(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomically(
  targetPath: string,
  value: string,
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, value, "utf8");
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

async function sanitizeLogFile(filePath: string): Promise<void> {
  try {
    const raw = await readFile(filePath, "utf8");
    const sanitized = redactSensitiveText(raw);
    if (sanitized !== raw) await writeTextAtomically(filePath, sanitized);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    await rm(filePath, { force: true }).catch(() => undefined);
    throw new Error("Unable to safely persist a background task log.", { cause: error });
  }
}

async function readLogChunk(
  filePath: string,
  offset: number,
  maxBytes: number,
): Promise<{
  content: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  eof: boolean;
}> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const stat = await handle.stat();
    const totalBytes = stat.size;
    if (offset > totalBytes) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "Background task output offset is beyond the current end of stream.",
      );
    }
    if (offset === totalBytes) {
      return { content: "", offset, nextOffset: offset, totalBytes, eof: true };
    }
    const readLength = Math.min(maxBytes, totalBytes - offset);
    const buffer = Buffer.allocUnsafe(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
    const selected = buffer.subarray(0, bytesRead);
    if (selected.length > 0 && isUtf8ContinuationByte(selected[0]!)) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "Background task output offset is not on a UTF-8 character boundary.",
      );
    }
    const safeLength = completeUtf8PrefixLength(selected);
    const content = selected.subarray(0, safeLength).toString("utf8");
    const nextOffset = offset + safeLength;
    return {
      content,
      offset,
      nextOffset,
      totalBytes,
      eof: nextOffset >= totalBytes,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", offset, nextOffset: offset, totalBytes: 0, eof: true };
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
}

function completeUtf8PrefixLength(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && isUtf8ContinuationByte(buffer[lead]!)) lead -= 1;
  if (lead < 0) return 0;
  const first = buffer[lead]!;
  const expected =
    (first & 0b1000_0000) === 0 ? 1 :
    (first & 0b1110_0000) === 0b1100_0000 ? 2 :
    (first & 0b1111_0000) === 0b1110_0000 ? 3 :
    (first & 0b1111_1000) === 0b1111_0000 ? 4 : 1;
  return buffer.length - lead < expected ? lead : buffer.length;
}

async function readLogFile(
  filePath: string,
  maxBytes: number,
): Promise<{ content: string; totalBytes: number; truncated: boolean }> {
  try {
    const value = await readFile(filePath);
    const totalBytes = value.byteLength;
    const truncated = totalBytes > maxBytes;
    const selected = truncated ? value.subarray(totalBytes - maxBytes) : value;
    return {
      content: selected.toString("utf8"),
      totalBytes,
      truncated,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { content: "", totalBytes: 0, truncated: false };
    }
    throw error;
  }
}

function sanitizeRunCommandResult(
  result: Extract<RunCommandResult, { status: "executed" }>,
): Extract<RunCommandResult, { status: "executed" }> {
  return {
    ...result,
    stdout: redactSensitiveText(result.stdout),
    stderr: redactSensitiveText(result.stderr),
  };
}


async function waitForBackgroundProgress(
  execution: Promise<void> | undefined,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw abortSignalError(signal, "Background task wait was cancelled.");
  }

  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, waitMs);
  });
  try {
    if (execution) {
      await Promise.race([execution, timer]);
    } else {
      await timer;
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }

  if (signal?.aborted) {
    throw abortSignalError(signal, "Background task wait was cancelled.");
  }
}
function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function taskStartedAt(record: BackgroundTaskRecord): number {
  const value = Date.parse(record.startedAt ?? record.createdAt);
  return Number.isFinite(value) ? value : Date.now();
}

function deadlineForTask(record: BackgroundTaskRecord) {
  return createOperationDeadline(
    record.timeoutMs,
    undefined,
    taskStartedAt(record),
  );
}
