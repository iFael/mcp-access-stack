import { describe, expect, it } from "@jest/globals";
import { BrowserOperationQueue } from "../../services/browser-operation-queue.js";

describe("BrowserOperationQueue", () => {
  it("serializes a burst of operations in enqueue order", async () => {
    const queue = new BrowserOperationQueue();
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 40 }, (_unused, index) =>
        queue.run(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 1));
          order.push(index);
          active -= 1;
          return index;
        }, 5_000),
      ),
    );

    expect(maxActive).toBe(1);
    expect(order).toEqual(Array.from({ length: 40 }, (_unused, index) => index));
    expect(queue.queuedCount).toBe(0);
  });

  it("does not leak a global slot after a queued operation expires", async () => {
    const queue = new BrowserOperationQueue(1);
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let secondExecuted = false;

    const first = queue.run(async () => {
      firstEntered?.();
      await firstGate;
      return "first";
    }, 5_000, undefined, "tab:first");
    await entered;
    const second = queue.run(async () => {
      secondExecuted = true;
      return "second";
    }, 10, undefined, "tab:expired");

    await new Promise((resolve) => setTimeout(resolve, 25));
    releaseFirst?.();

    await expect(first).resolves.toMatchObject({ value: "first" });
    await expect(second).rejects.toMatchObject({ code: "BROWSER_WORKER_TIMEOUT" });
    expect(secondExecuted).toBe(false);

    const recovered = queue.run(
      async () => "recovered",
      1_000,
      undefined,
      "tab:recovery",
    );
    await expect(
      Promise.race([
        recovered,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("The queue did not release its global slot.")),
            250,
          ),
        ),
      ]),
    ).resolves.toMatchObject({ value: "recovered" });
    expect(queue.queuedCount).toBe(0);
  });

  it("removes a cancelled request from the queue without executing it", async () => {
    const queue = new BrowserOperationQueue();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let cancelledExecuted = false;

    const first = queue.run(async () => {
      firstEntered?.();
      await firstGate;
      return "first";
    }, 5_000);
    await entered;

    const controller = new AbortController();
    const cancelled = queue.run(async () => {
      cancelledExecuted = true;
      return "cancelled";
    }, 5_000, controller.signal);
    controller.abort();

    await expect(cancelled).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(cancelledExecuted).toBe(false);
    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ value: "first" });
    expect(queue.queuedCount).toBe(0);
  });

  it("does not leak a slot when cancellation is observed after acquisition", async () => {
    const queue = new BrowserOperationQueue(1);
    let abortedReads = 0;
    const signal = {
      get aborted() {
        abortedReads += 1;
        return abortedReads >= 2;
      },
      reason: new DOMException("Aborted", "AbortError"),
      onabort: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => true,
      throwIfAborted: () => undefined,
    } as unknown as AbortSignal;
    let executed = false;

    await expect(queue.run(async () => {
      executed = true;
      return "cancelled";
    }, 1_000, signal, "tab:cancelled-after-acquire"))
      .rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    expect(executed).toBe(false);

    await expect(queue.run(
      async () => "recovered",
      1_000,
      undefined,
      "tab:recovered-after-cancel",
    )).resolves.toMatchObject({ value: "recovered" });
    expect(queue.queuedCount).toBe(0);
  });

  it("runs different tabs concurrently while preserving order per tab", async () => {
    const queue = new BrowserOperationQueue(2);
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const run = (key: string, label: string, delayMs: number) =>
      queue.run(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(label);
        active -= 1;
        return label;
      }, 5_000, undefined, key);

    await Promise.all([
      run("tab:a", "a1", 15),
      run("tab:a", "a2", 1),
      run("tab:b", "b1", 5),
    ]);

    expect(maxActive).toBe(2);
    expect(order.indexOf("a1")).toBeLessThan(order.indexOf("a2"));
    expect(queue.queuedCount).toBe(0);
  });
});
