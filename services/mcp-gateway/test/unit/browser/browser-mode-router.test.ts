import { describe, expect, it, jest } from "@jest/globals";
import type { BrowserExecutor } from "@vs-code-gpt/shared";
import {
  BrowserModeRouter,
  type PersonalBrowserExecutor,
} from "../../../src/browser/browser-mode-router.js";

function managedExecutor(): BrowserExecutor {
  const status = async () => ({
    state: "connected" as const,
    ready: true,
    browser: "chrome" as const,
    profile: "dedicated-persistent" as const,
    autoLaunch: true as const,
    tabGroup: "MCP" as const,
    edgeFallback: "technical-necessity-only" as const,
    tabCount: 0,
    taskCount: 0,
    engine: "playwright-direct" as const,
  });
  return {
    status: jest.fn(status),
    connect: jest.fn(status),
    open: jest.fn(async (input: Parameters<BrowserExecutor["open"]>[0]) => ({
      tab: {
        tabId: "managed:1",
        ...(input.taskId ? { taskId: input.taskId } : {}),
        lifecycle: "task-scoped" as const,
        ownership: "mcp" as const,
        purpose: input.purpose ?? input.url ?? "managed",
        reusable: false,
        protected: false,
        sticky: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        lastUsedAt: "2026-10-01T00:00:00.000Z",
        ...(input.url ? { url: input.url, requestedUrl: input.url } : {}),
      },
    })),
    snapshot: jest.fn(async ({ tabId }) => ({
      tabId,
      url: "https://managed.test/",
      content: "managed",
      refs: [],
    })),
    tabs: jest.fn(async () => ({ tabs: [] })),
    finishTask: jest.fn(async ({ taskId }) => ({
      completed: true as const,
      ...(taskId ? { taskId } : {}),
      closedTabs: 0,
      browserClosed: true,
    })),
  } as unknown as BrowserExecutor;
}

function personalExecutor(connected = true): PersonalBrowserExecutor {
  return {
    isConnected: () => connected,
    connectionInfo: () => ({
      connected,
      browser: "chrome" as const,
      profile: "personal" as const,
      protocolVersion: 1,
      extensionVersion: connected ? "0.3.0" : undefined,
      capabilities: ["tabs", "open", "snapshot", "screenshot", "tabGroups"],
    }),
    open: jest.fn(async (input: Parameters<BrowserExecutor["open"]>[0]) => ({
      tab: {
        tabId: "personal:42",
        ...(input.taskId ? { taskId: input.taskId } : {}),
        lifecycle: "task-scoped" as const,
        ownership: "mcp" as const,
        purpose: input.purpose ?? input.url ?? "personal",
        reusable: false,
        protected: false,
        sticky: false,
        createdAt: "2026-10-01T00:00:00.000Z",
        lastUsedAt: "2026-10-01T00:00:00.000Z",
        ...(input.url ? { url: input.url, requestedUrl: input.url } : {}),
      },
    })),
    snapshot: jest.fn(async ({ tabId }) => ({
      tabId,
      url: "https://chatgpt.com/",
      content: "personal",
      refs: [],
    })),
    find: jest.fn(async ({ tabId }) => ({ tabId, url: "https://chatgpt.com/", matches: [] })),
    tabs: jest.fn(async () => ({ tabs: [] })),
    finishTask: jest.fn(async ({ taskId }) => ({
      completed: true as const,
      ...(taskId ? { taskId } : {}),
      closedTabs: 1,
      closedTabIds: ["personal:42"],
      browserClosed: false,
    })),
  } as unknown as PersonalBrowserExecutor;
}

