import { describe, expect, test } from "@jest/globals";
import { trustedWorkspaceCriticalReason } from "../../../src/shell/trusted-workspace-authorization.js";

describe("trusted workspace critical command guard", () => {
  test.each([
    ["schtasks /Delete /TN MCP-Trusted-Workspace-Fixture /F", /Scheduled Task/u],
    ["Register-ScheduledTask -TaskName Fixture", /Scheduled Task/u],
    ["Start-Process powershell -Verb RunAs", /elevation|UAC/u],
    ["runas /user:Administrator cmd", /elevation|UAC/u],
    ["cmdkey /delete:fixture", /credential|certificate/u],
    ["certutil -delstore My fixture", /credential|certificate/u],
    ["winget uninstall Fixture.Package", /install|uninstall/u],
    ["Start-Service FixtureService", /service/u],
    ["cmd /c echo fixture", /nested shell/u],
    ["node -e 'console.log(1)'", /inline interpreter/u],
    ["python -c 'print(1)'", /inline interpreter/u],
    ["docker stop fixture-container", /Docker mutation/u],
    ["docker --context local compose -f compose.yml up -d", /Docker mutation/u],
    ["Write-Output ok; schtasks /Delete /TN Fixture /F", /Scheduled Task/u],
    ["Write-Output ok | cmd /c echo fixture", /nested shell/u],
    ["Write-Output ok; docker restart fixture-container", /Docker mutation/u],
    ["Write-Output ok; ./fixture.ps1", /script execution/u],
  ])("requires confirmation for %s", async (command, expected) => {
    await expect(
      trustedWorkspaceCriticalReason("powershell", command, process.cwd()),
    ).resolves.toMatch(expected);
  });

  test.each([
    "Get-ChildItem src",
    "schtasks /Query /FO LIST",
    "winget list",
    "node --version",
    "docker ps",
    "docker inspect stop",
    "docker volume ls",
    "docker compose ps",
    'Write-Output "schtasks /Delete /TN Fixture /F"',
    'Write-Output "ok; schtasks /Delete /TN Fixture /F"',
    'Write-Output "cmd /c echo fixture"',
  ])("does not flag inert command text: %s", async (command) => {
    await expect(
      trustedWorkspaceCriticalReason("powershell", command, process.cwd()),
    ).resolves.toBeUndefined();
  });
});
