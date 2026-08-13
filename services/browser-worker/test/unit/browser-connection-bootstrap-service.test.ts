import { describe, expect, it } from "@jest/globals";
import type { BrowserTab } from "@vs-code-gpt/shared";
import { TabRegistry } from "../../domain/tab-registry.js";
import type { BrowserDriverTab } from "../../drivers/browser-driver.js";
import {
  BrowserConnectionBootstrapService,
  type BrowserConnectionBootstrapServiceOptions,
} from "../../services/browser-connection-bootstrap-service.js";

const now = "2026-07-23T00:00:00.000Z";

describe("BrowserConnectionBootstrapService", () => {
  it("connects the persistent profile and creates one MCP-owned blank tab", async () => {
    const harness = makeHarness({
      remoteTabs: [remoteTab(0, "https://personal.test/", "Personal", true)],
      newTabResult: [
        remoteTab(0, "https://personal.test/", "Personal"),
        remoteTab(1, "about:blank", "", true),
      ],
    });

    await harness.service.connect();

    expect(harness.driver.connectCalls).toBe(1);
    expect(harness.driver.listTabsCalls).toBe(1);
    expect(harness.driver.newTabCalls).toEqual(["about:blank"]);
    expect(harness.reconcileCalls.map((call) => call.pruneOrphans)).toEqual([
      false,
      true,
      true,
    ]);
    expect(harness.tabsRegistry.list()).toEqual([
      expect.objectContaining({
        ownership: "mcp",
        purpose: "mcp-default",
        reusable: true,
        url: "about:blank",
      }),
    ]);
    expect(harness.bindCalls).toEqual([
      expect.objectContaining({ remoteIndex: 1, remoteTabCount: 2 }),
    ]);
    expect(harness.persistentCalls).toEqual({
      restore: 1,
      adopt: 0,
      close: 0,
    });
  });

  it("runs restore and adoption without cleaning external pages", async () => {
    const useful = remoteTab(1, "https://legacySite.test/", "LegacySite");
    const restored = [remoteTab(0, "about:blank", "", true), useful];
    const harness = makeHarness({
      adoptExistingTabs: true,
      remoteTabs: restored,
      restoredTabs: restored,
      adoptedTab: registeredTab("adopted", useful.url, useful.title),
      cleanedTabs: restored,
    });

    await harness.service.connect();

    expect(harness.driver.newTabCalls).toEqual([]);
    expect(harness.persistentCalls).toEqual({
      restore: 1,
      adopt: 1,
      close: 0,
    });
    expect(harness.reconcileCalls).toEqual([
      expect.objectContaining({ pruneOrphans: false }),
      expect.objectContaining({ pruneOrphans: true }),
      { pruneOrphans: true, remoteTabs: restored },
    ]);
  });

  it("creates the default tab when a persistent profile has nothing to adopt", async () => {
    const harness = makeHarness({
      adoptExistingTabs: true,
      remoteTabs: [],
      restoredTabs: [],
      newTabResult: [remoteTab(0, "about:blank", "", true)],
      cleanedTabs: [remoteTab(0, "about:blank", "", true)],
    });

    await harness.service.connect();

    expect(harness.persistentCalls).toEqual({
      restore: 1,
      adopt: 1,
      close: 0,
    });
    expect(harness.driver.newTabCalls).toEqual(["about:blank"]);
    expect(harness.tabsRegistry.list()).toHaveLength(1);
    expect(harness.bindCalls).toHaveLength(1);
  });

  it("does not adopt or create a tab when reconciliation preserves one", async () => {
    const existing = registeredTab(
      "existing",
      "https://existing.test/",
      "Existing",
    );
    const harness = makeHarness({
      tabs: [existing],
      remoteTabs: [remoteTab(2, existing.url!, existing.title!, true)],
    });

    await harness.service.connect();

    expect(harness.driver.newTabCalls).toEqual([]);
    expect(harness.bindCalls).toEqual([]);
    expect(harness.persistentCalls).toEqual({
      restore: 1,
      adopt: 0,
      close: 0,
    });
  });

  it("rejects a default tab result without a usable current tab", async () => {
    const harness = makeHarness({
      remoteTabs: [],
      newTabResult: [remoteTab(0, "about:blank", "", false)],
    });

    await expect(harness.service.connect()).rejects.toMatchObject({
      code: "TAB_NOT_FOUND",
      message: expect.stringContaining("current browser tab"),
    });

    expect(harness.tabsRegistry.list()).toEqual([]);
    expect(harness.bindCalls).toEqual([]);
  });

  it("propagates driver connection failures without touching tab state", async () => {
    const connectionError = new Error("connection failed");
    const harness = makeHarness({ connectionError });

    await expect(harness.service.connect()).rejects.toBe(connectionError);

    expect(harness.driver.listTabsCalls).toBe(0);
    expect(harness.driver.newTabCalls).toEqual([]);
    expect(harness.reconcileCalls).toEqual([]);
    expect(harness.tabsRegistry.list()).toEqual([]);
  });
});

