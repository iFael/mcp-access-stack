import { describe, expect, test } from "@jest/globals";
import {
  readFileActionInputSchema,
  runCommandActionInputSchema,
  runPowerShellActionInputSchema,
  runWorkspaceValidationActionInputSchema,
  startConsoleRunInputSchema,
  updateConsoleRunInputSchema,
} from "../../../src/actions/schemas.js";

describe("GPT Actions schemas", () => {
  test("applies defaults to a valid console run", () => {
    expect(
      startConsoleRunInputSchema.parse({
        workspaceId: "project",
        objective: "Review the current task",
      }),
    ).toEqual({
      workspaceId: "project",
      root: ".",
      objective: "Review the current task",
    });
  });

  test("rejects invalid workspaces and parent traversal", () => {
    expect(() =>
      startConsoleRunInputSchema.parse({
        workspaceId: "unknown",
        root: "../private",
        objective: "Invalid request",
      }),
    ).toThrow();
  });

  test("requires startLine when endLine is provided", () => {
    const result = readFileActionInputSchema.safeParse({
      workspaceId: "project",
      path: "src/example.ts",
      endLine: 20,
    });

    expect(result.success).toBe(false);
  });

  test("requires paths when validation scope is paths", () => {
    const result = runWorkspaceValidationActionInputSchema.safeParse({
      workspaceId: "project",
      validation: "diff-check",
      scope: "paths",
      paths: [],
    });

    expect(result.success).toBe(false);
  });

  test("accepts the additive qualified command contract", () => {
    expect(
      runCommandActionInputSchema.parse({
        workspaceId: "project",
        objective: "Executar os testes",
        executionMode: "qualified",
        autoCorrection: "safe",
        preferredShell: "auto",
        expectedOutcome: [{ kind: "exit_code", value: 0 }],
        timeoutMs: 120_000,
      }),
    ).toMatchObject({
      workspaceId: "project",
      objective: "Executar os testes",
      executionMode: "qualified",
    });
  });

  test("rejects qualified-only fields on an implicit direct command", () => {
    expect(
      runCommandActionInputSchema.safeParse({
        workspaceId: "project",
        command: "npm test",
        shell: "pwsh",
        autoCorrection: "safe",
        timeoutMs: 120_000,
      }).success,
    ).toBe(false);
  });

  test("limits HTTP shell operations to 300 seconds with background guidance", () => {
    const command = runCommandActionInputSchema.safeParse({
      workspaceId: "project",
      command: "npm run check",
      shell: "pwsh",
      timeoutMs: 300_001,
    });
    const powershell = runPowerShellActionInputSchema.safeParse({
      workspaceId: "project",
      command: "npm run check",
      timeoutMs: 300_001,
    });

    expect(command.success).toBe(false);
    expect(powershell.success).toBe(false);
    if (!command.success) {
      expect(command.error.issues[0]?.message).toContain(
        "BackgroundTaskManager",
      );
    }
  });

  test("requires at least one console update", () => {
    const result = updateConsoleRunInputSchema.safeParse({
      runId: "MT-20260724-0123456789ABCDEF",
    });

    expect(result.success).toBe(false);
  });
});
