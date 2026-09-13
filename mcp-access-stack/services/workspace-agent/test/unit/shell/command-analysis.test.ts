import { describe, expect, it } from "@jest/globals";
import {
  analyzeSimplePowerShellCommand,
  analyzeSimpleShellCommand,
} from "../../../src/shell/command-analysis.js";

describe("direct command analysis", () => {
  it("lowers static PowerShell commands to argv", () => {
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
  });

  it("does not reinterpret complex PowerShell syntax as literal argv", () => {
    for (const command of [
      "$value = 'ok'; Write-Output $value",
      "Get-Content file.txt | Select-Object -First 1",
      "echo value > output.txt",
      "Write-Output $(Get-Date)",
      "& 'tool.exe' argument",
      ". './profile.ps1'",
      "echo *.txt",
    ]) {
      expect(
        analyzeSimplePowerShellCommand("powershell", command),
      ).toBeUndefined();
    }
  });

  it("parses simple cmd commands and flags shell composition", () => {
    expect(
      analyzeSimpleShellCommand("cmd", 'node "script with spaces.js" --check'),
    ).toMatchObject({
      valid: true,
      execution: {
        kind: "argv",
        executable: "node",
        argv: ["script with spaces.js", "--check"],
      },
      usesShellFeatures: false,
    });
    expect(
      analyzeSimpleShellCommand("cmd", "npm test && npm run build"),
    ).toMatchObject({
      valid: true,
      execution: { kind: "script" },
      usesShellFeatures: true,
    });
  });

  it("parses simple POSIX commands and rejects unterminated quoting", () => {
    expect(
      analyzeSimpleShellCommand("git-bash", "git status --short"),
    ).toMatchObject({
      valid: true,
      execution: {
        kind: "argv",
        executable: "git",
        argv: ["status", "--short"],
      },
      usesShellFeatures: false,
    });
    expect(
      analyzeSimpleShellCommand("git-bash", "echo 'unterminated"),
    ).toMatchObject({
      valid: false,
      diagnostics: [{ code: "syntax_error" }],
    });
  });
});
