import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  type OperationContext,
} from "@vs-code-gpt/shared";
import { z } from "zod";

export const browserTaskStateSchema = z.enum([
  "active",
  "suspended",
  "finishing",
  "finished",
  "expired",
]);
export type BrowserTaskState = z.infer<typeof browserTaskStateSchema>;

const browserTaskFields = {
  taskId: z.string().min(1).max(128),
  ownerScopeHash: z.string().min(1).max(128),
  state: browserTaskStateSchema,
  tabIds: z.array(z.string().min(1).max(128)).max(500),
  createdAt: z.string().datetime(),
  lastActivityAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
} as const;

export const LEGACY_BROWSER_TASK_LIFECYCLE_VERSION = 1 as const;
export const CURRENT_BROWSER_TASK_LIFECYCLE_VERSION = 2 as const;

export const legacyBrowserTaskSchema = z
  .object({
    ...browserTaskFields,
    lifecycleVersion: z.literal(LEGACY_BROWSER_TASK_LIFECYCLE_VERSION),
  })
  .strict();
export type LegacyBrowserTask = z.infer<typeof legacyBrowserTaskSchema>;

export const browserTaskSchema = z
  .object({
    ...browserTaskFields,
    lifecycleVersion: z.literal(CURRENT_BROWSER_TASK_LIFECYCLE_VERSION),
  })
  .strict();
export type BrowserTask = z.infer<typeof browserTaskSchema>;

export const LEGACY_UNCLAIMED_OWNER_SCOPE_HASH = "legacy-unclaimed";
const DEFAULT_OWNER_SCOPE = "legacy-local";
const DEFAULT_TASK_TTL_MS = 10 * 60 * 1000;

export interface BrowserTaskLease {
  taskId: string;
  release(): void;
}

export class BrowserTaskRegistry {
  private readonly tasks = new Map<string, BrowserTask>();
  private readonly taskByTab = new Map<string, string>();
  private readonly activeLeases = new Map<string, number>();

  constructor(
    initialTasks: readonly BrowserTask[] = [],
    private readonly ttlMs = DEFAULT_TASK_TTL_MS,
  ) {
    for (const task of initialTasks) {
      const parsed = browserTaskSchema.parse(task);
      this.tasks.set(parsed.taskId, {
        ...parsed,
        tabIds: [...parsed.tabIds],
      });
      for (const tabId of parsed.tabIds) {
        if (!this.taskByTab.has(tabId)) {
          this.taskByTab.set(tabId, parsed.taskId);
        }
      }
    }
  }

  snapshot(): BrowserTask[] {
    return [...this.tasks.values()].map((task) => ({
      ...task,
      tabIds: [...task.tabIds],
    }));
  }

  taskIdForTab(tabId: string): string | undefined {
    return this.taskByTab.get(tabId);
  }

