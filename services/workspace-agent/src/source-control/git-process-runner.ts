import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { constants as fsConstants } from "node:fs";
import { abortSignalError, AppError } from "@vs-code-gpt/shared";
import { terminateChildProcessTree } from "../process/process-tree.js";

const MAX_STDOUT_BYTES = 256 * 1024;
const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "LANG",
  "LC_ALL",
] as const;

export type GitSpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface GitProcessExecutor {
  isInsideWorkTree(cwd: string, signal?: AbortSignal): Promise<boolean>;
  showTopLevel(cwd: string, signal?: AbortSignal): Promise<string>;
  currentBranch(cwd: string, signal?: AbortSignal): Promise<string>;
  headSha(cwd: string, signal?: AbortSignal): Promise<string>;
  branchSha(cwd: string, branch: string, signal?: AbortSignal): Promise<string | undefined>;
  createBranch(cwd: string, branch: string, expectedHeadSha: string, signal?: AbortSignal): Promise<void>;
  stagePaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void>;
  unstagePaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void>;
  writeTree(cwd: string, signal?: AbortSignal): Promise<string>;
  indexIsClean(cwd: string, signal?: AbortSignal): Promise<boolean>;
  worktreeIsClean(cwd: string, signal?: AbortSignal): Promise<boolean>;
  commit(cwd: string, message: string, signal?: AbortSignal): Promise<void>;
  mergeBaseIsAncestor(cwd: string, ancestorSha: string, descendantSha: string, signal?: AbortSignal): Promise<boolean>;
  mergeFastForward(cwd: string, sourceSha: string, signal?: AbortSignal): Promise<void>;
  remoteBranchSha(cwd: string, remote: string, branch: string, signal?: AbortSignal): Promise<string | undefined>;
  pushBranch(cwd: string, remote: string, branch: string, localSha: string, signal?: AbortSignal): Promise<void>;
  remoteUrl(cwd: string, signal?: AbortSignal): Promise<string>;
}

interface HardenedGitProcessRunnerOptions {
  gitExecutable: string;
  spawnProcess?: GitSpawnProcess;
  baseEnvironment?: NodeJS.ProcessEnv;
  terminateProcessTree?: (child: ChildProcess) => Promise<void>;
}

interface InvocationResult {
  code: number | null;
  stdout: string;
}

export class HardenedGitProcessRunner implements GitProcessExecutor {
  private readonly gitExecutable: string;
  private readonly spawnProcess: GitSpawnProcess;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly terminateProcessTree: (child: ChildProcess) => Promise<void>;
  private readonly mutationConfigArgs: readonly string[];

  constructor(options: HardenedGitProcessRunnerOptions) {
    if (!path.isAbsolute(options.gitExecutable)) {
      throw new AppError("GIT_ERROR", "Git executable path must be absolute.");
    }
    this.gitExecutable = options.gitExecutable;
    this.spawnProcess = options.spawnProcess ?? ((executable, args, spawnOptions) => spawn(executable, args, spawnOptions));
    this.environment = buildGitEnvironment(options.baseEnvironment ?? process.env);
    this.terminateProcessTree = options.terminateProcessTree ?? terminateChildProcessTree;
    const disabledHooksPath = path.join(
      os.tmpdir(),
      `.mcp-git-disabled-hooks-${process.pid}-${randomBytes(16).toString("hex")}`,
    );
    this.mutationConfigArgs = [
      "-c",
      `core.hooksPath=${disabledHooksPath}`,
      "-c",
      "commit.gpgSign=false",
      "-c",
      "merge.gpgSign=false",
    ];
  }

  static async create(): Promise<HardenedGitProcessRunner> {
    return new HardenedGitProcessRunner({ gitExecutable: await resolveGitExecutable() });
  }

  async isInsideWorkTree(cwd: string, signal?: AbortSignal): Promise<boolean> {
    const result = await this.invoke(cwd, ["rev-parse", "--is-inside-work-tree"], signal, [0, 128]);
    return result.code === 0 && result.stdout.trim() === "true";
  }

  async showTopLevel(cwd: string, signal?: AbortSignal): Promise<string> {
    return (await this.invokeSuccess(cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
  }

  async currentBranch(cwd: string, signal?: AbortSignal): Promise<string> {
    return (await this.invokeSuccess(cwd, ["rev-parse", "--abbrev-ref", "HEAD"], signal)).trim();
  }

  async headSha(cwd: string, signal?: AbortSignal): Promise<string> {
    return parseSha((await this.invokeSuccess(cwd, ["rev-parse", "HEAD"], signal)).trim());
  }

  async branchSha(cwd: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.invoke(cwd, ["rev-parse", "--verify", `refs/heads/${branch}`], signal, [0, 128]);
    return result.code === 0 ? parseSha(result.stdout.trim()) : undefined;
  }

  async createBranch(cwd: string, branch: string, expectedHeadSha: string, signal?: AbortSignal): Promise<void> {
    await this.invokeSuccess(cwd, this.mutationArgs(["switch", "-c", branch, expectedHeadSha]), signal);
  }

  async stagePaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    await this.invokeSuccess(cwd, this.mutationArgs(["add", "--", ...paths]), signal);
  }

  async unstagePaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    await this.invokeSuccess(cwd, this.mutationArgs(["restore", "--staged", "--", ...paths]), signal);
  }

