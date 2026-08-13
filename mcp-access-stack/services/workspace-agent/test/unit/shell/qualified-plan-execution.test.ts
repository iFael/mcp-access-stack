import { describe, expect, it } from "@jest/globals";
import {
  commandPlanExecutionToRiskCommand,
  commandPlanExecutionToShellCommand,
} from "../../../src/shell/qualified/plan-execution.js";

describe("qualified plan execution serialization", () => {
  it("serializes PowerShell argv as literal arguments", () => {
    expect(
      commandPlanExecutionToShellCommand("powershell", {
        kind: "argv",
        executable: "echo",
        argv: ["a b", "it's-safe"],
      }),
    ).toBe("& 'echo' 'a b' 'it''s-safe'");
  });

  it("serializes POSIX argv without interpolation", () => {
    expect(
      commandPlanExecutionToShellCommand("git-bash", {
        kind: "argv",
        executable: "printf",
        argv: ["a'b", "$HOME"],
      }),
    ).toBe("'printf' 'a'\"'\"'b' '$HOME'");
  });

  it("serializes cmd argv conservatively", () => {
    expect(
      commandPlanExecutionToShellCommand("cmd", {
        kind: "argv",
        executable: "echo",
        argv: ["hello world", "a&b"],
      }),
    ).toBe('echo "hello world" "a^&b"');
  });

  it("rejects cmd values that cannot be represented safely", () => {
    expect(() =>
      commandPlanExecutionToShellCommand("cmd", {
        kind: "argv",
        executable: "echo",
        argv: ["%TEMP%"],
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
      }),
    );
  });

  it("uses an operator-free representation for defense-in-depth risk analysis", () => {
    expect(
      commandPlanExecutionToRiskCommand({
        kind: "argv",
        executable: "echo",
        argv: ["hello world"],
      }),
    ).toBe('echo "hello world"');
  });
});
