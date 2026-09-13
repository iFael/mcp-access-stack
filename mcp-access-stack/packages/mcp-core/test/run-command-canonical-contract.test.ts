import { describe, expect, it } from "@jest/globals";
import {
  runCommandInputSchema,
  runCommandToolInputSchema,
} from "../src/index.js";

describe("canonical run_command contract", () => {
  const canonicalInput = {
    workspaceId: "project",
    command: "npm test",
    shell: "pwsh" as const,
    cwd: ".",
    timeoutMs: 120_000,
    confirmationId: "confirmation-1",
  };

  it("accepts the canonical direct-only input", () => {
    expect(runCommandInputSchema.parse(canonicalInput)).toEqual(canonicalInput);
    expect(runCommandToolInputSchema.parse(canonicalInput)).toEqual(canonicalInput);
  });

  it("rejects the legacy executionMode field", () => {
    expect(() =>
      runCommandInputSchema.parse({
        ...canonicalInput,
        executionMode: "direct",
      }),
    ).toThrow();
  });

  it("rejects legacy qualified-mode inputs", () => {
    expect(() =>
      runCommandInputSchema.parse({
        workspaceId: "project",
        objective: "Executar os testes",
        autoCorrection: "safe",
        preferredShell: "auto",
        expectedOutcome: [{ kind: "exit_code", value: 0 }],
      }),
    ).toThrow();
  });
});