interface HarnessOptions {
  adoptExistingTabs?: boolean;
  tabs?: BrowserTab[];
  remoteTabs?: BrowserDriverTab[];
  newTabResult?: BrowserDriverTab[];
  restoredTabs?: BrowserDriverTab[];
  adoptedTab?: BrowserTab;
  cleanedTabs?: BrowserDriverTab[];
  connectionError?: Error;
}

function makeHarness(options: HarnessOptions = {}) {
  const tabsRegistry = new TabRegistry(options.tabs ?? []);
  const driver = new FakeBootstrapDriver({
    remoteTabs: options.remoteTabs ?? [],
    newTabResult: options.newTabResult ?? [],
    ...(options.connectionError === undefined
      ? {}
      : { connectionError: options.connectionError }),
  });
  const reconcileCalls: Array<{
    pruneOrphans: boolean;
    remoteTabs: readonly BrowserDriverTab[];
  }> = [];
  const bindCalls: Array<{
    tabId: string;
    remoteIndex: number;
    remoteTabCount: number | undefined;
  }> = [];
  const persistentCalls = { restore: 0, adopt: 0, close: 0 };

  const tabSelection: BrowserConnectionBootstrapServiceOptions["tabSelection"] = {
    async reconcileBindings(pruneOrphans, knownRemoteTabs = []) {
      reconcileCalls.push({
        pruneOrphans: pruneOrphans ?? false,
        remoteTabs: knownRemoteTabs,
      });
      return knownRemoteTabs;
    },
  };
  const persistentTabs: BrowserConnectionBootstrapServiceOptions["persistentTabs"] = {
    async restore(remoteTabs) {
      persistentCalls.restore += 1;
      return options.restoredTabs ?? remoteTabs;
    },
    adopt() {
      persistentCalls.adopt += 1;
      return options.adoptedTab;
    },
    async closeUnclaimedBlankTabs(remoteTabs) {
      persistentCalls.close += 1;
      return options.cleanedTabs ?? remoteTabs;
    },
  };
  const service = new BrowserConnectionBootstrapService({
    driver,
    adoptExistingTabs: options.adoptExistingTabs ?? false,
    tabsRegistry,
    tabBindings: {
      bind(tabId, remote, remoteTabCount) {
        bindCalls.push({
          tabId,
          remoteIndex: remote.index,
          remoteTabCount,
        });
      },
    },
    tabSelection,
    persistentTabs,
  });

  return {
    service,
    driver,
    tabsRegistry,
    reconcileCalls,
    bindCalls,
    persistentCalls,
  };
}

class FakeBootstrapDriver {
  connectCalls = 0;
  listTabsCalls = 0;
  readonly newTabCalls: string[] = [];

  constructor(
    private readonly options: {
      remoteTabs: BrowserDriverTab[];
      newTabResult: BrowserDriverTab[];
      connectionError?: Error;
    },
  ) {}

  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.options.connectionError) throw this.options.connectionError;
  }

  async listTabs(): Promise<BrowserDriverTab[]> {
    this.listTabsCalls += 1;
    return this.options.remoteTabs;
  }

  async newTab(url = "about:blank"): Promise<BrowserDriverTab[]> {
    this.newTabCalls.push(url);
    return this.options.newTabResult;
  }
}

function registeredTab(
  tabId: string,
  url: string,
  title: string,
): BrowserTab {
  return {
    tabId,
    ownership: "mcp",
    purpose: "bootstrap-test",
    reusable: true,
    protected: false,
    sticky: false,
    createdAt: now,
    lastUsedAt: now,
    url,
    title,
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
