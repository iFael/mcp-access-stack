import { AppError, type BrowserTab } from "@vs-code-gpt/shared";
import {
  toUnifiedBrowserTab,
  touchBrowserSession,
  type BrowserSession,
  type BrowserSessionState,
  type UnifiedBrowserTab,
} from "../domain/browser-session-model.js";
import type { BrowserTabBinding } from "../domain/session-registry.js";
import type { BrowserTask, BrowserTaskRegistry } from "../domain/browser-task-registry.js";
import { TabRegistry } from "../domain/tab-registry.js";

export interface BrowserSessionStateStore {
  save(
    sessions: readonly BrowserSession[],
    tabs: readonly UnifiedBrowserTab[],
    bindings: readonly BrowserTabBinding[],
    tasks?: readonly BrowserTask[],
  ): Promise<void>;
}

export interface BrowserSessionStateServiceOptions {
  tabsRegistry: TabRegistry;
  sessionStore: BrowserSessionStateStore;
  sessions: Map<string, BrowserSession>;
  unifiedTabs: Map<string, UnifiedBrowserTab>;
  bindings: Map<string, BrowserTabBinding>;
  taskRegistry?: BrowserTaskRegistry;
  getSession(): BrowserSession;
  setSession(session: BrowserSession): void;
  isActiveBinding(binding: BrowserTabBinding): boolean;
  discardReferences(tabId: string): void;
  clearReferences(): void;
  clearConfirmations(): void;
}

export class BrowserSessionStateService {
  private checkpointTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: BrowserSessionStateServiceOptions) {}

  hydrate(
    persistedSessions: readonly BrowserSession[],
    persistedTabs: readonly UnifiedBrowserTab[],
  ): void {
    for (const session of persistedSessions) {
      this.options.sessions.set(session.sessionId, session);
    }
    for (const tab of persistedTabs) {
      this.options.unifiedTabs.set(tab.tabId, tab);
    }
    const activeSession = this.options.getSession();
    this.options.sessions.set(activeSession.sessionId, activeSession);
  }

  transition(state: BrowserSessionState): BrowserSession {
    const session = touchBrowserSession(this.options.getSession(), state);
    this.options.setSession(session);
    return session;
  }

  checkpoint(): Promise<void> {
    const checkpoint = this.checkpointTail.then(
      () => this.checkpointNow(),
      () => this.checkpointNow(),
    );
    this.checkpointTail = checkpoint.catch(() => undefined);
    return checkpoint;
  }

  private async checkpointNow(): Promise<void> {
    const session = this.options.getSession();
    this.options.sessions.set(session.sessionId, session);

    const activeTabs = this.options.tabsRegistry.list();
    const activeTabIds = new Set(activeTabs.map((tab) => tab.tabId));
    this.removeStaleUnifiedTabs(session.sessionId, activeTabIds);

    for (const tab of activeTabs) {
      this.persistActiveTab(tab, session);
    }

    for (const [tabId, binding] of this.options.bindings) {
      if (binding.sessionId === session.sessionId && !activeTabIds.has(tabId)) {
        this.options.bindings.delete(tabId);
      }
    }

    await this.options.sessionStore.save(
      [...this.options.sessions.values()],
      [...this.options.unifiedTabs.values()],
      [...this.options.bindings.values()],
      this.options.taskRegistry?.snapshot(),
    );
  }

  discardTaskTab(tabId: string): void {
    this.options.tabsRegistry.discard(tabId);
    this.options.bindings.delete(tabId);
    this.options.unifiedTabs.delete(tabId);
    this.options.taskRegistry?.detachTab(tabId);
    this.options.discardReferences(tabId);
  }

  clearTaskState(): void {
    for (const tab of this.options.tabsRegistry.list()) {
      this.discardTaskTab(tab.tabId);
    }

    const sessionId = this.options.getSession().sessionId;
    for (const [tabId, binding] of this.options.bindings) {
      if (binding.sessionId === sessionId) this.options.bindings.delete(tabId);
    }
    for (const [tabId, tab] of this.options.unifiedTabs) {
      if (tab.sessionId === sessionId) this.options.unifiedTabs.delete(tabId);
    }

    this.options.clearReferences();
    this.options.clearConfirmations();
  }

  private removeStaleUnifiedTabs(
    sessionId: string,
    activeTabIds: ReadonlySet<string>,
  ): void {
    for (const [tabId, tab] of this.options.unifiedTabs) {
      if (tab.sessionId === sessionId && !activeTabIds.has(tabId)) {
        this.options.unifiedTabs.delete(tabId);
      }
    }
  }

  private persistActiveTab(tab: BrowserTab, session: BrowserSession): void {
    const binding = this.options.bindings.get(tab.tabId);
    if (!binding || !this.options.isActiveBinding(binding)) {
      throw new AppError(
        "TAB_NOT_OWNED",
        "The tab cannot be persisted outside its browser session.",
      );
    }
    this.options.unifiedTabs.set(
      tab.tabId,
      toUnifiedBrowserTab(tab, session, binding.remoteTabId, binding.remoteIndex),
    );
  }
}
