import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import {
  abortSignalError,
  AppError,
  createOperationDeadline,
  createOperationLifecycle,
  type OperationDeadline,
  type RunCommandResult,
  type ShellName,
} from "@vs-code-gpt/shared";
import {
  terminateChildProcessTree,
  terminateProcessTreeByPid,
} from "../process/process-tree.js";

const MAX_OUTPUT_BYTES = 100_000;
const MAX_REDACTION_LINE_CHARS = 64_000;
const OMITTED_OUTPUT_LINE = "[output line omitted: exceeded safe redaction buffer]\n";

type TerminationReason = "timeout" | "abort";

export interface ShellFileExecutionOptions {
  stdoutPath: string;
  stderrPath: string;
  onPid?: (pid: number) => void;
  transformOutput?: (value: string) => string;
}

interface SafeFileSink {
  write(chunk: Buffer): void;
  end(): Promise<void>;
}

export async function runShellCommand(
  shell: ShellName,
  command: string,
  cwd: string,
  logicalCwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
  deadline: OperationDeadline = createOperationDeadline(timeoutMs, undefined),
): Promise<RunCommandResult> {
  const spec = await resolveShellSpec(shell, command, cwd);
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(spec.executable, spec.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let terminationReason: TerminationReason | undefined;
    let termination: Promise<void> | undefined;
    let timeoutDispatch: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      if (timeoutDispatch) clearTimeout(timeoutDispatch);
      signal?.removeEventListener("abort", onAbort);
    };

    const failTermination = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const requestTermination = (reason: TerminationReason): void => {
      if (terminationReason !== undefined || settled) return;
      terminationReason = reason;
      termination ??= terminateChildProcessTree(child);
      void termination.catch(failTermination);
    };

    const onAbort = (): void => requestTermination("abort");

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });

    const timer = setTimeout(() => {
      // Give an already-exited child one event-loop turn to publish its close event.
      timeoutDispatch = setTimeout(() => requestTermination("timeout"), 0);
      timeoutDispatch.unref();
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) requestTermination("abort");

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      const code = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "SHELL_UNAVAILABLE"
        : "SHELL_FAILED";
      reject(new AppError(code, `Failed to start ${shell}.`, { cause: error }));
    });

    child.on("close", async (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        await termination;
      } catch (error) {
        reject(error);
        return;
      }
      if (terminationReason === "abort") {
        reject(abortSignalError(signal));
        return;
      }
      resolve({
        status: "executed",
        shell,
        cwd: logicalCwd,
        exitCode: terminationReason === undefined ? exitCode : null,
        stdout,
        stderr,
        timedOut: terminationReason === "timeout",
        lifecycle: createOperationLifecycle(
          deadline,
          startedAt,
          terminationReason === "timeout"
            ? {
                layer: "child_process",
                reason: "timeout",
                diagnostic: "The child process exceeded its effective command deadline.",
              }
            : undefined,
        ),
      });
    });
  });
}

export async function runShellCommandToFiles(
  shell: ShellName,
  command: string,
  cwd: string,
  logicalCwd: string,
  timeoutMs: number,
  output: ShellFileExecutionOptions,
  signal?: AbortSignal,
  deadline: OperationDeadline = createOperationDeadline(timeoutMs, undefined),
): Promise<RunCommandResult> {
  const spec = await resolveShellSpec(shell, command, cwd);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined;
    let outputFailure: unknown;
    let termination: Promise<void> | undefined;
    let timeoutDispatch: NodeJS.Timeout | undefined;

    const terminate = (): Promise<void> => {
      if (!child) return Promise.resolve();
      termination ??= terminateChildProcessTree(child);
      return termination;
    };
    const onOutputFailure = (error: unknown): void => {
      outputFailure ??= error;
      void terminate().catch(() => undefined);
    };
    const stdoutSink = createSafeFileSink(
      output.stdoutPath,
      output.transformOutput,
      onOutputFailure,
    );
    const stderrSink = createSafeFileSink(
      output.stderrPath,
      output.transformOutput,
      onOutputFailure,
    );

    try {
      child = spawn(spec.executable, spec.args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      void Promise.allSettled([stdoutSink.end(), stderrSink.end()]);
      reject(new AppError("SHELL_FAILED", `Failed to start ${shell}.`, { cause: error }));
      return;
    }

    if (child.pid) output.onPid?.(child.pid);

    let settled = false;
    let terminationReason: TerminationReason | undefined;

    const cleanup = (): void => {
      clearTimeout(timer);
      if (timeoutDispatch) clearTimeout(timeoutDispatch);
      signal?.removeEventListener("abort", onAbort);
    };

    const failTermination = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void Promise.allSettled([stdoutSink.end(), stderrSink.end()]).finally(() => {
        reject(error);
      });
    };

    const requestTermination = (reason: TerminationReason): void => {
      if (terminationReason !== undefined || settled) return;
      terminationReason = reason;
      void terminate().catch(failTermination);
    };

    const onAbort = (): void => requestTermination("abort");
    const timer = setTimeout(() => {
      // Give an already-exited child one event-loop turn to publish its close event.
      timeoutDispatch = setTimeout(() => requestTermination("timeout"), 0);
      timeoutDispatch.unref();
    }, timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) requestTermination("abort");

    child.stdout?.on("data", (chunk: Buffer) => stdoutSink.write(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderrSink.write(chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      void Promise.allSettled([stdoutSink.end(), stderrSink.end()]).finally(() => {
        const code = (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "SHELL_UNAVAILABLE"
          : "SHELL_FAILED";
        reject(new AppError(code, `Failed to start ${shell}.`, { cause: error }));
      });
    });

    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      void Promise.all([stdoutSink.end(), stderrSink.end()])
        .then(async () => {
          await termination;
          if (outputFailure !== undefined) {
            throw new AppError("SHELL_FAILED", "Failed to persist sanitized shell output.", {
              cause: outputFailure,
            });
          }
          const [stdout, stderr] = await Promise.all([
            readCappedFile(output.stdoutPath),
            readCappedFile(output.stderrPath),
          ]);
          if (terminationReason === "abort") {
            throw abortSignalError(signal);
          }
          resolve({
            status: "executed",
            shell,
            cwd: logicalCwd,
            exitCode: terminationReason === undefined ? exitCode : null,
            stdout,
            stderr,
            timedOut: terminationReason === "timeout",
            lifecycle: createOperationLifecycle(
              deadline,
              startedAt,
              terminationReason === "timeout"
                ? {
                    layer: "child_process",
                    reason: "timeout",
                    diagnostic: "The persisted child process exceeded its effective command deadline.",
                  }
                : undefined,
            ),
          });
        })
        .catch(reject);
    });
  });
}

