import { abortSignalError, AppError } from "@vs-code-gpt/shared";

export interface BrowserOperationQueueResult<T> {
  value: T;
  queueWaitMs: number;
}

/** Serializes each tab independently while allowing bounded cross-tab work. */
export class BrowserOperationQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly slotWaiters: Array<() => void> = [];
  private active = 0;
  private queued = 0;

  constructor(private readonly maxConcurrency = 4) {}

  get queuedCount(): number {
    return this.queued;
  }

  async run<T>(
    task: () => Promise<T>,
    maxQueueWaitMs: number,
    signal?: AbortSignal,
    key = "context",
  ): Promise<BrowserOperationQueueResult<T>> {
    const enqueuedAt = performance.now();
    let release: (() => void) | undefined;
    const turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = (this.tails.get(key) ?? Promise.resolve())
      .catch(() => undefined);
    const current = previous.then(() => turn);
    this.tails.set(key, current);
    this.queued += 1;

    let releaseSlot: (() => void) | undefined;
    try {
      await waitForTurn(previous, signal);
      releaseSlot = await this.acquireSlot(signal);
    } catch (error) {
      this.queued -= 1;
      release?.();
      this.cleanupTail(key, current);
      throw error;
    }
    this.queued -= 1;
    const queueWaitMs = performance.now() - enqueuedAt;

    try {
      if (signal?.aborted) {
        throw abortSignalError(
          signal,
          "Browser operation was cancelled while queued.",
        );
      }
      if (queueWaitMs > maxQueueWaitMs) {
        throw new AppError(
          "BROWSER_WORKER_TIMEOUT",
          "Browser operation expired while waiting for the shared browser session.",
        );
      }
      return { value: await task(), queueWaitMs };
    } finally {
      releaseSlot?.();
      release?.();
      this.cleanupTail(key, current);
    }
  }

  private async acquireSlot(signal?: AbortSignal): Promise<() => void> {
    while (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve, reject) => {
        const resume = (): void => {
          cleanup();
          resolve();
        };
        const onAbort = (): void => {
          const index = this.slotWaiters.indexOf(resume);
          if (index >= 0) this.slotWaiters.splice(index, 1);
          cleanup();
          reject(abortSignalError(
            signal!,
            "Browser operation was cancelled while waiting for a worker slot.",
          ));
        };
        const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        this.slotWaiters.push(resume);
      });
    }
    this.active += 1;
    return () => {
      this.active = Math.max(0, this.active - 1);
      this.slotWaiters.shift()?.();
    };
  }

  private cleanupTail(key: string, current: Promise<void>): void {
    if (this.tails.get(key) !== current) return;
    void current.finally(() => {
      if (this.tails.get(key) === current) this.tails.delete(key);
    });
  }
}

async function waitForTurn(
  previous: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) return previous;
  if (signal.aborted) {
    throw abortSignalError(signal, "Browser operation was cancelled while queued.");
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortSignalError(signal, "Browser operation was cancelled while queued."));
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void previous.then(() => {
      cleanup();
      resolve();
    }, (error) => {
      cleanup();
      reject(error);
    });
  });
}
