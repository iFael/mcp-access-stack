import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import type { Frame } from "playwright";
import type { BrowserTab } from "@vs-code-gpt/shared";
import { BrowserRuntime } from "../../services/browser-runtime.js";
import { BrowserOperationTelemetry } from "../../infrastructure/browser-operation-telemetry.js";
import { DirectPlaywrightDriver } from "../../drivers/direct/direct-playwright-driver.js";
import { createBrowserSession } from "../../domain/browser-session-model.js";
import type { BrowserWorkerConfig } from "../../config/browser-worker-config.js";
import type {
  BrowserAuthenticationInspection,
  BrowserCredentialAuthenticationResult,
  BrowserCredentialInput,
  BrowserDriver,
  BrowserDriverResponse,
  BrowserDriverTab,
} from "../../drivers/browser-driver.js";
import { BrowserSessionRegistry } from "../../domain/session-registry.js";
import { hashOwnerScope } from "../../domain/browser-task-registry.js";
import { CredentialSecret } from "../../services/windows-credential-broker-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("BrowserSessionRegistry", () => {
  it("persists tabs and remote bindings atomically", async () => {
    const directory = await makeTemporaryDirectory();
    const store = new BrowserSessionRegistry(directory);
    await store.save([], [], []);
    const loaded = await store.load();
    expect(loaded.schemaVersion).toBe(6);
    expect(loaded.browser).toBe("chrome");
    expect(loaded.tabGroup).toBe("MCP");
    expect(loaded.sessions).toEqual([]);
    expect(loaded.tabs).toEqual([]);
    expect(loaded.bindings).toEqual([]);
    expect(path.dirname(store.filePath)).toContain("registry");
  });

  it("rejects tabs that attempt to cross session or driver boundaries", async () => {
    const directory = await makeTemporaryDirectory();
    const store = new BrowserSessionRegistry(directory);
    const session = createBrowserSession("direct", "2026-07-02T00:00:00.000Z");
    const tab = {
      tabId: "tab-1",
      taskId: "task-1",
      lifecycle: "task-scoped" as const,
      sessionId: session.sessionId,
      driver: "direct" as const,
      remoteTabId: "direct:page:1",
      remoteIndex: 1,
      ownership: "mcp" as const,
      purpose: "research",
      reusable: true,
      protected: false,
      sticky: false,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      url: "https://example.com/",
      title: "Example",
    };
    const binding = {
      tabId: tab.tabId,
      sessionId: "other-session",
      driver: "direct" as const,
      remoteTabId: "direct:page:1",
      remoteIndex: 1,
      url: "https://example.com/",
      title: "Example",
    };
    const task = {
      taskId: tab.taskId,
      ownerScopeHash: hashOwnerScope("test-owner"),
      state: "suspended" as const,
      tabIds: [tab.tabId],
      createdAt: tab.createdAt,
      lastActivityAt: tab.lastUsedAt,
      expiresAt: "2026-07-02T00:10:00.000Z",
      lifecycleVersion: 2 as const,
    };

    await expect(store.save([session], [tab], [binding], [task])).rejects.toThrow(
      /missing session|inconsistent/i,
    );
  });

  it("migrates safe version 2 bindings into one disconnected MCP session", async () => {
    const directory = await makeTemporaryDirectory();
    const store = new BrowserSessionRegistry(directory);
    await mkdir(path.dirname(store.filePath), { recursive: true });
    await writeFile(
      store.filePath,
      JSON.stringify({
        schemaVersion: 2,
        browser: "chrome",
        profile: "default",
        tabGroup: "MCP",
        updatedAt: "2026-07-02T00:00:00.000Z",
        tabs: [{
          tabId: "legacy-tab",
          ownership: "mcp",
          purpose: "research",
          reusable: true,
          protected: false,
          sticky: false,
          createdAt: "2026-07-02T00:00:00.000Z",
          lastUsedAt: "2026-07-02T00:00:00.000Z",
          url: "https://example.com/",
          title: "Example",
        }],
        bindings: [{
          tabId: "legacy-tab",
          remoteIndex: 3,
          url: "https://example.com/",
          title: "Example",
        }],
      }),
      "utf8",
    );

    const loaded = await store.load();
    expect(loaded.schemaVersion).toBe(6);
    expect(loaded.sessions).toEqual([]);
    expect(loaded.tabs).toEqual([]);
    expect(loaded.bindings).toEqual([]);
  });

  it("quarantines a version 4 registry without assigning its tabs to a caller", async () => {
    const directory = await makeTemporaryDirectory();
    const store = new BrowserSessionRegistry(directory);
    await mkdir(path.dirname(store.filePath), { recursive: true });
    await writeFile(store.filePath, JSON.stringify({
      schemaVersion: 4,
      browser: "chrome",
      tabGroup: "MCP",
      updatedAt: "2026-08-02T00:00:00.000Z",
      sessions: [{
        sessionId: "session-v4",
        driver: "direct",
        mode: "interactive",
        state: "disconnected",
        profileType: "persistent",
        createdAt: "2026-08-02T00:00:00.000Z",
        lastUsedAt: "2026-08-02T00:01:00.000Z"
      }],
      tabs: [{
        tabId: "tab-v4",
        sessionId: "session-v4",
        driver: "direct",
        remoteTabId: "direct:page:v4",
        remoteIndex: 0,
        ownership: "mcp",
        purpose: "legacy",
        reusable: true,
        protected: true,
        sticky: true,
        createdAt: "2026-08-02T00:00:00.000Z",
        lastUsedAt: "2026-08-02T00:01:00.000Z",
        url: "https://example.com/legacy",
        title: "Legacy"
      }],
      bindings: [{
        tabId: "tab-v4",
        sessionId: "session-v4",
        driver: "direct",
        remoteTabId: "direct:page:v4",
        remoteIndex: 0,
        url: "https://example.com/legacy",
        title: "Legacy"
      }]
    }), "utf8");

    const loaded = await store.load();
    expect(loaded.schemaVersion).toBe(6);
    expect(loaded.tasks).toEqual([expect.objectContaining({
      taskId: "task-session-v4",
      ownerScopeHash: "legacy-unclaimed",
      state: "expired",
      tabIds: [],
      lifecycleVersion: 2,
    })]);
    expect(loaded.tabs).toEqual([]);
    expect(loaded.bindings).toEqual([]);
  });

  it("quarantines version 5 tasks created with the legacy owner algorithm", async () => {
    const directory = await makeTemporaryDirectory();
    const store = new BrowserSessionRegistry(directory);
    await mkdir(path.dirname(store.filePath), { recursive: true });
    await writeFile(store.filePath, JSON.stringify({
      schemaVersion: 5,
      browser: "chrome",
      tabGroup: "MCP",
      updatedAt: "2026-08-05T12:00:00.000Z",
      sessions: [{
        sessionId: "legacy-session-v5",
        driver: "direct",
        mode: "interactive",
        state: "disconnected",
        profileType: "persistent",
        createdAt: "2026-08-05T11:00:00.000Z",
        lastUsedAt: "2026-08-05T12:00:00.000Z",
      }],
      tasks: [{
        taskId: "legacy-task-v5",
        ownerScopeHash: "a".repeat(64),
        state: "active",
        tabIds: ["legacy-tab-v5"],
        createdAt: "2026-08-05T11:00:00.000Z",
        lastActivityAt: "2026-08-05T12:00:00.000Z",
        expiresAt: "2026-08-05T12:10:00.000Z",
        lifecycleVersion: 1,
      }],
      tabs: [{
        tabId: "legacy-tab-v5",
        taskId: "legacy-task-v5",
        lifecycle: "task-scoped",
        sessionId: "legacy-session-v5",
        driver: "direct",
        remoteTabId: "direct:page:legacy-v5",
        remoteIndex: 0,
        ownership: "mcp",
        purpose: "legacy-owner",
        reusable: true,
        protected: false,
        sticky: false,
        createdAt: "2026-08-05T11:00:00.000Z",
        lastUsedAt: "2026-08-05T12:00:00.000Z",
        url: "https://legacy.example/",
        title: "Legacy",
      }],
      bindings: [{
        tabId: "legacy-tab-v5",
        sessionId: "legacy-session-v5",
        driver: "direct",
        remoteTabId: "direct:page:legacy-v5",
        remoteIndex: 0,
        url: "https://legacy.example/",
        title: "Legacy",
      }],
    }), "utf8");

    const loaded = await store.load();
    expect(loaded.schemaVersion).toBe(6);
    expect(loaded.tasks).toEqual([expect.objectContaining({
      taskId: "legacy-task-v5",
      state: "expired",
      tabIds: [],
      lifecycleVersion: 2,
    })]);
    expect(loaded.tabs).toEqual([]);
    expect(loaded.bindings).toEqual([]);
  });

  it("cleans an orphaned active session after a restart", async () => {
    const directory = await makeTemporaryDirectory();
    const store = new BrowserSessionRegistry(directory);
    await mkdir(path.dirname(store.filePath), { recursive: true });
    await writeFile(
      store.filePath,
      JSON.stringify({
        schemaVersion: 3,
        browser: "chrome",
        tabGroup: "MCP",
        updatedAt: "2026-07-02T00:00:00.000Z",
        sessions: [{
          sessionId: "orphan-session",
          driver: "direct",
          mode: "efficient",
          state: "connected",
          profileType: "persistent",
          createdAt: "2026-07-02T00:00:00.000Z",
          lastUsedAt: "2026-07-02T00:00:00.000Z",
        }],
        tabs: [],
        bindings: [],
      }),
      "utf8",
    );

    const loaded = await store.load();
    expect(loaded.sessions).toEqual([]);
    expect(loaded.tabs).toEqual([]);
    expect(loaded.bindings).toEqual([]);
  });
});

