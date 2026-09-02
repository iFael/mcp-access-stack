import { describe, expect, test } from "@jest/globals";
import type { RelayRequest } from "@vs-code-gpt/shared";
import {
  AgentRelayRequestManager,
  type RelayRequestSender,
} from "../../../src/relay/request-manager.js";
import { silentLogger } from "../../support/helpers.js";

class RecordingSender implements RelayRequestSender {
  payloads: string[] = [];
  sendError: Error | undefined;

  send(payload: string, callback: (error?: Error) => void): void {
    this.payloads.push(payload);
    callback(this.sendError);
  }

  request(index = 0): RelayRequest {
    return JSON.parse(this.payloads[index] ?? "null") as RelayRequest;
  }
}

function createManager() {
  let generation = 7;
  const manager = new AgentRelayRequestManager(
    {
      requestTimeoutMs: 1_000,
      maxConcurrency: 2,
      maxPayloadBytes: 64_000,
      generation: () => generation,
    },
    silentLogger(),
  );
  return {
    manager,
    setGeneration: (value: number) => {
      generation = value;
    },
  };
}

describe("agent availability classification", () => {
  test("classifies a send failure for a read-only operation as retryable with unknown outcome", async () => {
    const { manager } = createManager();
    const sender = new RecordingSender();
    sender.sendError = new Error("socket closed");

    await expect(manager.call(sender, "listWorkspaces", {})).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      details: {
        operation: "listWorkspaces",
        reason: "relay_send_failed",
        retryable: true,
        outcome: "unknown",
        connectionGeneration: 7,
      },
    });
  });

  test("classifies the same send failure for a mutating operation as non-retryable", async () => {
    const { manager } = createManager();
    const sender = new RecordingSender();
    sender.sendError = new Error("socket closed");

    await expect(
      manager.call(sender, "writeFile", {
        workspaceId: "project",
        path: "notes.txt",
        content: "updated",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      details: {
        operation: "writeFile",
        reason: "relay_send_failed",
        retryable: false,
        outcome: "unknown",
        connectionGeneration: 7,
      },
    });
  });

  test("rejects only requests that belong to the disconnected generation", async () => {
    const { manager, setGeneration } = createManager();
    const sender = new RecordingSender();

    const first = manager.call(sender, "listWorkspaces", {});
    const firstRequest = sender.request(0);

    setGeneration(8);
    const second = manager.call(sender, "listWorkspaces", {});
    const secondRequest = sender.request(1);

    manager.rejectGeneration(
      7,
      "AGENT_UNAVAILABLE",
      "The local agent disconnected.",
    );

    await expect(first).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      details: {
        operation: "listWorkspaces",
        reason: "agent_disconnected",
        connectionGeneration: 7,
      },
    });
    expect(manager.size).toBe(1);

    manager.complete({
      version: 1,
      type: "response",
      requestId: secondRequest.requestId,
      ok: true,
      result: [],
    });
    await expect(second).resolves.toEqual([]);
    expect(manager.size).toBe(0);

    expect(firstRequest.requestId).not.toBe(secondRequest.requestId);
  });
});
