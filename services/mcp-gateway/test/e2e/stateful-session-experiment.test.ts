import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Writable } from "node:stream";
import { describe, expect, it } from "@jest/globals";
import pino, { type Logger } from "pino";
import { AgentConnection } from "../../../workspace-agent/src/connection/service.js";
import type { LocalAgent } from "../../../workspace-agent/src/local-agent.js";
import { createGatewayApplication } from "../../src/app.js";
import { listen, makeGatewayConfig, silentLogger, waitFor } from "../support/helpers.js";

const mcpPath = "/mcp-stateful-experiment";
const agentToken = "stateful-experiment-agent-token";

describe("stateful MCP experiment", () => {
  it("creates one session, reuses it across POST/GET and invalidates it on DELETE", async () => {
    const fixture = await createFixture(createFakeAgent({}));
    try {
      const sessionId = await initializeMcp(fixture.url);

      const listed = await postMcp(
        fixture.url,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        },
        { "mcp-session-id": sessionId },
      );
      const listedBody = await listed.json() as {
        result?: { tools?: Array<{ name?: string }> };
      };

      expect(listed.status).toBe(200);
      expect(listedBody.result?.tools).toHaveLength(69);
      expect(listedBody.result?.tools?.map((tool) => tool.name)).toContain(
        "patch_file",
      );

      const streamAbort = new AbortController();
      const stream = await fetch(new URL(mcpPath, fixture.url), {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": sessionId,
          "user-agent": "stateful-experiment-test",
        },
        signal: streamAbort.signal,
      });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      streamAbort.abort();
      await stream.body?.cancel().catch(() => undefined);

      const deleted = await fetch(new URL(mcpPath, fixture.url), {
        method: "DELETE",
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId,
          "user-agent": "stateful-experiment-test",
        },
      });
      expect([200, 204]).toContain(deleted.status);

      const afterDelete = await postMcp(
        fixture.url,
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {},
        },
        { "mcp-session-id": sessionId },
      );
      expect(afterDelete.status).toBe(404);
    } finally {
      await fixture.close();
    }
  });

  it("falls back to stateless requests when the client does not negotiate an MCP session", async () => {
    const fixture = await createFixture(createFakeAgent({}));
    try {
      const listed = await postMcp(fixture.url, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/list",
        params: {},
      });
      const listedBody = await listed.json() as {
        result?: { tools?: Array<{ name?: string }> };
      };

      expect(listed.status).toBe(200);
      expect(listed.headers.get("mcp-session-id")).toBeNull();
      expect(listedBody.result?.tools).toHaveLength(69);

      const called = await postMcp(fixture.url, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: {
          name: "list_workspaces",
          arguments: {},
        },
      });
      const calledBody = await called.json() as {
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };

      expect(called.status).toBe(200);
      expect(called.headers.get("mcp-session-id")).toBeNull();
      expect(calledBody.result?.isError).not.toBe(true);
      expect(calledBody.result?.content?.[0]?.text).toContain("Found 0 workspace(s).");
    } finally {
      await fixture.close();
    }
  });

  it("logs explicit stateless versus stateful transport mode without exposing session ids", async () => {
    const captured = createCapturingLogger();
    const fixture = await createFixture(
      createFakeAgent({}),
      "stateful-experiment",
      {},
      captured.logger,
    );
    try {
      const sessionId = await initializeMcp(fixture.url);
      await toolsList(fixture.url);
      await toolsList(fixture.url, { "mcp-session-id": sessionId });

      await waitFor(
        () =>
          captured.records.filter(
            (entry) => entry.event === "mcp_http_request_completed",
          ).length >= 4,
        2_000,
      );

      const completed = captured.records.filter(
        (entry) => entry.event === "mcp_http_request_completed",
      );

      expect(completed).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mcpTransportMode: "stateful",
            hasMcpSessionId: false,
          }),
          expect.objectContaining({
            mcpTransportMode: "stateful",
            hasMcpSessionId: true,
          }),
          expect.objectContaining({
            mcpTransportMode: "stateless",
            hasMcpSessionId: false,
          }),
        ]),
      );
      expect(
        completed.every(
          (entry) =>
            entry.mcpTransportMode === "stateless" ||
            entry.mcpTransportMode === "stateful",
        ),
      ).toBe(true);
      expect(JSON.stringify(completed)).not.toContain(sessionId);
    } finally {
      await fixture.close();
    }
  });

  it("cancels an active tool call from a second POST in the same session", async () => {
    const operation = createBlockingOperation();
    const fixture = await createFixture(operation.agent);
    try {
      const sessionId = await initializeMcp(fixture.url);
      const headers = { "mcp-session-id": sessionId };

      let earlyResponse: Response | undefined;
      let earlyBody: string | undefined;
      const callPromise = postMcp(
        fixture.url,
        {
          jsonrpc: "2.0",
          id: 41,
          method: "tools/call",
          params: {
            name: "run_command",
            arguments: {
              workspaceId: "workspace",
              shell: "powershell",
              command: "Start-Sleep -Seconds 60",
              timeoutMs: 60_000,
            },
          },
        },
        headers,
      );
      void callPromise.then(async (response) => {
        earlyResponse = response;
        earlyBody = await response.clone().text();
      });

      await waitFor(
        () => operation.signal !== undefined || earlyResponse !== undefined,
        2_000,
      );
      if (operation.signal === undefined) {
        throw new Error(
          `Tool call settled before reaching the Agent: status=${earlyResponse?.status ?? "unknown"} body=${earlyBody ?? "<pending>"}`,
        );
      }

      const cancellation = await withTimeout(
        postMcp(
          fixture.url,
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 41, reason: "stateful experiment cancelled" },
          },
          headers,
        ),
        2_000,
        "Cancellation POST did not settle within 2 seconds.",
      );
      expect(cancellation.status).toBe(202);

      await waitFor(() => operation.signal?.aborted === true, 1_500);
      const response = await withTimeout(
        callPromise,
        1_500,
        "Tool call response did not settle after the Agent signal was aborted.",
      );
      const body = await response.json() as {
        result?: {
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
      };
      expect(response.status).toBe(200);
      expect(body.result?.isError).toBe(true);
      expect(body.result?.content?.[0]?.text).toContain("OPERATION_CANCELLED");
      expect(operation.signal?.aborted).toBe(true);
      expect(operation.signal?.reason).toMatchObject({
        code: "OPERATION_CANCELLED",
        lifecycle: { reason: "cancelled" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("rejects a stateful cancellation notification without a session id", async () => {
    const fixture = await createFixture(createFakeAgent({}));
    try {
      const response = await postMcp(fixture.url, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 99, reason: "missing session" },
      });
      expect(response.status).toBe(400);
    } finally {
      await fixture.close();
    }
  });

  it("expires an abandoned stateful session without requiring DELETE", async () => {
    const fixture = await createFixture(
      createFakeAgent({}),
      "stateful-experiment",
      { ttlMs: 500 },
    );
    try {
      const sessionId = await initializeMcp(fixture.url);
      await new Promise((resolve) => setTimeout(resolve, 650));

      const response = await postMcp(
        fixture.url,
        {
          jsonrpc: "2.0",
          id: 77,
          method: "tools/list",
          params: {},
        },
        { "mcp-session-id": sessionId },
      );
      expect(response.status).toBe(404);
    } finally {
      await fixture.close();
    }
  });

  it("enforces the stateful session cap without evicting an existing session", async () => {
    const fixture = await createFixture(
      createFakeAgent({}),
      "stateful-experiment",
      { maxSessions: 1 },
    );
    try {
      const firstSessionId = await initializeMcp(fixture.url);
      const second = await postMcp(fixture.url, {
        jsonrpc: "2.0",
        id: 88,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "stateful-experiment-test", version: "0.0.0" },
        },
      });
      expect(second.status).toBe(503);

      await toolsList(fixture.url, { "mcp-session-id": firstSessionId });
      await terminateSession(fixture.url, firstSessionId);

      const replacementSessionId = await initializeMcp(fixture.url);
      await terminateSession(fixture.url, replacementSessionId);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the session cap bounded during concurrent initialize requests", async () => {
    const fixture = await createFixture(
      createFakeAgent({}),
      "stateful-experiment",
      { maxSessions: 1 },
    );
    try {
      const initializeRequest = (id: number) =>
        postMcp(fixture.url, {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "stateful-experiment-test", version: "0.0.0" },
          },
        });

      const responses = await Promise.all([
        initializeRequest(91),
        initializeRequest(92),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([
        200,
        503,
      ]);

      const accepted = responses.find((response) => response.status === 200);
      const sessionId = accepted?.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();
      const notification = await postMcp(
        fixture.url,
        {
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {},
        },
        { "mcp-session-id": sessionId! },
      );
      expect(notification.status).toBe(202);
      await terminateSession(fixture.url, sessionId!);
    } finally {
      await fixture.close();
    }
  });
  it("records stateless versus stateful repeated tools/list latency", async () => {
    const stateful = await createFixture(createFakeAgent({}), "stateful-experiment");
    const stateless = await createFixture(createFakeAgent({}), "stateless");
    try {
      const sessionId = await initializeMcp(stateful.url);
      const statefulHeaders = { "mcp-session-id": sessionId };

      for (let index = 0; index < 1; index += 1) {
        await toolsList(stateful.url, statefulHeaders);
        await toolsList(stateless.url);
      }

      const statefulSamples = await measureRepeatedToolsList(
        stateful.url,
        statefulHeaders,
        6,
      );
      const statelessSamples = await measureRepeatedToolsList(
        stateless.url,
        {},
        6,
      );

      const statefulSummary = summarizeLatency(statefulSamples);
      const statelessSummary = summarizeLatency(statelessSamples);

      console.error(
        "STATEFUL_EXPERIMENT_AB " +
          JSON.stringify({
            calls: 6,
            stateful: statefulSummary,
            stateless: statelessSummary,
          }),
      );

      expect(statefulSamples).toHaveLength(6);
      expect(statelessSamples).toHaveLength(6);
      await terminateSession(stateful.url, sessionId);
    } finally {
      await stateful.close();
      await stateless.close();
    }
  });

  it("keeps GET and DELETE disabled in the default stateless mode", async () => {
    const fixture = await createFixture(createFakeAgent({}), "stateless");
    try {
      const get = await fetch(new URL(mcpPath, fixture.url), {
        method: "GET",
        headers: { accept: "text/event-stream" },
      });
      const del = await fetch(new URL(mcpPath, fixture.url), {
        method: "DELETE",
        headers: { accept: "application/json" },
      });
      expect(get.status).toBe(405);
      expect(del.status).toBe(405);
    } finally {
      await fixture.close();
    }
  });
});

