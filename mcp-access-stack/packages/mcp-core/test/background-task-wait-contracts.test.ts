import { describe, expect, test } from "@jest/globals";
import * as contracts from "../src/background-task-contracts.js";

const taskId = "123e4567-e89b-42d3-a456-426614174000";

describe("background task wait contracts", () => {
  test("publishes bounded wait input defaults", () => {
    const schema = (contracts as Record<string, unknown>)["waitBackgroundTaskInputSchema"] as
      | { parse(value: unknown): unknown }
      | undefined;

    expect(schema).toBeDefined();
    expect(
      schema?.parse({ workspaceId: "project", id: taskId }),
    ).toEqual({
      workspaceId: "project",
      id: taskId,
      timeoutMs: 60_000,
      maxBytes: 100_000,
    });
  });

  test("publishes a wait result with task, log tail and wait metadata", () => {
    const schema = (contracts as Record<string, unknown>)["backgroundTaskWaitResultSchema"] as
      | { parse(value: unknown): unknown }
      | undefined;

    expect(schema).toBeDefined();
    expect(
      schema?.parse({
        task: null,
        logs: null,
        timedOut: false,
        elapsedMs: 0,
      }),
    ).toEqual({
      task: null,
      logs: null,
      timedOut: false,
      elapsedMs: 0,
    });
  });
});
