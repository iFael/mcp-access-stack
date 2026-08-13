import { afterEach, describe, expect, test, jest } from "@jest/globals";
import { LocalAgent } from "../../../src/index.js";
import {
  createFixture,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
} from "../../support/helpers.js";

jest.setTimeout(60_000);

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("background task integration", () => {
  test("executes, persists and exposes redacted logs after the caller returns", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);

    const started = await agent.startBackgroundTask({
      workspaceId: "test",
      operation: "integration-check",
      shell: "powershell",
      command:
        "Write-Output 'background-ok'; Write-Output 'token=integration-secret'",
      timeoutMs: 30_000,
    });

    expect(started.task?.state).toBe("starting");
    const completed = await waitForTask(agent, started.task?.id, "succeeded");
    expect(completed?.result).toMatchObject({
      status: "executed",
      exitCode: 0,
      stdout: expect.stringContaining("background-ok"),
    });
    expect(JSON.stringify(completed)).not.toContain("integration-secret");

    const logs = await agent.readBackgroundTaskLogs({
      workspaceId: "test",
      id: completed!.id,
    });
    expect(logs.logs?.stdout).toContain("background-ok");
    expect(logs.logs?.stdout).toContain("token=[REDACTED]");
    expect(logs.logs?.stdout).not.toContain("integration-secret");

    const listed = await agent.listBackgroundTasks({ workspaceId: "test" });
    expect(listed.tasks.map((task) => task.id)).toContain(completed?.id);
  });

  test("deduplicates an active command and cancellation terminates its process", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);
    const input = {
      workspaceId: "test",
      operation: "integration-soak",
      shell: "powershell" as const,
      command: "Start-Sleep -Seconds 30",
      timeoutMs: 60_000,
    };

    const first = await agent.startBackgroundTask(input);
    const running = await waitForRunningTask(agent, first.task?.id);
    let cancelled;
    try {
      const duplicate = await agent.startBackgroundTask(input);
      expect(duplicate.task?.id).toBe(first.task?.id);
    } finally {
      cancelled = await agent.cancelBackgroundTask({
        workspaceId: "test",
        id: running.id,
      });
    }
    expect(cancelled.task?.state).toBe("cancelled");
    await waitFor(() => !processExists(running.pid!), 10_000);
  });

  test("rejects destructive background commands before creating a task", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.startBackgroundTask({
        workspaceId: "test",
        operation: "unsafe",
        shell: "powershell",
        command: "Remove-Item 'missing.txt' -Force",
        timeoutMs: 30_000,
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });

    await expect(
      agent.listBackgroundTasks({ workspaceId: "test" }),
    ).resolves.toEqual({ tasks: [] });
  });
});

async function createWritableShellFixture(): Promise<Fixture> {
  const created = await createFixture({
    profile: "full-repo-write",
    allowedRoots: ["."],
  });
  await writePolicy(created.policyPath, [
    {
      ...makeWorkspacePolicy(created.workspacePath, {
        profile: "full-repo-write",
        allowedRoots: ["."],
      }),
      allowWrites: ["."],
      allowShell: ["."],
      allowedShells: ["powershell"],
    },
  ]);
  return created;
}

async function waitForRunningTask(
  agent: LocalAgent,
  id: string | undefined,
) {
  if (!id) throw new Error("Background task id was not returned.");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const task = (await agent.getBackgroundTask({ workspaceId: "test", id })).task;
    if (task?.state === "running" && task.pid !== undefined) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for a running background task.");
}

async function waitForTask(
  agent: LocalAgent,
  id: string | undefined,
  state: "running" | "succeeded",
) {
  if (!id) throw new Error("Background task id was not returned.");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const task = (await agent.getBackgroundTask({ workspaceId: "test", id })).task;
    if (task?.state === state) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for background task state " + state + ".");
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition.");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
