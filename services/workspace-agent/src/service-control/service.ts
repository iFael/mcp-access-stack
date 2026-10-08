import { spawn } from "node:child_process";
import {
  AppError,
  managedLinuxServiceNameSchema,
  managedServiceSnapshotSchema,
  type ManagedLinuxServiceName,
  type ManagedServiceSnapshot,
  type ServiceStartInput,
  type ServiceStartResult,
} from "@vs-code-gpt/shared";

const SYSTEMCTL = "/usr/bin/systemctl";
const COMMAND_TIMEOUT_MS = 15_000;
const STATUS_POLL_ATTEMPTS = 20;
const STATUS_POLL_DELAY_MS = 250;
const MAX_OUTPUT_BYTES = 64 * 1024;

const STATUS_PROPERTIES = [
  "LoadState",
  "UnitFileState",
  "ActiveState",
  "SubState",
  "Result",
  "MainPID",
  "NRestarts",
  "ExecMainStatus",
  "StateChangeTimestamp",
] as const;

export interface ServiceControlCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ServiceControlCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ServiceControlCommandResult>;
}

export interface LinuxServiceControlServiceOptions {
  platform?: NodeJS.Platform;
  runner?: ServiceControlCommandRunner;
}

export class LinuxServiceControlService {
  private readonly platform: NodeJS.Platform;
  private readonly runner: ServiceControlCommandRunner;

  constructor(options: LinuxServiceControlServiceOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runner = options.runner ?? new SpawnServiceControlCommandRunner();
  }

  async getStatus(
    serviceName: ManagedLinuxServiceName,
    signal?: AbortSignal,
  ): Promise<ManagedServiceSnapshot> {
    this.assertLinux();
    const parsedService = managedLinuxServiceNameSchema.parse(serviceName);
    const result = await this.runner.run(
      SYSTEMCTL,
      [
        "show",
        parsedService,
        "--no-pager",
        "--property=" + STATUS_PROPERTIES.join(","),
      ],
      COMMAND_TIMEOUT_MS,
      signal,
    );
    if (result.timedOut) {
      throw new AppError(
        "AGENT_TIMEOUT",
        "Managed service status inspection timed out.",
      );
    }
    if (result.exitCode !== 0) {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Managed service status is unavailable on this runtime.",
      );
    }
    return parseServiceStatus(parsedService, result.stdout);
  }

  async start(
    input: ServiceStartInput,
    signal?: AbortSignal,
  ): Promise<ServiceStartResult> {
    this.assertLinux();
    const serviceName = managedLinuxServiceNameSchema.parse(input.serviceName);
    const before = await this.getStatus(serviceName, signal);

    if (before.loadState !== "loaded") {
      throw stateMismatch(
        "Managed service is not loaded.",
        "load_state_mismatch",
      );
    }
    if (before.unitFileState !== input.expectedUnitFileState) {
      throw stateMismatch(
        "Managed service unit-file state does not match the expected state.",
        "unit_file_state_mismatch",
      );
    }
    if (before.activeState !== input.expectedActiveState) {
      throw stateMismatch(
        "Managed service active state does not match the expected state.",
        "active_state_mismatch",
      );
    }

    const command = await this.runner.run(
      SYSTEMCTL,
      ["--no-ask-password", "start", serviceName],
      COMMAND_TIMEOUT_MS,
      signal,
    );

    if (command.timedOut) {
      throw new AppError(
        "EXECUTION_OUTCOME_UNKNOWN",
        "Managed service start exceeded its bounded execution window; reconcile service state before any retry.",
        { details: { operation: "service_start", outcome: "unknown" } },
      );
    }

    if (command.exitCode !== 0) {
      const after = await this.getStatus(serviceName, signal);
      if (after.activeState === "active" && after.mainPid > 0) {
        return {
          status: "started",
          operationId: input.operationId,
          serviceName,
          before,
          after,
        };
      }
      if (after.activeState === "inactive") {
        throw new AppError(
          "PERMISSION_DENIED",
          "Managed service start was denied or did not begin.",
          {
            details: {
              operation: "service_start",
              outcome: "not_started",
            },
          },
        );
      }
      throw new AppError(
        "EXECUTION_OUTCOME_UNKNOWN",
        "Managed service start command failed with an unresolved service state; reconcile service state before any retry.",
        { details: { operation: "service_start", outcome: "unknown" } },
      );
    }

    const after = await this.waitForTerminalStartState(serviceName, signal);
    if (after.activeState === "active" && after.mainPid > 0) {
      return {
        status: "started",
        operationId: input.operationId,
        serviceName,
        before,
        after,
      };
    }

    if (after.activeState === "failed") {
      throw new AppError(
        "EXECUTION_STATE_INVALID",
        "Managed service entered failed state after start.",
        {
          details: {
            operation: "service_start",
            outcome: "not_started",
          },
        },
      );
    }

    throw new AppError(
      "EXECUTION_OUTCOME_UNKNOWN",
      "Managed service start did not reach the required active/running postcondition; reconcile service state before any retry.",
      { details: { operation: "service_start", outcome: "unknown" } },
    );
  }

  private async waitForTerminalStartState(
    serviceName: ManagedLinuxServiceName,
    signal?: AbortSignal,
  ): Promise<ManagedServiceSnapshot> {
    let snapshot = await this.getStatus(serviceName, signal);
    for (let attempt = 0; attempt < STATUS_POLL_ATTEMPTS; attempt += 1) {
      if (
        (snapshot.activeState === "active" && snapshot.mainPid > 0) ||
        snapshot.activeState === "failed"
      ) {
        return snapshot;
      }
      await sleep(STATUS_POLL_DELAY_MS, signal);
      snapshot = await this.getStatus(serviceName, signal);
    }
    return snapshot;
  }

  private assertLinux(): void {
    if (this.platform !== "linux") {
      throw new AppError(
        "CAPABILITY_UNSUPPORTED",
        "Managed Linux service control is available only on Linux runtimes.",
      );
    }
  }
}

