import { randomUUID } from "node:crypto";
import { AppError, type BrowserOwnership, type BrowserTab } from "@vs-code-gpt/shared";

export interface RegisterMcpTabInput {
  tabId?: string;
  taskId?: string;
  lifecycle?: "task-scoped" | "persistent" | "external";
  purpose?: string;
  reusable?: boolean;
  protected?: boolean;
  sticky?: boolean;
  url?: string;
  requestedUrl?: string;
  title?: string;
  lockedUrl?: string;
}

export class TabRegistry {
  private readonly tabs = new Map<string, BrowserTab>();

  constructor(initialTabs: readonly BrowserTab[] = []) {
    for (const tab of initialTabs) this.tabs.set(tab.tabId, { ...tab });
  }

  ownershipOf(tabId: string): BrowserOwnership {
    return this.tabs.get(tabId)?.ownership ?? "user";
  }

  list(): BrowserTab[] {
    return [...this.tabs.values()].map((tab) => ({ ...tab }));
  }

  registerMcp(input: RegisterMcpTabInput = {}): BrowserTab {
    const now = new Date().toISOString();
    const sticky = input.sticky ?? false;
    const tab: BrowserTab = {
      tabId: input.tabId ?? randomUUID(),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      lifecycle: input.lifecycle ?? "task-scoped",
      ownership: "mcp",
      purpose: input.purpose ?? "generic-research",
      reusable: sticky ? false : (input.reusable ?? true),
      protected: sticky ? true : (input.protected ?? false),
      sticky,
      createdAt: now,
      lastUsedAt: now,
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.requestedUrl === undefined ? {} : { requestedUrl: input.requestedUrl }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.lockedUrl === undefined ? {} : { lockedUrl: input.lockedUrl }),
    };
    this.tabs.set(tab.tabId, tab);
    return { ...tab };
  }

  reconfigureMcp(tabId: string, input: RegisterMcpTabInput): BrowserTab {
    const current = this.assertMcpOwned(tabId);
    const { lockedUrl: currentLockedUrl, ...base } = current;
    const sticky = input.sticky ?? current.sticky;
    const updated: BrowserTab = {
      ...base,
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      lifecycle: input.lifecycle ?? current.lifecycle ?? "task-scoped",
      purpose: input.purpose ?? current.purpose,
      reusable: sticky ? false : (input.reusable ?? current.reusable),
      protected: sticky ? true : (input.protected ?? current.protected),
      sticky,
      lastUsedAt: new Date().toISOString(),
      ...(input.url === undefined ? {} : { url: input.url }),
      ...(input.requestedUrl === undefined ? {} : { requestedUrl: input.requestedUrl }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(sticky
        ? {
            lockedUrl:
              input.lockedUrl ??
              currentLockedUrl ??
              input.requestedUrl ??
              input.url ??
              current.requestedUrl ??
              current.url,
          }
        : {}),
    };
    this.tabs.set(tabId, updated);
    return { ...updated };
  }

  registerUser(tabId: string, url?: string, title?: string): BrowserTab {
    const now = new Date().toISOString();
    const tab: BrowserTab = {
      tabId,
      lifecycle: "external",
      ownership: "user",
      purpose: "user-existing",
      reusable: false,
      protected: true,
      sticky: false,
      createdAt: now,
      lastUsedAt: now,
      ...(url === undefined ? {} : { url }),
      ...(title === undefined ? {} : { title }),
    };
    this.tabs.set(tabId, tab);
    return { ...tab };
  }

  assertMcpOwned(tabId: string): BrowserTab {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.ownership !== "mcp") {
      throw new AppError("TAB_NOT_OWNED", "The tab is not owned by the MCP.");
    }
    return { ...tab };
  }

  assertNavigable(tabId: string, targetUrl?: string): BrowserTab {
    const tab = this.assertMcpOwned(tabId);
    if (tab.sticky && targetUrl && tab.lockedUrl && targetUrl !== tab.lockedUrl) {
      throw new AppError("NAVIGATION_BLOCKED", "The sticky tab cannot navigate away from its locked URL.");
    }
    return tab;
  }

  assertClosable(tabId: string): BrowserTab {
    const tab = this.assertMcpOwned(tabId);
    if (tab.protected || tab.sticky) {
      throw new AppError("TAB_PROTECTED", "The tab is protected and cannot be closed.");
    }
    return tab;
  }

  touch(tabId: string, changes: Partial<Pick<BrowserTab, "url" | "title">> = {}): BrowserTab {
    const current = this.assertMcpOwned(tabId);
    const updated: BrowserTab = {
      ...current,
      ...changes,
      lastUsedAt: new Date().toISOString(),
    };
    this.tabs.set(tabId, updated);
    return { ...updated };
  }

  discard(tabId: string): void {
    this.tabs.delete(tabId);
  }

  remove(tabId: string): void {
    this.assertClosable(tabId);
    this.tabs.delete(tabId);
  }
}
