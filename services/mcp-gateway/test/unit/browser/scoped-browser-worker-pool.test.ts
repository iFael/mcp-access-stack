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

    await pool.tabs({}, scopeA);
    await pool.tabs({}, scopeA);
    await pool.tabs({}, scopeB);

    expect(startWorker).toHaveBeenCalledTimes(2);
    expect(stateRoots).toHaveLength(2);
    expect(stateRoots[0]).not.toContain("owner-scope-a");
    expect(stateRoots[1]).not.toContain("owner-scope-b");
    expect(stateRoots[0]).not.toBe(stateRoots[1]);
    expect(tabsCalls).toEqual([
      "owner-scope-a",
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
        tabs: jest.fn(async () => ({ tabs: [] })),
      } as unknown as BrowserExecutor,
      close: jest.fn(async () => undefined),
    }));
    const pool = await ScopedBrowserWorkerPool.create({
      releaseRoot: root,
      stateRoot: path.join(root, "state"),
      maxScopes: 1,
      startWorker: startWorker as never,
    });

    await pool.tabs({}, { ownerScope: "scope-one" } as OperationContext);
    await expect(
      pool.tabs({}, { ownerScope: "scope-two" } as OperationContext),
    ).rejects.toMatchObject({ code: "AGENT_BUSY" });

    expect(startWorker).toHaveBeenCalledTimes(1);
    await pool.close();
  });
});
