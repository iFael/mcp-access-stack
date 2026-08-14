import { describe, expect, test } from "@jest/globals";
import { classifyCommandRisk } from "../../../src/shell/command-risk.js";

const DISK_FORMAT_REASON = "disk, boot or volume operation";

describe("command risk disk format classification", () => {
  test("keeps read-only format text and arguments non-destructive", () => {
    const safeCommands = [
      ["powershell", "Get-Date -Format o"],
      ["powershell", "Get-Date -Format 'yyyy-MM-dd'"],
      ["powershell", "Get-Process | Format-Table"],
      ["powershell", "Get-Service | Format-List"],
      ["powershell", "Write-Output format"],
      ["powershell", "git log --format oneline -1"],
      ["powershell", "git log -S 'format-volume' -- command-risk.ts"],
      ["powershell", "Write-Output 'not; format E:'"],
    ] as const;

    for (const [shell, command] of safeCommands) {
      expect(classifyCommandRisk(shell, command)).toEqual({
        destructive: false,
        reasons: [],
      });
    }
  });

  test("keeps executable disk format commands destructive", () => {
    const riskyCommands = [
      ["powershell", "Format-Volume -DriveLetter E"],
      ["powershell", "format E: /Q"],
      ["powershell", "format.exe E: /Q"],
      ["powershell", "Get-Date; format E: /Q"],
      ["powershell", "Write-Output Y | format.com E: /Q"],
      ["cmd", "cmd /d /c format E: /Q"],
      ["cmd", "cmd /c \"format.com E: /Q\""],
      ["powershell", "pwsh -NoProfile -Command \"Format-Volume -DriveLetter E\""],
      ["cmd", "if exist marker.txt format E: /Q"],
    ] as const;

    for (const [shell, command] of riskyCommands) {
      expect(classifyCommandRisk(shell, command)).toMatchObject({
        destructive: true,
        reasons: expect.arrayContaining([DISK_FORMAT_REASON]),
      });
    }
  });
});
