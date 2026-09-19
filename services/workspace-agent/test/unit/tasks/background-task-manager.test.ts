import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunCommandInput, RunCommandResult } from "@vs-code-gpt/shared";
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  BackgroundTaskManager,
  type BackgroundTaskExecutionContext,
  type BackgroundTaskRunner,
} from "../../../src/tasks/background-task-manager.js";

class ControlledRunner implements BackgroundTaskRunner {
  calls = 0;
  terminateCalls: number[] = [];
  private resolveResult?: (result: RunCommandResult) => void;
  private rejectResult?: (error: Error) => void;
  private input?: RunCommandInput;
  private execution?: BackgroundTaskExecutionContext;
  signal?: AbortSignal;

  start(
    input: RunCommandInput,
    signal: AbortSignal,
    execution: BackgroundTaskExecutionContext,
  ): Promise<RunCommandResult> {
    this.calls += 1;
    this.input = input;
    this.execution = execution;
    this.signal = signal;
    execution.onPid(4242);
    return new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
      signal.addEventListener(
        "abort",
        () => reject(new Error("cancelled")),
        { once: true },
      );
    });
  }

  async succeed(
    output: { stdout?: string; stderr?: string } = {},
  ): Promise<void> {
    if (output.stdout && this.execution) {
      await appendFile(this.execution.stdoutPath, output.stdout, "utf8");
    }
    if (output.stderr && this.execution) {
      await appendFile(this.execution.stderrPath, output.stderr, "utf8");
    }
    this.resolveResult?.({
      status: "executed",
      shell: this.input?.shell ?? "pwsh",
      cwd: this.input?.cwd ?? ".",
      exitCode: 0,
      stdout: output.stdout ?? "done",
      stderr: output.stderr ?? "",
      timedOut: false,
    });
  }

  timeout(): void {
    this.resolveResult?.({
      status: "executed",
      shell: this.input?.shell ?? "pwsh",
      cwd: this.input?.cwd ?? ".",
      exitCode: null,
      stdout: "partial output",
      stderr: "",
      timedOut: true,
    });
  }

  fail(error = new Error("boom")): void {
    this.rejectResult?.(error);
  }

  requireConfirmation(): void {
    this.resolveResult?.({
      status: "confirmation_required",
      shell: this.input?.shell ?? "pwsh",
      cwd: this.input?.cwd ?? ".",
      confirmationId: "confirmation-id",
      expiresAt: "2026-07-26T18:00:00.000Z",
      reasons: ["destructive command"],
    });
  }

  async terminate(pid: number): Promise<void> {
    this.terminateCalls.push(pid);
  }
}

