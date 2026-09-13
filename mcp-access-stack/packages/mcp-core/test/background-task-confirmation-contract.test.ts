import { describe, expect, test } from "@jest/globals";
import {
  backgroundTaskRecordSchema,
  startBackgroundTaskInputSchema,
} from "../src/index.js";

describe("background task confirmation contract", () => {
  test("accepts an optional confirmation id on start", () => {
    const parsed = startBackgroundTaskInputSchema.parse({
      workspaceId: "ws",
      operation: "run_command",
      command: "Remove-Item stale.txt -Force",
      shell: "powershell",
      timeoutMs: 30_000,
      confirmationId: "confirm-background-1",
    });

    expect(parsed.confirmationId).toBe("confirm-background-1");
  });

  test("never allows a confirmation id in the persisted task record", () => {
    const parsed = backgroundTaskRecordSchema.safeParse({
      version: 1,
      id: "123e4567-e89b-42d3-a456-426614174000",
      workspaceId: "ws",
      operation: "run_command",
      commandHash: "0".repeat(64),
      command: "Remove-Item stale.txt -Force",
      shell: "powershell",
      cwd: ".",
      state: "starting",
      createdAt: "2026-09-13T00:00:00.000Z",
      timeoutMs: 30_000,
      confirmationId: "must-not-persist",
    });

    expect(parsed.success).toBe(false);
  });
});
