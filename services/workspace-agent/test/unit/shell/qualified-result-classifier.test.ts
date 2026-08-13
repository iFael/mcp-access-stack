import { describe, expect, it } from "@jest/globals";
import type {
  CommandPlan,
  CommandPostconditionResult,
  RunCommandResult,
} from "@vs-code-gpt/shared";
import { classifyQualifiedCommandResult } from "../../../src/shell/qualified/result-classifier.js";

const fingerprint = "a".repeat(64);

function plan(overrides: Partial<CommandPlan> = {}): CommandPlan {
  return {
    invocationId: "invocation-1",
    objective: "Executar os testes",
    source: "deterministic-recipe",
    shell: "powershell",
    cwd: ".",
    execution: {
      kind: "argv",
      executable: "npm",
      argv: ["test"],
    },
    timeoutMs: 30_000,
    absoluteDeadline: "2026-08-04T23:00:00.000Z",
    riskClass: "safe",
    effectClass: "repeatable_local",
    expectedOutcomes: [{ kind: "exit_code", value: 0 }],
    postconditions: [{ kind: "exit_code", value: 0 }],
    fingerprint,
    provenance: {
      source: "deterministic-recipe",
      recipeId: "npm-test",
      sanitized: true,
    },
    ...overrides,
  };
}

function executed(
  overrides: Partial<Extract<RunCommandResult, { status: "executed" }>> = {},
): Extract<RunCommandResult, { status: "executed" }> {
  return {
    status: "executed",
    shell: "powershell",
    cwd: ".",
    exitCode: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

const passed: CommandPostconditionResult = {
  passed: true,
  checked: 1,
  failed: 0,
};

describe("qualified result classifier", () => {
  it("accepts a zero exit code with passing postconditions", () => {
    expect(classifyQualifiedCommandResult(plan(), executed(), passed)).toEqual({
      successful: true,
    });
  });

  it("classifies timeouts deterministically", () => {
    expect(
      classifyQualifiedCommandResult(
        plan(),
        executed({ timedOut: true, exitCode: null }),
        passed,
      ),
    ).toMatchObject({
      successful: false,
      diagnosis: {
        category: "timeout",
        confidence: 1,
        source: "deterministic",
      },
    });
  });

  it("classifies missing executables and permission failures from sanitized output", () => {
    expect(
      classifyQualifiedCommandResult(
        plan({ objective: "Executar ferramenta" }),
        executed({ exitCode: 1, stderr: "command not found" }),
        passed,
      ),
    ).toMatchObject({
      diagnosis: { category: "executable_unavailable" },
    });

    expect(
      classifyQualifiedCommandResult(
        plan({ objective: "Executar ferramenta" }),
        executed({ exitCode: 1, stderr: "Permission denied" }),
        passed,
      ),
    ).toMatchObject({
      diagnosis: { category: "permission_denied" },
    });
  });

  it("falls back to test_failed for an unsuccessful test plan", () => {
    expect(
      classifyQualifiedCommandResult(
        plan(),
        executed({ exitCode: 1, stderr: "2 assertions failed" }),
        passed,
      ),
    ).toMatchObject({
      successful: false,
      diagnosis: {
        category: "test_failed",
        confidence: 0.95,
      },
    });
  });

  it("marks a failed postcondition after exit zero as application_failed", () => {
    expect(
      classifyQualifiedCommandResult(plan(), executed(), {
        passed: false,
        checked: 1,
        failed: 1,
      }),
    ).toMatchObject({
      successful: false,
      diagnosis: {
        category: "application_failed",
        confidence: 1,
      },
    });
  });

  it("distinguishes a missing path from an unavailable executable", () => {
    expect(
      classifyQualifiedCommandResult(
        plan({ objective: "Ler arquivo" }),
        executed({
          exitCode: 1,
          stderr: "ENOENT: no such file or directory, open 'missing.txt'",
        }),
        passed,
      ),
    ).toMatchObject({
      diagnosis: { category: "path_not_found" },
    });
  });
});
