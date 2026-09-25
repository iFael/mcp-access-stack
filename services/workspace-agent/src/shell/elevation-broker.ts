import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  abortSignalError,
  AppError,
  createOperationLifecycle,
  type OperationDeadline,
  type RunCommandResult,
  type ShellName,
} from "@vs-code-gpt/shared";

export interface ElevatedCommandRequest {
  shell: ShellName;
  command: string;
  absoluteCwd: string;
  logicalCwd: string;
  timeoutMs: number;
  deadline: OperationDeadline;
}

export interface ElevationBroker {
  run(
    request: ElevatedCommandRequest,
    signal?: AbortSignal,
  ): Promise<RunCommandResult>;
}

export interface WindowsElevationBrokerOptions {
  brokerExecutablePath: string;
  privateDirectory: string;
  platform?: NodeJS.Platform;
  powershellExecutable?: string;
  spawnProcess?: typeof spawn;
}

type BrokerResponse = {
  version: 1;
  nonce: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
};

export class WindowsElevationBroker implements ElevationBroker {
  private readonly platform: NodeJS.Platform;
  private readonly powershellExecutable: string;
  private readonly spawnProcess: typeof spawn;

  constructor(private readonly options: WindowsElevationBrokerOptions) {
    this.platform = options.platform ?? process.platform;
    this.powershellExecutable =
      options.powershellExecutable ?? "powershell.exe";
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async run(
    request: ElevatedCommandRequest,
    signal?: AbortSignal,
  ): Promise<RunCommandResult> {
    if (this.platform !== "win32") {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Elevated command execution is available only on Windows local runtimes.",
      );
    }
    if (!["powershell", "pwsh", "cmd"].includes(request.shell)) {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        `Elevated execution does not support the ${request.shell} shell.`,
      );
    }
    if (signal?.aborted) throw abortSignalError(signal);

    const directory = path.resolve(this.options.privateDirectory, "elevation");
    await mkdir(directory, { recursive: true });
    const nonce = randomBytes(18).toString("base64url");
    const requestPath = path.join(directory, `request-${nonce}.json`);
    const responsePath = path.join(directory, `response-${nonce}.json`);
    const cancelPath = path.join(directory, `request-${nonce}.cancel`);
    const requestJson = JSON.stringify({
      version: 1,
      nonce,
      shell: request.shell,
      command: request.command,
      cwd: request.absoluteCwd,
      timeoutMs: request.timeoutMs,
      responsePath,
      cancelPath,
    });
    const requestBytes = Buffer.from(requestJson, "utf8");
    const sha256 = createHash("sha256").update(requestBytes).digest("hex");
    await writeFile(requestPath, requestBytes, {
      flag: "wx",
      mode: 0o600,
    });

    const startedAt = Date.now();
    let cancelled = false;
    let outerTimedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const markCancelled = async (): Promise<void> => {
      cancelled = true;
      await writeFile(cancelPath, nonce, { encoding: "utf8" })
        .catch(() => undefined);
    };
    const abort = () => { void markCancelled(); };
    signal?.addEventListener("abort", abort, { once: true });