describe("BrowserRuntime Playwright layer", () => {
  it("preserves an existing page and creates a separate task-scoped MCP tab", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(
      makeConfig(directory),
      () => fake,
    );

    await expect(runtime.status({})).resolves.toMatchObject({
      state: "disconnected",
      ready: false,
      tabCount: 0,
    });
    await expect(runtime.connect({})).resolves.toMatchObject({
      state: "connected",
      ready: true,
      tabCount: 1,
    });

    const tabs = await runtime.tabs({});
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.tabs[0]).toMatchObject({
      ownership: "mcp",
      purpose: "mcp-default",
      lifecycle: "task-scoped",
      taskId: expect.stringMatching(/^task-/),
      url: "about:blank",
    });
    expect(tabs.tabs.some((tab) => tab.url === "https://personal.example/")).toBe(false);
    expect(fake.remoteTabs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://personal.example/" }),
      expect.objectContaining({ url: "about:blank" }),
    ]));

    const persisted = await new BrowserSessionRegistry(directory).load();
    expect(persisted.sessions).toHaveLength(1);
    expect(persisted.tasks).toHaveLength(1);
    expect(persisted.sessions[0]).toMatchObject({
      driver: "direct",
      state: "disconnected",
      profileType: "persistent",
    });
    expect(persisted.tabs).toHaveLength(1);
    expect(persisted.bindings).toHaveLength(1);
    expect(persisted.tabs[0]?.sessionId).toBe(persisted.sessions[0]?.sessionId);
    expect(persisted.bindings[0]?.sessionId).toBe(persisted.sessions[0]?.sessionId);
    expect(persisted.tabs[0]?.driver).toBe("direct");
    expect(persisted.bindings[0]?.driver).toBe("direct");
  });


  it("keeps connection rollback in the runtime when bootstrap fails", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const connectionError = new Error("bootstrap connection failed");
    fake.failNextConnect(connectionError);
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);

    await expect(runtime.connect({})).rejects.toBe(connectionError);
    await expect(runtime.status({})).resolves.toMatchObject({
      state: "disconnected",
      ready: false,
      tabCount: 0,
    });
    expect(fake.connectCount).toBe(1);
    expect(fake.closeCount).toBe(1);

    const store = new BrowserSessionRegistry(directory);
    const raw = JSON.parse(await readFile(store.filePath, "utf8")) as {
      sessions: Array<{ state: string }>;
      tabs: unknown[];
      bindings: unknown[];
    };
    expect(raw.sessions).toEqual([
      expect.objectContaining({ state: "failed" }),
    ]);
    expect(raw.tabs).toEqual([]);
    expect(raw.bindings).toEqual([]);

    const recovered = await store.load();
    expect(recovered.sessions).toEqual([]);
    expect(recovered.tabs).toEqual([]);
    expect(recovered.bindings).toEqual([]);
  });
  it("does not adopt the current external tab in a dedicated persistent profile", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.profileMode = "persistent";
    config.userDataDirectory = path.join(config.privateDirectory, "chrome-profile");
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(config, () => fake);

    await expect(runtime.connect({})).resolves.toMatchObject({
      profile: "dedicated-persistent",
      tabCount: 1,
    });
    expect(fake.newTabCount).toBe(1);
    expect((await runtime.tabs({})).tabs[0]).toMatchObject({
      ownership: "mcp",
      purpose: "mcp-default",
      lifecycle: "task-scoped",
      url: "about:blank",
    });
    expect(fake.remoteTabs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://personal.example/" }),
    ]));
  });

  it("preserves unregistered external tabs instead of adopting or closing them", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.profileMode = "persistent";
    config.userDataDirectory = path.join(config.privateDirectory, "chrome-profile");
    const fake = new FakeBrowserDriver();
    fake.setTabs([
      {
        index: 0,
        current: true,
        title: "",
        url: "about:blank",
        crashed: false,
      },
      {
        index: 1,
        current: false,
        title: "LegacySite",
        url: config.primaryPrivateSiteUrl!.href,
        crashed: false,
      },
    ]);
    const runtime = await BrowserRuntime.create(config, () => fake);

    await runtime.connect({});
    const tabs = (await runtime.tabs({})).tabs;

    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({
      purpose: "mcp-default",
      lifecycle: "task-scoped",
      url: "about:blank",
      sticky: false,
      protected: false,
    });
    expect(fake.closeTabCount).toBe(0);
    expect(fake.remoteTabs()).toHaveLength(3);
    expect(fake.remoteTabs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "about:blank" }),
      expect.objectContaining({ url: config.primaryPrivateSiteUrl!.href }),
    ]));
  });

  it("closes the dedicated browser only when task finalization is explicit", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.profileMode = "persistent";
    config.userDataDirectory = path.join(config.privateDirectory, "chrome-profile");
    const fake = new FakeBrowserDriver();
    fake.setTabs([]);
    const runtime = await BrowserRuntime.create(config, () => fake);
    await runtime.connect({});
    const opened = await runtime.open({
      url: "https://example.com/",
      purpose: "task-work",
      reusable: true,
    });

    expect(await runtime.tabs({})).toMatchObject({
      tabs: [expect.objectContaining({ tabId: opened.tab.tabId })],
    });
    await expect(runtime.finishTask({})).resolves.toMatchObject({
      completed: true,
      taskId: opened.tab.taskId,
      closedTabs: 1,
      browserClosed: true,
    });
    await expect(runtime.status({})).resolves.toMatchObject({
      state: "disconnected",
      ready: false,
      tabCount: 0,
    });
    expect(fake.closeCount).toBe(1);

    const next = await runtime.open({
      url: "https://example.org/",
      purpose: "next-task",
      reusable: true,
    });
    expect(next.tab.url).toBe("https://example.org/");
    expect(fake.connectCount).toBe(2);
  });

  it("restores an active task after finalization fails before closing its tab", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setTabs([]);
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    const opened = await runtime.open({ url: "https://example.com/retry-finish" });
    fake.failNextCloseTab(new Error("close failed"));

    await expect(
      runtime.finishTask({ taskId: opened.tab.taskId }),
    ).rejects.toThrow("close failed");
    await expect(
      runtime.tabs({ taskId: opened.tab.taskId }),
    ).resolves.toMatchObject({
      tabs: [expect.objectContaining({ tabId: opened.tab.tabId })],
    });
    await expect(
      runtime.finishTask({ taskId: opened.tab.taskId }),
    ).resolves.toMatchObject({
      completed: true,
      taskId: opened.tab.taskId,
      closedTabs: 1,
    });
  });

  it("preserves other persisted sessions when finishing the current task", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.profileMode = "persistent";
    config.userDataDirectory = path.join(config.privateDirectory, "chrome-profile");
    const store = new BrowserSessionRegistry(directory);
    const currentSession = {
      ...createBrowserSession("direct", "2026-07-23T00:00:00.000Z"),
      profileType: "persistent" as const,
    };
    const otherSession = {
      ...createBrowserSession("direct", "2026-07-22T00:00:00.000Z"),
      mode: "efficient" as const,
      profileType: "persistent" as const,
    };
    const currentTab = {
      tabId: "current-tab",
      taskId: "current-task-id",
      lifecycle: "task-scoped" as const,
      sessionId: currentSession.sessionId,
      driver: "direct" as const,
      remoteTabId: "direct:page:0",
      remoteIndex: 0,
      ownership: "mcp" as const,
      purpose: "current-task",
      reusable: true,
      protected: false,
      sticky: false,
      createdAt: currentSession.createdAt,
      lastUsedAt: currentSession.lastUsedAt,
      url: "https://current.example/",
      title: "Current",
    };
    const otherTab = {
      tabId: "other-tab",
      taskId: "other-task-id",
      lifecycle: "task-scoped" as const,
      sessionId: otherSession.sessionId,
      driver: "direct" as const,
      remoteTabId: "direct:page:1",
      remoteIndex: 1,
      ownership: "mcp" as const,
      purpose: "other-session",
      reusable: true,
      protected: false,
      sticky: false,
      createdAt: otherSession.createdAt,
      lastUsedAt: otherSession.lastUsedAt,
      url: "https://other.example/",
      title: "Other",
    };
    const currentBinding = {
      tabId: currentTab.tabId,
      sessionId: currentSession.sessionId,
      driver: "direct" as const,
      remoteTabId: currentTab.remoteTabId,
      remoteIndex: currentTab.remoteIndex,
      url: currentTab.url,
      title: currentTab.title,
    };
    const otherBinding = {
      tabId: otherTab.tabId,
      sessionId: otherSession.sessionId,
      driver: "direct" as const,
      remoteTabId: otherTab.remoteTabId,
      remoteIndex: otherTab.remoteIndex,
      url: otherTab.url,
      title: otherTab.title,
    };
    const ownerScopeHash = hashOwnerScope("legacy-local");
    const currentTask = {
      taskId: currentTab.taskId,
      ownerScopeHash,
      state: "suspended" as const,
      tabIds: [currentTab.tabId],
      createdAt: currentTab.createdAt,
      lastActivityAt: currentTab.lastUsedAt,
      expiresAt: "2026-07-23T00:10:00.000Z",
      lifecycleVersion: 2 as const,
    };
    const otherTask = {
      taskId: otherTab.taskId,
      ownerScopeHash,
      state: "suspended" as const,
      tabIds: [otherTab.tabId],
      createdAt: otherTab.createdAt,
      lastActivityAt: otherTab.lastUsedAt,
      expiresAt: "2026-07-22T00:10:00.000Z",
      lifecycleVersion: 2 as const,
    };
    await store.save(
      [currentSession, otherSession],
      [currentTab, otherTab],
      [currentBinding, otherBinding],
      [currentTask, otherTask],
    );
    const fake = new FakeBrowserDriver();
    fake.setTabs([{
      index: 0,
      current: true,
      title: currentTab.title,
      url: currentTab.url,
      crashed: false,
    }]);
    fake.resetToBlankOnClose();
    const runtime = await BrowserRuntime.create(config, () => fake);

    await runtime.tabs({ taskId: currentTab.taskId });
    await expect(runtime.finishTask({ taskId: currentTab.taskId })).resolves.toMatchObject({
      completed: true,
      taskId: currentTab.taskId,
      closedTabs: 1,
      browserClosed: false,
    });

    const persisted = await store.load();
    expect(persisted.tabs).toEqual([
      expect.objectContaining({
        tabId: otherTab.tabId,
        sessionId: otherSession.sessionId,
        driver: "direct",
      }),
    ]);
    expect(persisted.bindings).toEqual([
      expect.objectContaining({
        tabId: otherTab.tabId,
        sessionId: otherSession.sessionId,
        driver: "direct",
      }),
    ]);
  });

  it("preserves task, tab and owner across separate calls and a worker restart", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.profileMode = "persistent";
    config.userDataDirectory = path.join(config.privateDirectory, "chrome-profile");
    const owner = { ownerScope: "stable-owner-scope" };
    const firstDriver = new FakeBrowserDriver();
    firstDriver.setTabs([]);
    const firstRuntime = await BrowserRuntime.create(config, () => firstDriver);
    const opened = await firstRuntime.open({
      url: "https://example.com/lifecycle",
      purpose: "lifecycle-continuity",
      reusable: true,
    }, owner);
    const { taskId, tabId } = opened.tab;

    const waitLease = firstRuntime.acquireOperationLease(
      "wait",
      { tabId, timeoutMs: 1 },
      owner,
    );
    try {
      await expect(firstRuntime.wait({ tabId, timeoutMs: 1 })).resolves.toMatchObject({
        tabId,
        completed: true,
      });
    } finally {
      waitLease.release();
    }

    const snapshotLease = firstRuntime.acquireOperationLease(
      "snapshot",
      { tabId },
      owner,
    );
    try {
      await expect(firstRuntime.snapshot({ tabId })).resolves.toMatchObject({
        tabId,
        refs: expect.arrayContaining([
          expect.objectContaining({ ref: "e9", name: "Open details" }),
        ]),
      });
    } finally {
      snapshotLease.release();
    }

    const firstExtractLease = firstRuntime.acquireOperationLease(
      "extract",
      { tabId, format: "text" },
      owner,
    );
    try {
      await expect(firstRuntime.extract({ tabId, format: "text" })).resolves.toMatchObject({
        tabId,
        format: "text",
        value: "extracted",
      });
    } finally {
      firstExtractLease.release();
    }

    const clickLease = firstRuntime.acquireOperationLease(
      "click",
      { tabId, ref: "e9" },
      owner,
    );
    try {
      await expect(firstRuntime.click({ tabId, ref: "e9" })).resolves.toMatchObject({
        tabId,
        completed: true,
      });
    } finally {
      clickLease.release();
    }

    const secondExtractLease = firstRuntime.acquireOperationLease(
      "extract",
      { tabId, format: "text" },
      owner,
    );
    try {
      await expect(firstRuntime.extract({ tabId, format: "text" })).resolves.toMatchObject({
        tabId,
        format: "text",
        value: "extracted",
      });
    } finally {
      secondExtractLease.release();
    }
    await firstRuntime.shutdown();

    const secondDriver = new FakeBrowserDriver();
    secondDriver.setTabs([{
      index: 0,
      current: true,
      title: "Navigated",
      url: "https://example.com/lifecycle",
      crashed: false,
    }]);
    const secondRuntime = await BrowserRuntime.create(config, () => secondDriver);
    await expect(secondRuntime.tabs({ taskId }, owner)).resolves.toEqual({
      tabs: [expect.objectContaining({ taskId, tabId })],
    });
    expect(() => secondRuntime.acquireOperationLease(
      "snapshot",
      { tabId },
      { ownerScope: "different-owner-scope" },
    )).toThrow(expect.objectContaining({ code: "TASK_OWNERSHIP_MISMATCH" }));

    const resumedLease = secondRuntime.acquireOperationLease(
      "snapshot",
      { tabId },
      owner,
    );
    try {
      await expect(secondRuntime.snapshot({ tabId })).resolves.toMatchObject({ tabId });
    } finally {
      resumedLease.release();
    }
    await secondRuntime.shutdown();
  });

  it("restores a sticky tab with the same logical id after a persistent worker restart", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.profileMode = "persistent";
    config.userDataDirectory = path.join(config.privateDirectory, "chrome-profile");
    const firstDriver = new FakeBrowserDriver();
    const firstRuntime = await BrowserRuntime.create(config, () => firstDriver);
    const firstOpened = await authorizeLegacySite(firstRuntime, "restart-test");
    const firstTab = firstOpened.tab;
    await firstRuntime.shutdown();

    const secondDriver = new FakeBrowserDriver();
    secondDriver.setTabs([{
      index: 0,
      current: true,
      title: "",
      url: "about:blank",
      crashed: false,
    }]);
    const secondRuntime = await BrowserRuntime.create(config, () => secondDriver);
    await secondRuntime.connect({});
    const [dormant] = (await secondRuntime.tabs({})).tabs;

    expect(dormant).toMatchObject({
      tabId: firstTab.tabId,
      purpose: "private-site",
      sticky: true,
      protected: true,
      url: "about:blank",
      lockedUrl: config.primaryPrivateSiteUrl!.href,
    });
    expect(() => secondRuntime.acquireOperationLease(
      "snapshot",
      { tabId: dormant!.tabId },
      {},
    )).toThrow(expect.objectContaining({
      code: "SITE_ACCESS_AUTHORIZATION_REQUIRED",
    }));
    await expect(secondRuntime.snapshot({
      tabId: dormant!.tabId,
    })).rejects.toMatchObject({
      code: "SITE_ACCESS_AUTHORIZATION_REQUIRED",
    });
    const reopened = await authorizeLegacySite(
      secondRuntime,
      "restart-test",
      dormant?.taskId,
    );
    expect(reopened.tab).toMatchObject({
      tabId: firstTab.tabId,
      url: config.primaryPrivateSiteUrl!.href,
    });
    expect(secondDriver.newTabCount).toBe(0);
  });


  it("uses snapshot refs and requires one-time confirmation for destructive clicks", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    const [tab] = (await runtime.tabs({})).tabs;
    if (!tab) throw new Error("Expected MCP tab.");

    const snapshot = await runtime.snapshot({ tabId: tab.tabId });
    expect(snapshot.refs).toContainEqual({
      ref: "e7",
      role: "button",
      name: "Delete account",
    });
    expect(snapshot.refs).toContainEqual({
      ref: "e8",
      role: "textbox",
      name: "Email",
    });

    let confirmationId = "";
    try {
      await runtime.click({ tabId: tab.tabId, ref: "e7" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      confirmationId = /"confirmationId":"([^"]+)"/.exec(message)?.[1] ?? "";
      expect(error).toMatchObject({ code: "ACTION_REQUIRES_CONFIRMATION" });
    }
    expect(confirmationId).not.toBe("");

    await expect(
      runtime.click({ tabId: tab.tabId, ref: "e7", confirmationId }),
    ).resolves.toEqual({ tabId: tab.tabId, completed: true });
    expect(fake.calls.some((call) => call.name === "browser_click")).toBe(true);
  });

  it("requires confirmation and uploads files through direct Playwright", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    const [tab] = (await runtime.tabs({})).tabs;
    if (!tab) throw new Error("Expected MCP tab.");

    const input = {
      tabId: tab.tabId,
      files: [{
        name: "playbook.md",
        contentBase64: "aGVsbG8=",
        mimeType: "text/markdown",
      }],
      selector: "input[type=file]",
    };
    let confirmationId = "";
    try {
      await runtime.upload(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      confirmationId = /"confirmationId":"([^"]+)"/.exec(message)?.[1] ?? "";
      expect(error).toMatchObject({ code: "ACTION_REQUIRES_CONFIRMATION" });
    }

    await expect(runtime.upload({ ...input, confirmationId })).resolves.toEqual({
      tabId: tab.tabId,
      completed: true,
      fileCount: 1,
      totalBytes: 5,
    });
    const upload = fake.calls.find((call) => call.name === "direct_set_input_files");
    expect(upload?.args.selector).toBe("input[type=file]");
    expect(JSON.stringify(upload?.args.files)).toContain("playbook.md");
  });

  it("auto-connects browser actions without requiring a separate connect call", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);

    const opened = await runtime.open({ url: "https://example.com/automatic" });

    expect(opened.tab.url).toBe("https://example.com/automatic");
    await expect(runtime.status({})).resolves.toMatchObject({
      state: "connected",
      ready: true,
      tabCount: 1,
    });
    expect(fake.newTabCount).toBe(1);
  });

  it("stabilizes delayed DOM hydration before runtime extraction", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.headless = true;
    config.userDataDirectory = path.join(directory, "private", "stage8-profile");
    const telemetry = new BrowserOperationTelemetry(directory);
    const driver = new DirectPlaywrightDriver(config);
    const runtime = await BrowserRuntime.create(
      config,
      () => driver,
      { telemetry },
    );
    try {
      await runtime.connect({});
      const [tab] = (await runtime.tabs({})).tabs;
      if (!tab) throw new Error("Expected the default MCP tab.");
      await driver.currentPage().setContent(`
        <!doctype html>
        <html><body>
          <main id="content">initial</main>
          <script>
            setTimeout(() => {
              document.getElementById("content").textContent = "hydrated-runtime-content";
            }, 250);
          </script>
        </body></html>
      `);

      const extracted = await telemetry.run(
        { traceId: "6".repeat(32), operation: "extract" },
        () => runtime.extract({ tabId: tab.tabId, format: "text" }),
      );
      await telemetry.flush();

      expect(extracted.value).toContain("hydrated-runtime-content");
      const log = await readFile(telemetry.filePath, "utf8");
      expect(log).toContain('"event":"browser_page_stabilization"');
      expect(log).toContain('"status":"stable"');
      expect(log).not.toContain("hydrated-runtime-content");
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);

  it("discovers lazy content below the fold with bounded document extraction", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.headless = true;
    config.userDataDirectory = path.join(directory, "private", "stage9-lazy-profile");
    config.extractionMaxScrolls = 8;
    config.extractionTimeoutMs = 15_000;
    const telemetry = new BrowserOperationTelemetry(directory);
    const driver = new DirectPlaywrightDriver(config);
    const runtime = await BrowserRuntime.create(
      config,
      () => driver,
      { telemetry },
    );
    try {
      await runtime.connect({});
      const [tab] = (await runtime.tabs({})).tabs;
      if (!tab) throw new Error("Expected the default MCP tab.");
      const page = driver.currentPage();
      await page.setViewportSize({ width: 800, height: 600 });
      await page.setContent(`
        <!doctype html>
        <html><body>
          <main>
            <p>above-fold-runtime-content</p>
            <div style="height: 1600px"></div>
            <p id="tail">tail-runtime-content</p>
          </main>
          <script>
            addEventListener("scroll", () => {
              if (scrollY < 200 || document.getElementById("lazy-runtime")) return;
              const item = document.createElement("p");
              item.id = "lazy-runtime";
              item.textContent = "lazy-below-fold-runtime-content";
              document.getElementById("tail").before(item);
            });
          </script>
        </body></html>
      `);

      const extracted = await telemetry.run(
        { traceId: "7".repeat(32), operation: "extract" },
        () => runtime.extract({
          tabId: tab.tabId,
          format: "text",
          completion: "document",
        }),
      );
      await telemetry.flush();

      expect(extracted.value).toContain("above-fold-runtime-content");
      expect(extracted.value).toContain("lazy-below-fold-runtime-content");
      expect(extracted.value).toContain("tail-runtime-content");
      expect(extracted.completeness).toMatchObject({
        status: "complete",
        reason: "end-of-document",
        mode: "document",
        pages: 1,
      });
      expect(extracted.completeness?.scrolls).toBeGreaterThan(0);
      const log = await readFile(telemetry.filePath, "utf8");
      expect(log).toContain('"event":"browser_extraction_completeness"');
      expect(log).toContain('"status":"complete"');
      expect(log).not.toContain("lazy-below-fold-runtime-content");
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);

  it("applies the same bounded completeness logic inside an explicitly targeted frame", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.headless = true;
    config.userDataDirectory = path.join(directory, "private", "stage9-frame-profile");
    config.extractionMaxScrolls = 8;
    config.extractionTimeoutMs = 15_000;
    const driver = new DirectPlaywrightDriver(config);
    const runtime = await BrowserRuntime.create(config, () => driver);
    try {
      await runtime.connect({});
      const [tab] = (await runtime.tabs({})).tabs;
      if (!tab) throw new Error("Expected the default MCP tab.");
      const page = driver.currentPage();
      await page.setViewportSize({ width: 800, height: 600 });
      await page.setContent('<iframe name="lazy-frame" style="width: 700px; height: 400px"></iframe>');
      const frame = page.frames().find((candidate) => candidate.name() === "lazy-frame");
      if (!frame) throw new Error("Expected lazy-frame.");
      await frame.setContent(`
        <!doctype html>
        <html><body>
          <p>frame-above-fold</p>
          <div style="height: 1200px"></div>
          <p id="frame-tail">frame-tail</p>
          <script>
            addEventListener("scroll", () => {
              if (scrollY < 100 || document.getElementById("frame-lazy")) return;
              const item = document.createElement("p");
              item.id = "frame-lazy";
              item.textContent = "frame-lazy-content";
              document.getElementById("frame-tail").before(item);
            });
          </script>
        </body></html>
      `);

      const extracted = await runtime.frameExtract({
        tabId: tab.tabId,
        frame: "lazy-frame",
        format: "text",
        completion: "document",
      });

      expect(extracted.value).toContain("frame-above-fold");
      expect(extracted.value).toContain("frame-lazy-content");
      expect(extracted.value).toContain("frame-tail");
      expect(extracted.completeness).toMatchObject({
        status: "complete",
        reason: "end-of-document",
        mode: "document",
        pages: 1,
      });
      expect(extracted.completeness?.scrolls).toBeGreaterThan(0);
    } finally {
      await runtime.shutdown();
    }
  }, 30_000);
  it("reuses the default tab and repeated reusable opens instead of creating duplicates", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    const [defaultTab] = (await runtime.tabs({})).tabs;
    if (!defaultTab) throw new Error("Expected MCP default tab.");

    const listCallsAfterConnect = fake.listTabsCount;
    const first = await runtime.open({ url: "https://example.com/reused" });
    expect(fake.listTabsCount - listCallsAfterConnect).toBe(1);
    const second = await runtime.open({ url: "https://example.com/reused" });
    expect(fake.listTabsCount - listCallsAfterConnect).toBe(2);

    expect(first.tab.tabId).toBe(defaultTab.tabId);
    expect(second.tab.tabId).toBe(defaultTab.tabId);
    expect((await runtime.tabs({})).tabs).toHaveLength(1);
    expect(fake.newTabCount).toBe(1);
    expect(fake.calls.filter((call) => call.name === "browser_navigate")).toHaveLength(1);
  });

  it("emits sanitized selection and navigation-cache telemetry", async () => {
    const directory = await makeTemporaryDirectory();
    const telemetry = new BrowserOperationTelemetry(directory);
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(
      makeConfig(directory),
      () => fake,
      { telemetry },
    );
    await runtime.connect({});

    const first = await telemetry.run(
      { traceId: "f".repeat(32), operation: "open" },
      () => runtime.open({ url: "https://example.com/cache", purpose: "cache-purpose" }),
    );
    await telemetry.run(
      { traceId: "1".repeat(32), operation: "open" },
      () => runtime.open({ url: "https://example.com/cache", purpose: "cache-purpose" }),
    );
    await telemetry.run(
      { traceId: "2".repeat(32), operation: "open" },
      () => runtime.open({ purpose: "cache-purpose" }),
    );
    await telemetry.run(
      { traceId: "3".repeat(32), operation: "open" },
      () => runtime.open({ url: "https://example.org/dedicated", reusable: false }),
    );
    await telemetry.run(
      { traceId: "4".repeat(32), operation: "open" },
      () => runtime.open({ url: "https://example.net/second", reusable: false }),
    );
    await telemetry.flush();

    const contents = await readFile(telemetry.filePath, "utf8");
    expect(contents).toContain('"selection":"recycled"');
    expect(contents).toContain('"selection":"exact"');
    expect(contents).toContain('"selection":"created"');
    expect(contents).toContain('"cache":"hit"');
    expect(contents).not.toContain(first.tab.tabId);
    if (first.tab.taskId) expect(contents).not.toContain(first.tab.taskId);
  });
  it("reuses sticky tabs deterministically and navigates only when the fragment changes", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);

    const first = await runtime.open({
      url: "HTTPS://Example.COM:443/a/../sticky#one",
      purpose: "sticky-page",
      sticky: true,
    });
    const navigationsAfterFirst = fake.calls.filter(
      (call) => call.name === "browser_navigate",
    ).length;
    const same = await runtime.open({
      url: "https://example.com/sticky#one",
      purpose: "sticky-page",
      sticky: true,
    });

    expect(same.tab).toMatchObject({
      tabId: first.tab.tabId,
      requestedUrl: "https://example.com/sticky#one",
      lockedUrl: "https://example.com/sticky#one",
      reusable: false,
      protected: true,
      sticky: true,
    });
    expect(fake.calls.filter((call) => call.name === "browser_navigate")).toHaveLength(
      navigationsAfterFirst,
    );

    const fragment = await runtime.open({
      url: "https://example.com/sticky#two",
      purpose: "sticky-page",
      sticky: true,
    });
    expect(fragment.tab).toMatchObject({
      tabId: first.tab.tabId,
      requestedUrl: "https://example.com/sticky#two",
      lockedUrl: "https://example.com/sticky#two",
    });
    expect(fake.calls.filter((call) => call.name === "browser_navigate")).toHaveLength(
      navigationsAfterFirst + 1,
    );
    expect((await runtime.tabs({})).tabs).toHaveLength(1);
  });

  it("reuses an exact dedicated tab but does not recycle it for another URL", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);

    const first = await runtime.open({
      url: "https://example.com/dedicated",
      purpose: "dedicated",
      reusable: false,
    });
    const second = await runtime.open({
      url: "https://example.com/dedicated",
      purpose: "dedicated",
      reusable: false,
    });
    const other = await runtime.open({
      url: "https://example.com/other",
      purpose: "dedicated",
      reusable: false,
    });

    expect(second.tab.tabId).toBe(first.tab.tabId);
    expect(other.tab).toMatchObject({
      requestedUrl: "https://example.com/other",
      reusable: false,
    });
    expect(other.tab.tabId).not.toBe(first.tab.tabId);
    expect((await runtime.tabs({})).tabs).toHaveLength(2);
  });

  it("preserves the requested URL across a redirect and worker restart", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.profileMode = "persistent";
    config.userDataDirectory = path.join(config.privateDirectory, "chrome-profile");
    const owner = { ownerScope: "redirect-owner" };
    const requestedUrl = "https://example.com/start";
    const finalUrl = "https://example.com/final";
    const firstDriver = new FakeBrowserDriver();
    firstDriver.setTabs([]);
    firstDriver.redirect(requestedUrl, finalUrl);
    const firstRuntime = await BrowserRuntime.create(config, () => firstDriver);
    const first = await firstRuntime.open({
      url: requestedUrl,
      purpose: "redirected-page",
      reusable: true,
    }, owner);
    const { taskId, tabId } = first.tab;
    expect(first.tab).toMatchObject({
      url: finalUrl,
      requestedUrl,
    });
    await firstRuntime.shutdown();

    const secondDriver = new FakeBrowserDriver();
    secondDriver.setTabs([{
      id: "page-1",
      index: 0,
      current: true,
      title: "Navigated",
      url: finalUrl,
      crashed: false,
    }]);
    const secondRuntime = await BrowserRuntime.create(config, () => secondDriver);
    const resumed = await secondRuntime.open({
      taskId,
      url: requestedUrl,
      purpose: "redirected-page",
      reusable: true,
    }, owner);

    expect(resumed.tab).toMatchObject({ tabId, taskId, url: finalUrl, requestedUrl });
    expect(secondDriver.newTabCount).toBe(0);
    expect(secondDriver.calls.filter((call) => call.name === "browser_navigate")).toHaveLength(0);
    expect((await secondRuntime.tabs({ taskId }, owner)).tabs).toHaveLength(1);
    await secondRuntime.shutdown();
  });

  it("restores a closed navigation by purpose without creating another physical tab", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.profileMode = "persistent";
    config.userDataDirectory = path.join(config.privateDirectory, "chrome-profile");
    const fake = new FakeBrowserDriver();
    fake.resetToBlankOnClose();
    const runtime = await BrowserRuntime.create(config, () => fake);

    const first = await runtime.open({
      url: "https://example.com/customer-dashboard",
      purpose: "customer-dashboard",
      reusable: true,
    });
    expect(first.restoredFromCache).toBeUndefined();
    await runtime.finishTask({});

    const restored = await runtime.open({
      purpose: "customer-dashboard",
      reusable: true,
    });

    expect(restored).toMatchObject({
      restoredFromCache: true,
      cacheAgeMs: expect.any(Number),
      tab: {
        purpose: "customer-dashboard",
        url: "https://example.com/customer-dashboard",
      },
    });
    expect(fake.newTabCount).toBe(2);
    expect(fake.calls.filter((call) => call.name === "browser_navigate")).toHaveLength(1);
  });

  it("executes a typed sequence with one tab selection and one final snapshot", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    const opened = await runtime.open({ url: "https://example.com/sequence" });
    await runtime.snapshot({ tabId: opened.tab.tabId });
    const listCallsBefore = fake.listTabsCount;

    const result = await runtime.sequence({
      tabId: opened.tab.tabId,
      steps: [
        { action: "fill", ref: "e8", value: "user@example.com" },
        { action: "click", ref: "e9" },
        { action: "wait", timeoutMs: 10 },
        { action: "extract", selector: "body", format: "text" },
      ],
      finalSnapshot: true,
    });

    expect(result).toMatchObject({
      tabId: opened.tab.tabId,
      completed: true,
      steps: [
        { index: 0, action: "fill", completed: true },
        { index: 1, action: "click", completed: true },
        { index: 2, action: "wait", completed: true },
        { index: 3, action: "extract", completed: true, value: expect.anything() },
      ],
      snapshot: {
        tabId: opened.tab.tabId,
        refs: expect.arrayContaining([expect.objectContaining({ ref: "e8" })]),
      },
    });
    expect(fake.listTabsCount - listCallsBefore).toBe(0);
    expect(fake.calls.filter((call) => call.name === "browser_type")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.name === "browser_click")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.name === "browser_wait_for")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.name === "browser_evaluate")).toHaveLength(1);
  });

  it("recovers a registered tab after Chrome renumbers tab indexes", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setTabs([
      {
        id: "personal-page",
        index: 0,
        current: false,
        title: "Personal",
        url: "https://personal.example/",
        crashed: false,
      },
      {
        id: "owned-page",
        index: 1,
        current: true,
        title: "Owned",
        url: "https://owned.example/",
        crashed: false,
      },
    ]);
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    const opened = await runtime.open({ url: "https://owned.example/" });
    const tab = opened.tab;

    fake.removePersonalTabAndShiftIndexes();

    await expect(runtime.snapshot({ tabId: tab.tabId })).resolves.toMatchObject({
      tabId: tab.tabId,
      url: "https://owned.example/",
    });
    const persisted = await new BrowserSessionRegistry(directory).load();
    const binding = persisted.bindings.find((candidate) => candidate.tabId === tab.tabId);
    expect(binding?.remoteIndex).toBe(1);
    expect(binding?.remoteTabId).toMatch(/^direct:page:/);
  });

  it("converts a recyclable default tab into a dedicated tab before enforcing the limit", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.maxOwnedTabs = 1;
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(config, () => fake);
    await runtime.connect({});
    const [defaultTab] = (await runtime.tabs({})).tabs;
    if (!defaultTab) throw new Error("Expected MCP default tab.");

    const dedicated = await runtime.open({
      url: "https://example.com/new-window",
      reusable: false,
    });
    expect(dedicated.tab).toMatchObject({
      tabId: defaultTab.tabId,
      requestedUrl: "https://example.com/new-window",
      reusable: false,
    });
    await expect(runtime.open({
      url: "https://example.com/second-window",
      reusable: false,
    })).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    expect(fake.newTabCount).toBe(1);
  });

  it("keeps an MCP tab bound when only its asynchronous title changes", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    const [tab] = (await runtime.tabs({})).tabs;
    if (!tab) throw new Error("Expected MCP tab.");

    fake.setCurrentPage("about:blank", "Updated asynchronously");

    await expect(runtime.snapshot({ tabId: tab.tabId })).resolves.toMatchObject({
      url: "about:blank",
      title: "Updated asynchronously",
    });
  });

  it("updates the remote binding when navigation returns only page metadata", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.usePageOnlyNavigationResponses();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    const [tab] = (await runtime.tabs({})).tabs;
    if (!tab) throw new Error("Expected MCP tab.");

    await expect(
      runtime.navigate({ tabId: tab.tabId, url: "https://example.com/target" }),
    ).resolves.toMatchObject({
      tab: { url: "https://example.com/target", title: "Navigated" },
    });
    await expect(runtime.snapshot({ tabId: tab.tabId })).resolves.toMatchObject({
      url: "https://example.com/target",
      title: "Navigated",
    });
  });

  it("accepts a short asynchronous navigation transition on the same owned tab", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    const [tab] = (await runtime.tabs({})).tabs;
    if (!tab) throw new Error("Expected MCP tab.");

    await runtime.snapshot({ tabId: tab.tabId });
    await runtime.click({ tabId: tab.tabId, ref: "e9" });
    fake.setCurrentPage("https://example.com/details", "Details");

    await expect(runtime.snapshot({ tabId: tab.tabId })).resolves.toMatchObject({
      url: "https://example.com/details",
      title: "Details",
    });
  });

  it("keeps ownership when the same page navigates to an unexpected URL", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    const [tab] = (await runtime.tabs({})).tabs;
    if (!tab) throw new Error("Expected MCP tab.");

    fake.setCurrentPage("https://personal.example/replacement", "Personal replacement");

    await expect(runtime.snapshot({ tabId: tab.tabId })).resolves.toMatchObject({
      tabId: tab.tabId,
      url: "https://personal.example/replacement",
      title: "Personal replacement",
    });
  });


  it("routes public diagnostics through the owned direct tab", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const config = makeConfig(directory);
    config.mode = "diagnostic";
    const runtime = await BrowserRuntime.create(config, () => fake);
    await runtime.connect({});
    const [tab] = (await runtime.tabs({})).tabs;
    if (!tab) throw new Error("Expected an owned direct tab.");

    await expect(
      runtime.console({ tabId: tab.tabId, level: "debug", clear: true }),
    ).resolves.toMatchObject({ tabId: tab.tabId, text: "console output" });
    await expect(
      runtime.networkList({ tabId: tab.tabId, filter: "/api" }),
    ).resolves.toMatchObject({ tabId: tab.tabId, text: "network output" });
    await expect(
      runtime.networkInspect({
        tabId: tab.tabId,
        index: 1,
        detail: "response-headers",
      }),
    ).resolves.toMatchObject({ tabId: tab.tabId, text: "request output" });
    await expect(runtime.traceStart({ tabId: tab.tabId })).resolves.toEqual({
      tabId: tab.tabId,
      active: true,
    });
    await expect(runtime.traceStop({ tabId: tab.tabId })).resolves.toMatchObject({
      tabId: tab.tabId,
      kind: "trace",
      totalBytes: 5,
    });
    await expect(
      runtime.videoStart({
        tabId: tab.tabId,
        filename: "flow.webm",
        width: 800,
        height: 600,
      }),
    ).resolves.toMatchObject({ tabId: tab.tabId, active: true });
    await expect(runtime.videoStop({ tabId: tab.tabId })).resolves.toMatchObject({
      tabId: tab.tabId,
      kind: "video",
    });
    await expect(
      runtime.pdf({ tabId: tab.tabId, filename: "page.pdf" }),
    ).resolves.toMatchObject({ tabId: tab.tabId, kind: "pdf" });
    await expect(
      runtime.diagnostics({ tabId: tab.tabId, consoleLevel: "warning" }),
    ).resolves.toMatchObject({
      tabId: tab.tabId,
      traceActive: false,
      videoActive: false,
    });

    expect(fake.advancedCalls).toEqual([
      "console",
      "networkList",
      "networkInspect:1:response-headers",
      "traceStart",
      "traceStop",
      "videoStart",
      "videoStop",
      "pdf",
      "diagnostics",
    ]);
  });

  it("blocks advanced operations in efficient mode without invoking the driver", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const config = makeConfig(directory);
    config.mode = "efficient";
    const runtime = await BrowserRuntime.create(config, () => fake);
    await runtime.connect({});
    const [tab] = (await runtime.tabs({})).tabs;
    if (!tab) throw new Error("Expected an owned direct tab.");

    await expect(runtime.console({ tabId: tab.tabId })).rejects.toMatchObject({
      code: "BROWSER_OPERATION_MODE_UNSUPPORTED",
    });
    expect(fake.advancedCalls).toEqual([]);
  });

  it("blocks advanced operations in interactive mode", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    const [tab] = (await runtime.tabs({})).tabs;
    if (!tab) throw new Error("Expected an owned MCP tab.");

    await expect(runtime.console({ tabId: tab.tabId })).rejects.toMatchObject({
      code: "BROWSER_OPERATION_MODE_UNSUPPORTED",
    });
    expect(fake.advancedCalls).toEqual([]);
  });

  it("rejects access to a task-owned tab from another owner scope", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setTabs([]);
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    const ownerA = { ownerScope: "identity:owner-a" };
    const ownerB = { ownerScope: "identity:owner-b" };
    const opened = await runtime.open({ url: "https://example.com/private" }, ownerA);

    expect(() => runtime.acquireOperationLease(
      "snapshot",
      { tabId: opened.tab.tabId },
      ownerB,
    )).toThrow(expect.objectContaining({ code: "TASK_OWNERSHIP_MISMATCH" }));
    await expect(runtime.finishTask({ taskId: opened.tab.taskId }, ownerB)).rejects.toMatchObject({
      code: "TASK_OWNERSHIP_MISMATCH"
    });
  });

  it("expires an idle task and removes only its MCP tabs", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.taskIdleTtlMs = 40;
    config.taskReaperIntervalMs = 10;
    config.contextIdleShutdownMs = 5_000;
    const fake = new FakeBrowserDriver();
    fake.setTabs([]);
    const runtime = await BrowserRuntime.create(config, () => fake);
    const opened = await runtime.open({ url: "https://example.com/idle" });

    const store = new BrowserSessionRegistry(directory);
    await waitForCondition(async () => {
      const persisted = await store.load();
      return persisted.tasks.some((task) =>
        task.taskId === opened.tab.taskId && task.state === "expired",
      );
    });
    const persisted = await store.load();
    expect(persisted.tasks.find((task) => task.taskId === opened.tab.taskId)).toMatchObject({
      state: "expired",
      tabIds: []
    });
  });

  it("suspends TTL expiration while a task operation lease is active", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.taskIdleTtlMs = 40;
    config.taskReaperIntervalMs = 10;
    config.contextIdleShutdownMs = 5_000;
    const fake = new FakeBrowserDriver();
    fake.setTabs([]);
    const runtime = await BrowserRuntime.create(config, () => fake);
    const opened = await runtime.open({ url: "https://example.com/leased" });
    const lease = runtime.acquireOperationLease(
      "snapshot",
      { tabId: opened.tab.tabId },
      {},
    );

    await new Promise((resolve) => setTimeout(resolve, 120));
    await expect(runtime.status({})).resolves.toMatchObject({ tabCount: 1 });
    lease.release();
    await waitForCondition(async () => (await runtime.status({})).tabCount === 0);
  });

  it("accepts an injected direct driver in diagnostic mode", async () => {
    const directory = await makeTemporaryDirectory();
    const config = makeConfig(directory);
    config.mode = "diagnostic";

    await expect(
      BrowserRuntime.create(config, () => new FakeBrowserDriver()),
    ).resolves.toBeInstanceOf(BrowserRuntime);
  });

  it("recovers after the last MCP tab is closed", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setTabs([]);
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    const opened = await runtime.open({
      url: "https://example.com/",
      purpose: "first-task",
      reusable: true,
    });

    await runtime.closeTab({ tabId: opened.tab.tabId });
    await expect(runtime.status({})).resolves.toMatchObject({
      state: "connected",
      ready: false,
      tabCount: 0,
    });

    const recovered = await runtime.open({
      url: "https://example.org/",
      purpose: "recovered-task",
      reusable: true,
    });

    expect(recovered.tab.url).toBe("https://example.org/");
    await expect(runtime.status({})).resolves.toMatchObject({
      state: "connected",
      ready: true,
      recovery: {
        zeroPageDetections: 1,
        contextRecoveriesAttempted: 1,
        contextRecoveriesSucceeded: 1,
        contextRecoveriesFailed: 0,
        contextsRestarted: 0,
      },
    });
    expect(fake.closeCount).toBe(0);
  });

  it("emits correlated recovery telemetry without page content", async () => {
    const directory = await makeTemporaryDirectory();
    const telemetry = new BrowserOperationTelemetry(directory);
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(
      makeConfig(directory),
      () => fake,
      { telemetry },
    );
    await runtime.connect({});
    fake.dropAllPages();

    await telemetry.run(
      { traceId: "5".repeat(32), operation: "tabs" },
      () => runtime.tabs({}),
    );
    await telemetry.flush();

    const contents = await readFile(telemetry.filePath, "utf8");
    expect(contents).toContain('"event":"browser_context_recovery_started"');
    expect(contents).toContain('"event":"browser_context_recovery_completed"');
    expect(contents).toContain('"status":"allowed"');
    expect(contents).toContain('"traceId":"' + "5".repeat(32) + '"');
  });
  it("serializes concurrent zero-page recovery through one shared attempt", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    fake.dropAllPages();
    fake.delayNextConnect(25);

    const [first, second] = await Promise.all([
      runtime.tabs({}),
      runtime.tabs({}),
    ]);

    expect(first.tabs).toHaveLength(1);
    expect(second.tabs).toHaveLength(1);
    await expect(runtime.status({})).resolves.toMatchObject({
      ready: true,
      recovery: {
        zeroPageDetections: 1,
        contextRecoveriesAttempted: 1,
        contextRecoveriesSucceeded: 1,
        contextRecoveriesFailed: 0,
        recoveryContentionCount: 1,
      },
    });
  });

  it("restarts the context once when page recreation in the existing context fails", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    fake.dropAllPages();
    fake.failNextNewTabs(1);

    await expect(runtime.tabs({})).resolves.toMatchObject({
      tabs: [expect.objectContaining({ ownership: "mcp" })],
    });
    await expect(runtime.status({})).resolves.toMatchObject({
      ready: true,
      recovery: {
        contextRecoveriesAttempted: 1,
        contextRecoveriesSucceeded: 1,
        contextRecoveriesFailed: 0,
        contextsRestarted: 1,
      },
    });
    expect(fake.closeCount).toBeGreaterThanOrEqual(1);
  });

  it("returns a structured failure when both recovery paths fail", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await runtime.connect({});
    fake.dropAllPages();
    fake.failNextNewTabs(2);

    await expect(runtime.tabs({})).rejects.toMatchObject({
      code: "BROWSER_CONTEXT_RECOVERY_FAILED",
    });
    await expect(runtime.status({})).resolves.toMatchObject({
      ready: false,
      recovery: {
        contextRecoveriesAttempted: 1,
        contextRecoveriesSucceeded: 0,
        contextRecoveriesFailed: 1,
      },
    });
    await expect(runtime.readiness()).resolves.toMatchObject({
      status: "disconnected",
      ready: false,
    });
  });

  it("restores a protected sticky tab and invalidates stale refs after all pages disappear", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    const opened = await authorizeLegacySite(runtime, "zero-page-recovery");
    await runtime.snapshot({ tabId: opened.tab.tabId });

    fake.dropAllPages();
    await expect(runtime.status({})).resolves.toMatchObject({
      state: "connected",
      ready: false,
      tabCount: 1,
    });
    await expect(runtime.readiness()).resolves.toMatchObject({
      status: "degraded",
      ready: false,
    });

    const restored = await runtime.open({
      taskId: opened.result.taskId,
      url: "https://dev-private.example.test/app",
    });

    expect(restored.tab).toMatchObject({
      tabId: opened.tab.tabId,
      protected: true,
      sticky: true,
      lockedUrl: "https://dev-private.example.test/app",
    });
    await expect(runtime.click({
      tabId: opened.tab.tabId,
      ref: "e7",
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(runtime.status({})).resolves.toMatchObject({
      ready: true,
      recovery: {
        zeroPageDetections: 1,
        contextRecoveriesAttempted: 1,
        contextRecoveriesSucceeded: 1,
        contextRecoveriesFailed: 0,
        pagesRecreated: 1,
        contextsRestarted: 0,
        staleReferencesRemoved: 3,
      },
    });
  });

  it("enforces business read-only actions without blocking safe consultation", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setTabs([]);
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    const authorized = await authorizeLegacySite(runtime, "read-only-actions");
    const tabId = authorized.tab.tabId;
    await runtime.snapshot({ tabId });

    await expect(runtime.fill({
      tabId,
      ref: "e8",
      value: "consulta@example.com",
    })).resolves.toMatchObject({ tabId, completed: true });
    await expect(runtime.click({
      tabId,
      ref: "e9",
    })).resolves.toMatchObject({ tabId, completed: true });

    await expect(runtime.click({
      tabId,
      ref: "e7",
      confirmationId: "cannot-override-read-only",
    })).rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });
    await expect(runtime.press({
      tabId,
      key: "Enter",
      confirmationId: "cannot-override-read-only",
    })).rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });
    await expect(runtime.sequence({
      tabId,
      steps: [{
        action: "click",
        ref: "e7",
        confirmationId: "cannot-override-read-only",
      }],
    })).rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });
    await expect(runtime.frameClick({
      tabId,
      frame: "MenuContent",
      text: "Salvar alterações",
      confirmationId: "cannot-override-read-only",
    })).rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });
    await expect(runtime.upload({
      tabId,
      files: [{
        name: "blocked.txt",
        contentBase64: "YmxvY2tlZA==",
      }],
      selector: "input[type=file]",
      confirmationId: "cannot-override-read-only",
    })).rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });

    expect(fake.calls.some((call) =>
      call.name === "browser_type" && call.args.text === "consulta@example.com"
    )).toBe(true);
    expect(fake.calls.some((call) =>
      call.name === "browser_click" && call.args.target === "e9"
    )).toBe(true);
    expect(fake.calls.some((call) =>
      call.name === "browser_click" && call.args.target === "e7"
    )).toBe(false);
    expect(fake.calls.some((call) => call.name === "browser_press_key")).toBe(false);
    expect(fake.calls.some((call) => call.name === "direct_set_input_files")).toBe(false);
  });


  it("activates the post-login request policy and scopes semantic permits", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setAuthenticationInspection({ state: "authenticated" });
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);

    const authorized = await authorizeLegacySite(runtime, "semantic-policy");
    expect(fake.requestPolicyActivations).toContain("private-site");

    await runtime.frameClick({
      tabId: authorized.tab.tabId,
      frame: "MenuContent",
      selector: "button.finc-fila-view-tab[onclick*=\"'CONFERENCIAS'\"]",
    });
    expect(fake.semanticPermitAcquisitions).toBe(1);
    expect(fake.maxSemanticPermitDepth).toBe(1);
    expect(fake.semanticPermitDepth).toBe(0);

    await runtime.frameClick({
      tabId: authorized.tab.tabId,
      frame: "MenuContent",
      selector: ".unknown-benign-control",
    });
    expect(fake.semanticPermitAcquisitions).toBe(1);
    expect(fake.semanticPermitDepth).toBe(0);
  });

  it("reuses an authenticated private-site session without reading the broker", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setAuthenticationInspection({ state: "authenticated" });
    let brokerReads = 0;
    const runtime = await BrowserRuntime.create(
      makeConfig(directory),
      () => fake,
      {
        credentialBroker: {
          read: async () => {
            brokerReads += 1;
            return { status: "broker-unavailable" as const };
          },
        },
      },
    );

    const authorized = await authorizeLegacySite(runtime, "reuse-session");
    expect(authorized.result.authentication).toEqual({
      status: "session-reused",
    });
    expect(brokerReads).toBe(0);
    expect(fake.authenticationSubmits).toBe(0);
  });

  it("performs one broker-backed login and clears credential buffers", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setAuthenticationInspection({ state: "login-required" });
    fake.setAuthenticationResult({ status: "performed" });
    const secret = new CredentialSecret(
      Buffer.from("reader", "utf8"),
      Buffer.from("secret-value", "utf8"),
    );
    let brokerReads = 0;
    const runtime = await BrowserRuntime.create(
      makeConfig(directory),
      () => fake,
      {
        credentialBroker: {
          read: async () => {
            brokerReads += 1;
            return { status: "success" as const, secret };
          },
        },
      },
    );

    const authorized = await authorizeLegacySite(runtime, "perform-login");
    expect(authorized.result.authentication).toEqual({ status: "performed" });
    expect(brokerReads).toBe(1);
    expect(fake.authenticationSubmits).toBe(1);
    expect([...secret.username]).toEqual(new Array(6).fill(0));
    expect([...secret.password]).toEqual(new Array(12).fill(0));
  });

  it("returns interaction-required for MFA without reading credentials", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setAuthenticationInspection({
      state: "interaction-required",
      reason: "mfa-or-captcha",
    });
    let brokerReads = 0;
    const runtime = await BrowserRuntime.create(
      makeConfig(directory),
      () => fake,
      {
        credentialBroker: {
          read: async () => {
            brokerReads += 1;
            return { status: "broker-unavailable" as const };
          },
        },
      },
    );

    const authorized = await authorizeLegacySite(runtime, "mfa-login");
    expect(authorized.result.authentication).toEqual({
      status: "interaction-required",
      reason: "mfa-or-captcha",
    });
    expect(brokerReads).toBe(0);
    expect(fake.authenticationSubmits).toBe(0);
  });

  it("locks the private tab and task while credential authentication is active", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    fake.setAuthenticationInspection({ state: "login-required" });
    fake.setAuthenticationResult({ status: "performed" });
    let releaseBroker!: () => void;
    const brokerGate = new Promise<void>((resolve) => {
      releaseBroker = resolve;
    });
    let brokerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      brokerEntered = resolve;
    });
    const runtime = await BrowserRuntime.create(
      makeConfig(directory),
      () => fake,
      {
        credentialBroker: {
          read: async () => {
            brokerEntered();
            await brokerGate;
            return {
              status: "success" as const,
              secret: new CredentialSecret(
                Buffer.from("reader", "utf8"),
                Buffer.from("secret-value", "utf8"),
              ),
            };
          },
        },
      },
    );

    const pending = await runtime.openAuthorizedSite({
      siteId: "private-site",
      purpose: "concurrent-login",
    });
    if (pending.status !== "confirmation_required") {
      throw new Error("Expected private-site confirmation.");
    }
    const opening = runtime.openAuthorizedSite({
      siteId: "private-site",
      purpose: "concurrent-login",
      taskId: pending.taskId,
      confirmationId: pending.confirmationId,
    });
    await entered;
    const [tab] = (await runtime.tabs({ taskId: pending.taskId })).tabs;
    if (!tab) throw new Error("Expected private tab during authentication.");

    await expect(runtime.snapshot({ tabId: tab.tabId })).rejects.toMatchObject({
      code: "TASK_SUSPENDED",
    });
    await expect(runtime.traceStart({ tabId: tab.tabId })).rejects.toMatchObject({
      code: "TASK_SUSPENDED",
    });

    let finishCompleted = false;
    const finishing = runtime.finishTask({ taskId: pending.taskId }).then((result) => {
      finishCompleted = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finishCompleted).toBe(false);

    releaseBroker();
    await expect(opening).resolves.toMatchObject({
      status: "opened",
      authentication: { status: "performed" },
    });
    await expect(finishing).resolves.toMatchObject({
      completed: true,
      taskId: pending.taskId,
    });
  });

  it("forces LegacySite into a protected sticky tab", async () => {
    const directory = await makeTemporaryDirectory();
    const fake = new FakeBrowserDriver();
    const runtime = await BrowserRuntime.create(makeConfig(directory), () => fake);
    await expect(runtime.open({
      url: "https://dev-private.example.test/app",
    })).rejects.toMatchObject({
      code: "SITE_ACCESS_AUTHORIZATION_REQUIRED",
    });

    const result = await authorizeLegacySite(runtime, "protected-sticky");
    const repeated = await runtime.open({
      taskId: result.result.taskId,
      url: "https://dev-private.example.test/app",
    });

    expect(repeated.tab.tabId).toBe(result.tab.tabId);
    expect((await runtime.tabs({ taskId: result.result.taskId })).tabs).toHaveLength(1);
    expect(result.tab).toMatchObject({
      purpose: "private-site",
      reusable: false,
      protected: true,
      sticky: true,
      lockedUrl: "https://dev-private.example.test/app",
    });
    await expect(runtime.closeTab({ tabId: result.tab.tabId })).rejects.toMatchObject({
      code: "TAB_PROTECTED",
    });
  });
});