describe("BrowserModeRouter", () => {
  it("runs personal-only without launching or falling back to a second Chrome profile", async () => {
    const personal = personalExecutor();
    const router = new BrowserModeRouter(undefined, personal);
    const status = await router.status({});
    expect(status).toMatchObject({
      browser: "chrome",
      profile: "personal",
      autoLaunch: false,
      ready: true,
      tabCount: 0,
    });
    expect(await router.connect({})).toMatchObject({ profile: "personal", autoLaunch: false });

    const opened = await router.open({
      taskId: "single-profile-task",
      url: "https://chatgpt.com/",
    });
    expect(opened.tab.tabId).toBe("personal:42");
    expect(personal.open).toHaveBeenCalledWith({
      taskId: "single-profile-task",
      url: "https://chatgpt.com/",
    }, undefined);

    await expect(router.tabs({ taskId: "single-profile-task" })).resolves.toEqual({ tabs: [] });
    await expect(router.snapshot({ tabId: "personal:42" })).resolves.toMatchObject({
      content: "personal",
    });
    const personalFound = await router.find({ tabId: "personal:42", query: "Enviar" });
    expect(personalFound.tabId).toBe("personal:42");
    expect(personal.find).toHaveBeenCalledWith({ tabId: "personal:42", query: "Enviar" });
    await expect(router.finishTask({ taskId: "single-profile-task", keepOpen: true })).resolves.toMatchObject({
      browserClosed: false,
    });
    await expect(router.open({
      url: "https://example.test/",
      browserMode: "managed",
    })).rejects.toMatchObject({ code: "BROWSER_CAPABILITY_UNSUPPORTED" });
    expect(() => router.snapshot({ tabId: "managed:1" })).toThrow(
      "Managed browser mode is disabled",
    );
    expect(() => router.openAuthorizedSite({ siteId: "unknown" } as never)).toThrow(
      "Managed browser mode is disabled",
    );
  });

  it("reports the personal extension disconnected without starting a managed browser", async () => {
    const router = new BrowserModeRouter(undefined, personalExecutor(false));
    await expect(router.status({})).resolves.toMatchObject({
      state: "disconnected",
      ready: false,
      profile: "personal",
      autoLaunch: false,
    });
    await expect(router.open({ url: "https://example.test/" })).rejects.toMatchObject({
      code: "BROWSER_CAPABILITY_UNSUPPORTED",
    });
  });

  it("adds personal provider state to managed browser status", async () => {
    const managed = managedExecutor();
    const personal = personalExecutor();
    const router = new BrowserModeRouter(managed, personal);

    await expect(router.status({})).resolves.toMatchObject({
      state: "connected",
      engine: "playwright-direct",
      personal: {
        connected: true,
        browser: "chrome",
        profile: "personal",
        protocolVersion: 1,
        extensionVersion: "0.3.0",
        capabilities: ["tabs", "open", "snapshot", "screenshot", "tabGroups"],
      },
    });
  });

  it("uses browserMode only for open and keeps personal affinity by tabId", async () => {
    const managed = managedExecutor();
    const personal = personalExecutor();
    const router = new BrowserModeRouter(managed, personal);

    const opened = await router.open({
      taskId: "task-personal",
      url: "https://chatgpt.com/",
      browserMode: "personal",
    });

    expect(opened.tab.tabId).toBe("personal:42");
    expect(personal.open).toHaveBeenCalledWith({
      taskId: "task-personal",
      url: "https://chatgpt.com/",
    }, undefined);
    expect(managed.open).not.toHaveBeenCalled();

    await expect(router.snapshot({
      tabId: "personal:42",
    })).resolves.toMatchObject({
      tabId: "personal:42",
      content: "personal",
    });
    expect(personal.snapshot).toHaveBeenCalledTimes(1);
    expect(managed.snapshot).not.toHaveBeenCalled();

    await router.tabs({ taskId: "task-personal" });
    expect(personal.tabs).toHaveBeenCalledWith({ taskId: "task-personal" }, undefined);
    expect(managed.tabs).not.toHaveBeenCalled();
  });

  it("keeps managed mode as the default", async () => {
    const managed = managedExecutor();
    const personal = personalExecutor();
    const router = new BrowserModeRouter(managed, personal);

    await router.open({ url: "https://example.test/" });

    expect(managed.open).toHaveBeenCalledWith({
      url: "https://example.test/",
    }, undefined);
    expect(personal.open).not.toHaveBeenCalled();
  });

  it("does not allow one task to switch between managed and personal modes", async () => {
    const router = new BrowserModeRouter(
      managedExecutor(),
      personalExecutor(),
    );

    await router.open({
      taskId: "task-fixed-mode",
      url: "https://example.test/",
    });

    await expect(router.open({
      taskId: "task-fixed-mode",
      url: "https://chatgpt.com/",
      browserMode: "personal",
    })).rejects.toMatchObject({
      code: "BROWSER_OPERATION_MODE_UNSUPPORTED",
    });
  });

  it("releases task mode affinity after finishTask", async () => {
    const managed = managedExecutor();
    const personal = personalExecutor();
    const router = new BrowserModeRouter(managed, personal);

    await router.open({
      taskId: "task-reusable-after-finish",
      url: "https://chatgpt.com/",
      browserMode: "personal",
    });
    await expect(router.finishTask({
      taskId: "task-reusable-after-finish",
    })).resolves.toMatchObject({
      completed: true,
      closedTabs: 1,
    });

    await expect(router.open({
      taskId: "task-reusable-after-finish",
      url: "https://example.test/",
      browserMode: "managed",
    })).resolves.toMatchObject({
      tab: { tabId: "managed:1" },
    });
    expect(personal.finishTask).toHaveBeenCalledTimes(1);
    expect(managed.open).toHaveBeenCalledTimes(1);
  });

  it("releases explicit personal task tabs when keepOpen is requested", async () => {
    const managed = managedExecutor();
    const personal = personalExecutor();
    personal.finishTask = jest.fn(async ({ taskId, keepOpen }) => ({
      completed: true as const,
      ...(taskId ? { taskId } : {}),
      closedTabs: 0,
      closedTabIds: [],
      ...(keepOpen
        ? { releasedTabs: 1, releasedTabIds: ["personal:42"] }
        : {}),
      browserClosed: false,
    }));
    const router = new BrowserModeRouter(managed, personal);

    await router.open({
      taskId: "task-keep-open",
      url: "https://chatgpt.com/",
      browserMode: "personal",
    });
    await expect(router.finishTask({
      taskId: "task-keep-open",
      keepOpen: true,
    })).resolves.toMatchObject({
      completed: true,
      closedTabs: 0,
      releasedTabs: 1,
      releasedTabIds: ["personal:42"],
    });
    expect(personal.finishTask).toHaveBeenCalledWith({
      taskId: "task-keep-open",
      keepOpen: true,
    });
  });

  it("rejects keepOpen for managed tasks", async () => {
    const managed = managedExecutor();
    const personal = personalExecutor();
    const router = new BrowserModeRouter(managed, personal);

    await router.open({
      taskId: "task-managed",
      url: "https://example.test/",
    });
    await expect(router.finishTask({
      taskId: "task-managed",
      keepOpen: true,
    })).rejects.toMatchObject({
      code: "BROWSER_OPERATION_MODE_UNSUPPORTED",
    });
    expect(managed.finishTask).not.toHaveBeenCalled();
  });

  it("pauses an explicit personal task and keeps it bound to personal Chrome", async () => {
    const managed = managedExecutor();
    const personal = personalExecutor();
    personal.finishTask = jest.fn(async ({ taskId }) => ({
      completed: true as const, ...(taskId ? { taskId } : {}), closedTabs: 0, closedTabIds: [],
      pausedTabs: 1, pausedTabIds: ["personal:42"], browserClosed: false,
    }));
    const router = new BrowserModeRouter(managed, personal);

    await router.open({ taskId: "task-pause", url: "https://chatgpt.com/", browserMode: "personal" });
    await expect(router.finishTask({ taskId: "task-pause", pause: true })).resolves.toMatchObject({
      closedTabs: 0, pausedTabs: 1, pausedTabIds: ["personal:42"],
    });
    // Still bound to personal Chrome: the task cannot drift to managed mode while paused.
    await expect(router.open({ taskId: "task-pause", url: "https://chatgpt.com/" })).rejects.toMatchObject({
      message: "Browser task task-pause is already bound to personal mode.",
    });
    expect(managed.open).not.toHaveBeenCalled();
    await expect(router.finishTask({ pause: true })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("rejects pause for managed tasks", async () => {
    const managed = managedExecutor();
    const personal = personalExecutor();
    const router = new BrowserModeRouter(managed, personal);

    await router.open({ taskId: "task-managed", url: "https://example.test/" });
    await expect(router.finishTask({ taskId: "task-managed", pause: true })).rejects.toMatchObject({
      code: "BROWSER_OPERATION_MODE_UNSUPPORTED",
    });
    expect(managed.finishTask).not.toHaveBeenCalled();
  });

  it("sends plans to personal Chrome and refuses them for managed tasks", async () => {
    const managed = managedExecutor();
    const personal = personalExecutor();
    const result = { planId: "plan_00000001", taskId: "task-plan", status: "pending" as const,
      domains: ["shop.example"], actions: [] };
    personal.plan = jest.fn(async () => result);
    const router = new BrowserModeRouter(managed, personal);
    const proposal = { taskId: "task-plan", summary: "Ler", steps: ["Ler a página"], domains: ["shop.example"], actions: [] };

    await expect(router.plan(proposal)).resolves.toEqual(result);
    await router.open({ taskId: "task-managed", url: "https://example.test/" });
    await expect(router.plan({ ...proposal, taskId: "task-managed" })).rejects.toMatchObject({
      code: "BROWSER_OPERATION_MODE_UNSUPPORTED",
    });
    expect(personal.plan).toHaveBeenCalledTimes(1);
  });

  it("fails closed when personal mode is requested without a connected extension", async () => {
    const router = new BrowserModeRouter(
      managedExecutor(),
      personalExecutor(false),
    );

    await expect(router.open({
      url: "https://chatgpt.com/",
      browserMode: "personal",
    })).rejects.toMatchObject({
      code: "BROWSER_CAPABILITY_UNSUPPORTED",
    });
  });
});
