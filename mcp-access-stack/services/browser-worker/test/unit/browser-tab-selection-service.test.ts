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
import { BrowserTabSelectionService } from "../../services/browser-tab-selection-service.js";

const now = "2026-07-23T00:00:00.000Z";

const baseTab: BrowserTab = {
  tabId: "tab-1",
  ownership: "mcp",
  purpose: "selection-test",
  reusable: true,
  protected: false,
  sticky: false,
  createdAt: now,
  lastUsedAt: now,
  url: "https://example.test/page",
  title: "Example",
};

describe("BrowserTabSelectionService", () => {
  it("uses the bound index fast path without an unnecessary checkpoint", async () => {
    const harness = makeHarness();
    harness.driver.selectionResults.set(1, [
      remoteTab(1, baseTab.url!, baseTab.title!, true),
    ]);

    await expect(harness.service.selectTab(baseTab)).resolves.toMatchObject({
      index: 1,
      current: true,
    });

    expect(harness.ensureConnectionCalls).toBe(1);
    expect(harness.driver.selectCalls).toEqual([1]);
    expect(harness.driver.listCalls).toBe(0);
    expect(harness.checkpointCalls).toBe(0);
  });

  it("falls back to reconciliation and checkpoints after index renumbering", async () => {
    const harness = makeHarness({
      remoteTabs: [remoteTab(2, baseTab.url!, baseTab.title!)],
    });
    harness.driver.selectionFailures.add(1);
    harness.driver.selectionResults.set(2, [
      remoteTab(2, baseTab.url!, baseTab.title!, true),
    ]);

    await expect(harness.service.selectTab(baseTab)).resolves.toMatchObject({
      index: 2,
      current: true,
    });

    expect(harness.driver.selectCalls).toEqual([1, 2]);
    expect(harness.driver.listCalls).toBe(1);
    expect(harness.checkpointCalls).toBe(1);
    expect(harness.bindings.get(baseTab.tabId)).toMatchObject({
      remoteIndex: 2,
      remoteTabId: "direct:page:page-2",
    });
  });

  it("refuses a personal current tab returned after selecting an owned match", async () => {
    const harness = makeHarness({
      remoteTabs: [remoteTab(2, baseTab.url!, baseTab.title!)],
    });
    harness.driver.selectionFailures.add(1);
    harness.driver.selectionResults.set(2, [
      remoteTab(0, "https://personal.test/", "Personal", true),
      remoteTab(2, baseTab.url!, baseTab.title!),
    ]);

    await expect(harness.service.selectTab(baseTab)).rejects.toMatchObject({
      code: "TAB_NOT_OWNED",
    });

    expect(harness.bindings.get(baseTab.tabId)?.remoteIndex).toBe(1);
    expect(harness.checkpointCalls).toBe(0);
  });

  it("does not select a personal tab when the owned identity is missing", async () => {
    const harness = makeHarness({
      remoteTabs: [remoteTab(0, "https://personal.test/", "Personal", true)],
    });
    harness.driver.selectionFailures.add(1);

    await expect(harness.service.selectTab(baseTab)).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
      message: expect.stringContaining("personal tab"),
    });

    expect(harness.driver.selectCalls).toEqual([1]);
    expect(harness.checkpointCalls).toBe(0);
  });

  it("reconciles valid bindings and prunes only unmatched registry entries", async () => {
    const secondTab: BrowserTab = {
      ...baseTab,
      tabId: "tab-2",
      url: "https://orphan.test/",
      title: "Orphan",
    };
    const harness = makeHarness({
      tabs: [baseTab, secondTab],
      remoteTabs: [remoteTab(1, baseTab.url!, "Updated title", true)],
    });

    await expect(harness.service.reconcileBindings(true)).resolves.toHaveLength(1);

    expect(harness.driver.listCalls).toBe(1);
    expect(harness.discarded).toEqual([secondTab.tabId]);
    expect(harness.tabsRegistry.list().map((tab) => tab.tabId)).toEqual([
      baseTab.tabId,
    ]);
    expect(harness.tabsRegistry.assertMcpOwned(baseTab.tabId)).toMatchObject({
      title: "Updated title",
    });
  });

  it("keeps unmatched entries when reconciliation is non-pruning", async () => {
    const harness = makeHarness({
      remoteTabs: [remoteTab(0, "https://personal.test/", "Personal", true)],
    });

    await harness.service.reconcileBindings(false);

    expect(harness.discarded).toEqual([]);
    expect(harness.tabsRegistry.list()).toHaveLength(1);
  });
});

