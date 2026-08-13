import { describe, expect, it } from "@jest/globals";
import type { BrowserTab } from "@vs-code-gpt/shared";
import {
  createBrowserSession,
  toUnifiedBrowserTab,
  type BrowserSession,
  type UnifiedBrowserTab,
} from "../../domain/browser-session-model.js";
import type { BrowserTabBinding } from "../../domain/session-registry.js";
import { TabRegistry } from "../../domain/tab-registry.js";
import {
  BrowserSessionStateService,
  type BrowserSessionStateStore,
} from "../../services/browser-session-state-service.js";

const now = "2026-07-23T00:00:00.000Z";

const activeTab: BrowserTab = {
  tabId: "active-tab",
  ownership: "mcp",
  purpose: "session-state-test",
  reusable: true,
  protected: false,
  sticky: false,
  createdAt: now,
  lastUsedAt: now,
  url: "https://example.test/active",
  title: "Active",
};

const staleTab: BrowserTab = {
  ...activeTab,
  tabId: "stale-tab",
  url: "https://example.test/stale",
  title: "Stale",
};

const otherTab: BrowserTab = {
  ...activeTab,
  tabId: "other-tab",
  purpose: "other-session",
  url: "https://example.test/other",
  title: "Other",
};

describe("BrowserSessionStateService", () => {
  it("hydrates persisted state while keeping the selected active session", () => {
    const harness = makeHarness({ includeActiveTab: false });
    const persistedActive = { ...harness.session, state: "failed" as const };

    harness.service.hydrate(
      [persistedActive, harness.otherSession],
      [harness.otherUnified],
    );

    expect(harness.sessions.get(harness.session.sessionId)).toMatchObject({
      state: "connected",
    });
    expect(harness.sessions.get(harness.otherSession.sessionId)).toEqual(
      harness.otherSession,
    );
    expect(harness.unifiedTabs.get(otherTab.tabId)).toEqual(harness.otherUnified);
  });

  it("updates the active session lifecycle without changing its identity", () => {
    const harness = makeHarness();
    const previousSessionId = harness.session.sessionId;

    const updated = harness.service.transition("failed");

    expect(updated.sessionId).toBe(previousSessionId);
    expect(updated.state).toBe("failed");
    expect(harness.session).toEqual(updated);
  });

  it("checkpoints active state, removes stale current-session entries and preserves other sessions", async () => {
    const harness = makeHarness();
    harness.sessions.set(harness.otherSession.sessionId, harness.otherSession);
    harness.unifiedTabs.set(staleTab.tabId, harness.staleUnified);
    harness.unifiedTabs.set(otherTab.tabId, harness.otherUnified);
    harness.bindings.set(otherTab.tabId, harness.otherBinding);

    await harness.service.checkpoint();

    expect(harness.store.saves).toHaveLength(1);
    const saved = harness.store.saves[0]!;
    expect(saved.sessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: harness.session.sessionId }),
        expect.objectContaining({ sessionId: harness.otherSession.sessionId }),
      ]),
    );
    expect(saved.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tabId: activeTab.tabId }),
        expect.objectContaining({ tabId: otherTab.tabId }),
      ]),
    );
    expect(saved.tabs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ tabId: staleTab.tabId })]),
    );
    expect(saved.bindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tabId: activeTab.tabId }),
        expect.objectContaining({ tabId: otherTab.tabId }),
      ]),
    );
    expect(harness.unifiedTabs.has(staleTab.tabId)).toBe(false);
  });

  it("rejects checkpoint when an active tab has no active-session binding", async () => {
    const harness = makeHarness();
    harness.bindings.set(activeTab.tabId, {
      ...harness.activeBinding,
      sessionId: harness.otherSession.sessionId,
    });

    await expect(harness.service.checkpoint()).rejects.toMatchObject({
      code: "TAB_NOT_OWNED",
    });
    expect(harness.store.saves).toHaveLength(0);
  });

  it("serializes concurrent checkpoints before writing shared session state", async () => {
    const store = new DelayedSessionStore();
    const harness = makeHarness({ store });

    await Promise.all([
      harness.service.checkpoint(),
      harness.service.checkpoint(),
      harness.service.checkpoint(),
    ]);

    expect(store.saves).toHaveLength(3);
    expect(store.maxActive).toBe(1);
  });

  it("continues checkpoint processing after a failed persistence attempt", async () => {
    const store = new FailOnceSessionStore();
    const harness = makeHarness({ store });

    const first = harness.service.checkpoint();
    const second = harness.service.checkpoint();

    await expect(first).rejects.toThrow("simulated registry failure");
    await expect(second).resolves.toBeUndefined();
    expect(store.attempts).toBe(2);
    expect(store.saves).toHaveLength(1);
  });

  it("discards one task tab from every current-session registry", () => {
    const harness = makeHarness();

    harness.service.discardTaskTab(activeTab.tabId);

    expect(harness.tabsRegistry.list()).toEqual([]);
    expect(harness.bindings.has(activeTab.tabId)).toBe(false);
    expect(harness.unifiedTabs.has(activeTab.tabId)).toBe(false);
    expect(harness.references.has(activeTab.tabId)).toBe(false);
    expect(harness.confirmationsCleared).toBe(0);
  });

  it("clears only the active session and preserves persisted state from another session", () => {
    const harness = makeHarness();
    harness.sessions.set(harness.otherSession.sessionId, harness.otherSession);
    harness.unifiedTabs.set(otherTab.tabId, harness.otherUnified);
    harness.bindings.set(otherTab.tabId, harness.otherBinding);
    harness.references.set("extra-reference", new Map());

    harness.service.clearTaskState();

    expect(harness.tabsRegistry.list()).toEqual([]);
    expect(harness.bindings.has(activeTab.tabId)).toBe(false);
    expect(harness.unifiedTabs.has(activeTab.tabId)).toBe(false);
    expect(harness.bindings.get(otherTab.tabId)).toEqual(harness.otherBinding);
    expect(harness.unifiedTabs.get(otherTab.tabId)).toEqual(harness.otherUnified);
    expect(harness.references.size).toBe(0);
    expect(harness.confirmationsCleared).toBe(1);
  });
});

