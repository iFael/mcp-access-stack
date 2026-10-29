import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { ChatWake, chatWakeText, type ChatWakeOutcome, type ChatWakeStatus, type ChatWakeTarget } from "../../../src/companion/chat-wake.js";
import { ConversationBook, type OpenConversation } from "../../../src/companion/conversation-book.js";
import {
  createDesktopChatAppTarget,
  DESKTOP_CHAT_APP_SCRIPT,
  parseDesktopChatAppInspect,
  parseDesktopChatAppResult,
} from "../../../src/companion/desktop-chat-app.js";

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

describe("ChatWake per conversation", () => {
  it("writes each notice only in its own conversation, holds the others and notifies each one once", async () => {
    const delivered: Array<{ text: string; conversationId?: string }> = [];
    let shown = "conversation-b";
    const app: ChatWakeTarget = { name: "app", deliver: async (text, conversationId) => {
      delivered.push({ text, ...(conversationId === undefined ? {} : { conversationId }) });
      return { outcome: conversationId === shown ? "sent" : "elsewhere" };
    } };
    const notices: Array<{ title: string; body: string }> = [];
    const owners: Record<string, string> = { "task-a": "conversation-a", "task-b": "conversation-b" };
    const wake = new ChatWake({ targets: () => [app], spacingMs: 1, retryMs: 10,
      notify: (notice) => { notices.push(notice); },
      conversationOf: (event) => (event.kind === "task" ? owners[event.taskId] : undefined) });
    wake.queue({ kind: "task", taskId: "task-a", state: "succeeded" });
    wake.queue({ kind: "task", taskId: "task-b", state: "failed" });
    wake.queue({ kind: "message", messageId: "msg_cccccccc", text: "de onde?" });
    await until(() => wake.status().recent.length === 1);
    expect(delivered.find((entry) => entry.text.includes("task-b"))).toEqual(
      { text: expect.stringContaining("task-b"), conversationId: "conversation-b" });
    expect(delivered.some((entry) => entry.text.includes("task-a") && entry.text.includes("task-b"))).toBe(false);
    // Conversation A is not open: retried, never written elsewhere, notified once.
    await until(() => delivered.filter((entry) => entry.conversationId === "conversation-a").length >= 3);
    expect(notices).toEqual([{ title: "O agente tem novidade no ChatGPT", body: expect.stringContaining("task-a") }]);
    // Nobody knows the message's conversation: it is never written anywhere, and the user is not told about their own words.
    expect(delivered.some((entry) => entry.text.includes("de onde?"))).toBe(false);
    expect(wake.status()).toMatchObject({ waiting: 2 });
    // The user opens conversation A: the notice goes in there.
    shown = "conversation-a";
    await until(() => wake.status().recent.length === 2);
    expect(delivered.at(-1)).toEqual({ text: expect.stringContaining("task-a"), conversationId: "conversation-a" });
    expect(notices).toHaveLength(1);
    wake.close();
  });

  it("notifies an update that waits for confirmation at once, and keeps the user's words with no time limit", async () => {
    let now = 0;
    const notices: Array<{ title: string; body: string }> = [];
    const app = target("app", ["elsewhere"]);
    const wake = new ChatWake({ targets: () => [app], now: () => now, spacingMs: 1, retryMs: 60_000, ttlMs: 1_000,
      notify: (notice) => { notices.push(notice); }, conversationOf: () => "conversation-a" });
    wake.queue({ kind: "update", updateId: "upd-1", workspaceId: "w", state: "needs_confirmation" });
    expect(notices).toEqual([{ title: "O agente espera sua confirmação", body: expect.stringContaining("upd-1") }]);
    wake.queue({ kind: "message", messageId: "msg_dddddddd", text: "Escolho A) Manter" });
    await until(() => app.texts.length === 1);
    await wake.settled();
    expect(notices).toHaveLength(1);
    now = 10_000;
    (wake as unknown as { start(): void }).start();
    await until(() => app.texts.length === 2);
    await wake.settled();
    expect(app.texts[1]).toBe("Escolho A) Manter");
    wake.close();
  });
});