    try {
      const launch = this.launchElevatedBroker(
        requestPath,
        responsePath,
        sha256,
        nonce,
      );
      const remainingDeadlineMs = Math.max(
        1,
        Date.parse(request.deadline.deadlineAt) - Date.now(),
      );
      const outerTimeoutMs = Math.min(
        request.timeoutMs + 30_000,
        remainingDeadlineMs + 30_000,
      );
      const timeout = new Promise<"timeout">((resolve) => {
        timeoutHandle = setTimeout(() => resolve("timeout"), outerTimeoutMs);
        timeoutHandle.unref();
      });
      const outcome = await Promise.race([
        launch.then(() => "completed" as const),
        timeout,
      ]);
      if (outcome === "timeout") {
        outerTimedOut = true;
        await markCancelled();
      }

      if (signal?.aborted) {
        throw abortSignalError(signal);
      }

      const response = await readBrokerResponse(
        responsePath,
        nonce,
        outerTimedOut ? 5_000 : 500,
      );
      if (!response) {
        if (outerTimedOut) {
          return {
            status: "executed",
            shell: request.shell,
            cwd: request.logicalCwd,
            exitCode: null,
            stdout: "",
            stderr: "",
            timedOut: true,
            lifecycle: createOperationLifecycle(
              request.deadline,
              startedAt,
              {
                layer: "external",
                reason: "timeout",
                diagnostic:
                  "Elevated broker exceeded the command deadline.",
              },
            ),
          };
        }
        throw new AppError(
          "SHELL_FAILED",
          "Elevated MCP V3 broker did not return a valid response.",
        );
      }
      if (response.cancelled || cancelled) {
        throw abortSignalError(
          signal,
          "Elevated command was cancelled.",
        );
      }
      return {
        status: "executed",
        shell: request.shell,
        cwd: request.logicalCwd,
        exitCode: response.exitCode,
        stdout: response.stdout,
        stderr: response.stderr,
        timedOut: response.timedOut,
        lifecycle: createOperationLifecycle(
          request.deadline,
          startedAt,
          response.timedOut
            ? {
                layer: "external",
                reason: "timeout",
                diagnostic:
                  "Elevated broker terminated the command at its deadline.",
              }
            : undefined,
        ),
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", abort);
      await Promise.allSettled([
        rm(requestPath, { force: true }),
        rm(responsePath, { force: true }),
        rm(cancelPath, { force: true }),
      ]);
    }
  }

  private async launchElevatedBroker(
    requestPath: string,
    responsePath: string,
    sha256: string,
    nonce: string,
  ): Promise<void> {
    const broker = path.resolve(this.options.brokerExecutablePath);
    const script = [
      "$ErrorActionPreference='Stop'",
      `$file='${escapePowerShellLiteral(broker)}'`,
      `$args=@('--request','${escapePowerShellLiteral(requestPath)}','--sha256','${sha256}','--nonce','${nonce}')`,
      "try {",
      "  $p=Start-Process -FilePath $file -ArgumentList $args -Verb RunAs -Wait -PassThru",
      "  exit [int]$p.ExitCode",
      "} catch {",
      "  [Console]::Error.Write($_.Exception.Message)",
      "  exit 1",
      "}",
    ].join("; ");
    const encoded = Buffer.from(script, "utf16le").toString("base64");

    await new Promise<void>((resolve, reject) => {
      const child = this.spawnProcess(
        this.powershellExecutable,
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          encoded,
        ],
        {
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4_000) stderr += chunk.toString("utf8");
      });
      child.once("error", (error) =>
        reject(new AppError(
          "SHELL_FAILED",
          "MCP V3 could not request Windows elevation.",
          { cause: error },
        )));
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new AppError(
          "SHELL_FAILED",
          stderr.trim() ||
            "Windows elevation was cancelled or the broker failed.",
        ));
      });
    });

    await readFile(responsePath).catch((error) => {
      throw new AppError(
        "SHELL_FAILED",
        "Elevated MCP V3 broker completed without a response.",
        { cause: error },
      );
    });
  }
}

async function readBrokerResponse(
  responsePath: string,
  expectedNonce: string,
  retryMs: number,
): Promise<BrokerResponse | null> {
  const deadline = Date.now() + retryMs;
  do {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(responsePath, "utf8"),
      );
      if (!isRecord(parsed) ||
          parsed.version !== 1 ||
          parsed.nonce !== expectedNonce ||
          (parsed.exitCode !== null &&
            !Number.isInteger(parsed.exitCode)) ||
          typeof parsed.stdout !== "string" ||
          typeof parsed.stderr !== "string" ||
          typeof parsed.timedOut !== "boolean" ||
          typeof parsed.cancelled !== "boolean") {
        return null;
      }
      return parsed as BrokerResponse;
    } catch {
      if (Date.now() >= deadline) return null;
      await delay(50);
    }
  } while (Date.now() <= deadline);
  return null;
}

function escapePowerShellLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value);
}