  async writeTree(cwd: string, signal?: AbortSignal): Promise<string> {
    return parseSha((await this.invokeSuccess(cwd, ["write-tree"], signal)).trim());
  }

  async indexIsClean(cwd: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.invoke(cwd, ["diff", "--cached", "--quiet"], signal, [0, 1])).code === 0;
  }

  async worktreeIsClean(cwd: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.invoke(cwd, ["diff", "--quiet"], signal, [0, 1])).code === 0;
  }

  async commit(cwd: string, message: string, signal?: AbortSignal): Promise<void> {
    await this.invokeSuccess(cwd, this.mutationArgs(["commit", "-m", message]), signal);
  }

  async mergeBaseIsAncestor(
    cwd: string,
    ancestorSha: string,
    descendantSha: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return (
      await this.invoke(cwd, ["merge-base", "--is-ancestor", ancestorSha, descendantSha], signal, [0, 1])
    ).code === 0;
  }

  async mergeFastForward(cwd: string, sourceSha: string, signal?: AbortSignal): Promise<void> {
    await this.invokeSuccess(cwd, this.mutationArgs(["merge", "--ff-only", sourceSha]), signal);
  }

  async remoteBranchSha(
    cwd: string,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const output = (await this.invokeSuccess(cwd, ["ls-remote", "--heads", remote, branch], signal)).trim();
    if (output.length === 0) return undefined;
    const [sha] = output.split(/\s+/u);
    return sha === undefined ? undefined : parseSha(sha);
  }

  async pushBranch(
    cwd: string,
    remote: string,
    branch: string,
    localSha: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.invoke(
      cwd,
      this.mutationArgs(["push", remote, `${localSha}:refs/heads/${branch}`]),
      signal,
      undefined,
      true,
    );
    if (result.code !== 0) throw ambiguousMutationError();
  }

  async remoteUrl(cwd: string, signal?: AbortSignal): Promise<string> {
    return (await this.invokeSuccess(cwd, ["remote", "get-url", "origin"], signal)).trim();
  }

  private mutationArgs(args: readonly string[]): readonly string[] {
    return [...this.mutationConfigArgs, ...args];
  }

  private async invokeSuccess(
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<string> {
    const result = await this.invoke(cwd, args, signal, [0]);
    return result.stdout;
  }

  private invoke(
    cwd: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
    acceptedCodes: readonly number[] | undefined,
    outcomeUnknownAfterStart = false,
  ): Promise<InvocationResult> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(this.gitExecutable, args, {
          cwd,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: this.environment,
        });
      } catch {
        reject(new AppError("GIT_ERROR", "Unable to start Git."));
        return;
      }

      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let settled = false;
      let termination: Promise<void> | undefined;
      const terminate = (): Promise<void> => {
        termination ??= this.terminateProcessTree(child);
        return termination;
      };
      const onAbort = (): void => {
        if (!settled) void terminate();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutBytes >= MAX_STDOUT_BYTES) return;
        const remaining = MAX_STDOUT_BYTES - stdoutBytes;
        const accepted = chunk.subarray(0, remaining);
        stdoutChunks.push(accepted);
        stdoutBytes += accepted.byteLength;
      });
      child.stderr?.resume();

      child.once("error", () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(new AppError("GIT_ERROR", "Unable to start Git."));
      });
      child.once("close", async (code) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        try {
          await termination;
        } catch {
          reject(new AppError("GIT_ERROR", "Git process termination failed."));
          return;
        }
        if (signal?.aborted) {
          reject(outcomeUnknownAfterStart ? ambiguousMutationError() : abortReason(signal));
          return;
        }
        if (code === null) {
          reject(outcomeUnknownAfterStart ? ambiguousMutationError() : new AppError("GIT_ERROR", "Git command failed."));
          return;
        }
        if (acceptedCodes !== undefined && !acceptedCodes.includes(code)) {
          reject(new AppError("GIT_ERROR", "Git command failed."));
          return;
        }
        resolve({ code, stdout: Buffer.concat(stdoutChunks).toString("utf8") });
      });
    });
  }
}

export async function resolveGitExecutable(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const executableNames = process.platform === "win32" ? ["git.exe"] : ["git"];
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = stripOuterQuotes(entry.trim());
    if (directory.length === 0) continue;
    for (const executableName of executableNames) {
      const candidate = path.resolve(directory, executableName);
      try {
        await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {}
    }
  }
  throw new AppError("GIT_ERROR", "Git executable is unavailable.");
}

function buildGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = base[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GCM_INTERACTIVE = "Never";
  environment.GIT_PAGER = "cat";
  return environment;
}

function parseSha(value: string): string {
  if (!/^[a-f0-9]{40}$/iu.test(value)) {
    throw new AppError("GIT_ERROR", "Git returned an invalid object id.");
  }
  return value.toLowerCase();
}

function stripOuterQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function ambiguousMutationError(): AppError {
  return new AppError("GIT_ERROR", "Git command failed.", {
    details: { outcome: "unknown" },
  });
}
function abortReason(signal: AbortSignal): AppError {
  return signal.reason instanceof AppError
    ? signal.reason
    : abortSignalError(signal, "Git operation was cancelled.");
}
