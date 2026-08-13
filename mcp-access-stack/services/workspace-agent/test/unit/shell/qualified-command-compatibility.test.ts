import { describe, expect, it } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import { routeRunCommandInput } from "../../../src/shell/qualified-command-compatibility.js";

describe("qualified command compatibility router", () => {
  it("returns a direct payload without adding or removing fields", () => {
    const input = {
      workspaceId: "project",
      command: "npm test",
      shell: "pwsh" as const,
      cwd: ".",
      timeoutMs: 120_000,
    };

    const routed = routeRunCommandInput(input);

    expect(routed).toEqual({ mode: "direct", input });
  });

  it("keeps an explicit executionMode=direct on the direct path", () => {
    const input = {
      workspaceId: "project",
      command: "npm test",
      shell: "pwsh" as const,
      executionMode: "direct" as const,
      timeoutMs: 120_000,
    };

    expect(routeRunCommandInput(input)).toEqual({ mode: "direct", input });
  });

  it("blocks objective-based qualified mode while the feature is disabled", () => {
    expect(() =>
      routeRunCommandInput({
        workspaceId: "project",
        objective: "Executar os testes",
        timeoutMs: 120_000,
      }),
    ).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_UNSUPPORTED",
        message: "Qualified command execution is disabled.",
      }),
    );
  });

  it("blocks safe autocorrection independently when qualified execution is enabled", () => {
    expect(() =>
      routeRunCommandInput(
        {
          workspaceId: "project",
          objective: "Executar os testes",
          autoCorrection: "safe",
          timeoutMs: 120_000,
        },
        { qualifiedExecution: true, safeAutoCorrection: false },
      ),
    ).toThrow(
      expect.objectContaining({
        code: "CAPABILITY_UNSUPPORTED",
        message: "Safe command autocorrection is disabled.",
      }),
    );
  });

  it("can expose the qualified route only when both relevant flags allow it", () => {
    const input = {
      workspaceId: "project",
      objective: "Executar os testes",
      autoCorrection: "safe" as const,
      timeoutMs: 120_000,
    };

    expect(
      routeRunCommandInput(input, {
        qualifiedExecution: true,
        safeAutoCorrection: true,
      }),
    ).toEqual({ mode: "qualified", input });
  });
});
