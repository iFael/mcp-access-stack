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

    expect(started.status).toBe("background_task_started");
    if (started.status !== "background_task_started") throw new Error("expected background task");
    expect(started.task.state).toBe("starting");
    const completed = await waitForTask(agent, started.task.id, "succeeded");
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
    if (first.status !== "background_task_started") throw new Error("expected background task");
    const running = await waitForRunningTask(agent, first.task.id);
    let cancelled;
    try {
      const duplicate = await agent.startBackgroundTask(input);
      if (duplicate.status !== "background_task_started") throw new Error("expected background task");
      expect(duplicate.task.id).toBe(first.task.id);
    } finally {
      cancelled = await agent.cancelBackgroundTask({
        workspaceId: "test",
        id: running.id,
      });
    }
    expect(cancelled.task?.state).toBe("cancelled");
    await waitFor(() => !processExists(running.pid!), 10_000);
  });

  test("isolates background tasks between owner scopes end to end", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);
    const input = {
      workspaceId: "test",
      operation: "owner-isolation",
      shell: "powershell" as const,
      command: "Start-Sleep -Seconds 30",
      timeoutMs: 60_000,
    };
    const ownerA = { ownerScope: "openai-session:integration-owner-a" };
    const ownerB = { ownerScope: "openai-session:integration-owner-b" };

    const first = await agent.startBackgroundTask(input, ownerA);
    const second = await agent.startBackgroundTask(input, ownerB);
    if (
      first.status !== "background_task_started" ||
      second.status !== "background_task_started"
    ) {
      throw new Error("expected background tasks");
    }

    expect(second.task.id).not.toBe(first.task.id);
    expect(
      (
        await agent.getBackgroundTask(
          { workspaceId: "test", id: first.task.id },
          ownerA,
        )
      ).task?.id,
    ).toBe(first.task.id);
    expect(
      (
        await agent.getBackgroundTask(
          { workspaceId: "test", id: first.task.id },
          ownerB,
        )
      ).task,
    ).toBeNull();
    expect(
      (await agent.listBackgroundTasks({ workspaceId: "test" }, ownerA)).tasks
        .map((task) => task.id),
    ).toEqual([first.task.id]);
    expect(
      (await agent.listBackgroundTasks({ workspaceId: "test" }, ownerB)).tasks
        .map((task) => task.id),
    ).toEqual([second.task.id]);

    expect(
      (
        await agent.cancelBackgroundTask(
          { workspaceId: "test", id: first.task.id },
          ownerB,
        )
      ).task,
    ).toBeNull();
    expect(
      (
        await agent.cancelBackgroundTask(
          { workspaceId: "test", id: first.task.id },
          ownerA,
        )
      ).task?.state,
    ).toBe("cancelled");
    expect(
      (
        await agent.cancelBackgroundTask(
          { workspaceId: "test", id: second.task.id },
          ownerB,
        )
      ).task?.state,
    ).toBe("cancelled");
  });
  test("always requires explicit confirmation before starting an interactive background task", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);
    const input = {
      workspaceId: "test",
      operation: "interactive-session",
      shell: "powershell" as const,
      command:
        "$line = [Console]::In.ReadLine(); [Console]::Out.WriteLine(('interactive:' + $line))",
      timeoutMs: 60_000,
      interactive: true,
    };

    const pending = await agent.startBackgroundTask(input);
    expect(pending).toMatchObject({
      status: "confirmation_required",
      reasons: expect.arrayContaining([
        "interactive process grants persistent stdin access",
      ]),
    });
    if (pending.status !== "confirmation_required") {
      throw new Error("expected confirmation");
    }
    expect((await agent.listBackgroundTasks({ workspaceId: "test" })).tasks).toEqual([]);

    const started = await agent.startBackgroundTask({
      ...input,
      confirmationId: pending.confirmationId,
    });
    expect(started).toMatchObject({
      status: "background_task_started",
      task: {
        operation: input.operation,
        interactive: true,
      },
    });
    if (started.status !== "background_task_started") {
      throw new Error("expected background task");
    }

    await waitForRunningTask(agent, started.task.id);
    await expect(
      agent.startBackgroundTask({
        ...input,
        operation: "different-interactive-session",
        confirmationId: pending.confirmationId,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFIRMATION_INVALID" });

    const written = await agent.writeBackgroundTaskStdin({
      workspaceId: "test",
      id: started.task.id,
      input: "hello-from-agent\n",
      close: true,
    });
    expect(written).toMatchObject({
      task: { id: started.task.id, interactive: true },
      bytesWritten: 17,
      stdinClosed: true,
    });

    const completed = await waitForTask(agent, started.task.id, "succeeded");
    expect(completed?.state).toBe("succeeded");

    const output = await agent.readBackgroundTaskOutput({
      workspaceId: "test",
      id: started.task.id,
      stdoutOffset: 0,
      stderrOffset: 0,
      maxBytes: 256,
    });
    expect(output).toMatchObject({
      task: { id: started.task.id, state: "succeeded" },
      stdout: {
        content: expect.stringContaining("interactive:hello-from-agent"),
        offset: 0,
        eof: true,
      },
    });
    expect(output.stdout?.nextOffset).toBe(output.stdout?.totalBytes);
  });

  test("requires confirmation before risky background execution and never persists the token", async () => {
    fixture = await createWritableShellFixture();
    const agent = await LocalAgent.create(fixture.policyPath);
    const input = {
      workspaceId: "test",
      operation: "confirmed-background-write",
      shell: "powershell" as const,
      command: "Set-Content -LiteralPath 'confirmed-background.txt' -Value 'ok'",
      timeoutMs: 30_000,
    };

    const pending = await agent.startBackgroundTask(input);
    expect(pending).toMatchObject({
      status: "confirmation_required",
      reasons: expect.arrayContaining(["move, overwrite or direct file write operation"]),
    });
    if (pending.status !== "confirmation_required") throw new Error("expected confirmation");
    expect((await agent.listBackgroundTasks({ workspaceId: "test" })).tasks).toEqual([]);

    await expect(
      agent.startBackgroundTask({ ...input, confirmationId: "wrong" }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFIRMATION_INVALID" });

    await expect(
      agent.startBackgroundTask({
        ...input,
        operation: "different-background-operation",
        confirmationId: pending.confirmationId,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFIRMATION_INVALID" });
    expect((await agent.listBackgroundTasks({ workspaceId: "test" })).tasks).toEqual([]);

    const started = await agent.startBackgroundTask({
      ...input,
      confirmationId: pending.confirmationId,
    });
    expect(started).toMatchObject({
      status: "background_task_started",
      task: { operation: input.operation, command: input.command },
    });
    if (started.status !== "background_task_started") throw new Error("expected background task");
    expect(JSON.stringify(started.task)).not.toContain("confirmationId");
    expect(JSON.stringify(started.task)).not.toContain(pending.confirmationId);

    const completed = await waitForTask(agent, started.task.id, "succeeded");
    expect(JSON.stringify(completed)).not.toContain("confirmationId");
    expect(JSON.stringify(completed)).not.toContain(pending.confirmationId);

    await expect(
      agent.startBackgroundTask({
        ...input,
        confirmationId: pending.confirmationId,
      }),
    ).rejects.toMatchObject({ code: "COMMAND_CONFIRMATION_INVALID" });
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