async function terminateSession(
  url: URL,
  sessionId: string,
): Promise<void> {
  const response = await fetch(new URL(mcpPath, url), {
    method: "DELETE",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "user-agent": "stateful-experiment-test",
    },
  });
  if (![200, 204].includes(response.status)) {
    throw new Error(
      `DELETE session failed with status ${response.status}: ${await response.text()}`,
    );
  }
}

async function toolsList(
  url: URL,
  headers: Record<string, string> = {},
): Promise<void> {
  const response = await postMcp(
    url,
    {
      jsonrpc: "2.0",
      id: Math.floor(Math.random() * 1_000_000) + 1,
      method: "tools/list",
      params: {},
    },
    headers,
  );
  if (!response.ok) {
    throw new Error(
      `tools/list failed with status ${response.status}: ${await response.text()}`,
    );
  }
  await response.arrayBuffer();
}

async function measureRepeatedToolsList(
  url: URL,
  headers: Record<string, string>,
  calls: number,
): Promise<number[]> {
  const samples: number[] = [];
  for (let index = 0; index < calls; index += 1) {
    const startedAt = performance.now();
    await toolsList(url, headers);
    samples.push(performance.now() - startedAt);
  }
  return samples;
}

function summarizeLatency(samples: number[]): {
  minMs: number;
  medianMs: number;
  averageMs: number;
  maxMs: number;
} {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    minMs: Number(sorted[0]!.toFixed(2)),
    medianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(2)),
    averageMs: Number(
      (samples.reduce((total, sample) => total + sample, 0) / samples.length).toFixed(2),
    ),
    maxMs: Number(sorted[sorted.length - 1]!.toFixed(2)),
  };
}

