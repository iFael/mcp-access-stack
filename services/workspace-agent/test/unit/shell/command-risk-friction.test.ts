import { describe, expect, test } from "@jest/globals";
import { classifyCommandRisk } from "../../../src/shell/command-risk.js";

describe("command risk friction regressions", () => {
  test.each([
    ["powershell", "git status 2>$null"],
    ["pwsh", "git status 2>$null"],
    ["powershell", 'Write-Output "COPY"'],
    ["powershell", 'Select-String -Pattern "COPY" package.json'],
    ["powershell", '& git status'],
    ["powershell", 'Write-Output "git push origin main"'],
  ] as const)("does not require confirmation for inert command text: %s / %s", (shell, command) => {
    expect(classifyCommandRisk(shell, command)).toEqual({
      destructive: false,
      reasons: [],
    });
  });

  test.each([
    ["powershell", "Copy-Item source.txt destination.txt", "move, overwrite or direct file write operation"],
    ["powershell", "Set-Content destination.txt value", "move, overwrite or direct file write operation"],
    ["powershell", "git push origin feature/task", "git push requires explicit user confirmation"],
  ] as const)("keeps real mutations protected: %s / %s", (shell, command, reason) => {
    expect(classifyCommandRisk(shell, command)).toMatchObject({
      destructive: true,
      reasons: expect.arrayContaining([reason]),
    });
  });
});
