import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { RelayRequest, RelayResponse } from "@vs-code-gpt/shared";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { AgentConnection, type AgentConnectionLog } from "../../src/connection/service.js";
import type { LocalAgent } from "../../src/local-agent.js";

type BufferedSocket = WebSocket & {
  messageQueue?: RawData[];
  messageWaiters?: Array<(data: RawData) => void>;
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("AgentConnection", () => {
  it("executes a relay request and emits correlated lifecycle diagnostics", async () => {
    const fixture = await createGatewayFixture();
    const logs: AgentConnectionLog[] = [];
    const listWorkspaces = jest.fn(async () => []);
    const connection = new AgentConnection(
      createFakeAgent({ listWorkspaces }),
      createOptions(fixture.url, logs),
    );
    const controller = new AbortController();
    const running = connection.run(controller.signal);

    const socket = await fixture.nextConnection();
    const hello = await nextJsonMessage(socket);
    expect(hello).toMatchObject({ type: "hello", agentId: "test-agent" });

    socket.send(JSON.stringify(createRequest("listWorkspaces", {})));
    const response = await nextJsonMessage(socket) as RelayResponse;
    expect(response).toMatchObject({ ok: true, result: [] });
    expect(listWorkspaces).toHaveBeenCalledTimes(1);

    await waitFor(() => logs.some((entry) => entry.event === "agent_request_completed"));
    const completed = logs.find((entry) => entry.event === "agent_request_completed");
    expect(completed).toMatchObject({
      operation: "listWorkspaces",
      status: "success",
      generation: 1,
    });
    expect(completed?.rssBytes).toBeGreaterThan(0);

    controller.abort();
    await running;
  });

  it("aborts an in-flight operation when its relay deadline expires", async () => {
    const fixture = await createGatewayFixture();
    let receivedSignal: AbortSignal | undefined;
    const searchFiles = jest.fn<LocalAgent["searchFiles"]>(async (_input, context) => {
      const signal = context?.signal;
      if (!signal) throw new Error("Expected relay operation signal.");
      receivedSignal = signal;
      await waitForAbort(signal);
      throw signal.reason ?? new Error("aborted");
    });
    const connection = new AgentConnection(
      createFakeAgent({ searchFiles }),
      createOptions(fixture.url, []),
    );
    const controller = new AbortController();
    const running = connection.run(controller.signal);

    const socket = await fixture.nextConnection();
    await nextJsonMessage(socket);
    socket.send(JSON.stringify(createRequest(
      "searchFiles",
      {
        workspaceId: "workspace",
        query: "needle",
        caseSensitive: false,
      },
      40,
    )));

    const response = await nextJsonMessage(socket) as RelayResponse;
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe("AGENT_TIMEOUT");
    }
    expect(receivedSignal?.aborted).toBe(true);

    controller.abort();
    await running;
  });

  it("aborts active operations and reconnects after an abnormal socket close", async () => {
    const fixture = await createGatewayFixture();
    const logs: AgentConnectionLog[] = [];
    let requestAborted = false;
    const searchFiles = jest.fn<LocalAgent["searchFiles"]>(async (_input, context) => {
      const signal = context?.signal;
      if (!signal) throw new Error("Expected relay operation signal.");
      await waitForAbort(signal);
      requestAborted = true;
      throw signal.reason ?? new Error("disconnected");
    });
    const connection = new AgentConnection(
      createFakeAgent({ searchFiles }),
      createOptions(fixture.url, logs),
    );
    const controller = new AbortController();
    const running = connection.run(controller.signal);

    const firstSocket = await fixture.nextConnection();
    await nextJsonMessage(firstSocket);
    firstSocket.send(JSON.stringify(createRequest(
      "searchFiles",
      {
        workspaceId: "workspace",
        query: "needle",
        caseSensitive: false,
      },
      5_000,
    )));
    await waitFor(() => searchFiles.mock.calls.length === 1);
    firstSocket.terminate();

    await waitFor(() => requestAborted);
    const secondSocket = await fixture.nextConnection();
    await nextJsonMessage(secondSocket);
    await waitFor(() => logs.some((entry) => entry.event === "connected" && entry.generation === 2));

    expect(logs.some((entry) =>
      entry.event === "disconnected" &&
      entry.generation === 1 &&
      entry.code === 1006
    )).toBe(true);

    controller.abort();
    await running;
  });

  it("keeps a standalone agent process alive while waiting to reconnect", async () => {
    const fixture = await createGatewayFixture();
    const child = spawn(process.execPath, [
      "--input-type=module",
      "--eval",
      standaloneAgentProcessScript(),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GATEWAY_URL: fixture.url,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let childStderr = "";
    child.stderr.on("data", (data) => {
      childStderr += data.toString("utf8");
    });
    cleanups.push(() => {
      if (child.exitCode === null && !child.killed) {
        child.kill();
      }
    });

    const firstSocket = await Promise.race([
      fixture.nextConnection(),
      failWhenChildExits(child, () => childStderr),
      rejectAfter(10_000, "Standalone agent did not open the first connection."),
    ]);
    await nextJsonMessage(firstSocket);
    firstSocket.terminate();

    const secondSocket = await Promise.race([
      fixture.nextConnection(),
      failWhenChildExits(child, () => childStderr),
      rejectAfter(10_000, "Standalone agent did not reconnect before the deadline."),
    ]);
    await nextJsonMessage(secondSocket);
    expect(child.exitCode).toBeNull();
  });
});

function createOptions(url: string, logs: AgentConnectionLog[]) {
  return {
    gatewayUrl: url,
    agentId: "test-agent",
    token: "test-token",
    heartbeatIntervalMs: 1_000,
    reconnectMinMs: 5,
    reconnectMaxMs: 20,
    log: (entry: AgentConnectionLog) => logs.push(entry),
  };
}

function createFakeAgent(overrides: Record<string, unknown>): LocalAgent {
  const defaults = {
    listWorkspaces: async () => [],
    listFiles: async () => ({ files: [], truncated: false }),
    readFile: async () => ({
      path: "file.txt",
      content: "",
      startLine: 1,
      endLine: 0,
      totalLines: 0,
      sizeBytes: 0,
    }),
    writeFile: async () => ({ path: "file.txt", bytesWritten: 0, created: false }),
    runCommand: async () => ({
      status: "executed",
      shell: "powershell",
      cwd: ".",
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }),
    runPowerShell: async () => ({
      status: "executed",
      shell: "powershell",
      cwd: ".",
      exitCode: 0,
      stdout: "",
      stderr: "",
      timedOut: false,
    }),
    searchFiles: async () => ({ matches: [], truncated: false, skippedFiles: 0 }),
    inspectGit: async () => ({ status: [], staged: "", unstaged: "", truncated: false }),
    getWorkspaceContext: async () => ({
      workspaceId: "workspace",
      rootPath: ".",
      instructionFiles: [],
      availableInstructionFiles: [],
      skills: [],
      git: { isGitRepository: false },
    }),
  };
  return { ...defaults, ...overrides } as unknown as LocalAgent;
}

function createRequest(
  operation: RelayRequest["operation"],
  input: unknown,
  deadlineInMs = 2_000,
): RelayRequest {
  return {
    version: 1,
    type: "request",
    requestId: randomUUID(),
    deadline: {
      requestedTimeoutMs: deadlineInMs,
      effectiveTimeoutMs: deadlineInMs,
      deadlineAt: new Date(Date.now() + deadlineInMs).toISOString(),
    },
    operation,
    input: input as never,
  };
}

async function createGatewayFixture(): Promise<{
  url: string;
  nextConnection: () => Promise<WebSocket>;
}> {
  const server = createServer();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const queued: WebSocket[] = [];
  const waiters: Array<(socket: WebSocket) => void> = [];

  webSocketServer.on("connection", (socket: BufferedSocket) => {
    socket.messageQueue = [];
    socket.messageWaiters = [];
    socket.on("message", (data) => {
      const messageWaiter = socket.messageWaiters?.shift();
      if (messageWaiter) messageWaiter(data);
      else socket.messageQueue?.push(data);
    });
    const waiter = waiters.shift();
    if (waiter) waiter(socket);
    else queued.push(socket);
  });
  server.on("upgrade", (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });
  await listen(server);
  const address = server.address() as AddressInfo;
  cleanups.push(async () => {
    for (const socket of webSocketServer.clients) socket.terminate();
    await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    url: `ws://127.0.0.1:${address.port}/agent`,
    nextConnection: () => {
      const socket = queued.shift();
      if (socket) return Promise.resolve(socket);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function nextJsonMessage(socket: WebSocket): Promise<unknown> {
  const buffered = socket as BufferedSocket;
  const queued = buffered.messageQueue?.shift();
  if (queued) {
    return parseJsonMessage(queued);
  }
  return new Promise((resolve, reject) => {
    const onClose = () => {
      reject(new Error("Socket closed before a message arrived."));
    };
    socket.once("close", onClose);
    buffered.messageWaiters?.push((data) => {
      socket.off("close", onClose);
      void parseJsonMessage(data).then(resolve, reject);
    });
  });
}

function parseJsonMessage(data: RawData): Promise<unknown> {
  try {
    return Promise.resolve(JSON.parse(data.toString("utf8")));
  } catch (error) {
    return Promise.reject(error);
  }
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return Promise.reject(new Error("Missing AbortSignal."));
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Condition was not met before timeout.");
}

function standaloneAgentProcessScript(): string {
  return `
    import { AgentConnection } from "./services/workspace-agent/dist/connection/service.js";

    const agent = {
      listWorkspaces: async () => [],
      listFiles: async () => ({ files: [], truncated: false }),
      readFile: async () => ({ path: "file.txt", content: "", startLine: 1, endLine: 0, totalLines: 0, sizeBytes: 0 }),
      writeFile: async () => ({ path: "file.txt", bytesWritten: 0, created: false }),
      runCommand: async () => ({ status: "executed", shell: "powershell", cwd: ".", exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      runPowerShell: async () => ({ status: "executed", shell: "powershell", cwd: ".", exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      searchFiles: async () => ({ matches: [], truncated: false, skippedFiles: 0 }),
      inspectGit: async () => ({ status: [], staged: "", unstaged: "", truncated: false }),
      getWorkspaceContext: async () => ({ workspaceId: "workspace", rootPath: ".", instructionFiles: [], availableInstructionFiles: [], skills: [], git: { isGitRepository: false } }),
    };

    const connection = new AgentConnection(agent, {
      gatewayUrl: process.env.GATEWAY_URL,
      agentId: "standalone-reconnect-test-agent",
      token: "test-token",
      reconnectMinMs: 100,
      reconnectMaxMs: 100,
      heartbeatIntervalMs: 1_000,
      log: (entry) => console.error(JSON.stringify({ event: entry.event, generation: entry.generation, code: entry.code ?? null })),
    });

    await connection.run();
  `;
}

function failWhenChildExits(
  child: ChildProcess,
  readStderr: () => string,
): Promise<never> {
  return new Promise((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(new Error(
        `Standalone agent exited before reconnecting. code=${code ?? "null"} signal=${signal ?? "null"}
${readStderr()}`,
      ));
    });
  });
}

function rejectAfter(timeoutMs: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref();
  });
}
