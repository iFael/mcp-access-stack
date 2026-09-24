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

  test("publishes a short MCP polling contract without shrinking the internal relay contract", () => {
    const schema = (contracts as Record<string, unknown>)["waitBackgroundTaskToolInputSchema"] as
      | { parse(value: unknown): unknown }
      | undefined;

    expect(schema).toBeDefined();
    expect(schema?.parse({ workspaceId: "project", id: taskId })).toEqual({
      workspaceId: "project",
      id: taskId,
      timeoutMs: 15_000,
      maxBytes: 100_000,
    });
    expect(
      schema?.parse({ workspaceId: "project", id: taskId, timeoutMs: 30_000 }),
    ).toMatchObject({ timeoutMs: 30_000 });
    expect(() =>
      schema?.parse({ workspaceId: "project", id: taskId, timeoutMs: 30_001 }),
    ).toThrow();
  });

  test("publishes a bounded multi-task wait contract with unique ids", () => {
    const schema = (contracts as Record<string, unknown>)["waitBackgroundTasksToolInputSchema"] as
      | { parse(value: unknown): unknown }
      | undefined;
    const secondId = "223e4567-e89b-42d3-a456-426614174000";

    expect(schema).toBeDefined();
    expect(schema?.parse({ workspaceId: "project", ids: [taskId, secondId] })).toEqual({
      workspaceId: "project",
      ids: [taskId, secondId],
      timeoutMs: 15_000,
      maxBytes: 100_000,
    });
    expect(() =>
      schema?.parse({ workspaceId: "project", ids: [taskId, taskId] }),
    ).toThrow();
    expect(() =>
      schema?.parse({
        workspaceId: "project",
        ids: Array.from({ length: 9 }, (_, index) =>
          `123e4567-e89b-42d3-a456-4266141740${String(index).padStart(2, "0")}`,
        ),
      }),
    ).toThrow();
    expect(() =>
      schema?.parse({
        workspaceId: "project",
        ids: [taskId],
        timeoutMs: 30_001,
      }),
    ).toThrow();
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