export class SpawnServiceControlCommandRunner implements ServiceControlCommandRunner {
  async run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ServiceControlCommandResult> {
    if (signal?.aborted) {
      throw new AppError("OPERATION_CANCELLED", "Managed service operation was cancelled.");
    }

    return await new Promise<ServiceControlCommandResult>((resolve, reject) => {
      const child = spawn(executable, [...args], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const finish = (result: ServiceControlCommandResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = () => {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new AppError("OPERATION_CANCELLED", "Managed service operation was cancelled."));
        }
      };
      const append = (current: string, chunk: Buffer): string => {
        if (Buffer.byteLength(current, "utf8") >= MAX_OUTPUT_BYTES) return current;
        return (current + chunk.toString("utf8")).slice(0, MAX_OUTPUT_BYTES);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(new AppError(
          "CAPABILITY_UNSUPPORTED",
          "Managed service command runner is unavailable.",
          { cause: error },
        ));
      });
      child.once("close", (code) => {
        finish({
          exitCode: code,
          stdout,
          stderr,
          timedOut,
        });
      });

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function parseServiceStatus(
  serviceName: ManagedLinuxServiceName,
  output: string,
): ManagedServiceSnapshot {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties.set(line.slice(0, separator), line.slice(separator + 1));
  }

  return managedServiceSnapshotSchema.parse({
    serviceName,
    loadState: stateValue(properties.get("LoadState")),
    unitFileState: stateValue(properties.get("UnitFileState")),
    activeState: stateValue(properties.get("ActiveState")),
    subState: stateValue(properties.get("SubState")),
    result: stateValue(properties.get("Result")),
    mainPid: nonNegativeInteger(properties.get("MainPID")),
    nRestarts: nonNegativeInteger(properties.get("NRestarts")),
    execMainStatus: nullableNonNegativeInteger(properties.get("ExecMainStatus")),
    stateChangeTimestamp: nullableText(properties.get("StateChangeTimestamp")),
  });
}

function stateValue(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 64) : "unknown";
}

function nonNegativeInteger(value: string | undefined): number {
  const parsed = Number(value ?? "0");
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function nullableNonNegativeInteger(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nullableText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}

function stateMismatch(message: string, reason: string): AppError {
  return new AppError(
    "EXECUTION_STATE_INVALID",
    message,
    {
      details: {
        operation: "service_start",
        reason,
        outcome: "not_started",
      },
    },
  );
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new AppError("OPERATION_CANCELLED", "Managed service operation was cancelled.");
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: AppError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () =>
      finish(new AppError("OPERATION_CANCELLED", "Managed service operation was cancelled."));
    const timer = setTimeout(() => finish(), ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
