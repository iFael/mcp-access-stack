import { describe, expect, test } from "@jest/globals";
import {
  createOperationDeadline,
  type RelayCancellation,
  type RelayRequest,
  type RelayResponse,
} from "@vs-code-gpt/shared";
import {
  AgentRelayRequestManager,
  type RelayRequestSender,
} from "../../../src/relay/request-manager.js";
import { silentLogger } from "../../support/helpers.js";

class FakeSender implements RelayRequestSender {
  payloads: string[] = [];
  sendError: Error | undefined;

  send(payload: string, callback: (error?: Error) => void): void {
    this.payloads.push(payload);
    callback(this.sendError);
  }

  request(index = 0): RelayRequest {
    return JSON.parse(this.payloads[index] ?? "null") as RelayRequest;
  }

  cancellation(index = 1): RelayCancellation {
    return JSON.parse(this.payloads[index] ?? "null") as RelayCancellation;
  }
}

function createManager(overrides: Partial<{
  requestTimeoutMs: number;
  maxConcurrency: number;
  maxPayloadBytes: number;
}> = {}) {
  let generation = 4;
  const manager = new AgentRelayRequestManager(
    {
      requestTimeoutMs: overrides.requestTimeoutMs ?? 100,
      maxConcurrency: overrides.maxConcurrency ?? 2,
      maxPayloadBytes: overrides.maxPayloadBytes ?? 64_000,
      generation: () => generation,
    },
    silentLogger(),
  );
  return { manager, setGeneration: (value: number) => { generation = value; } };
}

describe("agent relay request manager", () => {
  test("sends a request and resolves only a schema-valid response", async () => {
    const { manager } = createManager();
    const sender = new FakeSender();
    const pending = manager.call(sender, "listWorkspaces", {});
    const request = sender.request();

    manager.complete({
      version: 1,
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: [],
    });

    await expect(pending).resolves.toEqual([]);
    expect(manager.size).toBe(0);
  });

  test("does not reduce an explicit medium deadline to the Gateway default", async () => {
    const { manager } = createManager({ requestTimeoutMs: 20 });
    const sender = new FakeSender();
    const pending = manager.call(sender, "listWorkspaces", {}, {
      deadline: createOperationDeadline(300_000, undefined),
    });
    const request = sender.request();

    expect(request.deadline.requestedTimeoutMs).toBe(300_000);
    expect(request.deadline.effectiveTimeoutMs).toBeGreaterThan(299_000);
    manager.complete({
      version: 1,
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: [],
    });
    await expect(pending).resolves.toEqual([]);
  });
  test("allows command teardown to return a structured timeout result", async () => {
    const { manager } = createManager({ requestTimeoutMs: 100 });
    const sender = new FakeSender();
    const pending = manager.call(sender, "runCommand", {
      workspaceId: "project",
      shell: "powershell",
      command: "Write-Output partial; Start-Sleep -Seconds 10",
      timeoutMs: 20,
    });
    const request = sender.request();

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(manager.size).toBe(1);
    expect(sender.payloads).toHaveLength(1);

    manager.complete({
      version: 1,
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        status: "executed",
        shell: "powershell",
        cwd: ".",
        exitCode: null,
        stdout: "partial\n",
        stderr: "",
        timedOut: true,
        lifecycle: {
          ...request.deadline,
          elapsedMs: 120,
          terminatedBy: "child_process",
          reason: "timeout",
        },
      },
    });

    await expect(pending).resolves.toMatchObject({
      status: "executed",
      timedOut: true,
      stdout: expect.stringContaining("partial"),
      lifecycle: { terminatedBy: "child_process", reason: "timeout" },
    });
    expect(manager.size).toBe(0);
  });
  test("enforces concurrency and expires pending requests", async () => {
    const { manager } = createManager({ requestTimeoutMs: 20, maxConcurrency: 1 });
    const sender = new FakeSender();
    const pending = manager.call(sender, "listWorkspaces", {});

    expect(() => manager.call(sender, "listWorkspaces", {})).toThrow(
      expect.objectContaining({ code: "AGENT_BUSY" }),
    );
    await expect(pending).rejects.toMatchObject({
      code: "AGENT_TIMEOUT",
      lifecycle: {
        terminatedBy: "gateway",
        reason: "upstream_timeout",
      },
    });
    expect(sender.cancellation()).toMatchObject({
      type: "cancel",
      reason: "upstream_timeout",
    });
    expect(manager.size).toBe(0);
  });

  test("propagates client disconnection as an explicit relay cancellation", async () => {
    const { manager } = createManager({ requestTimeoutMs: 1_000 });
    const sender = new FakeSender();
    const controller = new AbortController();
    const pending = manager.call(sender, "listWorkspaces", {}, {
      signal: controller.signal,
      deadline: createOperationDeadline(300_000, undefined),
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "OPERATION_CANCELLED",
      lifecycle: {
        terminatedBy: "mcp_server",
        reason: "client_disconnected",
      },
    });
    expect(sender.cancellation()).toMatchObject({
      type: "cancel",
      reason: "client_disconnected",
    });
    expect(manager.size).toBe(0);
  });

  test("rejects invalid results and sender failures", async () => {
    const { manager } = createManager();
    const sender = new FakeSender();
    const invalid = manager.call(sender, "listWorkspaces", {});
    const request = sender.request();

    manager.complete({
      version: 1,
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {},
    } as RelayResponse);
    await expect(invalid).rejects.toMatchObject({ code: "RELAY_PROTOCOL_ERROR" });

    const failedSender = new FakeSender();
    failedSender.sendError = new Error("socket closed");
    await expect(
      manager.call(failedSender, "listWorkspaces", {}),
    ).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });

  test("rejects all requests when the agent disconnects", async () => {
    const { manager } = createManager();
    const sender = new FakeSender();
    const first = manager.call(sender, "listWorkspaces", {});
    const second = manager.call(sender, "listFiles", { workspaceId: "project" });

    manager.rejectAll("AGENT_UNAVAILABLE", "The local agent disconnected.");

    await expect(first).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    await expect(second).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    expect(manager.size).toBe(0);
  });
});

