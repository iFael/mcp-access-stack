import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import {
  runShellCommand,
  runShellCommandToFiles,
} from "../../../src/shell/process-runner.js";
import { redactSensitiveText } from "../../../src/tasks/background-task-manager.js";
import {
  createFixture,
  type Fixture,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;
let outputDirectory: string | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
  if (outputDirectory) {
    await rm(outputDirectory, { recursive: true, force: true });
    outputDirectory = undefined;
  }
}, 30_000);

describe("shell process runner", () => {
  test("executes a shell without using Node shell mode", async () => {
    fixture = await createFixture();

    await expect(
      runShellCommand(
        "cmd",
        "echo runner-ok",
        fixture.workspacePath,
        ".",
        5_000,
      ),
    ).resolves.toMatchObject({
      status: "executed",
      shell: "cmd",
      cwd: ".",
      exitCode: 0,
      stdout: expect.stringContaining("runner-ok"),
      timedOut: false,
    });
  });

  test("does not convert a completed child into a timeout when the event loop is delayed", async () => {
    fixture = await createFixture();
    const execution = runShellCommand(
      "cmd",
      "ping -n 3 127.0.0.1 >NUL",
      fixture.workspacePath,
      ".",
      3_000,
    );

    await delay(500);
    blockEventLoop(3_500);

    await expect(execution).resolves.toMatchObject({
      status: "executed",
      exitCode: 0,
      timedOut: false,
    });
  }, 60_000);

  test("terminates the process tree when the timeout expires", async () => {
    fixture = await createFixture();

    await expect(
      runShellCommand(
        "powershell",
        "Start-Sleep -Seconds 10",
        fixture.workspacePath,
        ".",
        100,
      ),
    ).resolves.toMatchObject({
      status: "executed",
      shell: "powershell",
      cwd: ".",
      exitCode: null,
      timedOut: true,
      lifecycle: {
        terminatedBy: "child_process",
        reason: "timeout",
      },
    });
  }, 60_000);

  test("terminates descendants and leaves no orphan after timeout", async () => {
    fixture = await createFixture();
    const pidPath = path.join(fixture.workspacePath, "child.pid");
    const escapedPidPath = pidPath.replaceAll("'", "''");
    const result = await runShellCommand(
      "powershell",
      [
        "$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -PassThru",
        `Set-Content -LiteralPath '${escapedPidPath}' -Value $child.Id`,
        "Start-Sleep -Seconds 30",
      ].join("; "),
      fixture.workspacePath,
      ".",
      20_000,
    );

    expect(result).toMatchObject({
      timedOut: true,
      lifecycle: { terminatedBy: "child_process", reason: "timeout" },
    });
    const childPid = Number((await readFile(pidPath, "utf8")).trim());
    expect(Number.isSafeInteger(childPid)).toBe(true);
    await expectProcessToExit(childPid);
  }, 90_000);

  test("distinguishes caller cancellation from timeout", async () => {
    fixture = await createFixture();
    const controller = new AbortController();
    const execution = runShellCommand(
      "powershell",
      "Start-Sleep -Seconds 10",
      fixture.workspacePath,
      ".",
      10_000,
      controller.signal,
    );

    setTimeout(() => controller.abort(), 100).unref();

    await expect(execution).rejects.toMatchObject({
      code: "OPERATION_CANCELLED",
    });
  }, 60_000);

  test("redacts streamed output before writing log files", async () => {
    fixture = await createFixture();
    outputDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-shell-output-"));
    const stdoutPath = path.join(outputDirectory, "stdout.log");
    const stderrPath = path.join(outputDirectory, "stderr.log");

    const result = await runShellCommandToFiles(
      "powershell",
      [
        "[Console]::Out.Write('token=runner-')",
        "Start-Sleep -Milliseconds 100",
        "[Console]::Out.WriteLine('secret')",
        "[Console]::Error.WriteLine('password: runner-pass')",
      ].join("; "),
      fixture.workspacePath,
      ".",
      30_000,
      {
        stdoutPath,
        stderrPath,
        transformOutput: redactSensitiveText,
      },
    );

    const persistedStdout = await readFile(stdoutPath, "utf8");
    const persistedStderr = await readFile(stderrPath, "utf8");

    expect(result).toMatchObject({
      status: "executed",
      exitCode: 0,
      timedOut: false,
      stdout: expect.stringContaining("token=[REDACTED]"),
      stderr: expect.stringContaining("password: [REDACTED]"),
    });
    expect(persistedStdout).not.toContain("runner-secret");
    expect(persistedStderr).not.toContain("runner-pass");
  }, 45_000);

  test("preserves a completed persisted child result when the event loop is delayed", async () => {
    fixture = await createFixture();
    outputDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-shell-output-"));
    const stdoutPath = path.join(outputDirectory, "stdout.log");
    const stderrPath = path.join(outputDirectory, "stderr.log");
    const execution = runShellCommandToFiles(
      "cmd",
      "ping -n 3 127.0.0.1 >NUL",
      fixture.workspacePath,
      ".",
      3_000,
      { stdoutPath, stderrPath },
    );

    await delay(500);
    blockEventLoop(3_500);

    await expect(execution).resolves.toMatchObject({
      status: "executed",
      exitCode: 0,
      timedOut: false,
    });
  }, 60_000);
});

async function expectProcessToExit(pid: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} remained alive after tree termination.`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blockEventLoop(durationMs: number): void {
  const deadline = performance.now() + durationMs;
  while (performance.now() < deadline) {
    // Intentionally block to reproduce timer/child-exit callback reordering under load.
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
