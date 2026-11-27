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

export interface GitWorktreeRecord {
  path: string;
  headSha: string;
  prunable: boolean;
  locked: boolean;
}

export interface GitProcessExecutor {
  isInsideWorkTree(cwd: string, signal?: AbortSignal): Promise<boolean>;
  showTopLevel(cwd: string, signal?: AbortSignal): Promise<string>;
  currentBranch(cwd: string, signal?: AbortSignal): Promise<string>;
  headSha(cwd: string, signal?: AbortSignal): Promise<string>;
  branchSha(cwd: string, branch: string, signal?: AbortSignal): Promise<string | undefined>;
  createBranch(cwd: string, branch: string, expectedHeadSha: string, signal?: AbortSignal): Promise<void>;
  createDetachedWorktree(cwd: string, destination: string, headSha: string, signal?: AbortSignal): Promise<void>;
  listWorktrees(cwd: string, signal?: AbortSignal): Promise<GitWorktreeRecord[]>;
  worktreeIsCompletelyClean(cwd: string, signal?: AbortSignal): Promise<boolean>;
  listIgnoredPaths(cwd: string, signal?: AbortSignal): Promise<string[]>;
  hasTrackedPaths(cwd: string, relativePath: string, signal?: AbortSignal): Promise<boolean>;
  removeWorktree(cwd: string, destination: string, signal?: AbortSignal): Promise<void>;
  detachHead(cwd: string, headSha: string, signal?: AbortSignal): Promise<void>;
  stashStatus(cwd: string, signal?: AbortSignal): Promise<string[]>;
  assertStashRegularPaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void>;
  stashSha(cwd: string, signal?: AbortSignal): Promise<string | null>;
  stashPaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void>;
  stashParents(cwd: string, stashSha: string, signal?: AbortSignal): Promise<{ headSha: string; indexTreeSha: string }>;
  stagePaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void>;
  unstagePaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void>;
  writeTree(cwd: string, signal?: AbortSignal): Promise<string>;
  indexIsClean(cwd: string, signal?: AbortSignal): Promise<boolean>;
  worktreeIsClean(cwd: string, signal?: AbortSignal): Promise<boolean>;
  repositoryIsClean(cwd: string, signal?: AbortSignal): Promise<boolean>;
  switchBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<void>;
  fetchBranch(cwd: string, remote: string, branch: string, signal?: AbortSignal): Promise<string>;
  commit(cwd: string, message: string, signal?: AbortSignal): Promise<void>;
  mergeBaseIsAncestor(cwd: string, ancestorSha: string, descendantSha: string, signal?: AbortSignal): Promise<boolean>;
  mergeFastForward(cwd: string, sourceSha: string, signal?: AbortSignal): Promise<void>;
  remoteBranchSha(cwd: string, remote: string, branch: string, signal?: AbortSignal): Promise<string | undefined>;
  localTagSha(cwd: string, tag: string, signal?: AbortSignal): Promise<string | undefined>;
  remoteTagSha(cwd: string, remote: string, tag: string, signal?: AbortSignal): Promise<string | undefined>;
  pushTag(cwd: string, remote: string, tag: string, commitSha: string, signal?: AbortSignal): Promise<void>;
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

  async createDetachedWorktree(cwd: string, destination: string, headSha: string, signal?: AbortSignal): Promise<void> {
    await this.invokeSuccess(cwd, this.mutationArgs(["worktree", "add", "--detach", destination, headSha]), signal);
  }

  async listWorktrees(cwd: string, signal?: AbortSignal): Promise<GitWorktreeRecord[]> {
    const output = await this.invokeSuccess(cwd, ["worktree", "list", "--porcelain", "-z"], signal);
    this.completeStashRecords(output);
    if (!output.endsWith("\0\0")) throw new AppError("GIT_ERROR", "Git worktree inventory is incomplete.");
    return output.split("\0\0").filter(Boolean).map((block) => {
      const lines = block.split("\0");
      const worktree = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      const sha = lines.find((line) => line.startsWith("HEAD "))?.slice(5);
      if (!worktree || !sha) {
        throw new AppError("GIT_ERROR", "Git worktree inventory is incomplete.");
      }
      return { path: worktree, headSha: parseSha(sha),
        prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
        locked: lines.some((line) => line === "locked" || line.startsWith("locked ")) };
    });
  }

