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

export interface BackgroundTaskExecutionContext {
  stdoutPath: string;
  stderrPath: string;
  onPid: (pid: number) => void;
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
}

const ACTIVE_STATES = new Set<BackgroundTaskState>(["starting", "running"]);
const BACKGROUND_WAIT_POLL_MS = 100;
const TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TASK_STATE_FILE_PATTERN = new RegExp(`^(${TASK_ID_PATTERN.source.slice(1, -1)})\\.json$`, "iu");
const MAX_LOG_BYTES = 1_000_000;

export class BackgroundTaskManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly executions = new Map<string, Promise<void>>();
  private readonly writes = new Map<string, Promise<void>>();
  private startQueue: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: BackgroundTaskManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async start_background_task(
    input: StartBackgroundTaskInput,
  ): Promise<BackgroundTaskRecord> {
    await this.ensureInitialized();
    const normalized = normalizeStartInput(input);
    let releaseQueue!: () => void;
    const previousStart = this.startQueue;
    this.startQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    await previousStart;

    try {
      const duplicate = (
        await this.list_background_tasks({ workspaceId: normalized.workspaceId })
      ).find(
        (task) =>
          task.commandHash === normalized.commandHash &&
          ACTIVE_STATES.has(task.state),
      );
      if (duplicate) return duplicate;

      const record: BackgroundTaskRecord = {
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
      return record;
    } finally {
      releaseQueue();
    }
  }

  async get_background_task(
    id: string,
  ): Promise<BackgroundTaskRecord | null> {
    await this.ensureInitialized();
    await this.writes.get(id);
    try {
      const raw = await readFile(this.taskPath(id), "utf8");
      const record = parseRecord(raw);
      return this.refreshRecoveredTask(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list_background_tasks(
    filter: { workspaceId?: string; state?: BackgroundTaskState } = {},
  ): Promise<BackgroundTaskRecord[]> {
    await this.ensureInitialized();
    await Promise.all(this.writes.values());
    const entries = await readdir(this.options.stateDirectory, {
      withFileTypes: true,
    });
    const records = await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && TASK_STATE_FILE_PATTERN.test(entry.name),
        )
        .map(async (entry) => {
          const record = parseRecord(
            await readFile(
              path.join(this.options.stateDirectory, entry.name),
              "utf8",
            ),
          );
          return this.refreshRecoveredTask(record);
        }),
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
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async cancel_background_task(
    id: string,
  ): Promise<BackgroundTaskRecord | null> {
    const record = await this.get_background_task(id);
    if (!record || !ACTIVE_STATES.has(record.state)) return record;

    const completedAt = this.now();
    const cancelled: BackgroundTaskRecord = {
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
    return (await this.get_background_task(id)) ?? cancelled;
  }

  async read_background_task_logs(
    id: string,
    maxBytes = 100_000,
  ): Promise<BackgroundTaskLogsResult | null> {
    const record = await this.get_background_task(id);
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

  async wait_background_task(
    id: string,
    options: {
      timeoutMs: number;
      maxBytes: number;
      signal?: AbortSignal;
    },
  ): Promise<BackgroundTaskWaitResult> {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1, Math.trunc(options.timeoutMs));

    while (true) {
      if (options.signal?.aborted) {
        throw abortSignalError(options.signal, "Background task wait was cancelled.");
      }

      const task = await this.get_background_task(id);
      if (!task) {
        return {
          task: null,
          logs: null,
          timedOut: false,
          elapsedMs: Date.now() - startedAt,
        };
      }

      if (!ACTIVE_STATES.has(task.state)) {
        return {
          task,
          logs: await this.read_background_task_logs(id, options.maxBytes),
          timedOut: false,
          elapsedMs: Date.now() - startedAt,
        };
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return {
          task,
          logs: await this.read_background_task_logs(id, options.maxBytes),
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
    initial: BackgroundTaskRecord,
    controller: AbortController,
    command: string,
  ): Promise<void> {
    let current: BackgroundTaskRecord = {
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
          transformOutput: redactSensitiveText,
        },
      );
      await this.sanitizeTaskLogs(current.id);
      const latest = await this.get_background_task(current.id);
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
      const latest = await this.get_background_task(current.id);
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
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isFile() && TASK_STATE_FILE_PATTERN.test(entry.name),
        )
        .map(async (entry) => {
          const filePath = path.join(this.options.stateDirectory, entry.name);
          try {
            parseRecord(await readFile(filePath, "utf8"));
          } catch {
            const quarantinePath = path.join(
              this.quarantineDirectory(),
              `${entry.name}.${Date.now()}.${randomUUID()}.invalid`,
            );
            await rename(filePath, quarantinePath);
          }
        }),
    );
  }

  private async refreshRecoveredTask(
    record: BackgroundTaskRecord,
  ): Promise<BackgroundTaskRecord> {
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
    const interrupted: BackgroundTaskRecord = {
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

  private async persist(record: BackgroundTaskRecord): Promise<void> {
    const parsed = backgroundTaskRecordSchema.parse(record);
    const previous = this.writes.get(parsed.id) ?? Promise.resolve();
    const write = previous.then(() =>
      writeJsonAtomically(this.taskPath(parsed.id), parsed),
    );
    this.writes.set(parsed.id, write);
    try {
      await write;
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

function normalizeStartInput(input: StartBackgroundTaskInput): {
  workspaceId: string;
  operation: string;
  command: string;
  shell: DirectRunCommandInput["shell"];
  cwd: string;
  timeoutMs: number;
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
    commandHash,
  };
}

function parseRecord(raw: string): BackgroundTaskRecord {
  return backgroundTaskRecordSchema.parse(JSON.parse(raw));
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