class FakeBrowserDriver implements BrowserDriver {
  readonly kind = "direct" as const;
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly advancedCalls: string[] = [];
  newTabCount = 0;
  listTabsCount = 0;
  closeTabCount = 0;
  closeCount = 0;
  connectCount = 0;
  authenticationSubmits = 0;
  requestPolicyActivations: string[] = [];
  semanticPermitAcquisitions = 0;
  semanticPermitDepth = 0;
  maxSemanticPermitDepth = 0;
  private authenticationInspection: BrowserAuthenticationInspection = {
    state: "authenticated",
  };
  private authenticationResult: BrowserCredentialAuthenticationResult = {
    status: "performed",
  };
  private connected = false;
  private connectError: Error | undefined;
  private closeTabError: Error | undefined;
  private readonly enabledPrivateOrigins = new Set<string>();
  private readonly redirects = new Map<string, string>();
  private activePageAllowedOrigins = new Set<string>();
  private connectDelayMs = 0;
  private newTabFailuresRemaining = 0;
  private resetTabsAfterClose = false;
  private pageCounter = 1;
  private tabs: BrowserDriverTab[] = [
    {
      id: "personal-page",
      index: 0,
      current: true,
      title: "Personal",
      url: "https://personal.example/",
      crashed: false,
    },
  ];