class FakeSessionStore implements BrowserSessionStateStore {
  readonly saves: Array<{
    sessions: BrowserSession[];
    tabs: UnifiedBrowserTab[];
    bindings: BrowserTabBinding[];
  }> = [];

  async save(
    sessions: readonly BrowserSession[],
    tabs: readonly UnifiedBrowserTab[],
    bindings: readonly BrowserTabBinding[],
  ): Promise<void> {
    this.saves.push({
      sessions: [...sessions],
      tabs: [...tabs],
      bindings: [...bindings],
    });
  }
}

class DelayedSessionStore extends FakeSessionStore {
  active = 0;
  maxActive = 0;

  override async save(
    sessions: readonly BrowserSession[],
    tabs: readonly UnifiedBrowserTab[],
    bindings: readonly BrowserTabBinding[],
  ): Promise<void> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      await super.save(sessions, tabs, bindings);
    } finally {
      this.active -= 1;
    }
  }
}

class FailOnceSessionStore extends FakeSessionStore {
  attempts = 0;

  override async save(
    sessions: readonly BrowserSession[],
    tabs: readonly UnifiedBrowserTab[],
    bindings: readonly BrowserTabBinding[],
  ): Promise<void> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error("simulated registry failure");
    }
    await super.save(sessions, tabs, bindings);
  }
}

function makeHarness(options: {
  includeActiveTab?: boolean;
  store?: FakeSessionStore;
} = {}) {
  let session: BrowserSession = {
    ...createBrowserSession("direct", now),
    sessionId: "active-session",
    state: "connected",
  };
  const otherSession: BrowserSession = {
    ...createBrowserSession("direct", now),
    sessionId: "other-session",
    state: "disconnected",
  };
  const activeBinding: BrowserTabBinding = {
    tabId: activeTab.tabId,
    sessionId: session.sessionId,
    driver: "direct",
    remoteTabId: "direct:page:1",
    remoteIndex: 1,
    url: activeTab.url!,
    title: activeTab.title!,
  };
  const otherBinding: BrowserTabBinding = {
    tabId: otherTab.tabId,
    sessionId: otherSession.sessionId,
    driver: "direct",
    remoteTabId: "direct:page:7",
    remoteIndex: 7,
    url: otherTab.url!,
    title: otherTab.title!,
  };
  const tabsRegistry = new TabRegistry(
    options.includeActiveTab === false ? [] : [activeTab],
  );
  const sessions = new Map<string, BrowserSession>();
  const bindings = new Map<string, BrowserTabBinding>([
    [activeTab.tabId, activeBinding],
  ]);
  const activeUnified = toUnifiedBrowserTab(
    activeTab,
    session,
    activeBinding.remoteTabId,
    activeBinding.remoteIndex,
  );
  const staleUnified = toUnifiedBrowserTab(
    staleTab,
    session,
    "mcp:index:2",
    2,
  );
  const otherUnified = toUnifiedBrowserTab(
    otherTab,
    otherSession,
    otherBinding.remoteTabId,
    otherBinding.remoteIndex,
  );
  const unifiedTabs = new Map<string, UnifiedBrowserTab>([
    [activeTab.tabId, activeUnified],
  ]);
  const references = new Map<string, Map<string, unknown>>([
    [activeTab.tabId, new Map([["ref-1", {}]])],
  ]);
  let confirmationsCleared = 0;
  const store = options.store ?? new FakeSessionStore();
  const service = new BrowserSessionStateService({
    tabsRegistry,
    sessionStore: store,
    sessions,
    unifiedTabs,
    bindings,
    getSession: () => session,
    setSession: (value) => {
      session = value;
    },
    isActiveBinding: (binding) =>
      binding.sessionId === session.sessionId && binding.driver === session.driver,
    discardReferences: (tabId) => {
      references.delete(tabId);
    },
    clearReferences: () => {
      references.clear();
    },
    clearConfirmations: () => {
      confirmationsCleared += 1;
    },
  });

  return {
    service,
    store,
    tabsRegistry,
    sessions,
    bindings,
    unifiedTabs,
    references,
    activeBinding,
    otherBinding,
    staleUnified,
    otherUnified,
    otherSession,
    get session() {
      return session;
    },
    get confirmationsCleared() {
      return confirmationsCleared;
    },
  };
}
