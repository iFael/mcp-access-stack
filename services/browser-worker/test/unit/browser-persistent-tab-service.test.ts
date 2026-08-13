import { describe, expect, it } from "@jest/globals";
import type { BrowserTab } from "@vs-code-gpt/shared";
import type { BrowserTabBinding } from "../../domain/session-registry.js";
import { TabRegistry } from "../../domain/tab-registry.js";
import type { BrowserDriverTab } from "../../drivers/browser-driver.js";
import type { RemoteTabMatch } from "../../services/browser-tab-binding-service.js";
import {
  BrowserPersistentTabService,
  type BrowserPersistentTabServiceOptions,
} from "../../services/browser-persistent-tab-service.js";

const legacySiteUrl = new URL("https://dev-private.example.test/app").href;

describe("BrowserPersistentTabService", () => {
  it("keeps an already matched persistent tab without opening or rebinding", async () => {
    const harness = makeHarness({
      tabs: [registeredTab("tab-1", "https://example.test/page")],
      remoteTabs: [remoteTab(2, "https://example.test/page", "Example", true)],
      matches: new Map([["tab-1", 2]]),
    });

    await expect(harness.service.restore(harness.driver.tabs)).resolves.toEqual(
      harness.driver.tabs,
    );

    expect(harness.driver.newTabCalls).toEqual([]);
    expect(harness.bindCalls).toEqual([]);
  });

  it("reuses only an unclaimed blank tab when restoring about:blank", async () => {
    const harness = makeHarness({
      tabs: [registeredTab("tab-blank", "about:blank")],
      remoteTabs: [
        remoteTab(0, "about:blank", "Claimed", true),
        remoteTab(1, "about:blank", "Free"),
      ],
      bindings: [binding("other-tab", 0, "about:blank")],
    });

    await harness.service.restore(harness.driver.tabs);

    expect(harness.driver.newTabCalls).toEqual([]);
    expect(harness.bindCalls).toEqual([
      { tabId: "tab-blank", index: 1, count: 2 },
    ]);
  });

  it("opens the persisted URL and binds the newly current tab when no match exists", async () => {
    const harness = makeHarness({
      tabs: [registeredTab("tab-restore", "https://example.test/restored")],
      remoteTabs: [remoteTab(0, "about:blank", "Blank", true)],
    });

    const restored = await harness.service.restore(harness.driver.tabs);

    expect(harness.driver.newTabCalls).toEqual([
      "https://example.test/restored",
    ]);
    expect(harness.bindCalls).toEqual([
      { tabId: "tab-restore", index: 1, count: 2 },
    ]);
    expect(restored.find((tab) => tab.current)).toMatchObject({
      index: 1,
      url: "https://example.test/restored",
    });
  });

  it("rejects restoration when the driver does not report a current tab", async () => {
    const harness = makeHarness({
      tabs: [registeredTab("tab-restore", "https://example.test/restored")],
      remoteTabs: [remoteTab(0, "about:blank", "Blank", true)],
      omitCurrentAfterNewTab: true,
    });

    await expect(harness.service.restore(harness.driver.tabs)).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
      message: expect.stringContaining("current browser tab"),
    });
    expect(harness.bindCalls).toEqual([]);
  });

  it("adopts LegacySite as a protected sticky tab when it is the best dedicated candidate", () => {
    const harness = makeHarness({
      remoteTabs: [
        remoteTab(0, "about:blank", "Blank", true),
        remoteTab(1, legacySiteUrl, "LegacySite"),
        remoteTab(2, "https://example.test/", "Example"),
      ],
    });

    const adopted = harness.service.adopt(harness.driver.tabs);

    expect(adopted).toMatchObject({
      purpose: "private-test",
      reusable: false,
      protected: true,
      sticky: true,
      url: legacySiteUrl,
      lockedUrl: legacySiteUrl,
    });
    expect(harness.bindCalls).toEqual([
      { tabId: adopted?.tabId, index: 1, count: 3 },
    ]);
  });

  it("closes only unclaimed blank tabs and reconciles after each close", async () => {
    const owned = registeredTab("tab-owned", "https://example.test/");
    const harness = makeHarness({
      tabs: [owned],
      remoteTabs: [
        remoteTab(0, "https://example.test/", "Owned", true),
        remoteTab(1, "about:blank", "Blank 1"),
        remoteTab(2, "about:blank", "Blank 2"),
      ],
      matches: new Map([[owned.tabId, 0]]),
    });

    const remaining = await harness.service.closeUnclaimedBlankTabs(
      harness.driver.tabs,
    );

    expect(harness.driver.closeTabCalls).toEqual([1, 2]);
    expect(harness.reconcileCalls).toBe(2);
    expect(remaining).toEqual([
      expect.objectContaining({ index: 0, url: "https://example.test/" }),
    ]);
  });
});

