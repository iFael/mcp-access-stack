import { spawn } from "node:child_process";
import { abortSignalError, AppError } from "@vs-code-gpt/shared";
import { terminateChildProcessTree } from "../process/process-tree.js";

const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputTruncated: boolean;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortSignalError(signal, "Validation request was cancelled.");
}

export function isExecutableNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export async function readToolVersion(
  command: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const result = await executeProcess(command, args, cwd, 15_000, signal);
  if (result.timedOut || result.exitCode !== 0) return undefined;
  return (result.stdout.trim() || result.stderr.trim()).split(/\r?\n/)[0]?.slice(0, 200);
}

export function sanitizeToolError(value: string, fallback: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 500) : fallback;
}

export function executeProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let outputTruncated = false;
    let timedOut = false;
    let abortError: AppError | undefined;
    let settled = false;
    let termination: Promise<void> | undefined;
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      const remaining = MAX_PROCESS_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      const slice = chunk.subarray(0, remaining);
      outputBytes += slice.byteLength;
      if (slice.byteLength < chunk.byteLength) outputTruncated = true;
      if (target === "stdout") stdout += slice.toString("utf8");
      else stderr += slice.toString("utf8");
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

    const terminate = (): Promise<void> => {
      termination ??= terminateChildProcessTree(child);
      return termination;
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const abort = (): void => {
      if (settled || abortError) return;
      abortError = abortSignalError(signal, "Validation request was cancelled.");
      void terminate();
    };
    signal?.addEventListener("abort", abort, { once: true });

    const timeout = setTimeout(() => {
      if (settled || abortError) return;
      timedOut = true;
      void terminate();
    }, timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", async (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      await termination;
      if (abortError) {
        reject(abortError);
        return;
      }
      resolve({
        exitCode: timedOut ? null : exitCode,
        stdout,
        stderr,
        timedOut,
        outputTruncated,
      });
    });
  });
}
