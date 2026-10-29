import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { createDesktopNotifier, DESKTOP_NOTIFIER_SCRIPT } from "../../../src/companion/desktop-notifier.js";

describe("Windows notifications", () => {
  it("runs the toast script hidden, with the notice in the environment and not on the command line", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-notice-"));
    const calls: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const logs: Array<Record<string, unknown>> = [];
    const notify = createDesktopNotifier({
      scriptDirectory: directory,
      powershellPath: "powershell.exe",
      log: (entry) => { logs.push(entry); },
      spawnProcess: ((_command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ args, options });
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
        (child.stdout as EventEmitter & { setEncoding(): void }).setEncoding = () => undefined;
        setImmediate(() => {
          child.stdout.emit("data", "shown\r\n");
          child.emit("close", 0);
        });
        return child;
      }) as never,
    })!;
    notify({ title: "O agente espera sua escolha", body: "Qual caminho?\nA) Manter" });
    const deadline = Date.now() + 2_000;
    while (logs.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(logs).toEqual([{ event: "mcp_v3_notice_shown", title: "O agente espera sua escolha" }]);
    expect(calls[0]!.args.join(" ")).not.toContain("caminho");
    expect(calls[0]!.options).toMatchObject({ windowsHide: true, env: expect.objectContaining({
      MCP_V3_NOTICE_TITLE: "O agente espera sua escolha", MCP_V3_NOTICE_BODY: "Qual caminho?\nA) Manter" }) });
    const script = await readFile(path.join(directory, "notify.ps1"), "utf8");
    expect(script).toContain("SecurityElement]::Escape($env:MCP_V3_NOTICE_BODY)");
  });

  (process.platform === "win32" ? it : it.skip)("is a script Windows PowerShell parses", () => {
    const errors = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:SCRIPT_UNDER_TEST, [ref]$null, [ref]$e); $e.Count"],
    { env: { ...process.env, SCRIPT_UNDER_TEST: DESKTOP_NOTIFIER_SCRIPT }, encoding: "utf8" });
    expect(errors.trim()).toBe("0");
  });
});
