import { describe, expect, it } from "@jest/globals";
import type { ServiceStartInput } from "@vs-code-gpt/shared";
import {
  LinuxServiceControlService,
  type ServiceControlCommandResult,
  type ServiceControlCommandRunner,
} from "../../../src/service-control/service.js";

const CHANNEL = "mcp-v3-update-control-oracle-channel.service" as const;

class FakeRunner implements ServiceControlCommandRunner {
  readonly calls: Array<{ executable: string; args: readonly string[] }> = [];
  constructor(private readonly results: ServiceControlCommandResult[]) {}

  async run(
    executable: string,
    args: readonly string[],
  ): Promise<ServiceControlCommandResult> {
    this.calls.push({ executable, args });
    const next = this.results.shift();
    if (!next) throw new Error("Unexpected command.");
    return next;
  }
}

function statusOutput(
  activeState: "inactive" | "active",
  mainPid: number,
): string {
  return [
    "LoadState=loaded",
    "UnitFileState=enabled",
    `ActiveState=${activeState}`,
    `SubState=${activeState === "active" ? "running" : "dead"}`,
    "Result=success",
    `MainPID=${mainPid}`,
    "NRestarts=0",
    "ExecMainStatus=0",
    "StateChangeTimestamp=Tue 2026-10-06 00:22:26 UTC",
    "",
  ].join("\n");
}

function commandResult(
  stdout = "",
  exitCode = 0,
): ServiceControlCommandResult {
  return {
    exitCode,
    stdout,
    stderr: "",
    timedOut: false,
  };
}

function startInput(): ServiceStartInput {
  return {
    workspaceId: "mcp-access-stack",
    serviceName: CHANNEL,
    operationId: "123e4567-e89b-42d3-a456-426614174000",
    expectedActiveState: "inactive",
    expectedUnitFileState: "enabled",
  };
}

describe("LinuxServiceControlService", () => {
  it("reads bounded status through fixed systemctl arguments", async () => {
    const runner = new FakeRunner([commandResult(statusOutput("inactive", 0))]);
    const service = new LinuxServiceControlService({ platform: "linux", runner });

    await expect(service.getStatus(CHANNEL)).resolves.toMatchObject({
      serviceName: CHANNEL,
      loadState: "loaded",
      unitFileState: "enabled",
      activeState: "inactive",
      subState: "dead",
      mainPid: 0,
      nRestarts: 0,
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.executable).toBe("/usr/bin/systemctl");
    expect(runner.calls[0]?.args).toEqual([
      "show",
      CHANNEL,
      "--no-pager",
      expect.stringMatching(/^--property=/u),
    ]);
  });

  it("starts only the allowlisted unit through noninteractive systemctl without sudo", async () => {
    const runner = new FakeRunner([
      commandResult(statusOutput("inactive", 0)),
      commandResult(),
      commandResult(statusOutput("active", 4242)),
    ]);
    const service = new LinuxServiceControlService({ platform: "linux", runner });

    await expect(service.start(startInput())).resolves.toMatchObject({
      status: "started",
      serviceName: CHANNEL,
      after: {
        activeState: "active",
        subState: "running",
        mainPid: 4242,
      },
    });
    expect(runner.calls[1]).toEqual({
      executable: "/usr/bin/systemctl",
      args: ["--no-ask-password", "start", CHANNEL],
    });
  });

  it("fails closed on expected-state mismatch without invoking a start command", async () => {
    const runner = new FakeRunner([
      commandResult(statusOutput("active", 4242)),
    ]);
    const service = new LinuxServiceControlService({ platform: "linux", runner });

    await expect(service.start(startInput())).rejects.toMatchObject({
      code: "EXECUTION_STATE_INVALID",
    });
    expect(runner.calls).toHaveLength(1);
  });

  it("reports a denied start as not-started after reconciling inactive state", async () => {
    const runner = new FakeRunner([
      commandResult(statusOutput("inactive", 0)),
      commandResult("", 1),
      commandResult(statusOutput("inactive", 0)),
      ...Array.from({ length: 20 }, () =>
        commandResult(statusOutput("inactive", 0))),
    ]);
    const service = new LinuxServiceControlService({ platform: "linux", runner });

    await expect(service.start(startInput())).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: {
        operation: "service_start",
        outcome: "not_started",
      },
    });
    expect(runner.calls[1]).toEqual({
      executable: "/usr/bin/systemctl",
      args: ["--no-ask-password", "start", CHANNEL],
    });
  });

  it("rejects non-Linux runtimes and arbitrary unit names", async () => {
    const runner = new FakeRunner([]);
    const windows = new LinuxServiceControlService({ platform: "win32", runner });
    await expect(windows.getStatus(CHANNEL)).rejects.toMatchObject({
      code: "CAPABILITY_UNSUPPORTED",
    });

    const linux = new LinuxServiceControlService({ platform: "linux", runner });
    await expect(
      linux.getStatus("ssh.service" as never),
    ).rejects.toBeDefined();
    expect(runner.calls).toHaveLength(0);
  });
});
