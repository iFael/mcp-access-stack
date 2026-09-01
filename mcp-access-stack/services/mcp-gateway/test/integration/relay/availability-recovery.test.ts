import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { RelayRequest } from "@vs-code-gpt/shared";
import { afterEach, describe, expect, it } from "@jest/globals";
import WebSocket from "ws";
import { AgentRelay } from "../../../src/relay/service.js";
import { listen, silentLogger, waitFor } from "../../support/helpers.js";

const token = "relay-recovery-test-token";
const tokenSha256 = createHash("sha256").update(token).digest("hex");
const closeCallbacks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (closeCallbacks.length > 0) {
    await closeCallbacks.pop()?.();
  }
});

describe("agent relay availability recovery", () => {
  it("waits for the first ready generation for a retryable read-only call", async () => {
    const fixture = await createRelay();
    const pending = fixture.relay.call("listWorkspaces", {});

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

    await expect(pending).resolves.toEqual([]);
  });

  it("retries a read-only request once after an in-flight disconnect on a new generation", async () => {
    const fixture = await createRelay();
    const firstAgent = await connectAgent(fixture.wsUrl);
    await waitFor(() => fixture.relay.isConnected);

    let firstRequestId: string | undefined;
    firstAgent.once("message", (data) => {
      const request = JSON.parse(data.toString()) as RelayRequest;
      firstRequestId = request.requestId;
      firstAgent.close(1012, "transient disconnect");
    });

    const pending = fixture.relay.call("listWorkspaces", {});
    await waitFor(() => firstRequestId !== undefined);
    await waitFor(() => !fixture.relay.isConnected);

    const secondAgent = await connectAgent(fixture.wsUrl);
    let secondRequestId: string | undefined;
    secondAgent.once("message", (data) => {
      const request = JSON.parse(data.toString()) as RelayRequest;
      secondRequestId = request.requestId;
      secondAgent.send(JSON.stringify({
        version: 1,
        type: "response",
        requestId: request.requestId,
        ok: true,
        result: [],
      }));
    });

    await expect(pending).resolves.toEqual([]);
    expect(secondRequestId).toBeDefined();
    expect(secondRequestId).not.toBe(firstRequestId);
  });

  it("never retries a mutating request after an in-flight disconnect", async () => {
    const fixture = await createRelay();
    const firstAgent = await connectAgent(fixture.wsUrl);
    await waitFor(() => fixture.relay.isConnected);

    firstAgent.once("message", () => {
      firstAgent.close(1012, "transient disconnect");
    });

    const pending = fixture.relay.call("writeFile", {
      workspaceId: "project",
      path: "notes.txt",
      content: "updated",
    });

    await expect(pending).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      details: {
        operation: "writeFile",
        reason: "agent_disconnected",
        retryable: false,
        outcome: "unknown",
      },
    });

    await waitFor(() => !fixture.relay.isConnected);
    const secondAgent = await connectAgent(fixture.wsUrl);
    let retried = false;
    secondAgent.on("message", () => {
      retried = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(retried).toBe(false);
  });
});

async function createRelay() {
  const relay = new AgentRelay(
    {
      agentId: "test-agent",
      tokenSha256,
      requestTimeoutMs: 1_000,
      heartbeatMs: 1_000,
      maxConcurrency: 4,
      maxPayloadBytes: 64_000,
      allowedOrigins: new Set<string>(),
      reconnectGraceMs: 300,
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
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const candidate = new WebSocket(url, {
      headers: {
        authorization: `Bearer ${token}`,
        "x-agent-id": "test-agent",
      },
    });
    candidate.once("open", () => resolve(candidate));
    candidate.once("error", reject);
  });
  socket.send(JSON.stringify({
    version: 1,
    type: "hello",
    agentId: "test-agent",
    capabilities: [
      "listWorkspaces",
      "listWorkspaceRoots",
      "listFiles",
      "readFile",
      "readBinaryFile",
      "writeFile",
      "patchFile",
      "runValidation",
      "runCommand",
      "runPowerShell",
      "searchFiles",
      "inspectGit",
      "getWorkspaceContext",
      "startBackgroundTask",
      "getBackgroundTask",
      "waitBackgroundTask",
      "listBackgroundTasks",
      "cancelBackgroundTask",
      "readBackgroundTaskLogs",
    ],
  }));
  closeCallbacks.push(() => socket.close());
  return socket;
}