  setAuthenticationInspection(value: BrowserAuthenticationInspection): void {
    this.authenticationInspection = value;
  }

  setAuthenticationResult(value: BrowserCredentialAuthenticationResult): void {
    this.authenticationResult = value;
  }

  async inspectAuthenticationState(): Promise<BrowserAuthenticationInspection> {
    return this.authenticationInspection;
  }

  async authenticateWithCredential(
    _credential: BrowserCredentialInput,
  ): Promise<BrowserCredentialAuthenticationResult> {
    this.authenticationSubmits += 1;
    return this.authenticationResult;
  }

  redirect(from: string, to: string): void {
    this.redirects.set(new URL(from).href, new URL(to).href);
  }

  failNextConnect(error: Error): void {
    this.connectError = error;
  }

  failNextCloseTab(error: Error): void {
    this.closeTabError = error;
  }

  usePageOnlyNavigationResponses(): void {}

  delayNextConnect(delayMs: number): void {
    this.connectDelayMs = delayMs;
  }

  failNextNewTabs(count: number): void {
    this.newTabFailuresRemaining = count;
  }

  setCurrentPage(url: string, title: string): void {
    const current = this.tabs.find((tab) => tab.current);
    if (!current) throw new Error("Expected a current browser tab.");
    current.url = new URL(url).href;
    current.title = title;
  }

