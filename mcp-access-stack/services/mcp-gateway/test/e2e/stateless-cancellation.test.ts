import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { describe, expect, it } from "@jest/globals";
import { AgentConnection } from "../../../workspace-agent/src/connection/service.js";
import type { LocalAgent } from "../../../workspace-agent/src/local-agent.js";
import { createGatewayApplication } from "../../src/app.js";
import { listen, makeGatewayConfig, silentLogger, waitFor } from "../support/helpers.js";

const mcpPath = "/mcp-stateless-cancellation";
const agentToken = "stateless-cancellation-agent-token";

describe("stateless MCP cancellation", () => {
  it("cancels an active tool call from a separate notification request", async () => {
    const operation = createBlockingOperation();
    const fixture = await createFixture(operation.agent);
    try {
      const callPromise = postMcp(fixture.url, {
        jsonrpc: "2.0",
        id: 41,
        method: "tools/call",
        params: {
          name: "run_command",
          arguments: {
            workspaceId: "workspace",
            shell: "powershell",
            command: "Start-Sleep -Seconds 120",
            timeoutMs: 120_000,
          },
        },
      });
      await operation.started;

      const cancellation = await postMcp(fixture.url, {
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: 41, reason: "user cancelled" },
      });
      expect(cancellation.status).toBe(202);

      const response = await callPromise;
      const body = await response.json() as {
        result: {
          isError?: boolean;
          content?: Array<{ text?: string }>;
        };
      };

      expect(response.status).toBe(200);
      expect(body.result.isError).toBe(true);
      expect(body.result.content?.[0]?.text).toContain("OPERATION_CANCELLED");
      expect(operation.signal?.aborted).toBe(true);
      expect(operation.signal?.reason).toMatchObject({
        code: "OPERATION_CANCELLED",
        lifecycle: { reason: "cancelled" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("cancels the relay operation when the HTTP client disconnects", async () => {
    const operation = createBlockingOperation();
    const fixture = await createFixture(operation.agent);
    try {
      const client = httpRequest(new URL(mcpPath, fixture.url), {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "user-agent": "stateless-cancellation-test",
        },
      });
      client.on("error", () => undefined);
      client.end(JSON.stringify({
        jsonrpc: "2.0",
        id: 52,
        method: "tools/call",
        params: {
          name: "run_command",
          arguments: {
            workspaceId: "workspace",
            shell: "powershell",
            command: "Start-Sleep -Seconds 120",
            timeoutMs: 120_000,
          },
        },
      }));

      await operation.started;
      client.destroy();
      await waitFor(() => operation.signal?.aborted === true, 5_000);

      expect(operation.signal?.reason).toMatchObject({
        code: "OPERATION_CANCELLED",
        lifecycle: { reason: "client_disconnected" },
      });
    } finally {
      await fixture.close();
    }
  });

  it("releases the MCP request id after confirmation_required before a confirmed retry", async () => {
    const confirmationId = "confirmation-retry-test";
    let calls = 0;
    const agent = createFakeAgent({
      runCommand: async (input: unknown) => {
        calls += 1;
        const confirmation = (input as { confirmationId?: string }).confirmationId;
        if (confirmation === undefined) {
          return {
            status: "confirmation_required",
            shell: "powershell",
            cwd: ".",
            confirmationId,
            expiresAt: "2099-01-01T00:00:00.000Z",
            reasons: ["test confirmation"],
          };
        }
        expect(confirmation).toBe(confirmationId);
        return {
          status: "executed",
          shell: "powershell",
          cwd: ".",
          exitCode: 0,
          stdout: "confirmed-ok",
          stderr: "",
          timedOut: false,
        };
      },
    });
    const fixture = await createFixture(agent);
    try {
      const first = await postMcp(fixture.url, {
        jsonrpc: "2.0",
        id: 63,
        method: "tools/call",
        params: {
          name: "run_command",
          arguments: {
            workspaceId: "workspace",
            shell: "powershell",
            command: "Write-Output confirmed",
            timeoutMs: 30_000,
          },
        },
      });
      const firstBody = await first.json() as {
        result: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(first.status).toBe(200);
      expect(firstBody.result.isError).not.toBe(true);
      expect(firstBody.result.content?.[0]?.text).toContain("confirmation_required");

      const second = await postMcp(fixture.url, {
        jsonrpc: "2.0",
        id: 63,
        method: "tools/call",
        params: {
          name: "run_command",
          arguments: {
            workspaceId: "workspace",
            shell: "powershell",
            command: "Write-Output confirmed",
            timeoutMs: 30_000,
            confirmationId,
          },
        },
      });
      const secondBody = await second.json() as {
        result: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      expect(second.status).toBe(200);
      expect(secondBody.result.isError).not.toBe(true);
      expect(secondBody.result.content?.[0]?.text).toContain("exit=0");
      expect(calls).toBe(2);
    } finally {
      await fixture.close();
    }
  });
});

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

async function createFixture(agent: LocalAgent): Promise<{
  url: URL;
  close(): Promise<void>;
}> {
  const config = makeGatewayConfig({
    authMode: "none",
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
  const gateway = createGatewayApplication(config, { logger: silentLogger() });
  const http = await listen(gateway.app);
  http.server.on("upgrade", (request, socket, head) => {
    gateway.relay.handleUpgrade(request, socket, head);
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
  await waitFor(() => gateway.relay.isConnected, 5_000);

  return {
    url: http.url,
    close: async () => {
      controller.abort();
      await running;
      gateway.relay.close();
      await http.close();
    },
  };
}

function postMcp(url: URL, body: unknown): Promise<Response> {
  return fetch(new URL(mcpPath, url), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "user-agent": "stateless-cancellation-test",
    },
    body: JSON.stringify(body),
  });
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
    startBackgroundTask: async () => ({ task: null }),
    getBackgroundTask: async () => ({ task: null }),
    listBackgroundTasks: async () => ({ tasks: [] }),
    cancelBackgroundTask: async () => ({ task: null }),
    readBackgroundTaskLogs: async () => ({ logs: null }),
  };
  return { ...defaults, ...overrides } as unknown as LocalAgent;
}
