import { spawn } from "node:child_process";
import { abortSignalError, AppError } from "@vs-code-gpt/shared";
import { terminateChildProcessTree } from "../process/process-tree.js";

interface GitCommandResult {
  output: string;
  truncated: boolean;
}

export interface GitBatchResult {
  output: string;
  remainingBytes: number;
  truncated: boolean;
}

export async function runGitInBatches(
  cwd: string,
  baseArgs: string[],
  paths: string[],
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<GitBatchResult> {
  throwIfAborted(signal);
  if (paths.length === 0 || maxOutputBytes <= 0) {
    return {
      output: "",
      remainingBytes: Math.max(0, maxOutputBytes),
      truncated: paths.length > 0 && maxOutputBytes <= 0,
    };
  }

  let output = "";
  let remainingBytes = maxOutputBytes;
  let truncated = false;
  for (const batch of chunkGitPaths(baseArgs, paths)) {
    if (remainingBytes <= 0) {
      truncated = true;
      break;
    }
    const part = await runGit(
      cwd,
      [...baseArgs, ...batch],
      remainingBytes,
      "truncate",
      signal,
    );
    output += part.output;
    remainingBytes = Math.max(
      0,
      remainingBytes - Buffer.byteLength(part.output, "utf8"),
    );
    if (part.truncated) {
      truncated = true;
      break;
    }
  }
  return { output, remainingBytes, truncated };
}

export async function runGitStrict(
  cwd: string,
  args: string[],
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runGit(cwd, args, maxOutputBytes, "error", signal);
  return result.output;
}

function chunkGitPaths(baseArgs: string[], paths: string[]): string[][] {
  const maxCommandChars = process.platform === "win32" ? 24_000 : 96_000;
  const baseChars = baseArgs.reduce((total, argument) => total + argument.length + 3, 0);
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = baseChars;
  for (const candidate of paths) {
    const candidateChars = candidate.length + 3;
    if (current.length > 0 && currentChars + candidateChars > maxCommandChars) {
      batches.push(current);
      current = [];
      currentChars = baseChars;
    }
    current.push(candidate);
    currentChars += candidateChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function runGit(
  cwd: string,
  args: string[],
  maxOutputBytes: number,
  overflow: "error" | "truncate",
  signal?: AbortSignal,
): Promise<GitCommandResult> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceeded = false;
    let settled = false;
    let termination: Promise<void> | undefined;
    const terminate = (): Promise<void> => {
      termination ??= terminateChildProcessTree(child);
      return termination;
    };
    const onAbort = () => {
      if (!settled) void terminate();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (exceeded) return;
      const remaining = maxOutputBytes - stdoutBytes;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes = maxOutputBytes;
        exceeded = true;
        void terminate();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.byteLength;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 65_536) return;
      const remaining = 65_536 - stderrBytes;
      const accepted = chunk.subarray(0, remaining);
      stderrChunks.push(accepted);
      stderrBytes += accepted.byteLength;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(new AppError("GIT_ERROR", "Unable to start Git.", { cause: error }));
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      await termination;
      if (signal?.aborted) {
        reject(abortSignalError(signal, "Git operation was cancelled."));
        return;
      }
      if (exceeded && overflow === "error") {
        reject(new AppError("LIMIT_EXCEEDED", "Git output exceeds the configured limit."));
        return;
      }
      if (!exceeded && code !== 0) {
        reject(
          new AppError("GIT_ERROR", "Git command failed.", {
            cause: new Error(Buffer.concat(stderrChunks).toString("utf8")),
          }),
        );
        return;
      }
      const decoded = decodePossiblyTruncatedUtf8(Buffer.concat(stdoutChunks));
      resolve({
        output: exceeded ? `${decoded}\n...[diff truncated]` : decoded,
        truncated: exceeded,
      });
    });
  });
}

function decodePossiblyTruncatedUtf8(value: Buffer): string {
  return value.toString("utf8").replace(/\uFFFD$/u, "");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortSignalError(signal, "Git operation was cancelled.");
  }
}