  removePersonalTabAndShiftIndexes(): void {
    this.tabs = this.tabs.filter((tab) => tab.url !== "https://personal.example/");
    this.tabs.forEach((tab, index) => {
      tab.index = index;
    });
  }

  setTabs(tabs: readonly BrowserDriverTab[]): void {
    this.tabs = structuredClone([...tabs]).map((tab, index) => ({
      ...tab,
      id: tab.id ?? `page-${index + 1}`,
    }));
  }

  remoteTabs(): BrowserDriverTab[] {
    return structuredClone(this.tabs);
  }

  dropAllPages(): void {
    this.tabs = [];
  }

  resetToBlankOnClose(): void {
    this.resetTabsAfterClose = true;
  }

  isConnected(): boolean {
    return this.connected;
  }

  enablePrivateOrigin(origin: string): void {
    this.enabledPrivateOrigins.add(new URL(origin).origin);
  }

  disablePrivateOrigin(origin: string): void {
    this.enabledPrivateOrigins.delete(new URL(origin).origin);
  }

  setActivePageAllowedOrigins(origins: readonly string[]): void {
    this.activePageAllowedOrigins = new Set(
      origins.map((origin) => new URL(origin).origin),
    );
  }

  setActivePageRequestPolicy(policy: { siteId: string } | undefined): void {
    if (policy) this.requestPolicyActivations.push(policy.siteId);
  }

