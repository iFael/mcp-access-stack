import { describe, expect, it } from "@jest/globals";
import {
  AppError,
  commandInvocationRecordSchema,
  commandInvocationResponseSchema,
} from "../src/index.js";

const fingerprint = "a".repeat(64);
const idempotencyKey = "b".repeat(64);
const createdAt = "2026-08-04T21:00:00.000Z";

function baseRecord() {
  return {
    version: 1 as const,
    invocationId: "invocation-1",
    workspaceId: "project",
    idempotencyKey,
    planFingerprint: fingerprint,
    sequence: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

function confirmationResponse() {
  return {
    kind: "result" as const,
    sanitized: true as const,
    value: {
      status: "confirmation_required" as const,
      shell: "pwsh" as const,
      cwd: ".",
      confirmationId: "confirmation-1",
      expiresAt: "2026-08-04T21:05:00.000Z",
      reasons: ["local mutation"],
      executionMode: "qualified" as const,
    },
  };
}

describe("qualified command invocation contracts", () => {
  it("accepts an active received invocation without expiration or response", () => {
    const record = {
      ...baseRecord(),
      state: "received" as const,
    };

    expect(commandInvocationRecordSchema.parse(record)).toEqual(record);
  });

  it("requires a sanitized confirmation result while awaiting confirmation", () => {
    const record = {
      ...baseRecord(),
      state: "awaiting_confirmation" as const,
      sequence: 2,
      response: confirmationResponse(),
    };

    expect(commandInvocationRecordSchema.parse(record)).toEqual(record);
    expect(() =>
      commandInvocationRecordSchema.parse({
        ...record,
        response: undefined,
      }),
    ).toThrow();
  });

  it("requires an executed result and expiry for completed invocations", () => {
    const record = {
      ...baseRecord(),
      state: "completed" as const,
      sequence: 3,
      expiresAt: "2026-08-05T21:00:00.000Z",
      response: {
        kind: "result" as const,
        sanitized: true as const,
        value: {
          status: "executed" as const,
          shell: "pwsh" as const,
          cwd: ".",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          timedOut: false,
          executionMode: "qualified" as const,
        },
      },
    };

    expect(commandInvocationRecordSchema.parse(record)).toEqual(record);
    expect(() =>
      commandInvocationRecordSchema.parse({
        ...record,
        expiresAt: undefined,
      }),
    ).toThrow();
  });

  it("binds outcome_unknown to the dedicated recovery error", () => {
    const response = {
      kind: "error" as const,
      sanitized: true as const,
      value: new AppError(
        "EXECUTION_OUTCOME_UNKNOWN",
        "Execution outcome is unknown.",
      ).toJSON(),
    };
    const record = {
      ...baseRecord(),
      state: "outcome_unknown" as const,
      sequence: 4,
      expiresAt: "2026-08-05T21:00:00.000Z",
      response,
      recovery: {
        code: "EXECUTION_OUTCOME_UNKNOWN" as const,
        priorState: "executing" as const,
        recoveredAt: "2026-08-04T21:00:01.000Z",
      },
    };

    expect(commandInvocationResponseSchema.parse(response)).toEqual(response);
    expect(commandInvocationRecordSchema.parse(record)).toEqual(record);
    expect(() =>
      commandInvocationRecordSchema.parse({
        ...record,
        response: {
          ...response,
          value: { code: "INTERNAL_ERROR", message: "wrong" },
        },
      }),
    ).toThrow();
  });

  it("rejects expiration and replay responses on non-replayable active states", () => {
    expect(() =>
      commandInvocationRecordSchema.parse({
        ...baseRecord(),
        state: "qualified",
        expiresAt: "2026-08-05T21:00:00.000Z",
        response: confirmationResponse(),
      }),
    ).toThrow();
  });
});
