// MCP wakes the ChatGPT conversation by itself: when the agent is not
// answering and something it waits for happens (a message from the reply card
// or the popup, a tab handed back, a background task that ended), the
// companion writes it into the conversation and sends it. What the user wrote
// goes in as they wrote it, as if typed in the chat, and then counts as
// delivered; a message that only rode on the result of one of the agent's
// calls still goes in once its turn ends, since the agent may have read past
// it. The rest is a short MCP V3 note. While the agent is answering, or the
// user is typing, nothing is written and it waits. Only the user's own words,
// the companion's notes and the agent's own ids go in, nothing from a page.
// The user can turn it off in the extension popup.
//
// Each notice goes to the conversation it belongs to (see
// conversation-book.ts), never to whichever one is open: it is written in the
// ChatGPT app for Windows only while the app shows that conversation. Until
// then it waits, the user's own words with no time limit, and a Windows
// notification tells the user once that the conversation has news.

import type { OpenConversation } from "./conversation-book.js";

export type ChatWakeEvent =
  | { kind: "message"; messageId: string; text: string; taskId?: string; passedAlong?: boolean }
  | { kind: "task"; taskId: string; workspaceId?: string; state: "succeeded" | "failed"; exitCode?: number }
  | {
    kind: "checks";
    watchId: string;
    workspaceId: string;
    repository: string;
    commitSha: string;
    state: "passed" | "failed" | "timed_out" | "error";
  }
  | { kind: "handback"; tabId: string; reason?: string }
  | { kind: "update"; updateId: string; workspaceId: string; state: "succeeded" | "failed" | "needs_confirmation" };

/** What a place that shows the conversation did with the notice. */
export type ChatWakeOutcome =
  | "sent"
  | "busy" // the agent is answering
  | "typing" // the user has something in the message field
  | "unavailable" // no app window or tab to write to
  | "elsewhere" // the app shows another conversation
  | "failed";

export interface ChatWakeTarget {
  readonly name: "app";
  /** Writes the notice in this conversation (chatgpt.com/c/<id>); without one, in the conversation open. */
  deliver(text: string, conversationId?: string): Promise<{ outcome: ChatWakeOutcome; detail?: string }>;
  /** The conversations this place shows and whether each is answering, without writing. */
  openConversations?(): Promise<OpenConversation[]>;
}

export interface ChatWakeStatus {
  enabled: boolean;
  waiting: number;
  lastError?: string;
  recent: Array<{ at: number; kinds: ChatWakeEvent["kind"][]; target: ChatWakeTarget["name"] }>;
}

export interface ChatWakeOptions {
  /** Where to write, first that works wins. */
  targets: () => readonly ChatWakeTarget[];
  /**
   * The conversation an event belongs to. With it, events go only to their
   * own conversation, and one whose conversation is unknown is not written.
   */
  conversationOf?: (event: ChatWakeEvent) => string | undefined;
  /** False once the agent already got the event through its own calls. */
  isOpen?: (event: ChatWakeEvent) => boolean;
  /** A message that only went along with the result of another call, which the agent may have read past. */
  passedAlong?: (event: ChatWakeEvent & { kind: "message" }) => boolean;
  onStatus?: (status: ChatWakeStatus) => void;
  /** A Windows notification, shown once per event that cannot be written yet or waits for the user. */
  notify?: (notice: { title: string; body: string }) => void;
  /** What went into the conversation; the user's messages there need no other delivery. */
  onSent?: (events: readonly ChatWakeEvent[]) => void;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
  spacingMs?: number;
  retryMs?: number;
  ttlMs?: number;
}

type Queued = ChatWakeEvent & { at: number };

const MAX_EVENTS = 20;

export class ChatWake {
  private enabled = true;
  private pending: Queued[] = [];
  private readonly notified = new WeakSet<Queued>();
  private recent: ChatWakeStatus["recent"] = [];
  private lastError: string | undefined;
  private lastSentAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private rerun = false;
  private closed = false;
  private readonly now: () => number;
  private readonly spacingMs: number;
  private readonly retryMs: number;
  private readonly ttlMs: number;

  constructor(private readonly options: ChatWakeOptions) {
    this.now = options.now ?? Date.now;
    this.spacingMs = options.spacingMs ?? 30_000;
    this.retryMs = options.retryMs ?? 60_000;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
  }