export { terminateProcessTreeByPid };

async function resolveShellSpec(
  shell: ShellName,
  command: string,
  cwd: string,
): Promise<{ executable: string; args: string[] }> {
  switch (shell) {
    case "powershell":
      return {
        executable: "powershell.exe",
        args: [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command,
        ],
      };
    case "pwsh":
      return {
        executable: "pwsh.exe",
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
      };
    case "cmd":
      return {
        executable: "cmd.exe",
        args: ["/d", "/s", "/c", command],
      };
    case "wsl":
      return {
        executable: "wsl.exe",
        args: ["--cd", cwd, "--exec", "sh", "-lc", command],
      };
    case "git-bash":
      return {
        executable: await resolveGitBash(),
        args: ["-lc", command],
      };
  }
}

async function resolveGitBash(): Promise<string> {
  const candidates = [
    process.env.GIT_BASH_PATH,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      await access(resolved);
      return resolved;
    } catch {
      continue;
    }
  }

  throw new AppError("SHELL_UNAVAILABLE", "Git Bash executable was not found.");
}

function createSafeFileSink(
  filePath: string,
  transform: ((value: string) => string) | undefined,
  onFailure: (error: unknown) => void,
): SafeFileSink {
  const stream = createWriteStream(filePath, { flags: "a", encoding: "utf8" });
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let droppingOversizedLine = false;
  let ended = false;
  let failed = false;

  stream.once("error", (error) => {
    failed = true;
    onFailure(error);
  });

  const writeSanitized = (value: string): void => {
    if (failed || value.length === 0) return;
    try {
      stream.write(transform ? transform(value) : value);
    } catch (error) {
      failed = true;
      onFailure(error);
    }
  };

  const consume = (value: string): void => {
    let text = pending + value;
    pending = "";

    while (text.length > 0) {
      if (droppingOversizedLine) {
        const newlineIndex = text.indexOf("\n");
        if (newlineIndex < 0) return;
        droppingOversizedLine = false;
        text = text.slice(newlineIndex + 1);
        continue;
      }

      const newlineIndex = text.indexOf("\n");
      if (newlineIndex >= 0) {
        writeSanitized(text.slice(0, newlineIndex + 1));
        text = text.slice(newlineIndex + 1);
        continue;
      }

      if (text.length > MAX_REDACTION_LINE_CHARS) {
        writeSanitized(OMITTED_OUTPUT_LINE);
        droppingOversizedLine = true;
        return;
      }

      pending = text;
      return;
    }
  };

  return {
    write(chunk: Buffer): void {
      if (ended || failed) return;
      consume(decoder.write(chunk));
    },
    async end(): Promise<void> {
      if (ended) {
        await finished(stream);
        return;
      }
      ended = true;
      consume(decoder.end());
      if (!droppingOversizedLine) writeSanitized(pending);
      pending = "";
      stream.end();
      await finished(stream);
    },
  };
}

function appendCapped(current: string, chunk: string): string {
  const combined = current + chunk;
  if (Buffer.byteLength(combined, "utf8") <= MAX_OUTPUT_BYTES) {
    return combined;
  }
  return `${truncateUtf8(combined, MAX_OUTPUT_BYTES)}\n...[output truncated]`;
}

async function readCappedFile(filePath: string): Promise<string> {
  const value = await readFile(filePath);
  if (value.byteLength <= MAX_OUTPUT_BYTES) return value.toString("utf8");
  return `${value.subarray(value.byteLength - MAX_OUTPUT_BYTES).toString("utf8")}\n...[output truncated]`;
}

function truncateUtf8(value: string, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return output;
}
