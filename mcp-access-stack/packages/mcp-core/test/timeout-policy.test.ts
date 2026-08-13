import { describe, expect, it } from "@jest/globals";
import {
  backgroundTaskRecordSchema,
  createOperationDeadline,
  createOperationLifecycle,
  MAX_BACKGROUND_OPERATION_TIMEOUT_MS,
  MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
  QUICK_OPERATION_TIMEOUT_MS,
  routableCommandTimeoutMsSchema,
  runCommandInputSchema,
  sanitizeOperationDiagnostic,
  startBackgroundTaskInputSchema,
  synchronousTimeoutMsSchema,
} from "../src/index.js";

describe("timeout policy", () => {
  it("uses the quick default for synchronous operations", () => {
    expect(synchronousTimeoutMsSchema.parse(undefined)).toBe(
      QUICK_OPERATION_TIMEOUT_MS,
    );
  });

  it("accepts an explicit medium timeout and rejects values above 300 seconds", () => {
    expect(synchronousTimeoutMsSchema.parse(300_000)).toBe(300_000);
    expect(() => synchronousTimeoutMsSchema.parse(300_001)).toThrow();
  });

  it("accepts long command requests only within the background ceiling", () => {
    expect(routableCommandTimeoutMsSchema.parse(300_001)).toBe(300_001);
    expect(routableCommandTimeoutMsSchema.parse(MAX_BACKGROUND_OPERATION_TIMEOUT_MS)).toBe(
      MAX_BACKGROUND_OPERATION_TIMEOUT_MS,
    );
    expect(() =>
      routableCommandTimeoutMsSchema.parse(MAX_BACKGROUND_OPERATION_TIMEOUT_MS + 1),
    ).toThrow();
  });

  it("preserves the original requested timeout while applying the smallest remaining deadline", () => {
    const now = Date.parse("2026-07-26T12:00:00.000Z");
    const upstream = {
      requestedTimeoutMs: MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
      effectiveTimeoutMs: 75_000,
      deadlineAt: new Date(now + 75_000).toISOString(),
    };
    const effective = createOperationDeadline(300_000, upstream, now + 25_000);

    expect(effective.requestedTimeoutMs).toBe(300_000);
    expect(effective.effectiveTimeoutMs).toBe(50_000);
    expect(effective.deadlineAt).toBe(upstream.deadlineAt);
  });

  it("records the responsible layer, terminal reason and elapsed time", () => {
    const startedAt = Date.parse("2026-07-26T12:00:00.000Z");
    const deadline = createOperationDeadline(60_000, undefined, startedAt);
    const lifecycle = createOperationLifecycle(
      deadline,
      startedAt,
      {
        layer: "child_process",
        reason: "timeout",
        diagnostic: "child exceeded deadline",
      },
      startedAt + 1_250,
    );

    expect(lifecycle).toMatchObject({
      requestedTimeoutMs: 60_000,
      effectiveTimeoutMs: 60_000,
      elapsedMs: 1_250,
      terminatedBy: "child_process",
      reason: "timeout",
      diagnostic: "child exceeded deadline",
    });
  });

  it("sanitizes credentials, private URLs, private paths and personal paths", () => {
    const sanitized = sanitizeOperationDiagnostic(
      "Authorization: Bearer secret-token token=abc http://127.0.0.1:3410/run?token=xyz C:\\Users\\example-user\\repo /home/example-user/project .runtime-private/secrets.json",
    );

    expect(sanitized).not.toContain("secret-token");
    expect(sanitized).not.toContain("token=abc");
    expect(sanitized).not.toContain("token=xyz");
    expect(sanitized).not.toContain("127.0.0.1");
    expect(sanitized).not.toContain("C:\\Users\\example-user");
    expect(sanitized).not.toContain("/home/example-user");
    expect(sanitized).not.toContain(".runtime-private");
    expect(sanitized).toContain("[REDACTED_PRIVATE_URL]");
    expect(sanitized).toContain("%USERPROFILE%");
    expect(sanitized).toContain("%HOME%");
    expect(sanitized).toContain("[REDACTED_PRIVATE_PATH]");
  });

  it("preserves significant command whitespace in synchronous and background schemas", () => {
    const command = "  printf 'a  b'  ";
    expect(
      runCommandInputSchema.parse({
        workspaceId: "ws",
        shell: "git-bash",
        command,
      }).command,
    ).toBe(command);
    expect(
      startBackgroundTaskInputSchema.parse({
        workspaceId: "ws",
        operation: "test",
        shell: "git-bash",
        command,
      }).command,
    ).toBe(command);
  });

  it("accepts lifecycle metadata on persisted background records", () => {
    const startedAt = Date.parse("2026-07-26T12:00:00.000Z");
    const deadline = createOperationDeadline(60_000, undefined, startedAt);
    expect(
      backgroundTaskRecordSchema.parse({
        version: 1,
        id: "123e4567-e89b-42d3-a456-426614174000",
        workspaceId: "ws",
        operation: "test",
        commandHash: "0".repeat(64),
        command: "echo ok",
        shell: "git-bash",
        cwd: ".",
        state: "failed",
        createdAt: new Date(startedAt).toISOString(),
        completedAt: new Date(startedAt + 10).toISOString(),
        timeoutMs: 60_000,
        lifecycle: createOperationLifecycle(
          deadline,
          startedAt,
          { layer: "child_process", reason: "process_failed" },
          startedAt + 10,
        ),
      }).lifecycle?.reason,
    ).toBe("process_failed");
  });
});
