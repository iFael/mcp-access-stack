import { describe, expect, it } from "@jest/globals";
import { analyzeSimplePowerShellCommand } from "../../../src/shell/qualified/powershell-lexical.js";

describe("simple PowerShell command analysis", () => {
  it("lowers static literal commands to argv without native parsing", () => {
    expect(
      analyzeSimplePowerShellCommand(
        "powershell",
        "Set-Content 'restart-confirmation.txt' 'after'",
      ),
    ).toEqual({
      shell: "powershell",
      valid: true,
      execution: {
        kind: "argv",
        executable: "Set-Content",
        argv: ["restart-confirmation.txt", "after"],
      },
      diagnostics: [],
      usesShellFeatures: false,
    });
    expect(
      analyzeSimplePowerShellCommand("pwsh", "npm test"),
    ).toMatchObject({
      shell: "pwsh",
      valid: true,
      execution: { kind: "argv", executable: "npm", argv: ["test"] },
    });
  });

  it("supports empty literals and doubled single quotes", () => {
    expect(
      analyzeSimplePowerShellCommand(
        "powershell",
        "echo '' 'it''s-safe'",
      ),
    ).toMatchObject({
      execution: {
        kind: "argv",
        executable: "echo",
        argv: ["", "it's-safe"],
      },
    });
  });

  it("rejects unterminated quotes deterministically", () => {
    expect(
      analyzeSimplePowerShellCommand("powershell", "echo 'unterminated"),
    ).toMatchObject({
      valid: false,
      diagnostics: [
        {
          code: "syntax_error",
          message: "PowerShell command contains an unterminated quote.",
        },
      ],
    });
  });

  it("defers variables, operators, redirection and composite syntax to the AST", () => {
    for (const command of [
      "$value = 'ok'; Write-Output $value",
      "Get-Content file.txt | Select-Object -First 1",
      "echo value > output.txt",
      "Write-Output $(Get-Date)",
      "& 'tool.exe' argument",
      ". './profile.ps1'",
      "echo *.txt",
      "Write-Output @('a', 'b')",
    ]) {
      expect(
        analyzeSimplePowerShellCommand("powershell", command),
      ).toBeUndefined();
    }
  });

  it("does not reinterpret interpolation or token concatenation as literal argv", () => {
    expect(
      analyzeSimplePowerShellCommand("powershell", 'echo "$env:TEMP"'),
    ).toBeUndefined();
    expect(
      analyzeSimplePowerShellCommand("powershell", "echo prefix'value'"),
    ).toBeUndefined();
  });
});