  acquireActivePageSemanticRequestPermit(): () => void {
    this.semanticPermitAcquisitions += 1;
    this.semanticPermitDepth += 1;
    this.maxSemanticPermitDepth = Math.max(
      this.maxSemanticPermitDepth,
      this.semanticPermitDepth,
    );
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.semanticPermitDepth -= 1;
    };
  }

  async resolveFrame(_name: string): Promise<Frame> {
    const locator = {
      filter: () => locator,
      nth: () => locator,
      click: async () => undefined,
    };
    return {
      locator: () => locator,
      getByText: () => locator,
    } as unknown as Frame;
  }

  async currentPageResponse(content?: string): Promise<BrowserDriverResponse> {
    const response = this.currentResponse();
    if (content !== undefined) response.snapshot = content;
    return response;
  }

  async newTabWithAllowedOrigins(
    url: string,
    origins: readonly string[],
  ): Promise<BrowserDriverTab[]> {
    this.setActivePageAllowedOrigins(origins);
    return this.newTab(url);
  }

  hasUsablePage(): boolean {
    return this.tabs.some((tab) => !tab.crashed);
  }

  async connect(): Promise<void> {
    this.connectCount += 1;
    if (this.connectError) {
      const error = this.connectError;
      this.connectError = undefined;
      throw error;
    }
    this.connected = true;
    if (this.connectDelayMs > 0) {
      const delayMs = this.connectDelayMs;
      this.connectDelayMs = 0;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.connected = false;
    if (this.resetTabsAfterClose) {
      this.tabs = [{
        id: "blank-page",
        index: 0,
        current: true,
        title: "",
        url: "about:blank",
        crashed: false,
      }];
    }
  }

  navigate(input: { url: string }): Promise<BrowserDriverResponse> {
    return this.perform("browser_navigate", input);
  }

  goBack(): Promise<BrowserDriverResponse> {
    return this.perform("browser_navigate_back", {});
  }

  goForward(): Promise<BrowserDriverResponse> {
    return this.perform("browser_navigate_forward", {});
  }

  snapshot(): Promise<BrowserDriverResponse> {
    return this.perform("browser_snapshot", {});
  }

  click(input: { target: string; element?: string }): Promise<BrowserDriverResponse> {
    return this.perform("browser_click", input);
  }

  fill(input: { target: string; text: string; element?: string }): Promise<BrowserDriverResponse> {
    return this.perform("browser_type", input);
  }

  press(input: { key: string }): Promise<BrowserDriverResponse> {
    return this.perform("browser_press_key", input);
  }

  wait(input: { text?: string; time?: number }): Promise<BrowserDriverResponse> {
    return this.perform("browser_wait_for", input);
  }

  evaluate(input: { function: string; target?: string }): Promise<BrowserDriverResponse> {
    return this.perform("browser_evaluate", input);
  }

  takeScreenshot(input: { filename: string }): Promise<BrowserDriverResponse> {
    return this.perform("browser_take_screenshot", input);
  }

  async uploadFiles(paths: readonly string[]): Promise<BrowserDriverResponse> {
    this.calls.push({ name: "browser_file_upload", args: { paths: [...paths] } });
    return this.currentResponse();
  }

  async listTabs(): Promise<BrowserDriverTab[]> {
    this.listTabsCount += 1;
    return structuredClone(this.tabs);
  }

  async newTab(url = "about:blank"): Promise<BrowserDriverTab[]> {
    this.newTabCount += 1;
    if (this.newTabFailuresRemaining > 0) {
      this.newTabFailuresRemaining -= 1;
      throw new Error("failed to create fake page");
    }
    for (const tab of this.tabs) tab.current = false;
    this.tabs.push({
      id: `page-${this.pageCounter++}`,
      index: this.tabs.length,
      current: true,
      title: "",
      url: this.redirects.get(new URL(url).href) ?? new URL(url).href,
      crashed: false,
    });
    return structuredClone(this.tabs);
  }

  async selectTab(index: number): Promise<BrowserDriverTab[]> {
    for (const tab of this.tabs) tab.current = tab.index === index;
    return structuredClone(this.tabs);
  }

  async selectTabByRemoteId(
    remoteTabId: string,
  ): Promise<{ tab: BrowserDriverTab; tabCount: number }> {
    const id = remoteTabId.includes(":page:")
      ? remoteTabId.slice(remoteTabId.indexOf(":page:") + 6)
      : remoteTabId;
    const tab = this.tabs.find((candidate) => candidate.id === id);
    if (!tab) throw new Error("stale page id");
    for (const candidate of this.tabs) candidate.current = candidate === tab;
    return { tab: structuredClone(tab), tabCount: this.tabs.length };
  }

  async closeTab(index: number): Promise<BrowserDriverTab[]> {
    this.closeTabCount += 1;
    if (this.closeTabError) {
      const error = this.closeTabError;
      this.closeTabError = undefined;
      throw error;
    }
    this.tabs = this.tabs.filter((tab) => tab.index !== index);
    this.tabs.forEach((tab, currentIndex) => {
      tab.index = currentIndex;
      tab.current = currentIndex === 0;
    });
    return structuredClone(this.tabs);
  }

  currentPage() {
    const driver = this;
    return {
      locator(selector: string) {
        return {
          async setInputFiles(files: unknown) {
            driver.calls.push({
              name: "direct_set_input_files",
              args: { selector, files },
            });
          },
        };
      },
    } as never;
  }

  async readConsole(): Promise<{ text: string; truncated: boolean; collectedAt: string }> {
    this.advancedCalls.push("console");
    return diagnosticText("console output");
  }

  async listNetwork(): Promise<{ text: string; truncated: boolean; collectedAt: string }> {
    this.advancedCalls.push("networkList");
    return diagnosticText("network output");
  }

  async inspectNetworkRequest(
    index: number,
    detail = "request",
  ): Promise<{ text: string; truncated: boolean; collectedAt: string }> {
    this.advancedCalls.push(`networkInspect:${index}:${detail}`);
    return diagnosticText("request output");
  }

  async startTrace(): Promise<void> {
    this.advancedCalls.push("traceStart");
  }

  async stopTrace() {
    this.advancedCalls.push("traceStop");
    const createdAt = new Date().toISOString();
    return {
      kind: "trace" as const,
      files: [{
        kind: "trace" as const,
        path: "C:/private/trace.zip",
        sizeBytes: 5,
        createdAt,
      }],
      totalBytes: 5,
      createdAt,
    };
  }

  async startVideo() {
    this.advancedCalls.push("videoStart");
    return { path: "C:/private/flow.webm" };
  }

  async stopVideo() {
    this.advancedCalls.push("videoStop");
    return {
      kind: "video" as const,
      path: "C:/private/flow.webm",
      sizeBytes: 7,
      createdAt: new Date().toISOString(),
    };
  }

  async savePdf() {
    this.advancedCalls.push("pdf");
    return {
      kind: "pdf" as const,
      path: "C:/private/page.pdf",
      sizeBytes: 11,
      createdAt: new Date().toISOString(),
    };
  }

  async collectDiagnostics() {
    this.advancedCalls.push("diagnostics");
    const collectedAt = new Date().toISOString();
    return {
      console: diagnosticText("console output", collectedAt),
      network: diagnosticText("network output", collectedAt),
      traceActive: false,
      videoActive: false,
      collectedAt,
    };
  }

  private async perform(
    name: string,
    args: Record<string, unknown>,
  ): Promise<BrowserDriverResponse> {
    if (!this.connected) throw new Error("not connected");
    this.calls.push({ name, args });
    if (name === "browser_navigate" && typeof args.url === "string") {
      const current = this.tabs.find((tab) => tab.current);
      if (current) {
        const requested = new URL(args.url).href;
        current.url = this.redirects.get(requested) ?? requested;
        current.title = "Navigated";
      }
    }
    const response = this.currentResponse();
    if (name === "browser_snapshot") {
      response.snapshot = [
        '- button "Delete account" [ref=e7]',
        '- textbox "Email" [active] [ref=e8]',
        '- link "Open details" [ref=e9]',
      ].join("\n");
    }
    if (name === "browser_evaluate") response.result = "extracted";
    return response;
  }

  private currentResponse(): BrowserDriverResponse {
    const current = this.tabs.find((tab) => tab.current);
    if (!current) throw new Error("Expected current page.");
    return {
      page: {
        ...(current.id === undefined ? {} : { id: current.id }),
        url: current.url,
        title: current.title,
      },
    };
  }
}

