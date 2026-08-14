import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import type {
  RelayCancellation,
  RelayRequest,
  RunCommandResult,
} from "@vs-code-gpt/shared";
import { AgentRequestExecutor } from "../../../src/connection/request-executor.js";
import { LocalAgent } from "../../../src/local-agent.js";
import {
  createFixture,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("synchronous command lifecycle", () => {
  test(
    "releases confirmation lease, cancels the confirmed process tree, and accepts the next command",
    async () => {
      fixture = await createFixture({
        profile: "full-repo-write",
        allowedRoots: ["."],
      });
      await writePolicy(fixture.policyPath, [
        writableShellWorkspace("workspace-a", fixture.workspacePath),
      ]);

      const pidPath = path.join(fixture.workspacePath, "confirmed-child.pid");
      const escapedPidPath = pidPath.replaceAll("'", "''");
      const command = [
        "$child = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120' -PassThru",
        `Set-Content -LiteralPath '${escapedPidPath}' -Value $child.Id`,
        "Start-Sleep -Seconds 120",
      ].join("; ");

      const agent = await LocalAgent.create(fixture.policyPath);
      const executor = new AgentRequestExecutor(agent, undefined, {
        maxConcurrentSynchronousShells: 1,
      });

      const confirmationResponse = await executor.execute(
        shellCommandRequest("confirmation-request", "workspace-a", command, 30_000),
        1,
      );
      expect(confirmationResponse.ok).toBe(true);
      if (!confirmationResponse.ok) throw new Error("Expected confirmation response.");
      const confirmation = confirmationResponse.result as RunCommandResult;
      expect(confirmation.status).toBe("confirmation_required");
      if (confirmation.status !== "confirmation_required") {
        throw new Error("Expected confirmation_required.");
      }
      expect(executor.activeRequestCount).toBe(0);

      await expect(
        executor.execute(
          shellCommandRequest(
            "after-confirmation",
            "workspace-a",
            "Write-Output 'confirmation-lease-released'",
            5_000,
          ),
          1,
        ),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          status: "executed",
          exitCode: 0,
          stdout: expect.stringContaining("confirmation-lease-released"),
        },
      });

      const confirmedExecution = executor.execute(
        shellCommandRequest(
          "confirmed-execution",
          "workspace-a",
          command,
          30_000,
          confirmation.confirmationId,
        ),
        1,
      );
      const childPid = await waitForPidFile(pidPath, 10_000);
      expect(processExists(childPid)).toBe(true);

      const cancellation: RelayCancellation = {
        version: 1,
        type: "cancel",
        requestId: "confirmed-execution",
        reason: "client_disconnected",
      };
      executor.cancel(cancellation);

      await expect(confirmedExecution).resolves.toMatchObject({
        ok: false,
        error: {
          code: "OPERATION_CANCELLED",
          lifecycle: {
            reason: "client_disconnected",
          },
        },
      });
      expect(executor.activeRequestCount).toBe(0);
      await expectProcessToExit(childPid);

      await expect(
        executor.execute(
          shellCommandRequest(
            "after-cancellation",
            "workspace-a",
            "Write-Output 'workspace-lock-released'",
            5_000,
          ),
          1,
        ),
      ).resolves.toMatchObject({
        ok: true,
        result: {
          status: "executed",
          exitCode: 0,
          stdout: expect.stringContaining("workspace-lock-released"),
        },
      });
    },
    60_000,
  );
});

function writableShellWorkspace(id: string, rootPath: string) {
  return {
    ...makeWorkspacePolicy(rootPath, {
      profile: "full-repo-write",
      allowedRoots: ["."],
    }),
    id,
    name: id,
    allowWrites: ["."],
    allowShell: ["."],
    allowedShells: ["powershell"],
  };
}

function shellCommandRequest(
  requestId: string,
  workspaceId: string,
  command: string,
  timeoutMs: number,
  confirmationId?: string,
): RelayRequest {
  return {
    version: 1,
    type: "request",
    requestId,
    deadline: {
      requestedTimeoutMs: timeoutMs,
      effectiveTimeoutMs: timeoutMs,
      deadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    },
    operation: "runCommand",
    input: {
      workspaceId,
      shell: "powershell",
      command,
      timeoutMs,
      ...(confirmationId === undefined ? {} : { confirmationId }),
    },
  };
}

async function waitForPidFile(filePath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      const pid = Number((await readFile(filePath, "utf8")).trim());
      if (Number.isSafeInteger(pid) && pid > 0) return pid;
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected PID file was not readable within ${timeoutMs}ms.`);
}

async function expectProcessToExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} remained alive after synchronous cancellation.`);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
