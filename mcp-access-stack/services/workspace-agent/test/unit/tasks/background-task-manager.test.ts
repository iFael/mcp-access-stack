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
