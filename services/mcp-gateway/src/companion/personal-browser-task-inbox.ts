import { browserUserMessageSchema, type BrowserUserMessage } from "@vs-code-gpt/shared";

// Messages the user writes in the extension popup wait here until the agent's
// next call on their task takes them. The extension keeps its own copy until
// it hears they were delivered, and sends the undelivered ones again after a
// reconnect, so this inbox only needs to hold what is in flight.
const MAX_QUEUED = 50;
const MAX_REMEMBERED_DELIVERED = 500;
const MAX_TAB_IDS = 20;

interface QueuedMessage {
  message: BrowserUserMessage;
  tabIds: readonly string[];
}

export interface TaskInboxScope {
  taskId?: string;
  tabId?: string;
}

export class PersonalBrowserTaskInbox {
  private readonly queued = new Map<string, QueuedMessage>();
  private readonly delivered = new Set<string>();
  private readonly waiters = new Set<() => void>();

  get size(): number {
    return this.queued.size;
  }

  holds(id: string): boolean {
    return this.queued.has(id);
  }

  /** The text of a message still waiting for the agent. */
  textOf(id: string): string | undefined {
    return this.queued.get(id)?.message.text;
  }

  /** The task a message still waiting for the agent was written for. */
  taskIdOf(id: string): string | undefined {
    return this.queued.get(id)?.message.taskId;
  }

  /** Takes these messages, which reached the agent another way (written into the conversation). */
  takeIds(ids: readonly string[]): BrowserUserMessage[] {
    const taken: BrowserUserMessage[] = [];
    for (const id of ids) {
      const queued = this.queued.get(id);
      if (!queued) continue;
      this.queued.delete(id);
      this.remember(id);
      taken.push(queued.message);
    }
    return taken;
  }

  /**
   * Adds the messages of a "task-messages" push. Returns how many were new and
   * the ids already delivered, whose delivery the extension never heard of.
   */
  accept(raw: unknown): { added: number; addedIds: string[]; alreadyDelivered: string[] } {
    const alreadyDelivered: string[] = [];
    const addedIds: string[] = [];
    if (!isRecord(raw) || !Array.isArray(raw.messages)) return { added: 0, addedIds, alreadyDelivered };
    let added = 0;
    for (const entry of raw.messages.slice(0, MAX_QUEUED)) {
      if (!isRecord(entry)) continue;
      const parsed = browserUserMessageSchema.safeParse({
        id: entry.id,
        text: entry.text,
        sentAt: entry.sentAt,
        ...(typeof entry.taskId === "string" ? { taskId: entry.taskId } : {}),
      });
      if (!parsed.success) continue;
      const id = parsed.data.id;
      if (this.delivered.has(id)) alreadyDelivered.push(id);
      if (this.delivered.has(id) || this.queued.has(id)) continue;
      const tabIds = Array.isArray(entry.tabIds)
        ? entry.tabIds.filter((tabId): tabId is string =>
          typeof tabId === "string" && /^personal:\d{1,12}$/u.test(tabId)).slice(0, MAX_TAB_IDS)
        : [];
      this.queued.set(id, { message: parsed.data, tabIds });
      addedIds.push(id);
      added += 1;
    }
    while (this.queued.size > MAX_QUEUED) {
      const oldest = this.queued.keys().next().value;
      if (oldest === undefined) break;
      this.queued.delete(oldest);
    }
    if (added > 0) for (const wake of [...this.waiters]) wake();
    return { added, addedIds, alreadyDelivered };
  }

  /**
   * Takes the messages for a call's scope, oldest first. A message written for
   * a task reaches calls on that task or its tabs, and calls that name no task
   * (all=true: files, commands, git); one written outside any task reaches the
   * next call.
   */
  take(scope: TaskInboxScope, all = false): BrowserUserMessage[] {
    const taken: BrowserUserMessage[] = [];
    for (const [id, queued] of this.queued) {
      if (!all && !matches(queued, scope)) continue;
      this.queued.delete(id);
      this.remember(id);
      taken.push(queued.message);
    }
    return taken;
  }

  has(scope: TaskInboxScope, all = false): boolean {
    for (const queued of this.queued.values()) {
      if (all || matches(queued, scope)) return true;
    }
    return false;
  }

  /** Resolves when a message for the scope arrives, the time is up or the signal aborts. */
  async waitFor(scope: TaskInboxScope, all: boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.has(scope, all) || timeoutMs <= 0 || signal?.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        this.waiters.delete(check);
        resolve();
      };
      const check = () => {
        if (this.has(scope, all)) done();
      };
      const timer = setTimeout(done, timeoutMs);
      signal?.addEventListener("abort", done, { once: true });
      this.waiters.add(check);
    });
  }

  private remember(id: string): void {
    this.delivered.add(id);
    if (this.delivered.size <= MAX_REMEMBERED_DELIVERED) return;
    const oldest = this.delivered.values().next().value;
    if (oldest !== undefined) this.delivered.delete(oldest);
  }
}

function matches(queued: QueuedMessage, scope: TaskInboxScope): boolean {
  const taskId = queued.message.taskId;
  if (taskId === undefined) return true;
  if (scope.taskId !== undefined && scope.taskId === taskId) return true;
  return scope.tabId !== undefined && queued.tabIds.includes(scope.tabId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
