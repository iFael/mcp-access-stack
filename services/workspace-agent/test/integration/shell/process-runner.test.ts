import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import {
  resolvePwshExecutable,
  runShellCommand,
  runShellCommandToFiles,
  type ShellStdinControl,
} from "../../../src/shell/process-runner.js";
import { redactSensitiveText } from "../../../src/tasks/background-task-manager.js";
import {
  createFixture,
  type Fixture,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;
let outputDirectory: string | undefined;

const isWindows = process.platform === "win32";
const nativeShell = isWindows ? "cmd" as const : "sh" as const;
const sleepShell = isWindows ? "powershell" as const : "sh" as const;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
  if (outputDirectory) {
    await rm(outputDirectory, { recursive: true, force: true });
    outputDirectory = undefined;
  }
}, 30_000);

describe("shell process runner", () => {
  test("resolves pwsh natively on Windows and Unix", () => {
    expect(resolvePwshExecutable("win32")).toBe("pwsh.exe");
    expect(resolvePwshExecutable("linux")).toBe("pwsh");
    expect(resolvePwshExecutable("darwin")).toBe("pwsh");
  });

  test("executes a shell without using Node shell mode", async () => {
    fixture = await createFixture();

    await expect(
      runShellCommand(
        nativeShell,
        "echo runner-ok",
        fixture.workspacePath,
        ".",
        5_000,
      ),
    ).resolves.toMatchObject({
      status: "executed",
      shell: nativeShell,
      cwd: ".",
      exitCode: 0,
      stdout: expect.stringContaining("runner-ok"),
      timedOut: false,
    });
  });

  test("does not convert a completed child into a timeout when the event loop is delayed", async () => {
    fixture = await createFixture();
    const execution = runShellCommand(
      nativeShell,
      delayCommand(2),
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
        sleepShell,
        longSleepCommand(),
        fixture.workspacePath,
        ".",
        100,
      ),
    ).resolves.toMatchObject({
      status: "executed",
      shell: sleepShell,
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
    const leasePath = path.join(fixture.workspacePath, "child.lease");
    const command = isWindows
      ? windowsDescendantCommand(pidPath, leasePath)
      : posixDescendantCommand(pidPath);
    const execution = runShellCommand(
      sleepShell,
      command,
      fixture.workspacePath,
      ".",
      30_000,
    );
    const childPid = await waitForPidFile(pidPath, 20_000);

    const result = await execution;
    expect(result).toMatchObject({
      timedOut: true,
      lifecycle: { terminatedBy: "child_process", reason: "timeout" },
    });
    expect(Number.isSafeInteger(childPid)).toBe(true);
    if (isWindows) {
      await expectExclusiveLeaseReleased(leasePath);
    } else {
      await expectProcessToExit(childPid);
    }
  }, 90_000);

  test("distinguishes caller cancellation from timeout", async () => {
    fixture = await createFixture();
    const controller = new AbortController();
    const execution = runShellCommand(
      sleepShell,
      longSleepCommand(),
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
      isWindows ? "powershell" : "sh",
      isWindows
        ? [
            "[Console]::Out.Write('token=runner-')",
            "Start-Sleep -Milliseconds 100",
            "[Console]::Out.WriteLine('secret')",
            "[Console]::Error.WriteLine('password: runner-pass')",
          ].join("; ")
        : [
            "printf 'token=runner-'",
            "sleep 0.1",
            "printf 'secret\\n'",
            "printf 'password: runner-pass\\n' >&2",
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

  test("writes to a persisted interactive process stdin without PTY", async () => {
    fixture = await createFixture();
    outputDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-shell-output-"));
    const stdoutPath = path.join(outputDirectory, "stdout.log");
    const stderrPath = path.join(outputDirectory, "stderr.log");
    let stdinControl: ShellStdinControl | undefined;

    const execution = runShellCommandToFiles(
      isWindows ? "powershell" : "sh",
      isWindows
        ? "$line = [Console]::In.ReadLine(); [Console]::Out.WriteLine(('stdin:' + $line))"
        : "IFS= read -r line; printf 'stdin:%s\\n' \"$line\"",
      fixture.workspacePath,
      ".",
      30_000,
      {
        stdoutPath,
        stderrPath,
        interactive: true,
        onStdinControl: (control) => {
          stdinControl = control;
        },
      },
    );

    const deadline = Date.now() + 5_000;
    while (!stdinControl && Date.now() < deadline) {
      await delay(10);
    }
    expect(stdinControl).toBeDefined();

    await stdinControl!.write("hello-from-stdin\n");
    await stdinControl!.close();

    await expect(execution).resolves.toMatchObject({
      status: "executed",
      exitCode: 0,
      timedOut: false,
      stdout: expect.stringContaining("stdin:hello-from-stdin"),
    });
    expect(await readFile(stdoutPath, "utf8")).toContain(
      "stdin:hello-from-stdin",
    );
  }, 45_000);

  test("preserves a completed persisted child result when the event loop is delayed", async () => {
    fixture = await createFixture();
    outputDirectory = await mkdtemp(path.join(os.tmpdir(), "mcp-shell-output-"));
    const stdoutPath = path.join(outputDirectory, "stdout.log");
    const stderrPath = path.join(outputDirectory, "stderr.log");
    const execution = runShellCommandToFiles(
      nativeShell,
      delayCommand(2),
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

function delayCommand(seconds: number): string {
  return isWindows
    ? `ping -n ${seconds + 1} 127.0.0.1 >NUL`
    : `sleep ${seconds}`;
}

function longSleepCommand(): string {
  return isWindows ? "Start-Sleep -Seconds 10" : "sleep 10";
}

function windowsDescendantCommand(pidPath: string, leasePath: string): string {
  const escapedPidPath = pidPath.replaceAll("'", "''");
  const escapedLeasePath = leasePath.replaceAll("'", "''");
  const childScript = [
    `$lease = [IO.File]::Open('${escapedLeasePath}', 'OpenOrCreate', 'ReadWrite', 'None')`,
    `Set-Content -LiteralPath '${escapedPidPath}' -Value $PID`,
    "Start-Sleep -Seconds 60",
  ].join("; ");
  const encoded = Buffer.from(childScript, "utf16le").toString("base64");
  return [
    `$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' -PassThru`,
    "Start-Sleep -Seconds 60",
  ].join("; ");
}

function posixDescendantCommand(pidPath: string): string {
  const escaped = "'" + pidPath.replaceAll("'", "'\\''") + "'";
  return `sleep 60 & child=$!; printf '%s\\n' "$child" > ${escaped}; wait "$child"`;
}

async function waitForPidFile(pidPath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pid = Number((await readFile(pidPath, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch (error) {
      // PowerShell's Set-Content briefly holds an exclusive handle on Windows.
      // Retry only transient open/read races; still require a valid PID in time.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
    }
    await delay(25);
  }
  throw new Error(`Descendant PID marker was not created within ${timeoutMs}ms.`);
}

async function expectExclusiveLeaseReleased(
  leasePath: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const handle = await open(leasePath, "r+");
      await handle.close();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") throw error;
    }
    await delay(50);
  }
  throw new Error("Descendant process kept its exclusive lease after tree termination.");
}

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
