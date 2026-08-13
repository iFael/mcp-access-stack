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
import type { BrowserDriverResponse } from "../../drivers/browser-driver.js";
import { BrowserNavigationStateService } from "../../services/browser-navigation-state-service.js";
import { BrowserTabBindingService } from "../../services/browser-tab-binding-service.js";

const now = "2026-07-23T18:00:00.000Z";

const baseTab: BrowserTab = {
  tabId: "tab-navigation",
  ownership: "mcp",
  purpose: "navigation-state-test",
  reusable: true,
  protected: false,
  sticky: false,
  createdAt: now,
  lastUsedAt: now,
  url: "https://example.test/start",
  title: "Start",
};

describe("BrowserNavigationStateService", () => {
  it("records a bounded normalized navigation transition", () => {
    const harness = makeHarness({ navigationTimeoutMs: 60_000 });

    harness.navigation.begin(
      harness.tab.tabId,
      "navigate",
      "https://example.test/next",
    );

    expect(harness.bindings.get(harness.tab.tabId)?.navigation).toEqual({
      operation: "navigate",
      startedAt: now,
      expiresAt: "2026-07-23T18:00:20.000Z",
      expectedUrl: "https://example.test/next",
    });
  });

  it("rejects navigation without an active binding", () => {
    const harness = makeHarness();
    harness.bindings.set(harness.tab.tabId, {
      ...harness.bindings.get(harness.tab.tabId)!,
      sessionId: "other-session",
    });

    expect(() => harness.navigation.begin(harness.tab.tabId, "click")).toThrow(
      expect.objectContaining({ code: "TAB_NOT_FOUND" }),
    );
  });

  it("updates binding, registry and unified tab from typed page metadata", () => {
    const harness = makeHarness({
      navigation: {
        operation: "navigate",
        startedAt: now,
        expiresAt: "2099-07-23T18:00:20.000Z",
        expectedUrl: "https://example.test/next",
      },
    });

    const updated = harness.navigation.updateSelectedTab(
      harness.tab.tabId,
      response("https://example.test/next", "Next"),
    );

    expect(updated).toMatchObject({
      tabId: harness.tab.tabId,
      url: "https://example.test/next",
      title: "Next",
    });
    expect(harness.bindings.get(harness.tab.tabId)).toMatchObject({
      remoteIndex: 1,
      remoteTabId: "direct:page:1",
      url: "https://example.test/next",
      title: "Next",
    });
    expect(harness.bindings.get(harness.tab.tabId)?.navigation).toBeUndefined();
    expect(harness.unifiedTabs.get(harness.tab.tabId)).toMatchObject({
      url: "https://example.test/next",
      title: "Next",
    });
  });

  it("preserves an active transition when the page URL is unchanged", () => {
    const navigation = {
      operation: "click" as const,
      startedAt: now,
      expiresAt: "2099-07-23T18:00:20.000Z",
    };
    const harness = makeHarness({ navigation });

    harness.navigation.updateSelectedTab(
      harness.tab.tabId,
      response("https://example.test/start", "Renamed"),
    );

    expect(harness.bindings.get(harness.tab.tabId)?.navigation).toEqual(
      navigation,
    );
    expect(harness.bindings.get(harness.tab.tabId)?.title).toBe("Renamed");
  });

  it("uses fallback URL and previous title when typed metadata is empty", () => {
    const navigation = {
      operation: "go-forward" as const,
      startedAt: now,
      expiresAt: "2099-07-23T18:00:20.000Z",
    };
    const harness = makeHarness({ navigation });

    const updated = harness.navigation.updateSelectedTab(
      harness.tab.tabId,
      response("", ""),
      "https://example.test/start",
    );

    expect(updated).toMatchObject({
      url: "https://example.test/start",
      title: "Start",
    });
    expect(harness.bindings.get(harness.tab.tabId)?.navigation).toEqual(
      navigation,
    );
  });
});

interface HarnessOptions {
  navigationTimeoutMs?: number;
  navigation?: BrowserTabBinding["navigation"];
}

function makeHarness(options: HarnessOptions = {}) {
  let session: BrowserSession = createBrowserSession("direct", now);
  const tab = { ...baseTab };
  const tabsRegistry = new TabRegistry([tab]);
  const binding: BrowserTabBinding = {
    tabId: tab.tabId,
    sessionId: session.sessionId,
    driver: "direct",
    remoteTabId: "direct:page:1",
    remoteIndex: 1,
    url: tab.url!,
    title: tab.title!,
    remoteTabCount: 1,
    ...(options.navigation === undefined
      ? {}
      : { navigation: options.navigation }),
  };
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
  const tabBindings = new BrowserTabBindingService({
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
  const navigation = new BrowserNavigationStateService({
    navigationTimeoutMs: options.navigationTimeoutMs ?? 5_000,
    tabsRegistry,
    bindings,
    tabBindings,
    normalizeUrl,
    now: () => new Date(now),
  });

  return { navigation, tab, tabsRegistry, bindings, unifiedTabs };
}

function response(url: string, title: string): BrowserDriverResponse {
  return { page: { id: "page-1", url, title } };
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return "about:blank";
  }
}
