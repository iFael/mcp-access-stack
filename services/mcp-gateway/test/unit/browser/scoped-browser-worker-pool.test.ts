import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { BrowserExecutor, OperationContext } from "@vs-code-gpt/shared";
import { ScopedBrowserWorkerPool } from "../../../src/browser/scoped-browser-worker-pool.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("ScopedBrowserWorkerPool", () => {
  it("keeps idle status and tabs process-free", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-pool-idle-"));
    temporaryRoots.push(root);

    const startWorker = jest.fn(async () => ({
      client: {} as BrowserExecutor,
      close: jest.fn(async () => undefined),
    }));
    const pool = await ScopedBrowserWorkerPool.create({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      startWorker: startWorker as never,
    });
    const scope = { ownerScope: "owner-idle" } as OperationContext;

    await expect(pool.status({}, scope)).resolves.toMatchObject({
      state: "disconnected",
      ready: false,
      tabCount: 0,
      taskCount: 0,
    });
    await expect(pool.tabs({}, scope)).resolves.toEqual({ tabs: [] });
    await expect(pool.tabs({ taskId: "task-stale" }, scope)).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });
    expect(startWorker).not.toHaveBeenCalled();

    await pool.close();
    await expect(pool.status({}, scope)).rejects.toMatchObject({
      code: "BROWSER_WORKER_UNAVAILABLE",
    });
    await expect(pool.tabs({}, scope)).rejects.toMatchObject({
      code: "BROWSER_WORKER_UNAVAILABLE",
    });
  });

  it("fails closed for personal mode instead of launching a managed worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-pool-personal-"));
    temporaryRoots.push(root);

    const startWorker = jest.fn(async () => ({
      client: {} as BrowserExecutor,
      close: jest.fn(async () => undefined),
    }));
    const pool = await ScopedBrowserWorkerPool.create({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      startWorker: startWorker as never,
    });
    const scope = { ownerScope: "owner-personal" } as OperationContext;

    await expect(pool.open({
      url: "https://chatgpt.com/",
      browserMode: "personal",
    }, scope)).rejects.toMatchObject({
      code: "BROWSER_CAPABILITY_UNSUPPORTED",
    });
    expect(startWorker).not.toHaveBeenCalled();

    await pool.close();
  });

  it("releases the owner worker after the final task finishes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-pool-finish-"));
    temporaryRoots.push(root);

    const close = jest.fn(async () => undefined);
    const stateRoots: string[] = [];
    const startWorker = jest.fn(async (options: { stateRoot: string }) => {
      stateRoots.push(options.stateRoot);
      return {
        client: {
          open: jest.fn(async () => ({
            tab: { taskId: "task-one", tabId: "tab-one" },
          })),
          finishTask: jest.fn(async () => ({
            completed: true as const,
            taskId: "task-one",
            closedTabs: 1,
            closedTabIds: ["tab-one"],
            browserClosed: true,
          })),
        } as unknown as BrowserExecutor,
        close,
      };
    });
    const pool = await ScopedBrowserWorkerPool.create({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      startWorker: startWorker as never,
    });
    const scope = { ownerScope: "owner-finish" } as OperationContext;

    await pool.open({ url: "https://example.test" } as never, scope);
    await expect(pool.finishTask({}, scope)).resolves.toMatchObject({
      taskId: "task-one",
      browserClosed: true,
    });
    expect(close).toHaveBeenCalledTimes(1);
    await expect(access(stateRoots[0]!)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(pool.status({}, scope)).resolves.toMatchObject({
      state: "disconnected",
      tabCount: 0,
      taskCount: 0,
    });
    await expect(pool.tabs({}, scope)).resolves.toEqual({ tabs: [] });
    expect(startWorker).toHaveBeenCalledTimes(1);

    await pool.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("waits for concurrent owner operations before retiring the worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-pool-concurrent-"));
    temporaryRoots.push(root);

    const close = jest.fn(async () => undefined);
    let resolveTabs!: (value: { tabs: [] }) => void;
    const tabsResult = new Promise<{ tabs: [] }>((resolve) => {
      resolveTabs = resolve;
    });
    const startWorker = jest.fn(async () => ({
      client: {
        open: jest.fn(async () => ({
          tab: { taskId: "task-concurrent", tabId: "tab-concurrent" },
        })),
        tabs: jest.fn(async () => tabsResult),
        finishTask: jest.fn(async () => ({
          completed: true as const,
          taskId: "task-concurrent",
          closedTabs: 1,
          closedTabIds: ["tab-concurrent"],
          browserClosed: true,
        })),
      } as unknown as BrowserExecutor,
      close,
    }));
    const pool = await ScopedBrowserWorkerPool.create({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      startWorker: startWorker as never,
    });
    const scope = { ownerScope: "owner-concurrent" } as OperationContext;

    await pool.open({ url: "https://example.test" } as never, scope);
    const pendingTabs = pool.tabs({}, scope);
    await pool.finishTask({ taskId: "task-concurrent" }, scope);
    expect(close).not.toHaveBeenCalled();

    resolveTabs({ tabs: [] });
    await pendingTabs;
    expect(close).toHaveBeenCalledTimes(1);

    await pool.close();
  });

  it("keeps a shared owner worker until its last task finishes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-pool-multi-"));
    temporaryRoots.push(root);

    const close = jest.fn(async () => undefined);
    let openCount = 0;
    const startWorker = jest.fn(async () => ({
      client: {
        open: jest.fn(async () => {
          openCount += 1;
          return {
            tab: {
              taskId: `task-${openCount}`,
              tabId: `tab-${openCount}`,
            },
          };
        }),
        finishTask: jest.fn(async (input: { taskId?: string }) => ({
          completed: true as const,
          taskId: input.taskId,
          closedTabs: 1,
          closedTabIds: [`tab-${input.taskId === "task-1" ? 1 : 2}`],
          browserClosed: input.taskId === "task-2",
        })),
      } as unknown as BrowserExecutor,
      close,
    }));
    const pool = await ScopedBrowserWorkerPool.create({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      startWorker: startWorker as never,
    });
    const scope = { ownerScope: "owner-multi" } as OperationContext;

    await pool.open({ url: "https://one.test" } as never, scope);
    await pool.open({ url: "https://two.test" } as never, scope);
    await pool.finishTask({ taskId: "task-1" }, scope);
    expect(close).not.toHaveBeenCalled();
    await pool.finishTask({ taskId: "task-2" }, scope);
    expect(close).toHaveBeenCalledTimes(1);
    expect(startWorker).toHaveBeenCalledTimes(1);

    await pool.close();
  });

  it("isolates workers by owner scope and removes ephemeral state on close", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-pool-"));
    temporaryRoots.push(root);

    const stateRoots: string[] = [];
    const closeCalls: Array<ReturnType<typeof jest.fn>> = [];
    const tabsCalls: string[] = [];
    const startWorker = jest.fn(async (options: { stateRoot: string }) => {
      stateRoots.push(options.stateRoot);
      const close = jest.fn(async () => undefined);
      closeCalls.push(close);
      return {
        client: {
          connect: jest.fn(async () => ({})),
          tabs: jest.fn(async (_input: unknown, context?: OperationContext) => {
            tabsCalls.push(context?.ownerScope ?? "");
            return { tabs: [] };
          }),
        } as unknown as BrowserExecutor,
        close,
      };
    });

    const pool = await ScopedBrowserWorkerPool.create({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      maxScopes: 2,
      startWorker: startWorker as never,
    });
    const scopeA = { ownerScope: "owner-scope-a" } as OperationContext;
    const scopeB = { ownerScope: "owner-scope-b" } as OperationContext;

    await pool.connect({}, scopeA);
    await pool.tabs({}, scopeA);
    await pool.connect({}, scopeB);
    await pool.tabs({}, scopeB);

    expect(startWorker).toHaveBeenCalledTimes(2);
    expect(stateRoots).toHaveLength(2);
    expect(stateRoots[0]).not.toContain("owner-scope-a");
    expect(stateRoots[1]).not.toContain("owner-scope-b");
    expect(stateRoots[0]).not.toBe(stateRoots[1]);
    expect(tabsCalls).toEqual([
      "owner-scope-a",
      "owner-scope-b",
    ]);

    await expect(pool.tabs({})).rejects.toMatchObject({
      code: "AUTHENTICATION_REQUIRED",
    });

    await pool.close();
    expect(closeCalls).toHaveLength(2);
    for (const close of closeCalls) expect(close).toHaveBeenCalledTimes(1);
    await expect(
      access(path.join(root, "state", "browser-scopes")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves live frames only from the unique owner scope that produced the task/tab", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-pool-live-"));
    temporaryRoots.push(root);

    const readLiveFrame = jest.fn(async (input: unknown) => ({
      seq: 7,
      data: "/9j/",
      width: 640,
      height: 360,
      capturedAt: 100,
      input,
    }));
    const startWorker = jest.fn(async () => ({
      client: {
        open: jest.fn(async () => ({
          tab: {
            taskId: "task-live",
            tabId: "tab-live",
          },
        })),
      } as unknown as BrowserExecutor,
      readLiveFrame,
      close: jest.fn(async () => undefined),
    }));
    const pool = await ScopedBrowserWorkerPool.create({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      startWorker: startWorker as never,
    });

    await pool.open(
      { url: "https://example.test", purpose: "live-test" } as never,
      { ownerScope: "user:one" } as OperationContext,
    );
    await expect(pool.readLiveFrame({
      taskId: "task-live",
      tabId: "tab-live",
      afterSeq: 6,
    }, { ownerScope: "user:one" })).resolves.toMatchObject({
      seq: 7,
      width: 640,
      height: 360,
    });
    expect(readLiveFrame).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-live",
      tabId: "tab-live",
      afterSeq: 6,
      ownerScope: "user:one",
    }));
    await expect(pool.readLiveFrame({
      taskId: "task-live",
      tabId: "tab-live",
      afterSeq: 0,
    }, { ownerScope: "user:other" })).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });
    await expect(pool.readLiveFrame({
      taskId: "task-other",
      tabId: "tab-live",
      afterSeq: 0,
    }, { ownerScope: "user:one" })).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });

    await pool.close();
  });

  it("fails closed instead of evicting another scope when capacity is full", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-v3-browser-pool-capacity-"));
    temporaryRoots.push(root);

    const startWorker = jest.fn(async () => ({
      client: {
        connect: jest.fn(async () => ({})),
      } as unknown as BrowserExecutor,
      close: jest.fn(async () => undefined),
    }));
    const pool = await ScopedBrowserWorkerPool.create({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      maxScopes: 1,
      startWorker: startWorker as never,
    });

    await pool.connect({}, { ownerScope: "scope-one" } as OperationContext);
    await expect(
      pool.connect({}, { ownerScope: "scope-two" } as OperationContext),
    ).rejects.toMatchObject({ code: "AGENT_BUSY" });

    expect(startWorker).toHaveBeenCalledTimes(1);
    await pool.close();
  });
});