interface HarnessOptions {
  tabs?: BrowserTab[];
  remoteTabs?: BrowserDriverTab[];
}

function makeHarness(options: HarnessOptions = {}) {
  const tabs = options.tabs ?? [baseTab];
  let session: BrowserSession = createBrowserSession("direct", now);
  const tabsRegistry = new TabRegistry(tabs);
  const bindings = new Map<string, BrowserTabBinding>();
  const unifiedTabs = new Map<string, UnifiedBrowserTab>();

  for (const [index, tab] of tabs.entries()) {
    const remoteIndex = index + 1;
    const binding: BrowserTabBinding = {
      tabId: tab.tabId,
      sessionId: session.sessionId,
      driver: "direct",
      remoteTabId: `direct:page:${remoteIndex}`,
      remoteIndex,
      url: normalizeUrl(tab.url ?? "about:blank"),
      title: tab.title ?? "",
      remoteTabCount: tabs.length,
    };
    bindings.set(tab.tabId, binding);
    unifiedTabs.set(
      tab.tabId,
      toUnifiedBrowserTab(
        tab,
        session,
        binding.remoteTabId,
        binding.remoteIndex,
      ),
    );
  }

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
  const driver = new FakeSelectionDriver(options.remoteTabs ?? []);
  let ensureConnectionCalls = 0;
  let checkpointCalls = 0;
  const discarded: string[] = [];
  const service = new BrowserTabSelectionService({
    driver,
    tabsRegistry,
    bindings,
    tabBindings,
    ensureConnection: async () => {
      ensureConnectionCalls += 1;
    },
    checkpoint: async () => {
      checkpointCalls += 1;
    },
    discardOrphan: (tabId) => {
      discarded.push(tabId);
      tabsRegistry.discard(tabId);
      bindings.delete(tabId);
      unifiedTabs.delete(tabId);
    },
  });

  return {
    service,
    driver,
    tabsRegistry,
    bindings,
    unifiedTabs,
    discarded,
    get ensureConnectionCalls() {
      return ensureConnectionCalls;
    },
    get checkpointCalls() {
      return checkpointCalls;
    },
  };
}

class FakeSelectionDriver {
  readonly selectionResults = new Map<number, BrowserDriverTab[]>();
  readonly selectionFailures = new Set<number>();
  readonly selectCalls: number[] = [];
  listCalls = 0;

  constructor(private readonly remoteTabs: BrowserDriverTab[]) {}

  async listTabs(): Promise<BrowserDriverTab[]> {
    this.listCalls += 1;
    return cloneTabs(this.remoteTabs);
  }

  async selectTab(index: number): Promise<BrowserDriverTab[]> {
    this.selectCalls.push(index);
    if (this.selectionFailures.has(index)) {
      throw new Error(`selection failed for ${index}`);
    }
    const result = this.selectionResults.get(index);
    if (!result) throw new Error(`missing selection result for ${index}`);
    return cloneTabs(result);
  }

  async selectTabByRemoteId(
    remoteTabId: string,
  ): Promise<{ tab: BrowserDriverTab; tabCount: number }> {
    const id = remoteTabId.includes(":page:")
      ? remoteTabId.slice(remoteTabId.indexOf(":page:") + 6)
      : remoteTabId;
    const tab = this.remoteTabs.find((candidate) => candidate.id === id);
    if (!tab) throw new Error(`missing remote page ${id}`);
    const selected = this.remoteTabs.map((candidate) => ({
      ...candidate,
      current: candidate === tab,
    }));
    return {
      tab: cloneTabs(selected).find((candidate) => candidate.current)!,
      tabCount: selected.length,
    };
  }
}

function remoteTab(
  index: number,
  url: string,
  title: string,
  current = false,
): BrowserDriverTab {
  return { id: `page-${index}`, index, url, title, current, crashed: false };
}

function cloneTabs(tabs: readonly BrowserDriverTab[]): BrowserDriverTab[] {
  return tabs.map((tab) => ({ ...tab }));
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return "about:blank";
  }
}
