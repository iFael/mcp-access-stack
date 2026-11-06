import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { McpConversationCall } from "@vs-code-gpt/shared";
import type { ChatWakeEvent } from "./chat-wake.js";

/**
 * Associates asynchronous MCP event IDs with their initiating ChatGPT session.
 * A session such as "v1/..." is opaque: it cannot be mapped to a Desktop
 * conversation by observing which window happens to be answering. Deliver
 * only when the session itself names the exact chat ID visible in the app.
 */
export interface OpenConversation {
  conversationId: string;
  answering: boolean;
}

export interface ConversationBookOptions {
  openConversations: () => Promise<readonly OpenConversation[]>;
  file?: string;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => number;
}

const MAX_IDS = 500;
const CHAT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class ConversationBook {
  private readonly sessionOfId = new Map<string, string>();
  private readonly conversationOfCardMessage = new Map<string, string>();

  constructor(private readonly options: ConversationBookOptions) {
    this.load();
  }

  noteCall(call: Pick<McpConversationCall, "session" | "ids">): void {
    if (call.ids.length === 0) return;
    for (const id of call.ids) touch(this.sessionOfId, id, call.session, MAX_IDS);
    this.save();
  }

  /** A card message was entered in the conversation actually shown by the app. */
  async noteCardMessage(messageId: string): Promise<void> {
    const open = await this.options.openConversations();
    this.options.log?.({ event: "mcp_v3_conversation_card_message", open: open.length });
    if (open.length !== 1) return;
    touch(this.conversationOfCardMessage, messageId, open[0]!.conversationId, MAX_IDS);
  }

  conversationOf(event: ChatWakeEvent): string | undefined {
    const written = event.kind === "message" ? this.conversationOfCardMessage.get(event.messageId) : undefined;
    if (written !== undefined) return written;
    const key = eventKey(event);
    if (key === undefined) return undefined;
    const session = this.sessionOfId.get(key);
    if (session === undefined) return undefined;
    // Unlike the former foreground-title and single-recent-session heuristics,
    // equality of a host-supplied chat ID and the Desktop URL is verifiable.
    const id = session.startsWith("id:") ? session.slice(3) : session;
    return CHAT_ID.test(id) ? `id:${id}` : undefined;
  }

  private load(): void {
    if (this.options.file === undefined) return;
    try {
      const saved = JSON.parse(readFileSync(this.options.file, "utf8")) as { sessionOfId?: unknown };
      fill(this.sessionOfId, saved.sessionOfId);
      // Intentionally ignore legacy conversationOfSession/lastSeen persisted
      // from the unsafe GUI learning algorithm.
    } catch {
      // No book yet, or an unreadable one: start empty.
    }
  }

  private save(): void {
    if (this.options.file === undefined) return;
    try {
      mkdirSync(path.dirname(this.options.file), { recursive: true });
      const temporary = `${this.options.file}.tmp`;
      writeFileSync(temporary, JSON.stringify({ sessionOfId: [...this.sessionOfId] }));
      renameSync(temporary, this.options.file);
    } catch (error) {
      this.options.log?.({ event: "mcp_v3_conversation_book_save_failed", message: error instanceof Error ? error.message : String(error) });
    }
  }
}

function fill(map: Map<string, string>, entries: unknown): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries.slice(-MAX_IDS)) {
    if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") {
      map.set(entry[0], entry[1]);
    }
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