  /** Something the agent may be waiting for happened. */
  queue(event: ChatWakeEvent): void {
    if (!this.enabled || this.closed) return;
    const queued: Queued = { ...event, at: this.now() };
    this.pending = [...this.pending, queued].slice(-MAX_EVENTS);
    // The update waits for the user whether or not the conversation is open.
    if (event.kind === "update" && event.state === "needs_confirmation") this.notifyOnce([queued]);
    this.publish();
    this.schedule(0);
  }

  /** The agent took the handed-back tab with browser_wait. */
  resolveHandback(tabId: string): void {
    const before = this.pending.length;
    this.pending = this.pending.filter((event) => event.kind !== "handback" || event.tabId !== tabId);
    if (this.pending.length !== before) this.publish();
  }

  // The extension sends its switch on every connect, so this also refreshes the popup.
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.pending = [];
      this.lastError = undefined;
      this.clearTimer();
    }
    this.publish();
  }

  status(): ChatWakeStatus {
    return {
      enabled: this.enabled,
      waiting: this.pending.length,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      recent: this.recent.slice(-3),
    };
  }

  /** Resolves when the attempt in progress, if any, ends. For tests and shutdown. */
  async settled(): Promise<void> {
    while (this.running) await this.running;
  }

  close(): void {
    this.closed = true;
    this.clearTimer();
  }

  private schedule(delayMs: number): void {
    if (this.closed || !this.enabled || this.pending.length === 0) return;
    const spacing = this.lastSentAt === undefined ? 0 : this.lastSentAt + this.spacingMs - this.now();
    const wait = Math.max(delayMs, spacing, 0);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start();
    }, wait);
    this.timer.unref?.();
  }

  private start(): void {
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = this.run().catch((error: unknown) => {
      this.options.log?.({ event: "mcp_v3_chat_wake_error", message: error instanceof Error ? error.message : String(error) });
    }).finally(() => {
      this.running = undefined;
      if (this.rerun) {
        this.rerun = false;
        this.schedule(0);
      }
    });
  }

  private async run(): Promise<void> {
    if (!this.enabled || this.pending.length === 0) return;
    const now = this.now();
    const snapshot = new Set(this.pending);
    // What the user wrote waits for its conversation with no time limit.
    const open = this.pending.filter((event) =>
      (event.kind === "message" || now - event.at < this.ttlMs) && (this.options.isOpen?.(event) ?? true));
    if (open.length === 0) {
      this.pending = [];
      this.publish();
      return;
    }
    const prepare = (event: Queued): Queued =>
      event.kind === "message" && this.options.passedAlong?.(event) === true ? { ...event, passedAlong: true } : event;
    // One notice per conversation; one that is not open does not hold up the others.
    const groups = new Map<string | undefined, Queued[]>();
    const unknown: Queued[] = [];
    for (const event of open) {
      const owner = this.options.conversationOf ? this.options.conversationOf(event) : undefined;
      if (this.options.conversationOf && owner === undefined) {
        // Never in a conversation that is not theirs: they wait until theirs is known.
        unknown.push(event);
        continue;
      }
      groups.set(owner, [...(groups.get(owner) ?? []), event]);
    }
    const keep = () => [...open, ...this.pending.filter((event) => !snapshot.has(event))];
    let lastError = unknown.length > 0
      ? "Ainda não sei de qual conversa do ChatGPT veio o aviso; ele espera e não vai para outra conversa."
      : undefined;
    this.notifyOnce(unknown);
    for (const [conversationId, batch] of groups) {
      const events = batch.map(prepare);
      const text = chatWakeText(events);
      let waiting = false;
      let failure = "O app do ChatGPT não está aberto.";
      for (const target of this.options.targets()) {
        let result: Awaited<ReturnType<ChatWakeTarget["deliver"]>>;
        try {
          result = await target.deliver(text, conversationId);
        } catch (error) {
          result = { outcome: "failed", detail: error instanceof Error ? error.message : String(error) };
        }
        this.options.log?.({ event: "mcp_v3_chat_wake_attempt", target: target.name, outcome: result.outcome,
          ...(conversationId === undefined ? {} : { conversationId }),
          ...(result.detail === undefined ? {} : { detail: result.detail.slice(0, 200) }) });
        if (result.outcome === "sent") {
          const sentAt = this.now();
          // Events that arrived while writing, or belong to another conversation, wait for the next notice.
          const written = new Set(batch);
          this.pending = this.pending.filter((event) =>
            !snapshot.has(event) || (!written.has(event) && open.includes(event)));
          this.lastSentAt = sentAt;
          this.lastError = undefined;
          this.recent = [...this.recent, { at: sentAt, kinds: [...new Set(events.map((event) => event.kind))], target: target.name }].slice(-5);
          try {
            this.options.onSent?.(events);
          } catch {
            // At worst the agent also gets the message with its next call.
          }
          this.publish();
          this.schedule(0);
          return;
        }
        if (result.outcome === "busy" || result.outcome === "typing") {
          // The conversation is there; it is just not the moment.
          waiting = true;
          break;
        }
        if (result.outcome === "failed") failure = "Não consegui escrever no app do ChatGPT.";
        if (result.outcome === "elsewhere") failure = "O app mostra outra conversa; o aviso espera a conversa dele ser aberta.";
      }
      if (!waiting) {
        lastError ??= failure;
        this.notifyOnce(batch);
      }
    }
    this.pending = keep();
    this.lastError = lastError;
    this.publish();
    this.schedule(this.retryMs);
  }

  // The user's own words need no notice: they know what they wrote.
  private notifyOnce(events: readonly Queued[]): void {
    const fresh = events.filter((event) => event.kind !== "message" && !this.notified.has(event));
    if (fresh.length === 0 || !this.options.notify) return;
    for (const event of fresh) this.notified.add(event);
    const confirm = fresh.some((event) => event.kind === "update" && event.state === "needs_confirmation");
    try {
      this.options.notify({
        title: confirm ? "O agente espera sua confirmação" : "O agente tem novidade no ChatGPT",
        body: `${chatWakeText(fresh).replaceAll("[MCP V3] ", "")}\n\nAbra no app do ChatGPT a conversa dessa tarefa: eu escrevo lá.`,
      });
    } catch {
      // The popup still shows what waits.
    }
  }

  private publish(): void {
    try {
      this.options.onStatus?.(this.status());
    } catch {
      // The popup only misses a refresh.
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

const CHECKS_STATE = { passed: "passou", failed: "falhou", timed_out: "o tempo acabou", error: "não deu para ler" } as const;
const UPDATE_STATE = { succeeded: "terminou", failed: "parou com um erro", needs_confirmation: "espera uma confirmação" } as const;

export function chatWakeText(events: readonly ChatWakeEvent[]): string {
  // The user's own words, as they wrote them.
  const parts = events.flatMap((event) => (event.kind === "message" ? [event.text.trim()] : [])).filter(Boolean);
  if (events.some((event) => event.kind === "message" && event.passedAlong === true)) {
    parts.unshift("[MCP V3] Escrevi isto enquanto você trabalhava e veio junto com o resultado de uma chamada sua. " +
      "Se ainda não fez o que peço, faça agora; se já fez, só confirme.");
  }
  const notes: string[] = [];
  for (const event of events.filter((entry) => entry.kind === "handback").slice(0, 3)) {
    notes.push(`[MCP V3] A aba ${event.tabId} foi devolvida${event.reason ? ` (${event.reason.slice(0, 120)})` : ""}. ` +
      "Chame browser_wait com forUser nessa aba para recebê-la.");
  }
  for (const event of events.filter((entry) => entry.kind === "task").slice(0, 5)) {
    notes.push(`[MCP V3] A tarefa em segundo plano ${event.taskId}` +
      `${event.workspaceId === undefined ? "" : ` (workspace ${event.workspaceId})`} terminou: ${event.state}` +
      `${event.exitCode === undefined ? "" : `, código ${event.exitCode}`}. Veja com get_background_task.`);
  }
  for (const event of events.filter((entry) => entry.kind === "checks").slice(0, 5)) {
    notes.push(`[MCP V3] O CI de ${event.repository} em ${event.commitSha.slice(0, 7)} terminou: ${CHECKS_STATE[event.state]} ` +
      `(acompanhamento ${event.watchId}, workspace ${event.workspaceId}). Veja com github_wait_commit_checks_watch.`);
  }
  for (const event of events.filter((entry) => entry.kind === "update").slice(0, 3)) {
    notes.push(`[MCP V3] A atualização do MCP ${event.updateId} ${UPDATE_STATE[event.state]} ` +
      `(workspace ${event.workspaceId}). Veja com mcp_update ` +
      `${JSON.stringify({ action: "read", workspaceId: event.workspaceId, updateId: event.updateId })}.`);
  }
  if (notes.length > 0) parts.push(notes.join("\n"));
  return parts.join("\n\n");
}