describe("BackgroundTaskManager", () => {
  let stateDirectory: string;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(
      path.join(os.tmpdir(), "mcp-background-tasks-"),
    );
  });

  afterEach(async () => {
    await rm(stateDirectory, { recursive: true, force: true });
  });

  it("persists a successful result and reloads it with another manager instance", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const started = await manager.start_background_task({
      workspaceId: "project",
      operation: "release",
      command: "npm   run check",
      shell: "pwsh",
    });

    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "running",
    );
    await runner.succeed();
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "succeeded",
    );

    const reloaded = new BackgroundTaskManager({
      stateDirectory,
      runner: new ControlledRunner(),
    });
    const result = await reloaded.get_background_task(started.id);
    expect(result).toMatchObject({
      id: started.id,
      state: "succeeded",
      pid: 4242,
      command: "npm   run check",
      result: { status: "executed", exitCode: 0 },
    });
    expect(
      JSON.parse(
        await readFile(
          path.join(stateDirectory, `${started.id}.json`),
          "utf8",
        ),
      ),
    ).toEqual(result);
    expect(
      JSON.parse(
        await readFile(
          path.join(stateDirectory, `${started.id}.result.json`),
          "utf8",
        ),
      ),
    ).toEqual(result?.result);
  });

  it("deduplicates the same active command in the same workspace", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const input = {
      workspaceId: "project",
      operation: "check",
      command: "npm run check",
      shell: "pwsh" as const,
    };

    const first = await manager.start_background_task(input);
    const duplicate = await manager.start_background_task(input);

    expect(duplicate.id).toBe(first.id);
    expect(runner.calls).toBe(1);
    await runner.succeed();
    await waitFor(
      async () =>
        (await manager.get_background_task(first.id))?.state === "succeeded",
    );
  });

  it("isolates deduplication and task access by owner scope", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const input = {
      workspaceId: "project",
      operation: "check",
      command: "npm run check",
      shell: "pwsh" as const,
    };
    const ownerA = { ownerScope: "openai-session:owner-a" };
    const ownerB = { ownerScope: "openai-session:owner-b" };

    const first = await manager.start_background_task(input, ownerA);
    const duplicate = await manager.start_background_task(input, ownerA);
    const secondOwner = await manager.start_background_task(input, ownerB);

    expect(duplicate.id).toBe(first.id);
    expect(secondOwner.id).not.toBe(first.id);
    expect(first).not.toHaveProperty("ownerScopeHash");
    const persisted = JSON.parse(
      await readFile(path.join(stateDirectory, `${first.id}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted.ownerScopeHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(persisted)).not.toContain(ownerA.ownerScope);
    await waitFor(async () => runner.calls === 2);

    expect(
      await manager.get_background_task(first.id, ownerA),
    ).toMatchObject({ id: first.id });
    expect(await manager.get_background_task(first.id, ownerB)).toBeNull();
    expect(
      (
        await manager.list_background_tasks(
          { workspaceId: "project" },
          ownerA,
        )
      ).map((task) => task.id),
    ).toEqual([first.id]);
    expect(
      (
        await manager.list_background_tasks(
          { workspaceId: "project" },
          ownerB,
        )
      ).map((task) => task.id),
    ).toEqual([secondOwner.id]);
    expect(
      await manager.read_background_task_logs(first.id, 100_000, ownerB),
    ).toBeNull();
    await expect(
      manager.wait_background_task(
        first.id,
        { timeoutMs: 10, maxBytes: 100 },
        ownerB,
      ),
    ).resolves.toMatchObject({ task: null, logs: null });
    expect(await manager.cancel_background_task(first.id, ownerB)).toBeNull();

    await manager.cancel_background_task(first.id, ownerA);
    await manager.cancel_background_task(secondOwner.id, ownerB);
  });

  it("keeps legacy unowned records valid but hides them from scoped callers", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174001";
    await writeFile(
      path.join(stateDirectory, `${id}.json`),
      `${JSON.stringify({
        version: 1,
        id,
        workspaceId: "project",
        operation: "legacy",
        commandHash: "b".repeat(64),
        command: "echo legacy",
        shell: "pwsh",
        cwd: ".",
        state: "succeeded",
        createdAt: "2026-09-17T20:00:00.000Z",
        completedAt: "2026-09-17T20:00:01.000Z",
        timeoutMs: 120_000,
      })}\n`,
      "utf8",
    );

    const manager = new BackgroundTaskManager({
      stateDirectory,
      runner: new ControlledRunner(),
    });
    expect(await manager.get_background_task(id)).toMatchObject({
      id,
      operation: "legacy",
    });
    expect(
      await manager.get_background_task(id, {
        ownerScope: "openai-session:new-owner",
      }),
    ).toBeNull();
    expect(
      await manager.list_background_tasks(
        { workspaceId: "project" },
        { ownerScope: "openai-session:new-owner" },
      ),
    ).toEqual([]);
  });
  it("preserves significant whitespace and does not deduplicate different commands", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const first = await manager.start_background_task({
      workspaceId: "project",
      operation: "check",
      command: '  Write-Output "a  b"  ',
      shell: "pwsh",
    });
    const second = await manager.start_background_task({
      workspaceId: "project",
      operation: "check",
      command: 'Write-Output "a b"',
      shell: "pwsh",
    });

    expect(first.command).toBe('  Write-Output "a  b"  ');
    expect(second.id).not.toBe(first.id);
    await waitFor(async () => runner.calls === 2);
    expect(runner.calls).toBe(2);
    await manager.cancel_background_task(first.id);
    await manager.cancel_background_task(second.id);
  });

  it("allows the same command in different workspaces", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const first = await manager.start_background_task({
      workspaceId: "project",
      operation: "check",
      command: "npm run check",
      shell: "pwsh",
    });
    const second = await manager.start_background_task({
      workspaceId: "legacySite",
      operation: "check",
      command: "npm run check",
      shell: "pwsh",
    });

    expect(second.id).not.toBe(first.id);
    await waitFor(async () => runner.calls === 2);
    await manager.cancel_background_task(first.id);
    await manager.cancel_background_task(second.id);
  });

  it("cancels an active task and keeps cancelled as its terminal state", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const started = await manager.start_background_task({
      workspaceId: "project",
      operation: "soak",
      command: "Start-Sleep -Seconds 60",
      shell: "pwsh",
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "running",
    );

    const cancelled = await manager.cancel_background_task(started.id);
    expect(cancelled).toMatchObject({
      state: "cancelled",
      lifecycle: {
        terminatedBy: "background_task_manager",
        reason: "cancelled",
      },
    });
    expect(runner.signal?.aborted).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await manager.get_background_task(started.id))?.state).toBe(
      "cancelled",
    );
  });

  it("persists failures", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const started = await manager.start_background_task({
      workspaceId: "project",
      operation: "release",
      command: "exit 1",
      shell: "pwsh",
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "running",
    );
    runner.fail();
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "failed",
    );
    expect(await manager.get_background_task(started.id)).toMatchObject({
      error: "boom",
      lifecycle: {
        terminatedBy: "background_task_manager",
        reason: "process_failed",
      },
    });
  });

  it("persists timeout diagnostics and partial output for long tasks", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const started = await manager.start_background_task({
      workspaceId: "project",
      operation: "long-check",
      command: "npm run check",
      shell: "pwsh",
      timeoutMs: 300_001,
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "running",
    );

    runner.timeout();

    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "failed",
    );
    expect(await manager.get_background_task(started.id)).toMatchObject({
      timeoutMs: 300_001,
      state: "failed",
      result: {
        timedOut: true,
        stdout: "partial output",
      },
      lifecycle: {
        terminatedBy: "child_process",
        reason: "timeout",
      },
    });
  });

  it("fails when a runner requests interactive confirmation", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const started = await manager.start_background_task({
      workspaceId: "project",
      operation: "check",
      command: "npm run check",
      shell: "pwsh",
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "running",
    );

    runner.requireConfirmation();

    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "failed",
    );
    expect((await manager.get_background_task(started.id))?.error).toBe(
      "Background tasks cannot enter an interactive confirmation flow.",
    );
  });

  it("rejects timeouts outside the centralized policy", async () => {
    const manager = new BackgroundTaskManager({
      stateDirectory,
      runner: new ControlledRunner(),
    });
    await expect(
      manager.start_background_task({
        workspaceId: "project",
        operation: "invalid",
        command: "echo invalid",
        shell: "pwsh",
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow();
  });

  it("persists separate logs and redacts credentials, private URLs and paths", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const started = await manager.start_background_task({
      workspaceId: "project",
      operation: "check",
      command: "npm run check",
      shell: "pwsh",
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "running",
    );

    await runner.succeed({
      stdout: "token=top-secret\nAuthorization: Bearer abc.def.ghi\nhttp://127.0.0.1:3410/private?token=value\nC:\\Users\\example-user\\repo\\file.txt\n.runtime-private\\config.json\n",
      stderr: "password: hunter2\n",
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "succeeded",
    );

    const task = await manager.get_background_task(started.id);
    expect(task?.result).toMatchObject({
      stdout: expect.not.stringContaining("top-secret"),
      stderr: expect.not.stringContaining("hunter2"),
    });
    const logs = await manager.read_background_task_logs(started.id);
    expect(logs?.stdout).toContain("token=[REDACTED]");
    expect(logs?.stdout).not.toContain("top-secret");
    expect(logs?.stdout).not.toContain("127.0.0.1");
    expect(logs?.stdout).not.toContain("C:\\Users\\example-user");
    expect(logs?.stdout).not.toContain(".runtime-private");
    expect(logs?.stdout).toContain("[REDACTED_PRIVATE_URL]");
    expect(logs?.stdout).toContain("%USERPROFILE%");
    expect(logs?.stdout).toContain("[REDACTED_PRIVATE_PATH]");
    expect(logs?.stderr).toContain("password: [REDACTED]");

    const persistedStdout = await readFile(
      path.join(stateDirectory, `${started.id}.stdout.log`),
      "utf8",
    );
    const persistedStderr = await readFile(
      path.join(stateDirectory, `${started.id}.stderr.log`),
      "utf8",
    );
    expect(persistedStdout).toContain("token=[REDACTED]");
    expect(persistedStdout).not.toContain("top-secret");
    expect(persistedStdout).not.toContain("127.0.0.1");
    expect(persistedStdout).not.toContain("C:\\Users\\example-user");
    expect(persistedStdout).not.toContain(".runtime-private");
    expect(persistedStderr).toContain("password: [REDACTED]");
    expect(persistedStderr).not.toContain("hunter2");
  });

  it("waits for an active task to finish and returns a bounded redacted log tail", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const started = await manager.start_background_task({
      workspaceId: "project",
      operation: "check",
      command: "npm run check",
      shell: "pwsh",
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "running",
    );

    const waitBackgroundTask = (manager as unknown as {
      wait_background_task?: (
        id: string,
        options: { timeoutMs: number; maxBytes: number },
      ) => Promise<unknown>;
    }).wait_background_task;
    expect(typeof waitBackgroundTask).toBe("function");

    const waiting = waitBackgroundTask!.call(manager, started.id, {
      timeoutMs: 500,
      maxBytes: 8,
    });
    await runner.succeed({ stdout: "0123456789", stderr: "ERR" });

    await expect(waiting).resolves.toMatchObject({
      task: {
        id: started.id,
        state: "succeeded",
        result: { exitCode: 0, timedOut: false },
      },
      logs: {
        id: started.id,
        stdout: "23456789",
        stderr: "ERR",
        stdoutBytes: 10,
        stderrBytes: 3,
        truncated: true,
      },
      timedOut: false,
      elapsedMs: expect.any(Number),
    });
  });

  it("stops waiting on wait timeout without cancelling the background task", async () => {
    const runner = new ControlledRunner();
    const manager = new BackgroundTaskManager({ stateDirectory, runner });
    const started = await manager.start_background_task({
      workspaceId: "project",
      operation: "check",
      command: "npm run check",
      shell: "pwsh",
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "running",
    );

    const waitBackgroundTask = (manager as unknown as {
      wait_background_task?: (
        id: string,
        options: { timeoutMs: number; maxBytes: number },
      ) => Promise<unknown>;
    }).wait_background_task;
    expect(typeof waitBackgroundTask).toBe("function");

    const result = await waitBackgroundTask!.call(manager, started.id, {
      timeoutMs: 25,
      maxBytes: 100,
    });

    expect(result).toMatchObject({
      task: { id: started.id, state: "running" },
      timedOut: true,
      elapsedMs: expect.any(Number),
    });
    expect(runner.signal?.aborted).toBe(false);
    expect(runner.terminateCalls).toEqual([]);

    await runner.succeed();
    await waitFor(
      async () =>
        (await manager.get_background_task(started.id))?.state === "succeeded",
    );
  });
  it("marks a persisted active task as interrupted when its pid is gone", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    await writeFile(
      path.join(stateDirectory, `${id}.json`),
      `${JSON.stringify({
        version: 1,
        id,
        workspaceId: "project",
        operation: "check",
        commandHash: "a".repeat(64),
        command: "npm run check",
        shell: "pwsh",
        cwd: ".",
        state: "running",
        createdAt: "2026-07-25T00:00:00.000Z",
        startedAt: "2026-07-25T00:00:01.000Z",
        timeoutMs: 120_000,
        pid: 2147483647,
      })}\n`,
      "utf8",
    );

    const manager = new BackgroundTaskManager({
      stateDirectory,
      runner: new ControlledRunner(),
    });
    const recovered = await manager.get_background_task(id);
    expect(recovered).toMatchObject({
      state: "failed",
      error: "Background task was interrupted before Agent recovery.",
      lifecycle: {
        terminatedBy: "background_task_manager",
        reason: "process_failed",
      },
    });
  });

  it("prunes expired terminal task artifacts while preserving active and recent records", async () => {
    const now = new Date("2026-09-19T00:00:00.000Z");
    const oldId = "123e4567-e89b-42d3-a456-426614174010";
    const recentId = "123e4567-e89b-42d3-a456-426614174011";
    const activeId = "123e4567-e89b-42d3-a456-426614174012";

    await writePersistedTaskArtifacts(stateDirectory, {
      version: 1,
      id: oldId,
      workspaceId: "project",
      operation: "old",
      commandHash: "1".repeat(64),
      command: "echo old",
      shell: "pwsh",
      cwd: ".",
      state: "succeeded",
      createdAt: "2026-08-18T00:00:00.000Z",
      completedAt: "2026-08-18T00:00:01.000Z",
      timeoutMs: 120_000,
    });
    await writePersistedTaskArtifacts(stateDirectory, {
      version: 1,
      id: recentId,
      workspaceId: "project",
      operation: "recent",
      commandHash: "2".repeat(64),
      command: "echo recent",
      shell: "pwsh",
      cwd: ".",
      state: "succeeded",
      createdAt: "2026-09-18T00:00:00.000Z",
      completedAt: "2026-09-18T00:00:01.000Z",
      timeoutMs: 120_000,
    });
    await writePersistedTaskArtifacts(
      stateDirectory,
      {
        version: 1,
        id: activeId,
        workspaceId: "project",
        operation: "active",
        commandHash: "3".repeat(64),
        command: "echo active",
        shell: "pwsh",
        cwd: ".",
        state: "running",
        createdAt: "2026-09-18T23:59:00.000Z",
        startedAt: "2026-09-18T23:59:01.000Z",
        timeoutMs: 120_000,
        pid: process.pid,
      },
      false,
    );

    const manager = new BackgroundTaskManager({
      stateDirectory,
      runner: new ControlledRunner(),
      now: () => now,
      terminalRetentionMs: 30 * 24 * 60 * 60 * 1_000,
      maxRetainedTerminalTasks: 500,
    });

    expect((await manager.list_background_tasks()).map((task) => task.id)).toEqual(
      expect.arrayContaining([recentId, activeId]),
    );
    expect(await manager.get_background_task(oldId)).toBeNull();

    const files = await readdir(stateDirectory);
    expect(files.some((file) => file.startsWith(oldId))).toBe(false);
    expect(files.some((file) => file.startsWith(recentId))).toBe(true);
    expect(files.some((file) => file.startsWith(activeId))).toBe(true);
  });

  it("caps retained terminal tasks by recency without pruning active tasks", async () => {
    const now = new Date("2026-09-19T00:00:00.000Z");
    const newestId = "123e4567-e89b-42d3-a456-426614174020";
    const middleId = "123e4567-e89b-42d3-a456-426614174021";
    const oldestId = "123e4567-e89b-42d3-a456-426614174022";
    const activeId = "123e4567-e89b-42d3-a456-426614174023";

    for (const [id, completedAt, hash] of [
      [newestId, "2026-09-18T23:00:00.000Z", "4"],
      [middleId, "2026-09-18T22:00:00.000Z", "5"],
      [oldestId, "2026-09-18T21:00:00.000Z", "6"],
    ] as const) {
      await writePersistedTaskArtifacts(stateDirectory, {
        version: 1,
        id,
        workspaceId: "project",
        operation: "terminal",
        commandHash: hash.repeat(64),
        command: `echo ${id}`,
        shell: "pwsh",
        cwd: ".",
        state: "succeeded",
        createdAt: completedAt,
        completedAt,
        timeoutMs: 120_000,
      });
    }
    await writePersistedTaskArtifacts(
      stateDirectory,
      {
        version: 1,
        id: activeId,
        workspaceId: "project",
        operation: "active",
        commandHash: "7".repeat(64),
        command: "echo active",
        shell: "pwsh",
        cwd: ".",
        state: "running",
        createdAt: "2026-09-18T20:00:00.000Z",
        startedAt: "2026-09-18T20:00:01.000Z",
        timeoutMs: 120_000,
        pid: process.pid,
      },
      false,
    );

    const manager = new BackgroundTaskManager({
      stateDirectory,
      runner: new ControlledRunner(),
      now: () => now,
      terminalRetentionMs: 30 * 24 * 60 * 60 * 1_000,
      maxRetainedTerminalTasks: 2,
    });

    const ids = (await manager.list_background_tasks()).map((task) => task.id);
    expect(ids).toEqual(expect.arrayContaining([newestId, middleId, activeId]));
    expect(ids).not.toContain(oldestId);
    expect(await manager.get_background_task(oldestId)).toBeNull();

    const files = await readdir(stateDirectory);
    expect(files.some((file) => file.startsWith(oldestId))).toBe(false);
    expect(files.some((file) => file.startsWith(activeId))).toBe(true);
  });

  it("prunes retained terminal tasks before starting a later task", async () => {
    const runner = new ControlledRunner();
    let nowMs = Date.parse("2026-09-19T00:00:00.000Z");
    const manager = new BackgroundTaskManager({
      stateDirectory,
      runner,
      now: () => new Date(nowMs),
      terminalRetentionMs: 30 * 24 * 60 * 60 * 1_000,
      maxRetainedTerminalTasks: 1,
    });

    const first = await manager.start_background_task({
      workspaceId: "project",
      operation: "first",
      command: "echo first",
      shell: "pwsh",
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(first.id))?.state === "running",
    );
    await runner.succeed();
    await waitFor(
      async () =>
        (await manager.get_background_task(first.id))?.state === "succeeded",
    );

    nowMs += 1_000;
    const second = await manager.start_background_task({
      workspaceId: "project",
      operation: "second",
      command: "echo second",
      shell: "pwsh",
    });
    await waitFor(
      async () =>
        (await manager.get_background_task(second.id))?.state === "running",
    );
    await runner.succeed();
    await waitFor(
      async () =>
        (await manager.get_background_task(second.id))?.state === "succeeded",
    );

    nowMs += 1_000;
    const third = await manager.start_background_task({
      workspaceId: "project",
      operation: "third",
      command: "echo third",
      shell: "pwsh",
    });

    expect(await manager.get_background_task(first.id)).toBeNull();
    expect(await manager.get_background_task(second.id)).toMatchObject({
      state: "succeeded",
    });
    await manager.cancel_background_task(third.id);
  });

  it("moves invalid state files to quarantine", async () => {
    const id = "123e4567-e89b-42d3-a456-426614174000";
    await writeFile(path.join(stateDirectory, `${id}.json`), "{invalid", "utf8");

    const manager = new BackgroundTaskManager({
      stateDirectory,
      runner: new ControlledRunner(),
    });
    expect(await manager.list_background_tasks()).toEqual([]);
    const quarantined = await readdir(path.join(stateDirectory, "quarantine"));
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toContain(`${id}.json`);
  });
});

async function writePersistedTaskArtifacts(
  stateDirectory: string,
  record: Record<string, unknown> & { id: string },
  includeResult = true,
): Promise<void> {
  await Promise.all([
    writeFile(
      path.join(stateDirectory, `${record.id}.json`),
      `${JSON.stringify(record)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(stateDirectory, `${record.id}.stdout.log`),
      "stdout\n",
      "utf8",
    ),
    writeFile(
      path.join(stateDirectory, `${record.id}.stderr.log`),
      "stderr\n",
      "utf8",
    ),
    ...(includeResult
      ? [
          writeFile(
            path.join(stateDirectory, `${record.id}.result.json`),
            "{}\n",
            "utf8",
          ),
        ]
      : []),
  ]);
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}
