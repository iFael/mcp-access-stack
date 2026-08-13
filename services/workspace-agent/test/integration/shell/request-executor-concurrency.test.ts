import { afterEach, describe, expect, test, jest } from "@jest/globals";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { RelayRequest } from "@vs-code-gpt/shared";
import { AgentRequestExecutor } from "../../../src/connection/request-executor.js";
import { LocalAgent } from "../../../src/local-agent.js";
import {
  createFixture,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
} from "../../support/helpers.js";

jest.setTimeout(20_000);

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("real synchronous shell concurrency", () => {
  test("runs independent workspace shells concurrently through one AgentRequestExecutor", async () => {
    fixture = await createFixture({
      profile: "full-repo-write",
      allowedRoots: ["."],
    });
    const secondWorkspacePath = path.join(fixture.basePath, "workspace-b");
    await mkdir(secondWorkspacePath, { recursive: true });
    await writePolicy(fixture.policyPath, [
      writableShellWorkspace("workspace-a", fixture.workspacePath),
      writableShellWorkspace("workspace-b", secondWorkspacePath),
    ]);

    const agent = await LocalAgent.create(fixture.policyPath);
    const executor = new AgentRequestExecutor(agent, undefined, {
      maxConcurrentSynchronousShells: 2,
    });

    const first = executor.execute(
      shellRequest("real-shell-a", "workspace-a", "A"),
      1,
    );
    await delay(150);
    const second = executor.execute(
      shellRequest("real-shell-b", "workspace-b", "B"),
      1,
    );
    await delay(200);

    expect(executor.activeRequestCount).toBe(2);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({
      ok: true,
      result: {
        status: "executed",
        exitCode: 0,
        stdout: expect.stringContaining("parallel-A"),
      },
    });
    expect(secondResult).toMatchObject({
      ok: true,
      result: {
        status: "executed",
        exitCode: 0,
        stdout: expect.stringContaining("parallel-B"),
      },
    });
    expect(executor.activeRequestCount).toBe(0);
  });

  test("holds a workspace lease through timeout teardown and releases it after settlement", async () => {
    fixture = await createFixture({
      profile: "full-repo-write",
      allowedRoots: ["."],
    });
    await writePolicy(fixture.policyPath, [
      writableShellWorkspace("workspace-a", fixture.workspacePath),
    ]);

    const agent = await LocalAgent.create(fixture.policyPath);
    const executor = new AgentRequestExecutor(agent, undefined, {
      maxConcurrentSynchronousShells: 1,
    });

    const timedOut = executor.execute(
      shellCommandRequest(
        "real-shell-timeout",
        "workspace-a",
        "Start-Sleep -Seconds 10",
        300,
      ),
      1,
    );
    await delay(100);

    const busy = await executor.execute(
      shellCommandRequest(
        "real-shell-busy",
        "workspace-a",
        "Write-Output 'must-not-run'",
        5_000,
      ),
      1,
    );
    expect(busy).toMatchObject({
      ok: false,
      error: { code: "AGENT_BUSY" },
    });

    await expect(timedOut).resolves.toMatchObject({
      ok: true,
      result: {
        status: "executed",
        exitCode: null,
        timedOut: true,
      },
    });
    expect(executor.activeRequestCount).toBe(0);

    await expect(
      executor.execute(
        shellCommandRequest(
          "real-shell-after-timeout",
          "workspace-a",
          "Write-Output 'lease-released'",
          5_000,
        ),
        1,
      ),
    ).resolves.toMatchObject({
      ok: true,
      result: {
        status: "executed",
        exitCode: 0,
        timedOut: false,
        stdout: expect.stringContaining("lease-released"),
      },
    });
  });
});

function writableShellWorkspace(id: string, rootPath: string) {
  return {
    ...makeWorkspacePolicy(rootPath, {
      profile: "full-repo-write",
      allowedRoots: ["."],
    }),
    id,
    name: id,
    allowWrites: ["."],
    allowShell: ["."],
    allowedShells: ["powershell"],
  };
}

function shellRequest(
  requestId: string,
  workspaceId: string,
  marker: string,
): RelayRequest {
  return shellCommandRequest(
    requestId,
    workspaceId,
    `Start-Sleep -Milliseconds 900; Write-Output 'parallel-${marker}'`,
    5_000,
  );
}

function shellCommandRequest(
  requestId: string,
  workspaceId: string,
  command: string,
  timeoutMs: number,
): RelayRequest {
  return {
    version: 1,
    type: "request",
    requestId,
    deadline: {
      requestedTimeoutMs: 5_000,
      effectiveTimeoutMs: 5_000,
      deadlineAt: new Date(Date.now() + 5_000).toISOString(),
    },
    operation: "runCommand",
    input: {
      workspaceId,
      shell: "powershell",
      command,
      timeoutMs,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
