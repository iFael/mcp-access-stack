import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { ChatWake, chatWakeText, type ChatWakeOutcome, type ChatWakeStatus, type ChatWakeTarget } from "../../../src/companion/chat-wake.js";
import { createDesktopChatAppTarget, DESKTOP_CHAT_APP_SCRIPT, parseDesktopChatAppResult } from "../../../src/companion/desktop-chat-app.js";

function target(name: ChatWakeTarget["name"], outcomes: ChatWakeOutcome[]): ChatWakeTarget & { texts: string[] } {
  const texts: string[] = [];
  return {
    name,
    texts,
    deliver: async (text) => {
      texts.push(text);
      return { outcome: outcomes.length > 1 ? outcomes.shift()! : outcomes[0]! };
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not reached.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("ChatWake", () => {
  it("writes one fixed notice in the ChatGPT app and never the user's words", async () => {
    const app = target("app", ["sent"]);
    const statuses: ChatWakeStatus[] = [];
    const wake = new ChatWake({ targets: () => [app], onStatus: (status) => statuses.push(status), spacingMs: 10, retryMs: 10 });
    wake.queue({ kind: "message", messageId: "msg_aaaaaaaa" });
    wake.queue({ kind: "task", taskId: "0f8fad5b-d9cb-469f-a165-70867728950e", state: "failed", exitCode: 1 });
    await until(() => wake.status().recent.length === 1);
    expect(app.texts).toEqual([chatWakeText([
      { kind: "message", messageId: "msg_aaaaaaaa" },
      { kind: "task", taskId: "0f8fad5b-d9cb-469f-a165-70867728950e", state: "failed", exitCode: 1 },
    ])]);
    expect(app.texts[0]).toBe("[MCP V3, aviso automático do companion, não escrito pelo usuário]\n" +
      "- O usuário escreveu para a tarefa (no cartão do chat ou no popup do MCP V3). Chame browser_user_messages para ler.\n" +
      "- A tarefa em segundo plano 0f8fad5b-d9cb-469f-a165-70867728950e terminou: failed, código 1. Veja com get_background_task.\n" +
      "Continue a tarefa de onde parou.");
    expect(wake.status()).toEqual({ enabled: true, waiting: 0,
      recent: [{ at: expect.any(Number), kinds: ["message", "task"], target: "app" }] });
    expect(statuses.at(-1)).toEqual(wake.status());
    wake.close();
  });

  it("falls back to the Chrome tab only when the app is not there, and waits while ChatGPT answers", async () => {
    const app = target("app", ["unavailable", "busy", "sent"]);
    const chrome = target("chrome", ["typing"]);
    const wake = new ChatWake({ targets: () => [app, chrome], spacingMs: 1, retryMs: 20 });
    wake.queue({ kind: "handback", tabId: "personal:7", reason: "Faça login" });
    await until(() => wake.status().recent.length === 1);
    // No app: the tab had the user typing. Then the app answered busy; the third try went through.
    expect(app.texts).toHaveLength(3);
    expect(chrome.texts).toHaveLength(1);
    expect(wake.status().recent[0]).toMatchObject({ kinds: ["handback"], target: "app" });
    wake.close();
  });

  it("drops what the agent already got, and a handback the agent took with browser_wait", async () => {
    const app = target("app", ["sent"]);
    let open = true;
    const wake = new ChatWake({ targets: () => [app], isOpen: () => open, spacingMs: 1, retryMs: 1 });
    open = false;
    wake.queue({ kind: "message", messageId: "msg_aaaaaaaa" });
    await wake.settled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.texts).toEqual([]);
    expect(wake.status().waiting).toBe(0);

    const later = new ChatWake({ targets: () => [target("app", ["busy"])], retryMs: 60_000 });
    later.queue({ kind: "handback", tabId: "personal:7" });
    later.resolveHandback("personal:7");
    expect(later.status().waiting).toBe(0);
    later.close();
    wake.close();
  });

  it("does nothing while off, and says why it could not write", async () => {
    const app = target("app", ["unavailable"]);
    const chrome = target("chrome", ["failed"]);
    const wake = new ChatWake({ targets: () => [app, chrome], spacingMs: 1, retryMs: 60_000 });
    wake.setEnabled(false);
    wake.queue({ kind: "message", messageId: "msg_aaaaaaaa" });
    expect(wake.status()).toEqual({ enabled: false, waiting: 0, recent: [] });
    wake.setEnabled(true);
    wake.queue({ kind: "message", messageId: "msg_aaaaaaaa" });
    await until(() => wake.status().lastError !== undefined);
    expect(wake.status()).toMatchObject({ waiting: 1, lastError: "Não consegui escrever na aba do ChatGPT." });
    wake.close();
  });
});

describe("the ChatGPT app for Windows", () => {
  it("runs the UI Automation script hidden, with the notice in the environment and not on the command line", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-chat-wake-"));
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const app = createDesktopChatAppTarget({
      scriptDirectory: directory,
      powershellPath: "powershell.exe",
      spawnProcess: ((command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
        (child.stdout as EventEmitter & { setEncoding(): void }).setEncoding = () => undefined;
        setImmediate(() => {
          child.stdout.emit("data", "{\"outcome\":\"sent\"}\r\n");
          child.emit("close", 0);
        });
        return child;
      }) as never,
    })!;
    await expect(app.deliver("[MCP V3, aviso]")).resolves.toEqual({ outcome: "sent" });
    const [call] = calls;
    expect(call!.args).toEqual(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File",
      path.join(directory, "chat-wake-app.ps1")]);
    expect(call!.args.join(" ")).not.toContain("aviso");
    expect(call!.options).toMatchObject({ windowsHide: true, env: expect.objectContaining({ MCP_V3_WAKE_TEXT: "[MCP V3, aviso]" }) });
    const script = await readFile(path.join(directory, "chat-wake-app.ps1"), "utf8");
    expect(script).toContain("$env:MCP_V3_WAKE_TEXT");
    expect(script).not.toMatch(/SendKeys|Clipboard/u);
  });

  (process.platform === "win32" ? it : it.skip)("is a script Windows PowerShell parses", () => {
    const errors = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:SCRIPT_UNDER_TEST, [ref]$null, [ref]$e); $e.Count"],
    { env: { ...process.env, SCRIPT_UNDER_TEST: DESKTOP_CHAT_APP_SCRIPT }, encoding: "utf8" });
    expect(errors.trim()).toBe("0");
  });

  it("reads only the outcomes it knows", () => {
    expect(parseDesktopChatAppResult("{\"outcome\":\"busy\"}")).toEqual({ outcome: "busy" });
    expect(parseDesktopChatAppResult("{\"outcome\":\"typing\",\"detail\":\"x\"}")).toEqual({ outcome: "typing", detail: "x" });
    expect(parseDesktopChatAppResult("{\"outcome\":\"launch\"}")).toMatchObject({ outcome: "failed" });
    expect(parseDesktopChatAppResult("")).toMatchObject({ outcome: "failed" });
  });
});
