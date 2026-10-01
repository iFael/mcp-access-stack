import { describe, expect, it, jest } from "@jest/globals";
import type { BrowserExecutor } from "@vs-code-gpt/shared";
import {
  BrowserModeRouter,
  type PersonalBrowserExecutor,
} from "../../../src/browser/browser-mode-router.js";

function managedExecutor(): BrowserExecutor {
  return {
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
