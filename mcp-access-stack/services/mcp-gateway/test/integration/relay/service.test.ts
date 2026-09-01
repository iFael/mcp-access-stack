import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { AppError, relayOperations, type RelayRequest } from "@vs-code-gpt/shared";
import { afterEach, describe, expect, it } from "@jest/globals";
import WebSocket from "ws";
import { AgentRelay } from "../../../src/relay/service.js";
import { listen, silentLogger, waitFor } from "../../support/helpers.js";

const token = "relay-test-token";
const tokenSha256 = createHash("sha256").update(token).digest("hex");
const closeCallbacks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (closeCallbacks.length > 0) {
    await closeCallbacks.pop()?.();
  }
});

describe("agent relay", () => {
  it("authenticates the agent and relays a validated response", async () => {
    const fixture = await createRelay();
    const agent = await connectAgent(fixture.wsUrl);
    agent.on("message", (data) => {
      const request = JSON.parse(data.toString()) as RelayRequest;
      agent.send(JSON.stringify({
        version: 1,
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: [],
      }));
    });

    await waitFor(() => fixture.relay.isConnected);
    await expect(fixture.relay.call("listWorkspaces", {})).resolves.toEqual([]);
  });

  it("rejects invalid credentials and a duplicate connection", async () => {
    const fixture = await createRelay();

    await expectUpgradeStatus(fixture.wsUrl, "wrong-token", 401);
    await connectAgent(fixture.wsUrl);
    await waitFor(() => fixture.relay.isConnected);
    await expectUpgradeStatus(fixture.wsUrl, token, 409);
  });

  it("rejects an incompatible hello message", async () => {
    const fixture = await createRelay();
    const socket = await openSocket(fixture.wsUrl, token);
    socket.send(JSON.stringify({
      version: 1,
      type: "hello",
      agentId: "test-agent",
      capabilities: ["listWorkspaces"],
    }));

    await expect(
      new Promise<number>((resolve) => socket.once("close", resolve)),
    ).resolves.toBe(1008);
  });

  it("enforces concurrency and discards late responses after timeout", async () => {
    const fixture = await createRelay({ requestTimeoutMs: 50, maxConcurrency: 1 });
    const agent = await connectAgent(fixture.wsUrl);
    let firstRequest: RelayRequest | undefined;
    agent.once("message", (data) => {
      firstRequest = JSON.parse(data.toString()) as RelayRequest;
    });
    await waitFor(() => fixture.relay.isConnected);

    const pending = fixture.relay.call("listWorkspaces", {});
    await waitFor(() => firstRequest !== undefined);
    await expect(fixture.relay.call("listWorkspaces", {})).rejects.toMatchObject({
      code: "AGENT_BUSY",
    });
    await expect(pending).rejects.toMatchObject({ code: "AGENT_TIMEOUT" });

    agent.send(JSON.stringify({
      version: 1,
      type: "response",
      requestId: firstRequest?.requestId,
      ok: true,
      result: [],
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.relay.isConnected).toBe(true);
  });

  it("allows wait_background_task to return its timeout result within completion grace", async () => {
    const fixture = await createRelay({ requestTimeoutMs: 20 });
    const agent = await connectAgent(fixture.wsUrl);
    agent.once("message", (data) => {
      const request = JSON.parse(data.toString()) as RelayRequest;
      setTimeout(() => {
        agent.send(JSON.stringify({
          version: 1,
          type: "response",
          requestId: request.requestId,
          ok: true,
          result: { task: null, logs: null, timedOut: true, elapsedMs: 20 },
        }));
      }, 40);
    });
    await waitFor(() => fixture.relay.isConnected);

    await expect(
      fixture.relay.call("waitBackgroundTask", {
        workspaceId: "project",
        id: "123e4567-e89b-42d3-a456-426614174000",
        timeoutMs: 20,
        maxBytes: 100,
      }),
    ).resolves.toMatchObject({ timedOut: true, elapsedMs: 20 });
  });

  it("closes an agent that stops answering heartbeat pings", async () => {
    const fixture = await createRelay({ heartbeatMs: 20 });
    const socket = await openSocket(fixture.wsUrl, token, { autoPong: false });
    socket.send(JSON.stringify({
      version: 1,
      type: "hello",
      agentId: "test-agent",
      capabilities: [...relayOperations],
    }));
    await waitFor(() => fixture.relay.isConnected);

    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
    expect(fixture.relay.isConnected).toBe(false);
  });

  it("closes a connection that exceeds the payload limit", async () => {
    const maxPayloadBytes = 2_048;
    const fixture = await createRelay({ maxPayloadBytes });
    const agent = await connectAgent(fixture.wsUrl);
    await waitFor(() => fixture.relay.isConnected);

    agent.send("x".repeat(maxPayloadBytes + 1));

    await expect(
      new Promise<number>((resolve) => agent.once("close", resolve)),
    ).resolves.toBe(1009);
  });

  it("rejects an upgrade from a disallowed browser origin", async () => {
    const fixture = await createRelay();

    await expectUpgradeStatus(fixture.wsUrl, token, 403, {
      origin: "https://evil.example",
    });
    expect(fixture.relay.isConnected).toBe(false);
  });

  it("accepts an upgrade from an allowed origin", async () => {
    const fixture = await createRelay({
      allowedOrigins: new Set(["https://chatgpt.com"]),
    });
    const socket = await openSocket(fixture.wsUrl, token, {
      headers: { origin: "https://chatgpt.com" },
    });
    closeCallbacks.push(() => socket.close());

    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});

async function createRelay(
  overrides: Partial<{
    requestTimeoutMs: number;
    maxConcurrency: number;
    heartbeatMs: number;
    maxPayloadBytes: number;
    allowedOrigins: ReadonlySet<string>;
  }> = {},
) {
  const relay = new AgentRelay(
    {
      agentId: "test-agent",
      tokenSha256,
      requestTimeoutMs: overrides.requestTimeoutMs ?? 500,
      heartbeatMs: overrides.heartbeatMs ?? 1_000,
      maxConcurrency: overrides.maxConcurrency ?? 4,
      maxPayloadBytes: overrides.maxPayloadBytes ?? 64_000,
      allowedOrigins: overrides.allowedOrigins ?? new Set<string>(),
    },
    silentLogger(),
  );
  const http = await listen();
  http.server.on("upgrade", (request, socket, head) => {
    relay.handleUpgrade(request, socket, head);
  });
  closeCallbacks.push(async () => {
    relay.close();
    await http.close();
  });
  const address = http.server.address() as AddressInfo;
  return {
    relay,
    wsUrl: `ws://127.0.0.1:${address.port}/agent`,
  };
}

async function connectAgent(url: string): Promise<WebSocket> {
  const socket = await openSocket(url, token);
  socket.send(JSON.stringify({
    version: 1,
    type: "hello",
    agentId: "test-agent",
    capabilities: [...relayOperations],
  }));
  closeCallbacks.push(() => socket.close());
  return socket;
}

function openSocket(
  url: string,
  bearerToken: string,
  options: { autoPong?: boolean; headers?: Record<string, string> } = {},
): Promise<WebSocket> {
  const { headers, ...socketOptions } = options;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      ...socketOptions,
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "x-agent-id": "test-agent",
        ...headers,
      },
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function expectUpgradeStatus(
  url: string,
  bearerToken: string,
  expectedStatus: number,
  headers: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${bearerToken}`,
        "x-agent-id": "test-agent",
        ...headers,
      },
    });
    socket.once("unexpected-response", (_request, response) => {
      try {
        expect(response.statusCode).toBe(expectedStatus);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", (error) => {
      if (!(error instanceof AppError)) {
        return;
      }
      reject(error);
    });
  });
}