async function initializeMcp(url: URL): Promise<string> {
  const initialized = await postMcp(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "stateful-experiment-test", version: "0.0.0" },
    },
  });
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();

  const notification = await postMcp(
    url,
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
    { "mcp-session-id": sessionId! },
  );
  expect(notification.status).toBe(202);
  return sessionId!;
}

function createBlockingOperation(): {
  agent: LocalAgent;
  started: Promise<void>;
  signal: AbortSignal | undefined;
} {
  let resolveStarted!: () => void;
  const state: {
    agent: LocalAgent;
    started: Promise<void>;
    signal: AbortSignal | undefined;
  } = {
    started: new Promise<void>((resolve) => {
      resolveStarted = resolve;
    }),
    signal: undefined,
    agent: undefined as unknown as LocalAgent,
  };

  state.agent = createFakeAgent({
    runCommand: async (_input: unknown, context?: { signal?: AbortSignal }) => {
      const signal = context?.signal;
      if (!signal) throw new Error("Expected operation signal.");
      state.signal = signal;
      resolveStarted();
      await waitForAbort(signal);
      throw signal.reason;
    },
  });
  return state;
}

async function createFixture(
  agent: LocalAgent,
  sessionMode: "stateless" | "stateful-experiment" = "stateful-experiment",
  sessionLimits: { ttlMs?: number; maxSessions?: number } = {},
  logger: Logger = silentLogger(),
): Promise<{
  url: URL;
  close(): Promise<void>;
}> {
  const config = makeGatewayConfig({
    authMode: "none",
    mcpSessionMode: sessionMode,
    mcpStatefulSessionTtlMs: sessionLimits.ttlMs ?? 30 * 60_000,
    mcpStatefulMaxSessions: sessionLimits.maxSessions ?? 100,
    mcpPath,
    agent: {
      id: "test-agent",
      tokenSha256: createHash("sha256").update(agentToken).digest("hex"),
      requestTimeoutMs: 120_000,
      heartbeatMs: 1_000,
      maxConcurrency: 4,
      maxPayloadBytes: 2 * 1024 * 1024,
    },
  });
  const gateway = createGatewayApplication(config, { logger });
  const http = await listen(gateway.app);
  http.server.on("upgrade", (request, socket, head) => {
    gateway.relay!.handleUpgrade(request, socket, head);
  });
  const controller = new AbortController();
  const connection = new AgentConnection(agent, {
    gatewayUrl: new URL("/agent", http.url).href.replace("http:", "ws:"),
    agentId: "test-agent",
    token: agentToken,
    heartbeatIntervalMs: 1_000,
    reconnectMinMs: 10,
    reconnectMaxMs: 50,
  });
  const running = connection.run(controller.signal);
  await waitFor(() => gateway.relay!.isConnected, 5_000);

  return {
    url: http.url,
    close: async () => {
      controller.abort();
      await running;
      await gateway.close();
      http.server.closeAllConnections();
      await http.close();
    },
  };
}