  async worktreeIsCompletelyClean(cwd: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.invokeSuccess(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], signal)).trim().length === 0;
  }

  async listIgnoredPaths(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const output = await this.invokeSuccess(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching", "--no-renames"], signal);
    const entries = this.completeStashRecords(output);
    if (entries.some((entry) => !entry.startsWith("!! "))) {
      throw new AppError("GIT_INDEX_CHANGED", "Worktree has non-ignored changes during artifact inventory.");
    }
    return entries.map((entry) => entry.slice(3));
  }

  async hasTrackedPaths(cwd: string, relativePath: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.invokeSuccess(cwd, ["--literal-pathspecs", "ls-files", "--cached", "-z", "--", relativePath], signal)).length > 0;
  }

  async removeWorktree(cwd: string, destination: string, signal?: AbortSignal): Promise<void> {
    await this.invoke(cwd, this.mutationArgs(["worktree", "remove", destination]), signal, [0], true);
  }

  async detachHead(cwd: string, headSha: string, signal?: AbortSignal): Promise<void> {
    await this.invokeSuccess(cwd, this.mutationArgs(["switch", "--detach", "--no-overwrite-ignore", headSha]), signal);
  }

  async stashStatus(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const output = await this.invokeSuccess(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all",
      "--no-renames", "--ignore-submodules=none"], signal);
    return this.completeStashRecords(output);
  }

  private completeStashRecords(output: string): string[] {
    if (Buffer.byteLength(output) >= MAX_STDOUT_BYTES || output.includes("\ufffd") ||
        (output.length > 0 && !output.endsWith("\0"))) {
      throw new AppError("GIT_INDEX_CHANGED", "Git stash inventory is incomplete or unsupported.");
    }
    return output.split("\0").filter(Boolean);
  }

  async assertStashRegularPaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    const index = this.completeStashRecords(await this.invokeSuccess(cwd,
      ["--literal-pathspecs", "ls-files", "--stage", "-z", "--", ...paths], signal));
    const base = this.completeStashRecords(await this.invokeSuccess(cwd,
      ["--literal-pathspecs", "ls-tree", "-z", "HEAD", "--", ...paths], signal));
    if (index.some((entry) => !/^100(?:644|755) [a-f0-9]{40} 0\t/u.test(entry)) ||
        base.some((entry) => !/^100(?:644|755) blob [a-f0-9]{40}\t/u.test(entry))) {
      throw new AppError("INVALID_PATH", "Stash accepts only regular files, not submodules or links.");
    }
  }

  async stashSha(cwd: string, signal?: AbortSignal): Promise<string | null> {
    const result = await this.invoke(cwd, ["rev-parse", "--verify", "refs/stash"], signal, [0, 128]);
    return result.code === 0 ? parseSha(result.stdout.trim()) : null;
  }

  async stashPaths(cwd: string, paths: readonly string[], signal?: AbortSignal): Promise<void> {
    await this.invoke(cwd, this.mutationArgs(["--literal-pathspecs", "stash", "push", "--include-untracked",
      "--message", "MCP explicit workspace checkpoint", "--", ...paths]), signal, [0], true);
  }

  async stashParents(cwd: string, stashSha: string, signal?: AbortSignal): Promise<{ headSha: string; indexTreeSha: string }> {
    const headSha = parseSha((await this.invokeSuccess(cwd, ["rev-parse", stashSha + "^1"], signal)).trim());
    const indexTreeSha = parseSha((await this.invokeSuccess(cwd, ["rev-parse", stashSha + "^2^{tree}"], signal)).trim());
    return { headSha, indexTreeSha };
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

  async repositoryIsClean(cwd: string, signal?: AbortSignal): Promise<boolean> {
    return (
      await this.invokeSuccess(
        cwd,
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        signal,
      )
    ).trim().length === 0;
  }

  async switchBranch(cwd: string, branch: string, signal?: AbortSignal): Promise<void> {
    await this.invokeSuccess(cwd, this.mutationArgs(["switch", branch]), signal);
  }

  async fetchBranch(
    cwd: string,
    remote: string,
    branch: string,
    signal?: AbortSignal,
  ): Promise<string> {
    await this.invokeSuccess(
      cwd,
      ["fetch", "--no-tags", remote, `refs/heads/${branch}`],
      signal,
    );
    return parseSha(
      (await this.invokeSuccess(cwd, ["rev-parse", "FETCH_HEAD"], signal)).trim(),
    );
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

  async localTagSha(cwd: string, tag: string, signal?: AbortSignal): Promise<string | undefined> {
    const result = await this.invoke(
      cwd, ["rev-parse", "--verify", `refs/tags/${tag}`], signal, [0, 128],
    );
    return result.code === 0 ? parseSha(result.stdout.trim()) : undefined;
  }

  async remoteTagSha(
    cwd: string, remote: string, tag: string, signal?: AbortSignal,
  ): Promise<string | undefined> {
    const output = (await this.invokeSuccess(
      cwd, ["ls-remote", "--refs", remote, `refs/tags/${tag}`], signal,
    )).trim();
    if (!output) return undefined;
    const lines = output.split(/\r?\n/u);
    if (lines.length !== 1) throw new AppError("GIT_ERROR", "Remote Git tag response is ambiguous.");
    const fields = lines[0]!.split(/\s+/u);
    if (fields.length !== 2 || fields[1] !== `refs/tags/${tag}`) {
      throw new AppError("GIT_ERROR", "Remote Git tag identity does not match the requested ref.");
    }
    return parseSha(fields[0]!);
  }

  async pushTag(
    cwd: string, remote: string, tag: string, commitSha: string, signal?: AbortSignal,
  ): Promise<void> {
    const result = await this.invoke(
      cwd,
      this.mutationArgs(["push", remote, `${commitSha}:refs/tags/${tag}`]),
      signal,
      undefined,
      true,
    );
    if (result.code !== 0) throw ambiguousMutationError();
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
