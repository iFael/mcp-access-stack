import { describe, expect, test } from "@jest/globals";
import { scheduledTaskPolicyReason } from "../../../src/shell/scheduled-task-policy.js";

describe("Scheduled Task policy", () => {
  test("blocks Scheduled Task mutations in any form, elevated or not", () => {
    const commands = [
      "Register-ScheduledTask -TaskName Fixture -Action $action",
      "$name = 'MCP V3 companion recovery'\nStart-ScheduledTask -TaskName $name",
      "Get-ScheduledTask Fixture | Set-ScheduledTask -Settings $settings",
      "Unregister-ScheduledTask -TaskName Fixture -Confirm:$false",
      "schtasks /Create /TN Fixture /XML task.xml",
      "schtasks.exe /Run /TN Fixture",
      "$svc = New-Object -ComObject Schedule.Service",
    ];
    for (const command of commands) {
      for (const elevated of [false, true]) {
        expect(scheduledTaskPolicyReason("powershell", command, elevated)).toMatch(/Scheduled Tasks/u);
      }
    }
  });

  test("keeps Scheduled Task queries available", () => {
    for (const command of [
      "Get-ScheduledTask -TaskName 'MCP V3 local companion' | Get-ScheduledTaskInfo",
      "schtasks /Query /TN Fixture /FO LIST",
    ]) {
      expect(scheduledTaskPolicyReason("powershell", command, true)).toBeUndefined();
    }
  });

  test("blocks execution policy bypass only on elevated commands", () => {
    const command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\run-once.ps1";
    expect(scheduledTaskPolicyReason("powershell", command, true)).toMatch(/execution policy/u);
    expect(scheduledTaskPolicyReason("powershell", "pwsh -ep bypass -File x.ps1", true)).toMatch(/execution policy/u);
    expect(scheduledTaskPolicyReason("powershell", command, false)).toBeUndefined();
  });
});
