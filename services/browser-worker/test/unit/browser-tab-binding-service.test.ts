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
import type { BrowserDriverTab } from "../../drivers/browser-driver.js";
import { BrowserTabBindingService } from "../../services/browser-tab-binding-service.js";

const now = "2026-07-23T00:00:00.000Z";

const baseTab: BrowserTab = {
  tabId: "tab-1",
  ownership: "mcp",
  purpose: "binding-test",
  reusable: true,
  protected: false,
  sticky: false,
  createdAt: now,
  lastUsedAt: now,
  url: "https://example.test/page",
  title: "Example",
};

const baseBinding: BrowserTabBinding = {
  tabId: baseTab.tabId,
  sessionId: "placeholder",
  driver: "direct",
  remoteTabId: "direct:page:1",
  remoteIndex: 1,
  url: "https://example.test/page",
  title: "Example",
  remoteTabCount: 2,
};

describe("BrowserTabBindingService", () => {
  it("matches exact, title-drift and sticky-origin identities", () => {
    const exact = makeHarness();
    expect(
      exact.service.findRemoteTab(
        exact.tab,
        [remoteTab(1, exact.tab.url!, exact.tab.title!)],
      ),
    ).toMatchObject({ mode: "exact", tab: { index: 1 } });

    expect(
      exact.service.findRemoteTab(
        exact.tab,
        [remoteTab(1, exact.tab.url!, "Changed title")],
      ),
    ).toMatchObject({ mode: "title-drift", tab: { index: 1 } });

    const sticky = makeHarness({
      tab: {
        ...baseTab,
        sticky: true,
        protected: true,
        reusable: false,
        lockedUrl: "https://example.test/app",
      },
    });
    expect(
      sticky.service.findRemoteTab(
        sticky.tab,
        [remoteTab(1, "https://example.test/app/next", "Next")],
      ),
    ).toMatchObject({ mode: "sticky-origin-drift", tab: { index: 1 } });
  });

  it("recovers a uniquely matching tab after index renumbering", () => {
    const harness = makeHarness();
    harness.bindings.set("tab-2", {
      tabId: "tab-2",
      sessionId: harness.session.sessionId,
      driver: "direct",
      remoteTabId: "direct:page:0",
      remoteIndex: 0,
      url: "https://claimed.test/",
      title: "Claimed",
    });

    const match = harness.service.findRemoteTab(harness.tab, [
      remoteTab(0, "https://claimed.test/", "Claimed"),
      remoteTab(2, harness.tab.url!, harness.tab.title!, true),
    ]);

    expect(match).toMatchObject({
      mode: "signature-recovery",
      tab: { index: 2, current: true },
    });
  });

  it("accepts only an active expected navigation transition", () => {
    const harness = makeHarness({
      binding: {
        ...baseBinding,
        remoteTabCount: 1,
        navigation: {
          operation: "navigate",
          startedAt: now,
          expiresAt: "2099-07-23T00:00:00.000Z",
          expectedUrl: "https://example.test/next",
        },
      },
    });
    const selected = remoteTab(
      1,
      "https://example.test/next?step=1",
      "Next",
      true,
    );
    const match = harness.service.findRemoteTab(harness.tab, [selected]);

    expect(match).toMatchObject({ mode: "navigation-transition" });
    expect(
      harness.service.sameRemoteIdentity(
        match!,
        selected,
        harness.bindings.get(harness.tab.tabId)!,
        1,
      ),
    ).toBe(true);
    expect(
      harness.service.sameRemoteIdentity(
        match!,
        selected,
        harness.bindings.get(harness.tab.tabId)!,
        2,
      ),
    ).toBe(false);
  });

  it("updates the binding, public tab, unified registry and active session", () => {
    const harness = makeHarness();
    const previousLastUsedAt = harness.session.lastUsedAt;

    harness.service.bind(
      harness.tab.tabId,
      remoteTab(3, "https://example.test/updated", "Updated", true),
      4,
    );

    expect(harness.bindings.get(harness.tab.tabId)).toMatchObject({
      sessionId: harness.session.sessionId,
      driver: "direct",
      remoteTabId: "direct:page:3",
      remoteIndex: 3,
      remoteTabCount: 4,
      url: "https://example.test/updated",
      title: "Updated",
    });
    expect(harness.tabsRegistry.assertMcpOwned(harness.tab.tabId)).toMatchObject({
      url: "https://example.test/updated",
      title: "Updated",
    });
    expect(harness.unifiedTabs.get(harness.tab.tabId)).toMatchObject({
      remoteTabId: "direct:page:3",
      remoteIndex: 3,
      url: "https://example.test/updated",
    });
    expect(harness.session.lastUsedAt >= previousLastUsedAt).toBe(true);
  });

  it("refuses to overwrite a binding owned by another session", () => {
    const harness = makeHarness({
      binding: { ...baseBinding, sessionId: "other-session" },
      preserveBindingSession: true,
    });

    expect(() =>
      harness.service.bind(
        harness.tab.tabId,
        remoteTab(1, harness.tab.url!, harness.tab.title!),
      ),
    ).toThrow(expect.objectContaining({ code: "TAB_NOT_OWNED" }));
  });

  it("requires consistent unified state before matching or synchronizing", () => {
    const harness = makeHarness();
    harness.unifiedTabs.delete(harness.tab.tabId);

    expect(
      harness.service.findRemoteTab(
        harness.tab,
        [remoteTab(1, harness.tab.url!, harness.tab.title!)],
      ),
    ).toBeUndefined();

    harness.bindings.set(harness.tab.tabId, {
      ...harness.bindings.get(harness.tab.tabId)!,
      sessionId: "other-session",
    });
    expect(() => harness.service.syncUnifiedTab(harness.tab.tabId)).toThrow(
      expect.objectContaining({ code: "TAB_NOT_OWNED" }),
    );
  });
});

interface HarnessOptions {
  tab?: BrowserTab;
  binding?: BrowserTabBinding;
  preserveBindingSession?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const tab = options.tab ?? baseTab;
  let session: BrowserSession = createBrowserSession("direct", now);
  const binding: BrowserTabBinding = {
    ...(options.binding ?? baseBinding),
    tabId: tab.tabId,
    sessionId: options.preserveBindingSession
      ? (options.binding?.sessionId ?? baseBinding.sessionId)
      : session.sessionId,
  };
  const tabsRegistry = new TabRegistry([tab]);
  const bindings = new Map([[tab.tabId, binding]]);
  const unifiedTabs = new Map<string, UnifiedBrowserTab>([
    [
      tab.tabId,
      toUnifiedBrowserTab(
        tab,
        session,
        binding.remoteTabId,
        binding.remoteIndex,
      ),
    ],
  ]);
  const service = new BrowserTabBindingService({
    driverKind: "direct",
    tabsRegistry,
    bindings,
    unifiedTabs,
    getSession: () => session,
    setSession: (value) => {
      session = value;
    },
    normalizeUrl,
  });

  return {
    service,
    tab,
    tabsRegistry,
    bindings,
    unifiedTabs,
    get session() {
      return session;
    },
  };
}

function remoteTab(
  index: number,
  url: string,
  title: string,
  current = false,
): BrowserDriverTab {
  return { id: String(index), index, url, title, current, crashed: false };
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return "about:blank";
  }
}
