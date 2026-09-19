import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "@jest/globals";
import {
  AppError,
  createOperationDeadline,
  createOperationLifecycle,
} from "@vs-code-gpt/shared";
import { LocalAgent } from "../../../src/local-agent.js";
import {
  createFixture,
  makeWorkspacePolicy,
  type Fixture,
  writePolicy,
} from "../../support/helpers.js";

let fixture: Fixture | undefined;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
}, 30_000);

describe("audit lifecycle", () => {
  test("persists structured lifecycle from audited operation errors", async () => {
    fixture = await createFixture({
      profile: "full-repo-write",
      allowedRoots: ["."],
    });
    await writePolicy(fixture.policyPath, [
      {
        ...makeWorkspacePolicy(fixture.workspacePath, {
          profile: "full-repo-write",
          allowedRoots: ["."],
        }),
        allowWrites: ["."],
        allowShell: ["."],
        allowedShells: ["powershell"],
      },
    ]);

    const startedAt = Date.now();
    const deadline = createOperationDeadline(5_000, undefined, startedAt);
    const lifecycle = createOperationLifecycle(
      deadline,
      startedAt,
      {
        layer: "mcp_server",
        reason: "client_disconnected",
        diagnostic: "request connection closed",
      },
      startedAt + 125,
    );
    const controller = new AbortController();
    controller.abort(
      new AppError("OPERATION_CANCELLED", "Command operation was cancelled.", {
        lifecycle,
      }),
    );

    const agent = await LocalAgent.create(fixture.policyPath);

    await expect(
      agent.runCommand(
        {
          workspaceId: "test",
          shell: "powershell",
          command: "Write-Output 'never-runs'",
          timeoutMs: 5_000,
        },
        {
          correlationId: "audit-lifecycle-test",
          deadline,
          signal: controller.signal,
        },
      ),
    ).rejects.toMatchObject({
      code: "OPERATION_CANCELLED",
      lifecycle,
    });

    const audit = await readFile(
      path.join(fixture.auditPath, "audit.ndjson"),
      "utf8",
    );
    const entry = audit
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((value) => value.correlationId === "audit-lifecycle-test");

    expect(entry).toMatchObject({
      operation: "runCommand",
      workspaceId: "test",
      status: "error",
      reason: "OPERATION_CANCELLED",
      lifecycle,
    });
  });
});
