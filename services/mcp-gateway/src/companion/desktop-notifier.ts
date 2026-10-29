import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// A Windows notification for the user: the agent waits for their choice, or
// something it waited for happened and its conversation is not open to write
// in. Each one is shown once; nothing repeats it.

export interface DesktopNotice {
  title: string;
  body: string;
}

export type DesktopNotify = (notice: DesktopNotice) => void;

export interface DesktopNotifierOptions {
  /** Where the script is written before each run, under the companion's state. */
  scriptDirectory: string;
  powershellPath?: string;
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
  log?: (entry: Record<string, unknown>) => void;
}

// Windows PowerShell's own app id lets an unpackaged process show a toast.
export const DESKTOP_NOTIFIER_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$title = [System.Security.SecurityElement]::Escape($env:MCP_V3_NOTICE_TITLE)
$body = [System.Security.SecurityElement]::Escape($env:MCP_V3_NOTICE_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast><visual><binding template=""ToastGeneric""><text>$title</text><text>$body</text></binding></visual><audio src=""ms-winsoundevent:Notification.Reminder""/></toast>")
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
'shown'
`;

/** Shows Windows notifications; undefined off Windows. */
export function createDesktopNotifier(options: DesktopNotifierOptions): DesktopNotify | undefined {
  if (process.platform !== "win32" && options.spawnProcess === undefined) return undefined;
  const powershell = options.powershellPath ??
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const scriptPath = path.join(options.scriptDirectory, "notify.ps1");
  const run = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? 20_000;
  return (notice) => {
    void show(notice).catch((error: unknown) => {
      options.log?.({ event: "mcp_v3_notice_failed", message: error instanceof Error ? error.message : String(error) });
    });
  };

  async function show(notice: DesktopNotice): Promise<void> {
    await mkdir(options.scriptDirectory, { recursive: true });
    await writeFile(scriptPath, "\uFEFF" + DESKTOP_NOTIFIER_SCRIPT, "utf8");
    const shown = await new Promise<boolean>((resolve) => {
      const child = run(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, MCP_V3_NOTICE_TITLE: notice.title.slice(0, 120), MCP_V3_NOTICE_BODY: notice.body.slice(0, 600) },
      });
      let output = "";
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (output.length < 1_024) output += chunk;
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
      child.on("close", () => {
        clearTimeout(timer);
        resolve(output.includes("shown"));
      });
    });
    options.log?.({ event: shown ? "mcp_v3_notice_shown" : "mcp_v3_notice_failed", title: notice.title.slice(0, 120) });
  }
}