function diagnosticText(text: string, collectedAt = new Date().toISOString()) {
  return { text, truncated: false, collectedAt };
}

async function authorizeLegacySite(
  runtime: BrowserRuntime,
  purpose: string,
  taskId?: string,
): Promise<{
  result: Extract<
    Awaited<ReturnType<BrowserRuntime["openAuthorizedSite"]>>,
    { status: "opened" }
  >;
  tab: BrowserTab;
}> {
  const pending = await runtime.openAuthorizedSite({
    siteId: "private-site",
    purpose,
    ...(taskId === undefined ? {} : { taskId }),
  });
  if (pending.status !== "confirmation_required") {
    throw new Error("Expected private-site confirmation.");
  }
  const opened = await runtime.openAuthorizedSite({
    siteId: "private-site",
    purpose,
    taskId: pending.taskId,
    confirmationId: pending.confirmationId,
  });
  if (opened.status !== "opened") {
    throw new Error("Expected private site to open after confirmation.");
  }
  const tab = (await runtime.tabs({ taskId: opened.taskId })).tabs.find(
    (candidate) => candidate.tabId === opened.tabId,
  );
  if (!tab) throw new Error("Expected authorized private-site tab.");
  return { result: opened, tab };
}

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function makeConfig(directory: string): BrowserWorkerConfig {
  return {
    host: "127.0.0.1",
    port: 3350,
    token: "x".repeat(32),
    mode: "interactive",
    maxPayloadBytes: 1024 * 1024,
    runtimeDirectory: directory,
    privateDirectory: path.join(directory, "private"),
    primaryPrivateSiteId: "private-site",
    primaryPrivateSiteUrl: new URL("https://dev-private.example.test/app"),
    privateSitePolicies: [{
      siteId: "private-site",
      entryUrl: "https://dev-private.example.test/app",
      allowedOrigins: ["https://dev-private.example.test"],
      deniedOrigins: ["https://private.example.test"],
      accessMode: "business-read-only",
      loginStrategy: "credential-broker",
      credentialAccountId: "default",
      requestPolicy: {
        rules: [{
          methods: ["GET", "HEAD", "POST"],
          pathname: "/app",
          queryKeys: [],
          requiresSemanticPermit: false,
        }],
        semanticActions: [{
          operation: "frame-click",
          framePath: ["MenuContent"],
          selector: "button.finc-fila-view-tab[onclick*=\"'CONFERENCIAS'\"]",
        }],
      },
    }],
    connectTimeoutMs: 5_000,
    operationTimeoutMs: 5_000,
    actionTimeoutMs: 1_000,
    navigationTimeoutMs: 5_000,
    outputMaxBytes: 16 * 1024 * 1024,
    diagnosticTimeoutMs: 10_000,
    diagnosticRetentionMs: 7 * 24 * 60 * 60 * 1_000,
    diagnosticMaxArtifacts: 500,
    diagnosticMaxEntries: 500,
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-worker-"));
  temporaryDirectories.push(directory);
  return directory;
}
