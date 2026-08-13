import { afterEach, describe, expect, it } from "@jest/globals";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandInvocationResponse } from "@vs-code-gpt/shared";
import {
  CommandInvocationRegistry,
  commandInvocationIdempotencyKey,
} from "../../../src/shell/qualified/invocation-registry.js";

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function identity(invocationId: string, planFingerprint = fingerprintA) {
  return {
    workspaceId: "project",
    invocationId,
    planFingerprint,
  };
}

function executedResponse(stdout = "ok"): CommandInvocationResponse {
  return {
    kind: "result",
    sanitized: true,
    value: {
      status: "executed",
      shell: "pwsh",
      cwd: ".",
      exitCode: 0,
      stdout,
      stderr: "",
      timedOut: false,
      executionMode: "qualified",
    },
  };
}

function confirmationResponse(): CommandInvocationResponse {
  return {
    kind: "result",
    sanitized: true,
    value: {
      status: "confirmation_required",
      shell: "pwsh",
      cwd: ".",
      confirmationId: "confirmation-1",
      expiresAt: "2026-08-04T22:00:00.000Z",
      reasons: ["local mutation"],
      executionMode: "qualified",
    },
  };
}

function blockedResponse(): CommandInvocationResponse {
  return {
    kind: "error",
    sanitized: true,
    value: {
      code: "PERMISSION_DENIED",
      message: "Command invocation was blocked by policy.",
    },
  };
}

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "command-invocation-registry-unit-"),
  );
  directories.push(directory);
  return directory;
}

describe("CommandInvocationRegistry", () => {
  it("deduplicates concurrent external retries before any execution starts", async () => {
    const registry = new CommandInvocationRegistry({
      stateDirectory: await stateDirectory(),
    });

    const [first, retry] = await Promise.all([
      registry.acquire(identity("invocation-1")),
      registry.acquire(identity("invocation-1")),
    ]);

    expect(new Set([first.status, retry.status])).toEqual(
      new Set(["created", "active"]),
    );
    expect(first.record.idempotencyKey).toBe(retry.record.idempotencyKey);
    expect(await registry.snapshot()).toMatchObject({
      entries: 1,
      active: 1,
      hits: 1,
      misses: 1,
      conflicts: 0,
    });
  });

  it("rejects a reused invocation ID with a divergent plan fingerprint", async () => {
    const registry = new CommandInvocationRegistry({
      stateDirectory: await stateDirectory(),
    });
    await registry.acquire(identity("invocation-conflict", fingerprintA));

    await expect(
      registry.acquire(identity("invocation-conflict", fingerprintB)),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
    expect(await registry.snapshot()).toMatchObject({
      entries: 1,
      conflicts: 1,
      misses: 1,
    });
  });

  it("enforces the state machine and replays one stored completed result", async () => {
    const registry = new CommandInvocationRegistry({
      stateDirectory: await stateDirectory(),
    });
    const current = identity("invocation-completed");
    await registry.acquire(current);
    await registry.transition({
      ...current,
      expectedState: "received",
      nextState: "qualified",
    });
    await registry.transition({
      ...current,
      expectedState: "qualified",
      nextState: "executing",
    });
    const completed = await registry.transition({
      ...current,
      expectedState: "executing",
      nextState: "completed",
      response: executedResponse("stored"),
    });

    expect(completed.state).toBe("completed");
    expect(completed.sequence).toBe(3);
    const retry = await registry.acquire(current);
    expect(retry.status).toBe("replay");
    if (retry.status === "replay") {
      expect(retry.response).toEqual(executedResponse("stored"));
    }
    await expect(
      registry.transition({
        ...current,
        expectedState: "completed",
        nextState: "executing",
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
  });

  it("replays awaiting confirmation and removes that response before execution", async () => {
    const registry = new CommandInvocationRegistry({
      stateDirectory: await stateDirectory(),
    });
    const current = identity("invocation-confirmation");
    await registry.acquire(current);
    await registry.transition({
      ...current,
      expectedState: "received",
      nextState: "qualified",
    });
    await registry.transition({
      ...current,
      expectedState: "qualified",
      nextState: "awaiting_confirmation",
      response: confirmationResponse(),
    });

    const retry = await registry.acquire(current);
    expect(retry.status).toBe("replay");
    const executing = await registry.transition({
      ...current,
      expectedState: "awaiting_confirmation",
      nextState: "executing",
    });
    expect(executing.response).toBeUndefined();
    expect(executing.expiresAt).toBeUndefined();
  });

  it("expires terminal records but never expires an active invocation", async () => {
    let now = new Date("2026-08-04T21:00:00.000Z");
    const registry = new CommandInvocationRegistry({
      stateDirectory: await stateDirectory(),
      ttlMs: 100,
      now: () => new Date(now),
    });
    await registry.acquire(identity("active"));
    const terminal = identity("terminal");
    await registry.acquire(terminal);
    await registry.transition({
      ...terminal,
      expectedState: "received",
      nextState: "blocked",
      response: blockedResponse(),
    });

    now = new Date(now.getTime() + 101);

    expect(await registry.snapshot()).toMatchObject({
      entries: 1,
      active: 1,
      expirations: 1,
    });
    expect(await registry.get("active")).toMatchObject({ state: "received" });
    expect(await registry.get("terminal")).toBeNull();
  });

  it("evicts the oldest terminal record but refuses to evict active invocations", async () => {
    const directory = await stateDirectory();
    const registry = new CommandInvocationRegistry({
      stateDirectory: directory,
      maxEntries: 2,
    });
    await registry.acquire(identity("active-1"));
    const terminal = identity("terminal-1");
    await registry.acquire(terminal);
    await registry.transition({
      ...terminal,
      expectedState: "received",
      nextState: "blocked",
      response: blockedResponse(),
    });

    await expect(registry.acquire(identity("active-2"))).resolves.toMatchObject({
      status: "created",
    });
    expect(await registry.get("terminal-1")).toBeNull();
    expect(await registry.snapshot()).toMatchObject({
      entries: 2,
      active: 2,
      evictions: 1,
    });

    const activeOnly = new CommandInvocationRegistry({
      stateDirectory: await stateDirectory(),
      maxEntries: 1,
    });
    await activeOnly.acquire(identity("only-active"));
    await expect(
      activeOnly.acquire(identity("cannot-fit")),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("derives a stable idempotency key from invocation ID and fingerprint", () => {
    expect(
      commandInvocationIdempotencyKey("invocation-1", fingerprintA),
    ).toBe(commandInvocationIdempotencyKey("invocation-1", fingerprintA));
    expect(
      commandInvocationIdempotencyKey("invocation-1", fingerprintA),
    ).not.toBe(commandInvocationIdempotencyKey("invocation-1", fingerprintB));
    expect(
      commandInvocationIdempotencyKey("invocation-1", fingerprintA),
    ).not.toBe(commandInvocationIdempotencyKey("invocation-2", fingerprintA));
  });
});
