import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatWakeOutcome, ChatWakeTarget } from "./chat-wake.js";
import type { OpenConversation } from "./conversation-book.js";

// Writes the wake notice into the ChatGPT app for Windows through UI
// Automation: it fills the message field and invokes the Send button, without
// keystrokes, clipboard or taking focus. It only reads the window when the
// agent is answering (a Stop button) or the user has something in the field,
// and when the app shows another conversation than the notice's (the page
// address, chatgpt.com/c/<id>, read before filling and again before sending).
// With MCP_V3_WAKE_INSPECT it writes nothing and tells which conversation is
// open and whether it is answering.
// The text goes in through an environment variable, never the command line.
export const DESKTOP_CHAT_APP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Done($result) { $result | ConvertTo-Json -Compress; exit 0 }
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $A = [System.Windows.Automation.AutomationElement]
  $T = [System.Windows.Automation.TreeScope]
  $All = [System.Windows.Automation.Condition]::TrueCondition
  $pids = @(Get-Process -Name ChatGPT -ErrorAction SilentlyContinue | ForEach-Object Id)
  if ($pids.Count -eq 0) { Done @{ outcome = 'unavailable'; detail = 'app-not-running' } }
  $window = $A::RootElement.FindAll($T::Children, $All) |
    Where-Object { $pids -contains $_.Current.ProcessId -and $_.Current.ClassName -eq 'Chrome_WidgetWin_1' } |
    Select-Object -First 1
  if (-not $window) { Done @{ outcome = 'unavailable'; detail = 'no-window' } }
  function Read-State {
    $state = @{ composer = $null; stop = $null; send = $null; title = ''; url = '' }
    foreach ($e in $window.FindAll($T::Descendants, $All)) {
      $c = $e.Current
      $type = $c.ControlType.ProgrammaticName
      if ($type -eq 'ControlType.Document' -and $c.AutomationId -eq 'RootWebArea' -and -not $state.title) {
        $state.title = $c.Name
        try { $state.url = [string]$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
      }
      elseif ($type -eq 'ControlType.Edit' -and $c.ClassName -like '*ProseMirror*') { $state.composer = $e }
      elseif ($type -eq 'ControlType.Button') {
        if ($c.Name -match '^(?i)(parar|stop)') { $state.stop = $e }
        elseif ($c.Name -match '^(?i)(enviar|send)') { $state.send = $e }
      }
    }
    $state
  }
  function Conversation-Of($url) { ([regex]::Match([string]$url, '/c/([A-Za-z0-9-]{8,80})(?:[/?#]|$)')).Groups[1].Value }
  $want = [string]$env:MCP_V3_WAKE_CONVERSATION
  function Assert-Conversation($state) {
    if (-not $want) { return }
    if (-not $state.url) { Done @{ outcome = 'elsewhere'; detail = 'no-address' } }
    if ((Conversation-Of $state.url) -ne $want) { Done @{ outcome = 'elsewhere'; detail = 'other-conversation' } }
  }
  $s = Read-State
  if ($env:MCP_V3_WAKE_INSPECT -eq '1') {
    Done @{ outcome = 'inspect'; conversationId = (Conversation-Of $s.url); answering = [bool]$s.stop; address = [bool]$s.url }
  }
  Assert-Conversation $s
  if (-not $s.composer) { Done @{ outcome = 'failed'; detail = 'no-message-field' } }
  if ($s.stop) { Done @{ outcome = 'busy' } }
  $field = $s.composer.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  # Empty, the field reads back its own placeholder ("Pergunte ao ChatGPT").
  $current = ([string]$field.Current.Value).Trim()
  if ($current -and $current -ne $s.composer.Current.Name.Trim()) { Done @{ outcome = 'typing' } }
  $text = $env:MCP_V3_WAKE_TEXT
  if (-not $text) { Done @{ outcome = 'failed'; detail = 'no-text' } }
  $field.SetValue($text)
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 250
    $s = Read-State
    if ($s.send -and $s.send.Current.IsEnabled) { break }
  }
  if (-not ($s.send -and $s.send.Current.IsEnabled)) {
    try { $field.SetValue('') } catch {}
    Done @{ outcome = 'failed'; detail = 'no-send-button' }
  }
  if ($want -and (-not $s.url -or (Conversation-Of $s.url) -ne $want)) {
    # The user switched conversation while the text went in: take it back out.
    try { $field.SetValue('') } catch {}
    Done @{ outcome = 'elsewhere'; detail = 'switched' }
  }
  $s.send.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  for ($i = 0; $i -lt 16; $i++) {
    Start-Sleep -Milliseconds 250
    $s = Read-State
    if ($s.stop) { Done @{ outcome = 'sent' } }
  }
  $left = ([string]$s.composer.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value).Trim()
  if (-not $left -or $left -eq $s.composer.Current.Name.Trim()) { Done @{ outcome = 'sent'; detail = 'no-stop-seen' } }
  Done @{ outcome = 'failed'; detail = 'not-sent' }
} catch {
  Done @{ outcome = 'failed'; detail = $_.Exception.Message }
}
`;

const OUTCOMES = new Set<ChatWakeOutcome>(["sent", "busy", "typing", "unavailable", "elsewhere", "failed"]);

export interface DesktopChatAppOptions {
  /** Where the script is written before each run, under the companion's state. */
  scriptDirectory: string;
  powershellPath?: string;
  timeoutMs?: number;
  spawnProcess?: typeof spawn;
}

/** The ChatGPT app for Windows as a place to wake the conversation; undefined elsewhere. */
export function createDesktopChatAppTarget(options: DesktopChatAppOptions): ChatWakeTarget | undefined {
  if (process.platform !== "win32" && options.spawnProcess === undefined) return undefined;
  const powershell = options.powershellPath ??
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const scriptPath = path.join(options.scriptDirectory, "chat-wake-app.ps1");
  const run = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? 30_000;
  return {
    name: "app",
    deliver: async (text, conversationId) => parseDesktopChatAppResult(await runScript({
      MCP_V3_WAKE_TEXT: text,
      ...(conversationId === undefined ? {} : { MCP_V3_WAKE_CONVERSATION: conversationId }),
    })),
    openConversations: async () => parseDesktopChatAppInspect(await runScript({ MCP_V3_WAKE_INSPECT: "1" })),
  };

  async function runScript(env: Record<string, string>): Promise<string> {
    await mkdir(options.scriptDirectory, { recursive: true });
    // Written each time, so an update never runs an old copy. UTF-8 with BOM for Windows PowerShell.
    await writeFile(scriptPath, "\uFEFF" + DESKTOP_CHAT_APP_SCRIPT, "utf8");
    return new Promise((resolve) => {
      const child = run(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, ...env },
      });
      let output = "";
      let settled = false;
      const finish = (result: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(JSON.stringify({ outcome: "failed", detail: "timeout" }));
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (output.length < 8_192) output += chunk;
      });
      child.on("error", (error) => finish(JSON.stringify({ outcome: "failed", detail: error.message })));
      child.on("close", () => finish(output));
    });
  }
}

export function parseDesktopChatAppResult(output: string): { outcome: ChatWakeOutcome; detail?: string } {
  const line = output.trim().split(/\r?\n/u).at(-1) ?? "";
  try {
    const parsed = JSON.parse(line) as { outcome?: unknown; detail?: unknown };
    if (typeof parsed.outcome === "string" && OUTCOMES.has(parsed.outcome as ChatWakeOutcome)) {
      return {
        outcome: parsed.outcome as ChatWakeOutcome,
        ...(typeof parsed.detail === "string" ? { detail: parsed.detail.slice(0, 200) } : {}),
      };
    }
  } catch {
    // Falls through to a failure that names what came back.
  }
  return { outcome: "failed", detail: `unexpected output: ${line.slice(0, 120)}` };
}

/** The conversation the app shows, when its address can be read. */
export function parseDesktopChatAppInspect(output: string): OpenConversation[] {
  const line = output.trim().split(/\r?\n/u).at(-1) ?? "";
  try {
    const parsed = JSON.parse(line) as { outcome?: unknown; conversationId?: unknown; answering?: unknown };
    if (parsed.outcome === "inspect" && typeof parsed.conversationId === "string" &&
        /^[A-Za-z0-9-]{8,80}$/u.test(parsed.conversationId)) {
      return [{ conversationId: parsed.conversationId, answering: parsed.answering === true }];
    }
  } catch {
    // Nothing readable: no conversation known.
  }
  return [];
}
