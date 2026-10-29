import type { McpConversationCall } from "@vs-code-gpt/shared";
import type { ChatWakeEvent } from "./chat-wake.js";

// Which ChatGPT conversation each thing the agent started belongs to, so the
// chat wake writes about it there and in no other conversation, whatever the
// user has open. Every call carries ChatGPT's id for its conversation; the
// ids the call names or gets back (a task, a tab, an update, a CI watch) are
// filed under it. Which conversation that is in the app (its title there) is
// learned from what the app shows when a call arrives: the one conversation
// answering then is most likely the one making the call. Another conversation
// may be answering in the background, so it counts only once two such looks,
// apart in time, agree, and a look that disagrees unlearns it. It is looked at
// again now and then, since a title can change.

/** The ChatGPT conversation the app shows ("title:<title>"). */
export interface OpenConversation {
  conversationId: string;
  answering: boolean;
}

export interface ConversationBookOptions {
  /** The conversations open right now in the app. */
  openConversations: () => Promise<readonly OpenConversation[]>;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

const MAX_IDS = 500;
const MAX_SESSIONS = 50;
const LEARN_SPACING_MS = 5_000;
// Once two looks agree, a look now and then is enough.
const RELEARN_SPACING_MS = 60_000;
// Alone in this window, a conversation also owns what no call named.
const SOLE_SESSION_WINDOW_MS = 2 * 60 * 60 * 1000;

export class ConversationBook {
  private readonly sessionOfId = new Map<string, string>();
  private readonly conversationOfSession = new Map<string, string>();
  private readonly lastSeen = new Map<string, string>();
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
    const spacing = this.conversationOfSession.has(call.session) ? RELEARN_SPACING_MS : LEARN_SPACING_MS;
    const last = this.lastLearnAt.get(call.session);
    if (last !== undefined && now - last < spacing) return;
    touch(this.lastLearnAt, call.session, now, MAX_SESSIONS);
    void this.learn(call.session);
  }

  /** The conversation this event belongs to, when known. */
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
    const before = this.lastSeen.get(session);
    touch(this.lastSeen, session, conversationId, MAX_SESSIONS);
    if (before !== conversationId) {
      this.conversationOfSession.delete(session);
      return;
    }
    // A conversation has one session; an older session that pointed to it is stale.
    for (const [other, id] of this.conversationOfSession) {
      if (id === conversationId && other !== session) this.conversationOfSession.delete(other);
    }
    touch(this.conversationOfSession, session, conversationId, MAX_SESSIONS);
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
