import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  AppError,
  type BrowserExecutor,
  type OperationContext,
} from "@vs-code-gpt/shared";
import {
  LocalBrowserWorker,
  type BrowserLiveFramePayload,
  type LocalBrowserWorkerOptions,
} from "../companion/local-browser-worker.js";

interface ScopedBrowserWorkerHandle {
  client: BrowserExecutor;
  readLiveFrame?(input: {
    taskId: string;
    tabId: string;
    afterSeq: number;
    ownerScope: string;
    signal?: AbortSignal;
  }): Promise<BrowserLiveFramePayload | null>;
  close(): Promise<void>;
}

export interface ScopedBrowserWorkerPoolOptions {
  releaseRoot: string;
  stateRoot: string;
  nodePath?: string;
  browserChannel?: "chromium" | "chrome";
  headless?: boolean;
  maxScopes?: number;
  log?: (entry: Record<string, unknown>) => void;
  startWorker?: (
    options: LocalBrowserWorkerOptions,
  ) => Promise<ScopedBrowserWorkerHandle>;
}

const DEFAULT_MAX_SCOPES = 32;

export class ScopedBrowserWorkerPool implements BrowserExecutor {
  private readonly workers = new Map<string, Promise<ScopedBrowserWorkerHandle>>();
  private readonly tabTaskScopes = new Map<string, Set<string>>();
  private readonly scopesRoot: string;
  private readonly maxScopes: number;
  private closed = false;

  private constructor(private readonly options: ScopedBrowserWorkerPoolOptions) {
    this.scopesRoot = path.join(path.resolve(options.stateRoot), "browser-scopes");
    this.maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
  }

  static async create(
    options: ScopedBrowserWorkerPoolOptions,
  ): Promise<ScopedBrowserWorkerPool> {
    const pool = new ScopedBrowserWorkerPool(options);
    await rm(pool.scopesRoot, { recursive: true, force: true });
    await mkdir(pool.scopesRoot, { recursive: true, mode: 0o700 });
    return pool;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const workers = [...this.workers.values()];
    this.workers.clear();
    this.tabTaskScopes.clear();
    await Promise.allSettled(
      workers.map(async (workerPromise) => {
        const worker = await workerPromise;
        await worker.close();
      }),
    );
    await rm(this.scopesRoot, { recursive: true, force: true });
  }

  status(...args: Parameters<BrowserExecutor["status"]>): ReturnType<BrowserExecutor["status"]> {
    return this.invoke(args[1], (client) => client.status(...args));
  }

  connect(...args: Parameters<BrowserExecutor["connect"]>): ReturnType<BrowserExecutor["connect"]> {
    return this.invoke(args[1], (client) => client.connect(...args));
  }

  tabs(...args: Parameters<BrowserExecutor["tabs"]>): ReturnType<BrowserExecutor["tabs"]> {
    return this.invoke(args[1], (client) => client.tabs(...args));
  }

  open(...args: Parameters<BrowserExecutor["open"]>): ReturnType<BrowserExecutor["open"]> {
    return this.invoke(args[1], (client) => client.open(...args));
  }

  openAuthorizedSite(
    ...args: Parameters<BrowserExecutor["openAuthorizedSite"]>
  ): ReturnType<BrowserExecutor["openAuthorizedSite"]> {
    return this.invoke(args[1], (client) => client.openAuthorizedSite(...args));
  }

  navigate(...args: Parameters<BrowserExecutor["navigate"]>): ReturnType<BrowserExecutor["navigate"]> {
    return this.invoke(args[1], (client) => client.navigate(...args));
  }

  snapshot(...args: Parameters<BrowserExecutor["snapshot"]>): ReturnType<BrowserExecutor["snapshot"]> {
    return this.invoke(args[1], (client) => client.snapshot(...args));
  }

  click(...args: Parameters<BrowserExecutor["click"]>): ReturnType<BrowserExecutor["click"]> {
    return this.invoke(args[1], (client) => client.click(...args));
  }

