import { describe, expect, it } from "@jest/globals";
import {
  commandPlanSchema,
  directRunCommandInputSchema,
  disabledQualifiedCommandFeatureFlags,
  qualifiedRunCommandInputSchema,
  runCommandInputSchema,
  runCommandResultSchema,
} from "../src/index.js";

const fingerprint = "a".repeat(64);

describe("qualified command contracts", () => {
  it("preserves the parsed legacy direct payload without adding defaults", () => {
    const input = {
      workspaceId: "project",
      command: "npm test",
      shell: "pwsh" as const,
      cwd: ".",
      timeoutMs: 120_000,
    };

    expect(runCommandInputSchema.parse(input)).toEqual(input);
    expect(directRunCommandInputSchema.parse(input)).toEqual(input);
  });

  it("accepts an objective as an additive qualified-mode contract", () => {
    const input = {
      workspaceId: "project",
      objective: "Executar os testes do pacote MCP principal",
      autoCorrection: "safe" as const,
      preferredShell: "auto" as const,
      cwd: ".",
      timeoutMs: 120_000,
      expectedOutcome: [{ kind: "exit_code" as const, value: 0 }],
    };

    expect(runCommandInputSchema.parse(input)).toEqual(input);
    expect(qualifiedRunCommandInputSchema.parse(input)).toEqual(input);
  });

  it("accepts an explicit command in qualified mode", () => {
    const input = {
      workspaceId: "project",
      command: "npm test",
      shell: "pwsh" as const,
      executionMode: "qualified" as const,
      autoCorrection: "off" as const,
      timeoutMs: 120_000,
    };

    expect(runCommandInputSchema.parse(input)).toEqual(input);
  });

  it("rejects qualified-only fields when neither objective nor qualified mode is present", () => {
    expect(() =>
      runCommandInputSchema.parse({
        workspaceId: "project",
        command: "npm test",
        shell: "pwsh",
        autoCorrection: "safe",
        timeoutMs: 120_000,
      }),
    ).toThrow();
  });

  it("defines a strict typed CommandPlan contract", () => {
    const plan = {
      invocationId: "invocation-1",
      objective: "Executar os testes",
      source: "deterministic-recipe" as const,
      shell: "pwsh" as const,
      cwd: ".",
      execution: {
        kind: "argv" as const,
        executable: "npm",
        argv: ["test"],
      },
      timeoutMs: 120_000,
      absoluteDeadline: "2026-08-04T16:00:00.000Z",
      riskClass: "safe" as const,
      effectClass: "repeatable_local" as const,
      expectedOutcomes: [{ kind: "exit_code" as const, value: 0 }],
      postconditions: [{ kind: "git_clean" as const, root: "." }],
      fingerprint,
      provenance: {
        source: "deterministic-recipe" as const,
        recipeId: "npm-test",
        sanitized: true,
      },
    };

    expect(commandPlanSchema.parse(plan)).toEqual(plan);
  });

  it("keeps legacy command results byte-semantically compatible", () => {
    const result = {
      status: "executed" as const,
      shell: "pwsh" as const,
      cwd: ".",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
    };

    expect(runCommandResultSchema.parse(result)).toEqual(result);
  });

  it("accepts additive qualified result metadata", () => {
    const result = {
      status: "executed" as const,
      shell: "pwsh" as const,
      cwd: ".",
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      timedOut: false,
      executionMode: "qualified" as const,
      corrected: true,
      attemptCount: 2,
      diagnosis: {
        category: "wrong_working_directory" as const,
        confidence: 0.99,
        source: "deterministic" as const,
      },
      correction: {
        applied: true,
        effectiveCommand: "npm test",
        sanitized: true,
      },
      postcondition: { passed: true, checked: 1, failed: 0 },
      attempts: [
        {
          attempt: 1,
          planFingerprint: fingerprint,
          shell: "pwsh" as const,
          cwd: ".",
          exitCode: 1,
          timedOut: false,
          startedAt: "2026-08-04T15:59:00.000Z",
          completedAt: "2026-08-04T15:59:01.000Z",
        },
        {
          attempt: 2,
          planFingerprint: "b".repeat(64),
          shell: "pwsh" as const,
          cwd: ".",
          exitCode: 0,
          timedOut: false,
          startedAt: "2026-08-04T15:59:02.000Z",
          completedAt: "2026-08-04T15:59:03.000Z",
        },
      ],
    };

    expect(runCommandResultSchema.parse(result)).toEqual(result);
  });

  it("keeps qualified features disabled by default", () => {
    expect(disabledQualifiedCommandFeatureFlags).toEqual({
      qualifiedExecution: false,
      safeAutoCorrection: false,
      shadowMode: false,
      providerEnabled: false,
    });
  });
});
