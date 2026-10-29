import type { McpConversationCall } from "@vs-code-gpt/shared";
import type { ChatWakeEvent } from "./chat-wake.js";

// Which ChatGPT conversation each thing the agent started belongs to, so the
// chat wake writes about it there and in no other conversation, whatever the
// user has open. Every call carries ChatGPT's id for its conversation; the
// ids the call names or gets back (a task, a tab, an update, a CI watch) are
// filed under it. The conversation's address (chatgpt.com/c/<id>) is learned
// the first time a call arrives while exactly one conversation is answering:
// that is the one making the call.

/** A ChatGPT conversation that is open in the app or in a Chrome tab. */
export interface OpenConversation {
  conversationId: string;
  answering: boolean;
}

export interface ConversationBookOptions {
  /** The conversations open right now, in the app and in Chrome. */
  openConversations: () => Promise<readonly OpenConversation[]>;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

const MAX_IDS = 500;
const MAX_SESSIONS = 50;
const LEARN_SPACING_MS = 5_000;
// Alone in this window, a conversation also owns what no call named.
const SOLE_SESSION_WINDOW_MS = 2 * 60 * 60 * 1000;

export class ConversationBook {
  private readonly sessionOfId = new Map<string, string>();
  private readonly conversationOfSession = new Map<string, string>();
  private readonly lastCallAt = new Map<string, number>();
  private readonly lastLearnAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: ConversationBookOptions) {
    this.now = options.now ?? Date.now;
  }

  noteCall(call: Pick<McpConversationCall, "session" | "ids">): void {
    const now = this.now();
    touch(this.lastCallAt, call.session, now, MAX_SESSIONS);
    for (const id of call.ids) touch(this.sessionOfId, id, call.session, MAX_IDS);
    if (this.conversationOfSession.has(call.session)) return;
    const last = this.lastLearnAt.get(call.session);
    if (last !== undefined && now - last < LEARN_SPACING_MS) return;
    touch(this.lastLearnAt, call.session, now, MAX_SESSIONS);
    void this.learn(call.session);
  }

  /** The conversation (its chatgpt.com/c/<id>) this event belongs to, when known. */
  conversationOf(event: ChatWakeEvent): string | undefined {
    const session = this.sessionOf(event);
    return session === undefined ? undefined : this.conversationOfSession.get(session);
  }

  private sessionOf(event: ChatWakeEvent): string | undefined {
    const key = eventKey(event);
    const session = key === undefined ? undefined : this.sessionOfId.get(key);
    if (session !== undefined) return session;
    const recent = [...this.lastCallAt].filter(([, at]) => this.now() - at < SOLE_SESSION_WINDOW_MS);
    return recent.length === 1 ? recent[0]![0] : undefined;
  }

  private async learn(session: string): Promise<void> {
    let open: readonly OpenConversation[];
    try {
      open = await this.options.openConversations();
    } catch (error) {
      this.options.log?.({ event: "mcp_v3_conversation_learn_failed", message: error instanceof Error ? error.message : String(error) });
      return;
    }
    const answering = [...new Set(open.filter((entry) => entry.answering).map((entry) => entry.conversationId))];
    this.options.log?.({ event: "mcp_v3_conversation_learn", answering: answering.length, open: open.length });
    if (answering.length !== 1) return;
    const conversationId = answering[0]!;
    // A conversation has one session; an older session that pointed to it is stale.
    for (const [other, id] of this.conversationOfSession) {
      if (id === conversationId && other !== session) this.conversationOfSession.delete(other);
    }
    touch(this.conversationOfSession, session, conversationId, MAX_SESSIONS);
  }
}

/** The conversation id in a ChatGPT address: chatgpt.com/c/<id>, also inside a project (/g/<project>/c/<id>). */
export function conversationIdOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(parsed.hostname)) return undefined;
    const match = /\/c\/([A-Za-z0-9-]{8,80})(?:\/|$)/.exec(parsed.pathname);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function eventKey(event: ChatWakeEvent): string | undefined {
  switch (event.kind) {
    case "message": return event.taskId;
    case "task": return event.taskId;
    case "checks": return event.watchId;
    case "handback": return event.tabId;
    case "update": return event.updateId;
  }
}

function touch<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value!);
}