describe("ConversationBook", () => {
  it("learns a conversation once two looks while its call arrives agree, and unlearns it when one disagrees", async () => {
    let open: OpenConversation[] = [
      { conversationId: "title:Conversa A", answering: true },
    ];
    let now = 1_000;
    let looks = 0;
    const book = new ConversationBook({ openConversations: async () => { looks += 1; return open; }, now: () => now });
    const taskA = { kind: "task", taskId: "task-a", state: "succeeded" } as const;
    book.noteCall({ session: "session-a", ids: ["task-a"] });
    await until(() => looks === 1);
    // One look is not enough: another conversation may be answering in the background.
    expect(book.conversationOf(taskA)).toBeUndefined();
    now += 1_000;
    book.noteCall({ session: "session-a", ids: [] });
    expect(looks).toBe(1);
    now += 5_000;
    book.noteCall({ session: "session-a", ids: [] });
    await until(() => book.conversationOf(taskA) !== undefined);
    expect(book.conversationOf(taskA)).toBe("title:Conversa A");
    // Alone in the last hours, the conversation also owns what no call named.
    expect(book.conversationOf({ kind: "update", updateId: "upd_x", workspaceId: "w", state: "succeeded" })).toBe("title:Conversa A");

    // Known, it is looked at again only after a minute; a look that disagrees unlearns it.
    open = [{ conversationId: "title:Conversa B", answering: true }];
    now += 10_000;
    book.noteCall({ session: "session-a", ids: [] });
    expect(looks).toBe(2);
    now += 60_000;
    book.noteCall({ session: "session-a", ids: [] });
    await until(() => looks === 3);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(book.conversationOf(taskA)).toBeUndefined();

    // Two conversations answering: nothing is learned.
    open = [{ conversationId: "title:Conversa A", answering: true }, { conversationId: "title:Conversa C", answering: true }];
    now += 10_000;
    book.noteCall({ session: "session-b", ids: ["task-b"] });
    now += 10_000;
    book.noteCall({ session: "session-b", ids: [] });
    await until(() => looks === 5);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(book.conversationOf({ kind: "task", taskId: "task-b", state: "succeeded" })).toBeUndefined();
    expect(book.conversationOf({ kind: "update", updateId: "upd_x", workspaceId: "w", state: "succeeded" })).toBeUndefined();
  });

  it("parses what the app shows without writing", () => {
    expect(parseDesktopChatAppInspect('{"outcome":"inspect","conversationId":"title:Teste funcional inconclusivo","answering":true}'))
      .toEqual([{ conversationId: "title:Teste funcional inconclusivo", answering: true }]);
    expect(parseDesktopChatAppInspect('{"outcome":"inspect","conversationId":"id:6720f1c2-0a1b","answering":false}'))
      .toEqual([{ conversationId: "id:6720f1c2-0a1b", answering: false }]);
    expect(parseDesktopChatAppInspect('{"outcome":"inspect","conversationId":"","answering":true}')).toEqual([]);
    expect(parseDesktopChatAppInspect('{"outcome":"inspect","conversationId":"Conversa","answering":true}')).toEqual([]);
    expect(parseDesktopChatAppResult('{"outcome":"elsewhere","detail":"other-conversation"}'))
      .toEqual({ outcome: "elsewhere", detail: "other-conversation" });
    expect(DESKTOP_CHAT_APP_SCRIPT).toContain("MCP_V3_WAKE_CONVERSATION");
    expect(DESKTOP_CHAT_APP_SCRIPT).toContain("'switched'");
  });
});

