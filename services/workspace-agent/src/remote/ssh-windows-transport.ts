import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { AppError } from "@vs-code-gpt/shared";
import { buildWindowsSshRpcScript } from "./windows-ssh-rpc-script.js";

export interface SshWindowsTransportConfig {
  host: string;
  port: number;
  username: string;
  privateKeyPath: string;
  knownHostsPath: string;
  connectTimeoutMs: number;
  sshExecutable?: string;
}

export interface RemoteProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RpcEnvelope<T> {
  ok: boolean;
  result?: T;
  error?: {
    message?: string;
    type?: string;
  };
}

export interface RemotePathProbe {
  fullPath: string;
  kind: "file" | "directory";
}

export interface RemoteDirectoryListing {
  entries: Array<{
    path: string;
    kind: "file" | "directory";
    sizeBytes: number;
  }>;
  truncated: boolean;
}

export interface RemoteBytesResult {
  contentBase64: string;
  sizeBytes: number;
  sha256: string;
}

export interface RemoteWriteResult {
  created: boolean;
  sizeBytes: number;
  sha256: string;
}

export class SshWindowsTransport {
  private readonly sshExecutable: string;

  constructor(private readonly config: SshWindowsTransportConfig) {
    this.sshExecutable = config.sshExecutable ?? "ssh";
  }

  async probeRoot(rootPath: string, signal?: AbortSignal): Promise<RemotePathProbe> {
    return this.invoke<RemotePathProbe>(
      "probe",
      { rootPath },
      15_000,
      signal,
    );
  }

  async list(
    rootPath: string,
    logicalRoot: string,
    options: {
      recursive: boolean;
      directoriesOnly?: boolean;
      maxEntries: number;
      excludedPrefixes?: readonly string[];
    },
    signal?: AbortSignal,
  ): Promise<RemoteDirectoryListing> {
    return this.invoke<RemoteDirectoryListing>(
      "list",
      {
        rootPath,
        logicalRoot,
        recursive: options.recursive,
        directoriesOnly: options.directoriesOnly ?? false,
        maxEntries: options.maxEntries,
        excludedPrefixes: options.excludedPrefixes ?? [],
      },
      60_000,
      signal,
    );
  }

  async readBytes(
    rootPath: string,
    logicalPath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<RemoteBytesResult> {
    return this.invoke<RemoteBytesResult>(
      "readBytes",
      { rootPath, logicalPath, maxBytes },
      60_000,
      signal,
    );
  }

  async writeBytes(
    rootPath: string,
    logicalPath: string,
    content: Buffer,
    options: { expectedSha256?: string } = {},
    signal?: AbortSignal,
  ): Promise<RemoteWriteResult> {
    return this.invoke<RemoteWriteResult>(
      "writeBytes",
      {
        rootPath,
        logicalPath,
        contentBase64: content.toString("base64"),
        ...(options.expectedSha256 === undefined
          ? {}
          : { expectedSha256: options.expectedSha256 }),
      },
      120_000,
      signal,
    );
  }

  async exec(
    rootPath: string,
    logicalCwd: string,
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RemoteProcessResult> {
    return this.invoke<RemoteProcessResult>(
      "exec",
      { rootPath, logicalCwd, executable, args, timeoutMs },
      timeoutMs + 10_000,
      signal,
    );
  }

  async runShell(
    rootPath: string,
    logicalCwd: string,
    shell: "powershell" | "pwsh" | "cmd" | "wsl" | "git-bash",
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<RemoteProcessResult> {
    return this.invoke<RemoteProcessResult>(
      "runShell",
      { rootPath, logicalCwd, shell, command, timeoutMs },
      timeoutMs + 10_000,
      signal,
    );
  }

  private async invoke<T>(
    operation: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      throw new AppError("OPERATION_CANCELLED", "SSH workspace operation was cancelled.");
    }

    const child = this.spawnSsh();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();

    const abort = () => child.kill();
    signal?.addEventListener("abort", abort, { once: true });

    try {
      child.stdin.end(buildWindowsSshRpcScript({ operation, ...payload }));
      const [exitCode] = (await once(child, "close")) as [number | null];
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();

      if (signal?.aborted) {
        throw new AppError("OPERATION_CANCELLED", "SSH workspace operation was cancelled.");
      }
      if (timedOut) {
        throw new AppError("AGENT_TIMEOUT", "SSH workspace operation timed out.");
      }
      if (!output) {
        throw new AppError(
          "AGENT_UNAVAILABLE",
          diagnostic
            ? `SSH workspace transport returned no result: ${sanitizeDiagnostic(diagnostic)}`
            : "SSH workspace transport returned no result.",
        );
      }

      let envelope: RpcEnvelope<T>;
      try {
        const line = output.split(/\r?\n/u).filter(Boolean).at(-1) ?? "";
        envelope = JSON.parse(line) as RpcEnvelope<T>;
      } catch (error) {
        throw new AppError(
          "AGENT_UNAVAILABLE",
          "SSH workspace transport returned invalid JSON.",
          { cause: error },
        );
      }

      if (!envelope.ok || exitCode !== 0) {
        const message = sanitizeDiagnostic(
          envelope.error?.message ?? diagnostic ?? "Remote Windows operation failed.",
        );
        throw new AppError("AGENT_UNAVAILABLE", message);
      }
      return envelope.result as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (!child.killed && child.exitCode === null) child.kill();
    }
  }

  private spawnSsh(): ChildProcessWithoutNullStreams {
    const connectTimeoutSeconds = Math.max(
      1,
      Math.ceil(this.config.connectTimeoutMs / 1_000),
    );
    const args = [
      "-T",
      "-q",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${this.config.knownHostsPath}`,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `ConnectTimeout=${connectTimeoutSeconds}`,
      "-i",
      this.config.privateKeyPath,
      "-p",
      String(this.config.port),
      `${this.config.username}@${this.config.host}`,
      "pwsh.exe -NoLogo -NoProfile -NonInteractive -Command -",
    ];
    return spawn(this.sshExecutable, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, LANG: "C" },
    });
  }
}

function sanitizeDiagnostic(value: string): string {
  const normalized = value.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized.length <= 500 ? normalized : `${normalized.slice(0, 497)}...`;
}
