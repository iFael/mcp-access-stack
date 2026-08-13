import { afterEach, describe, expect, it } from "@jest/globals";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CommandInvocationResponse } from "@vs-code-gpt/shared";
import { CommandInvocationRegistry } from "../../../src/shell/qualified/invocation-registry.js";

const fingerprint = "c".repeat(64);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "command-invocation-registry-integration-"),
  );
  directories.push(directory);
  return directory;
}

function identity(invocationId: string) {
  return {
    workspaceId: "project",
    invocationId,
    planFingerprint: fingerprint,
  };
}

function executedResponse(): CommandInvocationResponse {
  return {
    kind: "result",
    sanitized: true,
    value: {
      status: "executed",
      shell: "pwsh",
      cwd: ".",
      exitCode: 0,
      stdout: "persisted",
      stderr: "",
      timedOut: false,
      executionMode: "qualified",
    },
  };
}

async function advanceToExecuting(
  registry: CommandInvocationRegistry,
  invocationId: string,
): Promise<void> {
  const current = identity(invocationId);
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
}

describe("CommandInvocationRegistry recovery", () => {
  it("replays a durable completed result after a fresh registry instance", async () => {
    const directory = await stateDirectory();
    const first = new CommandInvocationRegistry({ stateDirectory: directory });
    const current = identity("durable-completed");
    await advanceToExecuting(first, current.invocationId);
    await first.transition({
      ...current,
      expectedState: "executing",
      nextState: "completed",
      response: executedResponse(),
    });

    const restored = new CommandInvocationRegistry({ stateDirectory: directory });
    const retry = await restored.acquire(current);

    expect(retry.status).toBe("replay");
    if (retry.status === "replay") {
      expect(retry.response).toEqual(executedResponse());
      expect(retry.record.state).toBe("completed");
    }
    const files = await readdir(directory);
    expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(1);
    expect(files.filter((name) => name.endsWith(".tmp"))).toHaveLength(0);
  });

  it("converts a recovered executing record to outcome_unknown exactly once", async () => {
    const directory = await stateDirectory();
    const first = new CommandInvocationRegistry({ stateDirectory: directory });
    const current = identity("crashed-execution");
    await advanceToExecuting(first, current.invocationId);

    const recovered = new CommandInvocationRegistry({ stateDirectory: directory });
    const retry = await recovered.acquire(current);

    expect(retry.status).toBe("replay");
    if (retry.status === "replay") {
      expect(retry.record).toMatchObject({
        state: "outcome_unknown",
        sequence: 3,
        recovery: {
          code: "EXECUTION_OUTCOME_UNKNOWN",
          priorState: "executing",
        },
      });
      expect(retry.response).toMatchObject({
        kind: "error",
        sanitized: true,
        value: { code: "EXECUTION_OUTCOME_UNKNOWN" },
      });
    }
    expect(await recovered.snapshot()).toMatchObject({
      entries: 1,
      outcomeUnknown: 1,
      recoveries: 1,
    });

    const restartedAgain = new CommandInvocationRegistry({
      stateDirectory: directory,
    });
    const stableRetry = await restartedAgain.acquire(current);
    expect(stableRetry.record).toMatchObject({
      state: "outcome_unknown",
      sequence: 3,
    });
    expect(await restartedAgain.snapshot()).toMatchObject({
      outcomeUnknown: 1,
      recoveries: 0,
    });
  });

  it("quarantines invalid state and removes orphan transaction files", async () => {
    const directory = await stateDirectory();
    const quarantine = path.join(directory, "quarantine");
    await mkdir(quarantine, { recursive: true });
    const recordName = `${"d".repeat(64)}.json`;
    const tempName = `${"e".repeat(64)}.json.${randomUUID()}.tmp`;
    await writeFile(path.join(directory, recordName), "{invalid-json", "utf8");
    await writeFile(path.join(directory, tempName), "partial", "utf8");

    const registry = new CommandInvocationRegistry({ stateDirectory: directory });
    expect(await registry.snapshot()).toMatchObject({ entries: 0 });

    const rootEntries = await readdir(directory);
    expect(rootEntries).not.toContain(recordName);
    expect(rootEntries).not.toContain(tempName);
    const quarantined = await readdir(quarantine);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toContain(recordName);
    expect(await readFile(path.join(quarantine, quarantined[0]!), "utf8")).toBe(
      "{invalid-json",
    );
  });
});