  taskForTab(tabId: string): BrowserTask | undefined {
    const taskId = this.taskByTab.get(tabId);
    if (!taskId) return undefined;
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  accessibleTasks(
    context: OperationContext | undefined,
    includeTerminal = false,
  ): BrowserTask[] {
    const ownerHash = hashOwnerScope(ownerScope(context));
    return [...this.tasks.values()]
      .filter((task) => task.ownerScopeHash === ownerHash)
      .filter((task) => includeTerminal || isAccessibleState(task.state))
      .map(cloneTask);
  }

  resolveForOpen(
    taskId: string | undefined,
    context: OperationContext | undefined,
  ): BrowserTask {
    const ownerHash = hashOwnerScope(ownerScope(context));
    if (taskId) {
      return this.requireOwnedTask(taskId, ownerHash, false, true);
    }

    const accessible = [...this.tasks.values()].filter(
      (task) =>
        task.ownerScopeHash === ownerHash &&
        isAccessibleState(task.state),
    );
    if (accessible.length === 0) {
      return this.create(context);
    }
    if (accessible.length > 1) {
      throw new AppError(
        "TASK_SCOPE_REQUIRED",
        "More than one browser task is accessible. Provide taskId explicitly.",
      );
    }
    return this.resume(accessible[0]!);
  }

  resolveScoped(
    taskId: string | undefined,
    context: OperationContext | undefined,
    includeFinished = false,
  ): BrowserTask {
    const ownerHash = hashOwnerScope(ownerScope(context));
    if (taskId) {
      return this.requireOwnedTask(taskId, ownerHash, includeFinished, true);
    }
    const accessible = [...this.tasks.values()].filter(
      (task) =>
        task.ownerScopeHash === ownerHash &&
        (isAccessibleState(task.state) ||
          (includeFinished && task.state === "finished")),
    );
    if (accessible.length === 0) {
      throw new AppError("TASK_NOT_FOUND", "No browser task is accessible.");
    }
    if (accessible.length > 1) {
      throw new AppError(
        "TASK_SCOPE_REQUIRED",
        "More than one browser task is accessible. Provide taskId explicitly.",
      );
    }
    const task = accessible[0]!;
    return isAccessibleState(task.state) ? this.resume(task) : cloneTask(task);
  }

  create(context?: OperationContext): BrowserTask {
    const now = Date.now();
    const task = browserTaskSchema.parse({
      taskId: `task-${randomUUID()}`,
      ownerScopeHash: hashOwnerScope(ownerScope(context)),
      state: "active",
      tabIds: [],
      createdAt: new Date(now).toISOString(),
      lastActivityAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      lifecycleVersion: CURRENT_BROWSER_TASK_LIFECYCLE_VERSION,
    });
    this.tasks.set(task.taskId, task);
    return cloneTask(task);
  }

  assertTabAccess(
    tabId: string,
    context?: OperationContext,
  ): BrowserTask {
    const taskId = this.taskByTab.get(tabId);
    if (!taskId) {
      throw new AppError(
        "TASK_NOT_FOUND",
        "The browser tab is not associated with a task.",
      );
    }
    const ownerHash = hashOwnerScope(ownerScope(context));
    return this.requireOwnedTask(taskId, ownerHash, false, true);
  }

  attachTab(
    taskId: string,
    tabId: string,
    context?: OperationContext,
  ): BrowserTask {
    const ownerHash = hashOwnerScope(ownerScope(context));
    this.requireOwnedTask(taskId, ownerHash, false, true);
    const task = this.tasks.get(taskId)!;
    const currentTaskId = this.taskByTab.get(tabId);
    if (currentTaskId && currentTaskId !== task.taskId) {
      throw new AppError(
        "TASK_OWNERSHIP_MISMATCH",
        "The browser tab already belongs to another task.",
      );
    }
    if (!task.tabIds.includes(tabId)) task.tabIds.push(tabId);
    this.taskByTab.set(tabId, task.taskId);
    return this.touchTask(task);
  }

  attachExistingTab(taskId: string, tabId: string): BrowserTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError("TASK_NOT_FOUND", "The browser task was not found.");
    const currentTaskId = this.taskByTab.get(tabId);
    if (currentTaskId && currentTaskId !== taskId) {
      throw new AppError(
        "TASK_OWNERSHIP_MISMATCH",
        "The browser tab already belongs to another task.",
      );
    }
    if (!task.tabIds.includes(tabId)) task.tabIds.push(tabId);
    this.taskByTab.set(tabId, taskId);
    return cloneTask(task);
  }

  detachTab(tabId: string): void {
    const taskId = this.taskByTab.get(tabId);
    if (!taskId) return;
    this.taskByTab.delete(tabId);
    const task = this.tasks.get(taskId);
    if (!task) return;
    task.tabIds = task.tabIds.filter((candidate) => candidate !== tabId);
    this.touchTask(task);
  }

  acquireForTask(
    taskId: string,
    context?: OperationContext,
  ): BrowserTaskLease {
    const ownerHash = hashOwnerScope(ownerScope(context));
    const task = this.requireOwnedTask(taskId, ownerHash, false, true);
    this.activeLeases.set(task.taskId, (this.activeLeases.get(task.taskId) ?? 0) + 1);
    this.touchTask(task);
    let released = false;
    return {
      taskId: task.taskId,
      release: () => {
        if (released) return;
        released = true;
        const remaining = Math.max(0, (this.activeLeases.get(task.taskId) ?? 1) - 1);
        if (remaining === 0) this.activeLeases.delete(task.taskId);
        else this.activeLeases.set(task.taskId, remaining);
        const current = this.tasks.get(task.taskId);
        if (current && isAccessibleState(current.state)) this.touchTask(current);
      },
    };
  }