describe("source-control relay request context", () => {
  test("serializes exactly the allowed operation-context fields and never the AbortSignal", async () => {
    const { manager } = createManager({ requestTimeoutMs: 1_000 });
    const sender = new FakeSender();
    const controller = new AbortController();
    const pending = manager.call(
      sender,
      "githubGetRepository",
      { workspaceId: "project", owner: "octo", repository: "repo" },
      {
        correlationId: "corr-1",
        invocationId: "inv-1",
        idempotencyKey: "idem-1",
        ownerScope: "owner-1",
        signal: controller.signal,
        deadline: createOperationDeadline(30_000, undefined),
      },
    );
    const request = sender.request();

    expect(request.context).toEqual({
      correlationId: "corr-1",
      invocationId: "inv-1",
      idempotencyKey: "idem-1",
      ownerScope: "owner-1",
    });
    expect(Object.keys(request.context ?? {}).sort()).toEqual([
      "correlationId",
      "idempotencyKey",
      "invocationId",
      "ownerScope",
    ]);
    expect(JSON.stringify(request.context)).not.toContain("signal");
    expect(JSON.stringify(request.context)).not.toContain("deadline");

    manager.complete({
      version: 1,
      type: "response",
      requestId: request.requestId,
      ok: true,
      result: {
        owner: "octo",
        name: "repo",
        fullName: "octo/repo",
        defaultBranch: "main",
        visibility: "private",
        url: "https://github.com/octo/repo",
      },
    });
    await expect(pending).resolves.toMatchObject({ fullName: "octo/repo" });
  });
});
describe("source-control relay strict input", () => {
  test("rejects rawArgs and credential-like fields before anything is sent", () => {
    const { manager } = createManager();
    const sender = new FakeSender();

    expect(() =>
      manager.call(sender, "githubGetRepository", {
        workspaceId: "project",
        owner: "octo",
        repository: "repo",
        rawArgs: ["unexpected"],
      }),
    ).toThrow(expect.objectContaining({ code: "RELAY_PROTOCOL_ERROR" }));

    expect(() =>
      manager.call(sender, "githubGetRepository", {
        workspaceId: "project",
        owner: "octo",
        repository: "repo",
        githubToken: "redacted-fixture",
      }),
    ).toThrow(expect.objectContaining({ code: "RELAY_PROTOCOL_ERROR" }));

    expect(sender.payloads).toHaveLength(0);
  });
});