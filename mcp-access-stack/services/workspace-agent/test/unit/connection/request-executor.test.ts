import { describe, expect, test, jest } from "@jest/globals";
import type { OperationContext, RelayRequest } from "@vs-code-gpt/shared";
import {
  AgentRequestExecutor,
  type RequestExecutionLog,
} from "../../../src/connection/request-executor.js";
import type { LocalAgent } from "../../../src/local-agent.js";

describe("connection request executor", () => {
  test("executes a request with deadline context and lifecycle diagnostics", async () => {
    const logs: RequestExecutionLog[] = [];
    const listWorkspaces = jest.fn(async (_context?: OperationContext) => []);
    const executor = new AgentRequestExecutor(
      { listWorkspaces } as unknown as LocalAgent,
      (entry) => logs.push(entry),
    );

    const response = await executor.execute(
      createRequest("listWorkspaces", {}),
      3,
    );

    expect(response).toMatchObject({
      ok: true,
      requestId: "request-listWorkspaces",
      result: [],
    });
    expect(executor.activeRequestCount).toBe(0);
    expect(listWorkspaces).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "request-listWorkspaces",
        deadline: expect.objectContaining({ requestedTimeoutMs: 5_000 }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(logs).toEqual([
      expect.objectContaining({
        event: "agent_request_started",
        generation: 3,
        activeRequests: 1,
      }),
      expect.objectContaining({
        event: "agent_request_completed",
        generation: 3,
        status: "success",
        activeRequests: 1,
      }),
    ]);
  });

  test("rejects expired requests before invoking the agent", async () => {
    const listWorkspaces = jest.fn(async (_context?: OperationContext) => []);
    const executor = new AgentRequestExecutor(
      { listWorkspaces } as unknown as LocalAgent,
    );

    const response = await executor.execute(
      createRequest("listWorkspaces", {}, -1),
      1,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "AGENT_TIMEOUT",
        lifecycle: {
          terminatedBy: "workspace_agent",
          reason: "timeout",
        },
      },
    });
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(executor.activeRequestCount).toBe(0);
  });

  test("applies the remaining Agent deadline to an active operation", async () => {
    const searchFiles = jest.fn(
      async (_input: unknown, context: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          const signal = context.signal!;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const executor = new AgentRequestExecutor(
      { searchFiles } as unknown as LocalAgent,
    );

    const response = await executor.execute(
      createRequest("searchFiles", { query: "needle" }, 20),
      1,
    );

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "AGENT_TIMEOUT",
        lifecycle: {
          terminatedBy: "workspace_agent",
          reason: "timeout",
        },
      },
    });
    expect(executor.activeRequestCount).toBe(0);
  });

  test("allows background wait timeout to finish within completion grace", async () => {
    const waitBackgroundTask = jest.fn(
      async (_input: unknown, context: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ task: null, logs: null, timedOut: true, elapsedMs: 20 }),
            40,
          );
          const signal = context.signal!;
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    );
    const executor = new AgentRequestExecutor(
      { waitBackgroundTask } as unknown as LocalAgent,
    );

    const response = await executor.execute(
      createRequest(
        "waitBackgroundTask",
        {
          workspaceId: "project",
          id: "123e4567-e89b-42d3-a456-426614174000",
          timeoutMs: 20,
          maxBytes: 100,
        },
        20,
      ),
      1,
    );

    expect(response).toMatchObject({
      ok: true,
      result: { timedOut: true, elapsedMs: 20 },
    });
    expect(executor.activeRequestCount).toBe(0);
  });

  test("allows command teardown to finish after the execution deadline", async () => {
    const runCommand = jest.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        status: "executed" as const,
        shell: "powershell" as const,
        cwd: ".",
        exitCode: null,
        stdout: "partial\n",
        stderr: "",
        timedOut: true,
      };
    });
    const executor = new AgentRequestExecutor(
      { runCommand, resolveWorkspaceConcurrencyKey: (workspaceId: string) => `root:${workspaceId}` } as unknown as LocalAgent,
    );

    const response = await executor.execute(
      createRequest(
        "runCommand",
        {
          workspaceId: "project",
          shell: "powershell",
          command: "Write-Output partial; Start-Sleep -Seconds 10",
          timeoutMs: 20,
        },
        20,
      ),
      1,
    );

    expect(response).toMatchObject({
      ok: true,
      result: {
        status: "executed",
        timedOut: true,
        stdout: expect.stringContaining("partial"),
      },
    });
    expect(executor.activeRequestCount).toBe(0);
  });

  test("keeps same-workspace synchronous shells fail-fast while reads remain concurrent", async () => {
    let releaseCommand!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const executedResult = commandResult();
    const runCommand = jest.fn(async () => {
      markStarted();
      await blocked;
      return executedResult;
    });
    const listWorkspaces = jest.fn(async () => []);
    const executor = new AgentRequestExecutor(
      {
        runCommand,
        listWorkspaces,
        resolveWorkspaceConcurrencyKey: (workspaceId: string) => `root:${workspaceId}`,
      } as unknown as LocalAgent,
    );
    const first = executor.execute(shellRequest("shell-request-1", "project-a"), 1);
    await started;

    const second = await executor.execute(
      powerShellRequest("shell-request-2", "project-a"),
      1,
    );
    const read = await executor.execute(
      { ...createRequest("listWorkspaces", {}), requestId: "read-request" },
      1,
    );

    expect(second).toMatchObject({
      ok: false,
      error: {
        code: "AGENT_BUSY",
        message: "Another synchronous shell operation is already active for this workspace.",
      },
    });
    expect(read).toMatchObject({ ok: true, result: [] });
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    releaseCommand();
    await expect(first).resolves.toMatchObject({ ok: true, result: executedResult });
    expect(executor.activeRequestCount).toBe(0);
  });

  test("allows synchronous shells from different canonical workspaces to overlap", async () => {
    const controls = createCommandControls(["project-a", "project-b"]);
    const executor = new AgentRequestExecutor(
      {
        runCommand: controls.runCommand,
        resolveWorkspaceConcurrencyKey: (workspaceId: string) => `root:${workspaceId}`,
      } as unknown as LocalAgent,
    );

    const first = executor.execute(shellRequest("shell-a", "project-a"), 1);
    await controls.started.get("project-a");
    const second = executor.execute(shellRequest("shell-b", "project-b"), 1);
    await controls.started.get("project-b");

    expect(executor.activeRequestCount).toBe(2);
    expect(controls.runCommand).toHaveBeenCalledTimes(2);

    controls.release.get("project-a")?.();
    controls.release.get("project-b")?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
  });

  test("serializes workspace aliases that resolve to the same canonical root", async () => {
    const controls = createCommandControls(["alias-a"]);
    const executor = new AgentRequestExecutor(
      {
        runCommand: controls.runCommand,
        resolveWorkspaceConcurrencyKey: () => "c:/canonical/project",
      } as unknown as LocalAgent,
    );

    const first = executor.execute(shellRequest("shell-alias-a", "alias-a"), 1);
    await controls.started.get("alias-a");
    const second = await executor.execute(shellRequest("shell-alias-b", "alias-b"), 1);

    expect(second).toMatchObject({
      ok: false,
      error: { code: "AGENT_BUSY" },
    });
    expect(controls.runCommand).toHaveBeenCalledTimes(1);

    controls.release.get("alias-a")?.();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  test("bounds cross-workspace synchronous shell concurrency and releases capacity", async () => {
    const controls = createCommandControls(["project-a", "project-b", "project-c"]);
    const executor = new AgentRequestExecutor(
      {
        runCommand: controls.runCommand,
        resolveWorkspaceConcurrencyKey: (workspaceId: string) => `root:${workspaceId}`,
      } as unknown as LocalAgent,
      undefined,
      { maxConcurrentSynchronousShells: 2 },
    );

    const first = executor.execute(shellRequest("shell-a", "project-a"), 1);
    await controls.started.get("project-a");
    const second = executor.execute(shellRequest("shell-b", "project-b"), 1);
    await controls.started.get("project-b");

    const rejected = await executor.execute(shellRequest("shell-c-rejected", "project-c"), 1);
    expect(rejected).toMatchObject({
      ok: false,
      error: {
        code: "AGENT_BUSY",
        message: "The Workspace Agent synchronous shell concurrency limit is reached.",
      },
    });
    expect(controls.runCommand).toHaveBeenCalledTimes(2);

    controls.release.get("project-a")?.();
    await expect(first).resolves.toMatchObject({ ok: true });

    const third = executor.execute(shellRequest("shell-c", "project-c"), 1);
    await controls.started.get("project-c");
    expect(controls.runCommand).toHaveBeenCalledTimes(3);

    controls.release.get("project-b")?.();
    controls.release.get("project-c")?.();
    await expect(Promise.all([second, third])).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
  });

  test("releases the workspace shell lease after command failure", async () => {
    let attempts = 0;
    const runCommand = jest.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture failure");
      return commandResult();
    });
    const executor = new AgentRequestExecutor(
      {
        runCommand,
        resolveWorkspaceConcurrencyKey: (workspaceId: string) => `root:${workspaceId}`,
      } as unknown as LocalAgent,
    );

    await expect(
      executor.execute(shellRequest("shell-failed", "project-a"), 1),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      executor.execute(shellRequest("shell-retry", "project-a"), 1),
    ).resolves.toMatchObject({ ok: true });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });

  test("keeps explicit cancellation distinct from timeout", async () => {
    const searchFiles = jest.fn(
      async (_input: unknown, context: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          const signal = context.signal!;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const executor = new AgentRequestExecutor(
      { searchFiles } as unknown as LocalAgent,
    );
    const request = createRequest("searchFiles", { query: "needle" }, 5_000);
    const pending = executor.execute(request, 2);

    executor.cancel({
      version: 1,
      type: "cancel",
      requestId: request.requestId,
      reason: "cancelled",
    });
    const response = await pending;

    expect(response).toMatchObject({
      ok: false,
      error: {
        code: "OPERATION_CANCELLED",
        lifecycle: {
          terminatedBy: "workspace_agent",
          reason: "cancelled",
        },
      },
    });
    expect(executor.activeRequestCount).toBe(0);
  });

  test("aborts all active operations when the connection closes", async () => {
    const searchFiles = jest.fn(
      async (_input: unknown, context: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          const signal = context.signal;
          if (!signal) {
            reject(new Error("Missing signal"));
            return;
          }
          const rejectWithReason = () => reject(signal.reason);
          if (signal.aborted) rejectWithReason();
          else signal.addEventListener("abort", rejectWithReason, { once: true });
        }),
    );
    const executor = new AgentRequestExecutor(
      { searchFiles } as unknown as LocalAgent,
    );

    const pending = executor.execute(
      createRequest("searchFiles", { query: "needle" }),
      2,
    );
    expect(executor.activeRequestCount).toBe(1);

    executor.abortAll("socket closed");
    const response = await pending;

    expect(response).toMatchObject({
      ok: false,
      error: { code: "AGENT_UNAVAILABLE" },
    });
    expect(executor.activeRequestCount).toBe(0);
  });
});