  acquireForTab(
    tabId: string,
    context?: OperationContext,
  ): BrowserTaskLease {
    const task = this.assertTabAccess(tabId, context);
    return this.acquireForTask(task.taskId, context);
  }

  leaseCount(taskId: string): number {
    return this.activeLeases.get(taskId) ?? 0;
  }

  beginFinish(taskId: string, context?: OperationContext): BrowserTask {
    const ownerHash = hashOwnerScope(ownerScope(context));
    this.requireOwnedTask(taskId, ownerHash, true, false);
    const task = this.tasks.get(taskId)!;
    if (task.state === "finished") return cloneTask(task);
    if (task.state === "expired") {
      throw new AppError("TASK_EXPIRED", "The browser task has expired.");
    }
    task.state = "finishing";
    return this.touchTask(task, false);
  }

  completeFinish(taskId: string): BrowserTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError("TASK_NOT_FOUND", "The browser task was not found.");
    for (const tabId of task.tabIds) this.taskByTab.delete(tabId);
    task.state = "finished";
    task.tabIds = [];
    const now = new Date().toISOString();
    task.lastActivityAt = now;
    task.expiresAt = now;
    return cloneTask(task);
  }

  beginExpiration(taskId: string, now = Date.now()): BrowserTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task || !isAccessibleState(task.state)) return undefined;
    if (this.leaseCount(taskId) > 0) return undefined;
    if (Date.parse(task.expiresAt) > now) return undefined;
    task.state = "finishing";
    return cloneTask(task);
  }

  restoreAfterFailedFinalization(taskId: string): BrowserTask | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "finishing") return undefined;
    task.state = "active";
    return this.touchTask(task);
  }

  markExpired(taskId: string): BrowserTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError("TASK_NOT_FOUND", "The browser task was not found.");
    for (const tabId of task.tabIds) this.taskByTab.delete(tabId);
    task.state = "expired";
    task.tabIds = [];
    const now = new Date().toISOString();
    task.lastActivityAt = now;
    task.expiresAt = now;
    return cloneTask(task);
  }

  expiredCandidates(now = Date.now()): BrowserTask[] {
    return [...this.tasks.values()]
      .filter((task) => isAccessibleState(task.state))
      .filter((task) => this.leaseCount(task.taskId) === 0)
      .filter((task) => Date.parse(task.expiresAt) <= now)
      .map(cloneTask);
  }

  private requireOwnedTask(
    taskId: string,
    ownerHash: string,
    includeFinished: boolean,
    resumeSuspended: boolean,
  ): BrowserTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new AppError("TASK_NOT_FOUND", "The browser task was not found.");
    if (task.ownerScopeHash !== ownerHash) {
      throw new AppError(
        "TASK_OWNERSHIP_MISMATCH",
        "The browser task belongs to another owner scope.",
      );
    }
    if (task.state === "expired") {
      throw new AppError("TASK_EXPIRED", "The browser task has expired.");
    }
    if (task.state === "finished" && !includeFinished) {
      throw new AppError("TASK_NOT_FOUND", "The browser task is already finished.");
    }
    if (task.state === "finishing") {
      throw new AppError("TASK_SUSPENDED", "The browser task is finishing.");
    }
    if (resumeSuspended && task.state === "suspended") {
      return this.resume(task);
    }
    return cloneTask(task);
  }

  private resume(task: BrowserTask): BrowserTask {
    task.state = "active";
    return this.touchTask(task);
  }

  private touchTask(task: BrowserTask, extendExpiry = true): BrowserTask {
    const now = Date.now();
    task.lastActivityAt = new Date(now).toISOString();
    if (extendExpiry) task.expiresAt = new Date(now + this.ttlMs).toISOString();
    return cloneTask(task);
  }
}

export function ownerScope(context?: OperationContext): string {
  return context?.ownerScope ?? DEFAULT_OWNER_SCOPE;
}

export function hashOwnerScope(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cloneTask(task: BrowserTask): BrowserTask {
  return { ...task, tabIds: [...task.tabIds] };
}

function isAccessibleState(state: BrowserTaskState): boolean {
  return state === "active" || state === "suspended";
}
