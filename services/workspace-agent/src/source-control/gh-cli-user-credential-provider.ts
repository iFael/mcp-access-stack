import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import {
  abortSignalError,
  AppError,
  type OperationContext,
} from "@vs-code-gpt/shared";
import { terminateChildProcessTree } from "../process/process-tree.js";
import type {
  GitHubCredential,
  GitHubCredentialProvider,
} from "./github-credential-provider.js";

const DEFAULT_MAX_OUTPUT_BYTES = 16_384;
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
  "LANG",
  "LC_ALL",
] as const;

export type GhSpawnProcess = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface GhCliUserCredentialProviderOptions {
  ghExecutable: string;
  gitExecutable?: string;
  spawnProcess?: GhSpawnProcess;
  baseEnvironment?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  terminateProcessTree?: (child: ChildProcess) => Promise<void>;
}

export class GhCliUserCredentialProvider implements GitHubCredentialProvider {
  private readonly ghExecutable: string;
  private readonly gitExecutable: string | undefined;
  private readonly spawnProcess: GhSpawnProcess;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly maxOutputBytes: number;
  private readonly terminateProcessTree: (child: ChildProcess) => Promise<void>;

  constructor(options: GhCliUserCredentialProviderOptions) {
    if (!path.isAbsolute(options.ghExecutable)) {
      throw new AppError("AUTHENTICATION_FAILED", "GitHub CLI executable path must be absolute.");
    }
    if (options.gitExecutable !== undefined && !path.isAbsolute(options.gitExecutable)) {
      throw new AppError("AUTHENTICATION_FAILED", "Git executable path must be absolute.");
    }
    this.ghExecutable = options.ghExecutable;
    this.gitExecutable = options.gitExecutable;
    this.spawnProcess =
      options.spawnProcess ??
      ((executable, args, spawnOptions) => spawn(executable, args, spawnOptions));
    this.environment = buildGhEnvironment(options.baseEnvironment ?? process.env);
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.terminateProcessTree = options.terminateProcessTree ?? terminateChildProcessTree;
  }

  static async create(): Promise<GhCliUserCredentialProvider> {
    const ghExecutable = await resolveGhExecutable();
    const gitExecutable = await resolveGitExecutable().catch(() => undefined);
    return new GhCliUserCredentialProvider({
      ghExecutable,
      ...(gitExecutable === undefined ? {} : { gitExecutable }),
    });
  }

  async getCredential(context?: OperationContext): Promise<GitHubCredential> {
    try {
      return await this.getGhCredential(context);
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== "AUTHENTICATION_FAILED" ||
        this.gitExecutable === undefined
      ) {
        throw error;
      }
      return this.getGitCredential(context);
    }
  }

  private async getGhCredential(context?: OperationContext): Promise<GitHubCredential> {
    const signal = context?.signal;
    if (signal?.aborted) {
      throw abortSignalError(signal, "GitHub credential lookup was cancelled.");
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(this.ghExecutable, ["auth", "token"], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: this.environment,
        });
      } catch {
        reject(authenticationFailure());
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let exceeded = false;
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
        if (exceeded) return;
        const remaining = this.maxOutputBytes - totalBytes;
        if (chunk.byteLength > remaining) {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          totalBytes = this.maxOutputBytes;
          exceeded = true;
          void terminate();
          return;
        }
        chunks.push(Buffer.from(chunk));
        totalBytes += chunk.byteLength;
      });
      child.stderr?.resume();

      child.once("error", () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(authenticationFailure());
      });

      child.once("close", async (code) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        try {
          await termination;
        } catch {
          reject(authenticationFailure());
          return;
        }
        if (signal?.aborted) {
          reject(abortSignalError(signal, "GitHub credential lookup was cancelled."));
          return;
        }
        if (code !== 0) {
          reject(authenticationFailure());
          return;
        }
        if (exceeded) {
          reject(new AppError("LIMIT_EXCEEDED", "GitHub credential output exceeded the configured limit."));
          return;
        }
        const token = Buffer.concat(chunks).toString("utf8").trim();
        if (token.length === 0) {
          reject(authenticationFailure());
          return;
        }
        resolve({ token, source: "gh-cli-user" });
      });
    });
  }

  private async getGitCredential(context?: OperationContext): Promise<GitHubCredential> {
    const gitExecutable = this.gitExecutable;
    if (gitExecutable === undefined) throw authenticationFailure();
    const signal = context?.signal;
    if (signal?.aborted) {
      throw abortSignalError(signal, "GitHub credential lookup was cancelled.");
    }

    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawnProcess(gitExecutable, ["credential", "fill"], {
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...this.environment, GIT_TERMINAL_PROMPT: "0" },
        });
      } catch {
        reject(authenticationFailure());
        return;
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let exceeded = false;
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
        if (exceeded) return;
        const remaining = this.maxOutputBytes - totalBytes;
        if (chunk.byteLength > remaining) {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          totalBytes = this.maxOutputBytes;
          exceeded = true;
          void terminate();
          return;
        }
        chunks.push(Buffer.from(chunk));
        totalBytes += chunk.byteLength;
      });
      child.stderr?.resume();

      child.once("error", () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        reject(authenticationFailure());
      });

      child.once("close", async (code) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        try {
          await termination;
        } catch {
          reject(authenticationFailure());
          return;
        }
        if (signal?.aborted) {
          reject(abortSignalError(signal, "GitHub credential lookup was cancelled."));
          return;
        }
        if (code !== 0 || exceeded) {
          reject(authenticationFailure());
          return;
        }
        const output = Buffer.concat(chunks).toString("utf8");
        let token = "";
        for (const line of output.split(/\r?\n/u)) {
          const separator = line.indexOf("=");
          if (separator <= 0) continue;
          if (line.slice(0, separator) === "password") {
            token = line.slice(separator + 1).trim();
            break;
          }
        }
        if (token.length === 0) {
          reject(authenticationFailure());
          return;
        }
        resolve({ token, source: "git-credential-user" });
      });

      if (child.stdin === null) {
        void terminate();
        reject(authenticationFailure());
        return;
      }
      child.stdin.end("protocol=https\nhost=github.com\n\n", "utf8");
    });
  }
}

export async function resolveGhExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const executableNames = process.platform === "win32" ? ["gh.exe"] : ["gh"];
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = stripOuterQuotes(entry.trim());
    if (directory.length === 0) continue;
    for (const executableName of executableNames) {
      const candidate = path.resolve(directory, executableName);
      try {
        await access(
          candidate,
          process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return candidate;
      } catch {}
    }
  }
  throw authenticationFailure();
}

export async function resolveGitExecutable(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const executableNames = process.platform === "win32" ? ["git.exe"] : ["git"];
  for (const entry of pathValue.split(path.delimiter)) {
    const directory = stripOuterQuotes(entry.trim());
    if (directory.length === 0) continue;
    for (const executableName of executableNames) {
      const candidate = path.resolve(directory, executableName);
      try {
        await access(
          candidate,
          process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK,
        );
        return candidate;
      } catch {}
    }
  }
  throw authenticationFailure();
}
function buildGhEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = base[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function stripOuterQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

function authenticationFailure(): AppError {
  return new AppError(
    "AUTHENTICATION_FAILED",
    "Unable to obtain a GitHub credential from the authenticated GitHub CLI user.",
  );
}