function createCapturingLogger(): {
  logger: Logger;
  records: Array<Record<string, unknown>>;
} {
  const records: Array<Record<string, unknown>> = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      const text = chunk.toString("utf8").trim();
      if (text.length > 0) {
        for (const line of text.split(/\r?\n/u)) {
          records.push(JSON.parse(line) as Record<string, unknown>);
        }
      }
      callback();
    },
  });
  return {
    logger: pino({ level: "info" }, destination),
    records,
  };
}

function postMcp(
  url: URL,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(new URL(mcpPath, url), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "user-agent": "stateful-experiment-test",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

function createFakeAgent(overrides: Record<string, unknown>): LocalAgent {
  const defaults = {
    resolveWorkspaceConcurrencyKey: (workspaceId: string) => `fixture:${workspaceId}`,
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
    readBinaryFile: async () => ({
      path: "file.bin",
      contentBase64: "",
      sizeBytes: 0,
    }),
    writeFile: async () => ({ path: "file.txt", sizeBytes: 0, created: false }),
    patchFile: async () => ({
      path: "file.txt",
      sha256Before: "0".repeat(64),
      sha256After: "1".repeat(64),
      encoding: "utf-8",
      lineEnding: "none",
      replacementsApplied: 1,
      sizeBytes: 1,
      changed: true,
      dryRun: false,
    }),
    runCommand: async () => ({
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
    startBackgroundTask: async () => ({
      status: "confirmation_required",
      shell: "powershell",
      cwd: ".",
      confirmationId: "test-confirmation",
      expiresAt: "2099-01-01T00:00:00.000Z",
      reasons: ["test confirmation"],
    }),
    getBackgroundTask: async () => ({ task: null }),
    waitBackgroundTask: async () => ({
      task: null,
      logs: null,
      timedOut: false,
      elapsedMs: 0,
    }),
    listBackgroundTasks: async () => ({ tasks: [] }),
    cancelBackgroundTask: async () => ({ task: null }),
    readBackgroundTaskLogs: async () => ({ logs: null }),
  };
  return { ...defaults, ...overrides } as unknown as LocalAgent;
}