function commandResult() {
  return {
    status: "executed" as const,
    shell: "powershell" as const,
    cwd: ".",
    exitCode: 0,
    stdout: "done\n",
    stderr: "",
    timedOut: false,
  };
}

function shellRequest(requestId: string, workspaceId: string): RelayRequest {
  return {
    ...createRequest("runCommand", {
      workspaceId,
      shell: "powershell",
      command: "Write-Output fixture",
      timeoutMs: 30_000,
    }),
    requestId,
  };
}

function powerShellRequest(requestId: string, workspaceId: string): RelayRequest {
  return {
    ...createRequest("runPowerShell", {
      workspaceId,
      command: "Write-Output fixture",
      timeoutMs: 30_000,
    }),
    requestId,
  };
}

function createCommandControls(workspaces: readonly string[]) {
  const started = new Map<string, Promise<void>>();
  const markStarted = new Map<string, () => void>();
  const blocked = new Map<string, Promise<void>>();
  const release = new Map<string, () => void>();
  for (const workspaceId of workspaces) {
    started.set(workspaceId, new Promise<void>((resolve) => markStarted.set(workspaceId, resolve)));
    blocked.set(workspaceId, new Promise<void>((resolve) => release.set(workspaceId, resolve)));
  }
  const runCommand = jest.fn(async (input: { workspaceId: string }) => {
    markStarted.get(input.workspaceId)?.();
    await blocked.get(input.workspaceId);
    return commandResult();
  });
  return { started, release, runCommand };
}

function createRequest(
  operation: RelayRequest["operation"],
  input: unknown,
  deadlineInMs = 5_000,
): RelayRequest {
  return {
    version: 1,
    type: "request",
    requestId: `request-${operation}`,
    deadline: {
      requestedTimeoutMs: Math.max(1, Math.abs(deadlineInMs)),
      effectiveTimeoutMs: Math.max(0, deadlineInMs),
      deadlineAt: new Date(Date.now() + deadlineInMs).toISOString(),
    },
    operation,
    input: input as never,
  };
}