describe("ChatWake", () => {
  it("writes what the user wrote in the ChatGPT app as they wrote it, with short notes for the rest", async () => {
    const app = target("app", ["sent"]);
    const statuses: ChatWakeStatus[] = [];
    const sent: unknown[] = [];
    const wake = new ChatWake({ targets: () => [app], onStatus: (status) => statuses.push(status),
      onSent: (events) => sent.push(...events), spacingMs: 10, retryMs: 10 });
    wake.queue({ kind: "message", messageId: "msg_aaaaaaaa", text: "Use o CPF do titular" });
    wake.queue({ kind: "task", taskId: "0f8fad5b-d9cb-469f-a165-70867728950e", state: "failed", exitCode: 1 });
    await until(() => wake.status().recent.length === 1);
    expect(app.texts).toEqual([chatWakeText([
      { kind: "message", messageId: "msg_aaaaaaaa", text: "Use o CPF do titular" },
      { kind: "task", taskId: "0f8fad5b-d9cb-469f-a165-70867728950e", state: "failed", exitCode: 1 },
    ])]);
    expect(app.texts[0]).toBe("Use o CPF do titular\n\n" +
      "[MCP V3] A tarefa em segundo plano 0f8fad5b-d9cb-469f-a165-70867728950e terminou: failed, código 1. Veja com get_background_task.");
    expect(sent).toEqual([expect.objectContaining({ messageId: "msg_aaaaaaaa" }), expect.objectContaining({ kind: "task" })]);
    expect(chatWakeText([{ kind: "message", messageId: "msg_bbbbbbbb", text: "  só isso  " }])).toBe("só isso");
    expect(chatWakeText([{ kind: "checks", watchId: "w-1", workspaceId: "mcp-access-stack", repository: "iFael/mcp-access-stack",
      commitSha: "abcdef1234567890abcdef1234567890abcdef12", state: "failed" }])).toBe(
      "[MCP V3] O CI de iFael/mcp-access-stack em abcdef1 terminou: falhou (acompanhamento w-1, workspace mcp-access-stack). " +
      "Veja com github_wait_commit_checks_watch.");
    expect(chatWakeText([{ kind: "update", updateId: "upd_00000000-0000-4000-8000-000000000001", workspaceId: "mcp-access-stack",
      state: "needs_confirmation" }])).toBe("[MCP V3] A atualização do MCP upd_00000000-0000-4000-8000-000000000001 espera uma " +
      "confirmação (workspace mcp-access-stack). Veja com mcp_update action=read.");
    expect(wake.status()).toEqual({ enabled: true, waiting: 0,
      recent: [{ at: expect.any(Number), kinds: ["message", "task"], target: "app" }] });
    expect(statuses.at(-1)).toEqual(wake.status());
    wake.close();
  });

  it("waits while ChatGPT answers and writes once it stops", async () => {
    const app = target("app", ["unavailable", "busy", "sent"]);
    const wake = new ChatWake({ targets: () => [app], spacingMs: 1, retryMs: 20 });
    wake.queue({ kind: "handback", tabId: "personal:7", reason: "Faça login" });
    await until(() => wake.status().recent.length === 1);
    expect(app.texts).toHaveLength(3);
    expect(wake.status().recent[0]).toMatchObject({ kinds: ["handback"], target: "app" });
    wake.close();
  });

  it("drops what the agent already got, and a handback the agent took with browser_wait", async () => {
    const app = target("app", ["sent"]);
    let open = true;
    const wake = new ChatWake({ targets: () => [app], isOpen: () => open, spacingMs: 1, retryMs: 1 });
    open = false;
    wake.queue({ kind: "message", messageId: "msg_aaaaaaaa", text: "Use o CPF do titular" });
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

  it("still writes a message that only rode on a call's result, once the agent's turn ends", async () => {
    const app = target("app", ["busy", "sent"]);
    let passed = false;
    const wake = new ChatWake({ targets: () => [app], isOpen: () => true, passedAlong: () => passed, spacingMs: 1, retryMs: 10 });
    wake.queue({ kind: "message", messageId: "msg_aaaaaaaa", text: "Atualize a .codex" });
    // The agent is answering; meanwhile its next call carries the message.
    await until(() => app.texts.length === 1);
    passed = true;
    await until(() => wake.status().recent.length === 1);
    expect(app.texts[0]).toBe("Atualize a .codex");
    expect(app.texts[1]).toBe("[MCP V3] Escrevi isto enquanto você trabalhava e veio junto com o resultado de uma chamada sua. " +
      "Se ainda não fez o que peço, faça agora; se já fez, só confirme.\n\nAtualize a .codex");
    wake.close();
  });

  it("does nothing while off, and says why it could not write", async () => {
    const app = target("app", ["failed"]);
    const wake = new ChatWake({ targets: () => [app], spacingMs: 1, retryMs: 60_000 });
    wake.setEnabled(false);
    wake.queue({ kind: "message", messageId: "msg_aaaaaaaa", text: "Use o CPF do titular" });
    expect(wake.status()).toEqual({ enabled: false, waiting: 0, recent: [] });
    wake.setEnabled(true);
    wake.queue({ kind: "message", messageId: "msg_aaaaaaaa", text: "Use o CPF do titular" });
    await until(() => wake.status().lastError !== undefined);
    expect(wake.status()).toMatchObject({ waiting: 1, lastError: "Não consegui escrever no app do ChatGPT." });
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