interface HarnessOptions {
  tabs?: BrowserTab[];
  remoteTabs?: BrowserDriverTab[];
  bindings?: BrowserTabBinding[];
  matches?: Map<string, number>;
  omitCurrentAfterNewTab?: boolean;
}

function makeHarness(options: HarnessOptions = {}) {
  const tabsRegistry = new TabRegistry(options.tabs ?? []);
  const bindings = new Map(
    (options.bindings ?? []).map((value) => [value.tabId, value]),
  );
  const driver = new FakePersistentDriver(
    options.remoteTabs ?? [],
    options.omitCurrentAfterNewTab ?? false,
  );
  const bindCalls: Array<{ tabId: string; index: number; count: number }> = [];
  let reconcileCalls = 0;
  const tabBindings: BrowserPersistentTabServiceOptions["tabBindings"] = {
    findRemoteTab(tab, remoteTabs): RemoteTabMatch | undefined {
      const index = options.matches?.get(tab.tabId);
      const remote = remoteTabs.find((candidate) => candidate.index === index);
      return remote ? { tab: remote, mode: "exact" } : undefined;
    },
    isActive(): boolean {
      return true;
    },
    bind(tabId, remote, remoteTabCount): void {
      bindCalls.push({
        tabId,
        index: remote.index,
        count: remoteTabCount ?? 0,
      });
    },
  };
  const service = new BrowserPersistentTabService({
    driver,
    tabsRegistry,
    bindings,
    tabBindings,
    primaryPrivateSite: { url: legacySiteUrl, siteId: "private-test" },
    normalizeUrl,
    tabSelection: {
      async reconcileBindings(): Promise<readonly BrowserDriverTab[]> {
        reconcileCalls += 1;
        return driver.tabs;
      },
    },
  });
  return {
    service,
    driver,
    bindCalls,
    get reconcileCalls() {
      return reconcileCalls;
    },
  };
}

class FakePersistentDriver {
  readonly newTabCalls: string[] = [];
  readonly closeTabCalls: number[] = [];

  constructor(
    readonly tabs: BrowserDriverTab[],
    private readonly omitCurrentAfterNewTab: boolean,
  ) {}

  async newTab(url = "about:blank"): Promise<BrowserDriverTab[]> {
    this.newTabCalls.push(url);
    for (const tab of this.tabs) tab.current = false;
    const index = this.tabs.length === 0
      ? 0
      : Math.max(...this.tabs.map((tab) => tab.index)) + 1;
    this.tabs.push(
      remoteTab(index, url, url, !this.omitCurrentAfterNewTab),
    );
    return this.tabs;
  }

  async closeTab(index: number): Promise<BrowserDriverTab[]> {
    this.closeTabCalls.push(index);
    const position = this.tabs.findIndex((tab) => tab.index === index);
    if (position >= 0) this.tabs.splice(position, 1);
    if (!this.tabs.some((tab) => tab.current) && this.tabs[0]) {
      this.tabs[0].current = true;
    }
    return this.tabs;
  }
}

function registeredTab(tabId: string, url: string): BrowserTab {
  const now = "2026-07-23T00:00:00.000Z";
  return {
    tabId,
    ownership: "mcp",
    purpose: "persistent-test",
    reusable: true,
    protected: false,
    sticky: false,
    createdAt: now,
    lastUsedAt: now,
    url,
    title: url,
  };
}

function binding(
  tabId: string,
  remoteIndex: number,
  url: string,
): BrowserTabBinding {
  return {
    tabId,
    sessionId: "session-1",
    driver: "direct",
    remoteTabId: `direct:page:${remoteIndex}`,
    remoteIndex,
    remoteTabCount: 2,
    url,
    title: url,
  };
}

function remoteTab(
  index: number,
  url: string,
  title: string,
  current = false,
): BrowserDriverTab {
  return { index, url, title, current, crashed: false };
}

function normalizeUrl(value: string): string {
  try {
    return new URL(value).href;
  } catch {
    return "about:blank";
  }
}