  fill(...args: Parameters<BrowserExecutor["fill"]>): ReturnType<BrowserExecutor["fill"]> {
    return this.invoke(args[1], (client) => client.fill(...args));
  }

  press(...args: Parameters<BrowserExecutor["press"]>): ReturnType<BrowserExecutor["press"]> {
    return this.invoke(args[1], (client) => client.press(...args));
  }

  wait(...args: Parameters<BrowserExecutor["wait"]>): ReturnType<BrowserExecutor["wait"]> {
    return this.invoke(args[1], (client) => client.wait(...args));
  }

  extract(...args: Parameters<BrowserExecutor["extract"]>): ReturnType<BrowserExecutor["extract"]> {
    return this.invoke(args[1], (client) => client.extract(...args));
  }

  sequence(...args: Parameters<BrowserExecutor["sequence"]>): ReturnType<BrowserExecutor["sequence"]> {
    return this.invoke(args[1], (client) => client.sequence(...args));
  }

  frameExtract(
    ...args: Parameters<NonNullable<BrowserExecutor["frameExtract"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameExtract"]>> {
    return this.invoke(args[1], (client) => client.frameExtract!(...args));
  }

  frameClick(
    ...args: Parameters<NonNullable<BrowserExecutor["frameClick"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameClick"]>> {
    return this.invoke(args[1], (client) => client.frameClick!(...args));
  }

  frameFill(
    ...args: Parameters<NonNullable<BrowserExecutor["frameFill"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameFill"]>> {
    return this.invoke(args[1], (client) => client.frameFill!(...args));
  }

  profilePage(
    ...args: Parameters<NonNullable<BrowserExecutor["profilePage"]>>
  ): ReturnType<NonNullable<BrowserExecutor["profilePage"]>> {
    return this.invoke(args[1], (client) => client.profilePage!(...args));
  }

  domIndex(
    ...args: Parameters<NonNullable<BrowserExecutor["domIndex"]>>
  ): ReturnType<NonNullable<BrowserExecutor["domIndex"]>> {
    return this.invoke(args[1], (client) => client.domIndex!(...args));
  }

  frameSequence(
    ...args: Parameters<NonNullable<BrowserExecutor["frameSequence"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameSequence"]>> {
    return this.invoke(args[1], (client) => client.frameSequence!(...args));
  }

  navigatePath(
    ...args: Parameters<NonNullable<BrowserExecutor["navigatePath"]>>
  ): ReturnType<NonNullable<BrowserExecutor["navigatePath"]>> {
    return this.invoke(args[1], (client) => client.navigatePath!(...args));
  }

  screenshot(
    ...args: Parameters<BrowserExecutor["screenshot"]>
  ): ReturnType<BrowserExecutor["screenshot"]> {
    return this.invoke(args[1], (client) => client.screenshot(...args));
  }

  goBack(...args: Parameters<BrowserExecutor["goBack"]>): ReturnType<BrowserExecutor["goBack"]> {
    return this.invoke(args[1], (client) => client.goBack(...args));
  }

  goForward(
    ...args: Parameters<BrowserExecutor["goForward"]>
  ): ReturnType<BrowserExecutor["goForward"]> {
    return this.invoke(args[1], (client) => client.goForward(...args));
  }

  async closeTab(
    ...args: Parameters<BrowserExecutor["closeTab"]>
  ): ReturnType<BrowserExecutor["closeTab"]> {
    const result = await this.invoke(args[1], (client) => client.closeTab(...args));
    this.forgetTab(args[0].tabId);
    return result;
  }

  async finishTask(
    ...args: Parameters<BrowserExecutor["finishTask"]>
  ): ReturnType<BrowserExecutor["finishTask"]> {
    const result = await this.invoke(args[1], (client) => client.finishTask(...args));
    const taskId = args[0].taskId;
    if (taskId) this.forgetTask(taskId);
    return result;
  }

  download(
    ...args: Parameters<BrowserExecutor["download"]>
  ): ReturnType<BrowserExecutor["download"]> {
    return this.invoke(args[1], (client) => client.download(...args));
  }

  upload(...args: Parameters<BrowserExecutor["upload"]>): ReturnType<BrowserExecutor["upload"]> {
    return this.invoke(args[1], (client) => client.upload(...args));
  }

  console(...args: Parameters<BrowserExecutor["console"]>): ReturnType<BrowserExecutor["console"]> {
    return this.invoke(args[1], (client) => client.console(...args));
  }

  networkList(
    ...args: Parameters<BrowserExecutor["networkList"]>
  ): ReturnType<BrowserExecutor["networkList"]> {
    return this.invoke(args[1], (client) => client.networkList(...args));
  }

  networkInspect(
    ...args: Parameters<BrowserExecutor["networkInspect"]>
  ): ReturnType<BrowserExecutor["networkInspect"]> {
    return this.invoke(args[1], (client) => client.networkInspect(...args));
  }

  traceStart(
    ...args: Parameters<BrowserExecutor["traceStart"]>
  ): ReturnType<BrowserExecutor["traceStart"]> {
    return this.invoke(args[1], (client) => client.traceStart(...args));
  }

  traceStop(
    ...args: Parameters<BrowserExecutor["traceStop"]>
  ): ReturnType<BrowserExecutor["traceStop"]> {
    return this.invoke(args[1], (client) => client.traceStop(...args));
  }

  videoStart(
    ...args: Parameters<BrowserExecutor["videoStart"]>
  ): ReturnType<BrowserExecutor["videoStart"]> {
    return this.invoke(args[1], (client) => client.videoStart(...args));
  }

  videoStop(
    ...args: Parameters<BrowserExecutor["videoStop"]>
  ): ReturnType<BrowserExecutor["videoStop"]> {
    return this.invoke(args[1], (client) => client.videoStop(...args));
  }

  pdf(...args: Parameters<BrowserExecutor["pdf"]>): ReturnType<BrowserExecutor["pdf"]> {
    return this.invoke(args[1], (client) => client.pdf(...args));
  }

  diagnostics(
    ...args: Parameters<BrowserExecutor["diagnostics"]>
  ): ReturnType<BrowserExecutor["diagnostics"]> {
    return this.invoke(args[1], (client) => client.diagnostics(...args));
  }

  async readLiveFrame(
    input: { taskId: string; tabId: string; afterSeq: number; signal?: AbortSignal },
    context: Pick<OperationContext, "ownerScope">,
  ): Promise<BrowserLiveFramePayload | null> {
    const ownerScope = context.ownerScope?.trim();
    if (!ownerScope) {
      throw new AppError(
        "AUTHENTICATION_REQUIRED",
        "Remote Browser live view requires an authenticated owner scope.",
      );
    }
    const scopes = this.tabTaskScopes.get(tabTaskKey(input.taskId, input.tabId));
    if (!scopes || scopes.size !== 1 || !scopes.has(ownerScope)) {
      throw new AppError(
        "TASK_NOT_FOUND",
        "Remote Browser live view is unavailable for this task/tab.",
      );
    }
    const workerPromise = this.workers.get(ownerScope);
    if (!workerPromise) {
      throw new AppError("TASK_NOT_FOUND", "Remote Browser live view has ended.");
    }
    const worker = await workerPromise;
    if (!worker.readLiveFrame) {
      throw new AppError(
        "BROWSER_CAPABILITY_UNSUPPORTED",
        "Remote Browser live view is unavailable.",
      );
    }
    return worker.readLiveFrame({
      taskId: input.taskId,
      tabId: input.tabId,
      afterSeq: input.afterSeq,
      ownerScope,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  private async invoke<T>(
    context: OperationContext | undefined,
    operation: (client: BrowserExecutor) => Promise<T>,
  ): Promise<T> {
    const ownerScope = context?.ownerScope?.trim();
    const worker = await this.workerFor(context);
    const result = await operation(worker.client);
    if (ownerScope) this.rememberResultScopes(result, ownerScope);
    return result;
  }

  private rememberResultScopes(value: unknown, ownerScope: string): void {
    for (const pair of collectTaskTabPairs(value)) {
      const key = tabTaskKey(pair.taskId, pair.tabId);
      const scopes = this.tabTaskScopes.get(key) ?? new Set<string>();
      scopes.add(ownerScope);
      this.tabTaskScopes.set(key, scopes);
    }
  }

  private forgetTab(tabId: string): void {
    for (const key of [...this.tabTaskScopes.keys()]) {
      if (key.endsWith(`\0${tabId}`)) this.tabTaskScopes.delete(key);
    }
  }

  private forgetTask(taskId: string): void {
    for (const key of [...this.tabTaskScopes.keys()]) {
      if (key.startsWith(`${taskId}\0`)) this.tabTaskScopes.delete(key);
    }
  }

  private async workerFor(
    context: OperationContext | undefined,
  ): Promise<ScopedBrowserWorkerHandle> {
    if (this.closed) {
      throw new AppError(
        "BROWSER_WORKER_UNAVAILABLE",
        "Remote Browser Worker pool is closed.",
      );
    }
    const ownerScope = context?.ownerScope?.trim();
    if (!ownerScope) {
      throw new AppError(
        "AUTHENTICATION_REQUIRED",
        "Remote Browser execution requires an authenticated owner scope.",
      );
    }

    const existing = this.workers.get(ownerScope);
    if (existing) return existing;
    if (this.workers.size >= this.maxScopes) {
      throw new AppError(
        "AGENT_BUSY",
        "Remote Browser scope capacity is exhausted.",
      );
    }

    const scopeRoot = path.join(this.scopesRoot, scopeDirectoryName(ownerScope));
    const startWorker = this.options.startWorker ?? LocalBrowserWorker.start;
    const created = (async (): Promise<ScopedBrowserWorkerHandle> => {
      await mkdir(scopeRoot, { recursive: true, mode: 0o700 });
      try {
        return await startWorker({
          releaseRoot: this.options.releaseRoot,
          stateRoot: scopeRoot,
          ...(this.options.nodePath === undefined
            ? {}
            : { nodePath: this.options.nodePath }),
          ...(this.options.browserChannel === undefined
            ? {}
            : { browserChannel: this.options.browserChannel }),
          headless: this.options.headless ?? true,
          ...(this.options.log === undefined ? {} : { log: this.options.log }),
        });
      } catch (error) {
        this.workers.delete(ownerScope);
        await rm(scopeRoot, { recursive: true, force: true }).catch(
          () => undefined,
        );
        throw error;
      }
    })();
    this.workers.set(ownerScope, created);
    return created;
  }
}

function scopeDirectoryName(ownerScope: string): string {
  return createHash("sha256").update(ownerScope, "utf8").digest("hex");
}

function tabTaskKey(taskId: string, tabId: string): string {
  return `${taskId}\0${tabId}`;
}

function collectTaskTabPairs(value: unknown): Array<{ taskId: string; tabId: string }> {
  const pairs = new Map<string, { taskId: string; tabId: string }>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > 8 || current === null || current === undefined) return;
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 256)) visit(item, depth + 1);
      return;
    }
    if (typeof current !== "object") return;
    const record = current as Record<string, unknown>;
    if (typeof record.taskId === "string" && record.taskId.length <= 128 &&
        typeof record.tabId === "string" && record.tabId.length <= 128) {
      pairs.set(tabTaskKey(record.taskId, record.tabId), {
        taskId: record.taskId,
        tabId: record.tabId,
      });
    }
    for (const nested of Object.values(record).slice(0, 256)) visit(nested, depth + 1);
  };
  visit(value, 0);
  return [...pairs.values()];
}
