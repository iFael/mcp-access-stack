import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { browserTabSchema } from "@vs-code-gpt/shared";
import { z } from "zod";
import {
  browserTaskSchema,
  CURRENT_BROWSER_TASK_LIFECYCLE_VERSION,
  legacyBrowserTaskSchema,
  LEGACY_BROWSER_TASK_LIFECYCLE_VERSION,
  LEGACY_UNCLAIMED_OWNER_SCOPE_HASH,
  type BrowserTask,
} from "./browser-task-registry.js";
import {
  browserSessionSchema,
  unifiedBrowserTabSchema,
  type BrowserSession,
  type UnifiedBrowserTab,
} from "./browser-session-model.js";

export const browserNavigationTransitionSchema = z
  .object({
    operation: z.enum(["navigate", "click", "press", "go-back", "go-forward"]),
    startedAt: z.string().min(1),
    expiresAt: z.string().min(1),
    expectedUrl: z.url().optional(),
  })
  .strict();
export type BrowserNavigationTransition = z.infer<
  typeof browserNavigationTransitionSchema
>;

const legacyBrowserTabBindingSchema = z
  .object({
    tabId: z.string().min(1).max(128),
    remoteIndex: z.number().int().nonnegative(),
    url: z.url(),
    title: z.string().max(500),
    remoteTabCount: z.number().int().nonnegative().optional(),
    navigation: browserNavigationTransitionSchema.optional(),
  })
  .strict();

export const browserTabBindingSchema = z
  .object({
    tabId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    driver: z.literal("direct"),
    remoteTabId: z.string().min(1).max(256),
    remoteIndex: z.number().int().nonnegative(),
    url: z.url(),
    title: z.string().max(500),
    remoteTabCount: z.number().int().nonnegative().optional(),
    navigation: browserNavigationTransitionSchema.optional(),
  })
  .strict();
export type BrowserTabBinding = z.infer<typeof browserTabBindingSchema>;

const registryV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    browser: z.literal("chrome"),
    profile: z.literal("default"),
    tabGroup: z.literal("MCP"),
    updatedAt: z.string().min(1),
    tabs: z.array(browserTabSchema).max(100),
  })
  .strict();

const registryV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    browser: z.literal("chrome"),
    profile: z.literal("default"),
    tabGroup: z.literal("MCP"),
    updatedAt: z.string().min(1),
    tabs: z.array(browserTabSchema).max(100),
    bindings: z.array(legacyBrowserTabBindingSchema).max(100),
  })
  .strict();

const legacyDriverKindSchema = z.enum(["direct", "mcp", "cli"]);
const legacyProfileTypeSchema = z.enum([
  "default-chrome",
  "isolated",
  "persistent",
]);
const legacySessionSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    driver: legacyDriverKindSchema,
    mode: z.enum(["auto", "interactive", "efficient", "diagnostic"]),
    state: z.enum(["starting", "connected", "disconnected", "failed"]),
    profileType: legacyProfileTypeSchema,
    routingReason: z.string().min(1).max(200).optional(),
    routingPolicyReason: z.string().min(1).max(200).optional(),
    fallbackFrom: legacyDriverKindSchema.optional(),
    fallbackReason: z.string().min(1).max(500).optional(),
    createdAt: z.string().datetime(),
    lastUsedAt: z.string().datetime(),
  })
  .strict();
const legacyUnifiedTabSchema = z
  .object({
    tabId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    driver: legacyDriverKindSchema,
    remoteTabId: z.string().min(1).max(256),
    remoteIndex: z.number().int().nonnegative(),
    ownership: z.literal("mcp"),
    purpose: z.string().min(1).max(200),
    reusable: z.boolean(),
    protected: z.boolean(),
    sticky: z.boolean(),
    createdAt: z.string().datetime(),
    lastUsedAt: z.string().datetime(),
    url: z.url().optional(),
    title: z.string().max(500).optional(),
    lockedUrl: z.url().optional(),
  })
  .strict();
const legacyV3BindingSchema = z
  .object({
    tabId: z.string().min(1).max(128),
    sessionId: z.string().min(1).max(128),
    driver: legacyDriverKindSchema,
    remoteTabId: z.string().min(1).max(256),
    remoteIndex: z.number().int().nonnegative(),
    url: z.url(),
    title: z.string().max(500),
    remoteTabCount: z.number().int().nonnegative().optional(),
    navigation: browserNavigationTransitionSchema.optional(),
  })
  .strict();

const registryV3StorageSchema = z
  .object({
    schemaVersion: z.literal(3),
    browser: z.literal("chrome"),
    tabGroup: z.literal("MCP"),
    updatedAt: z.string().datetime(),
    sessions: z.array(legacySessionSchema).max(100),
    tabs: z.array(legacyUnifiedTabSchema).max(500),
    bindings: z.array(legacyV3BindingSchema).max(500),
  })
  .strict();

const unifiedBrowserTabV4Schema = unifiedBrowserTabSchema.omit({
  taskId: true,
  lifecycle: true,
});
type UnifiedBrowserTabV4 = z.infer<typeof unifiedBrowserTabV4Schema>;

const registryV4StorageSchema = z
  .object({
    schemaVersion: z.literal(4),
    browser: z.literal("chrome"),
    tabGroup: z.literal("MCP"),
    updatedAt: z.string().datetime(),
    sessions: z.array(browserSessionSchema).max(100),
    tabs: z.array(unifiedBrowserTabV4Schema).max(500),
    bindings: z.array(browserTabBindingSchema).max(500),
  })
  .strict();

const registryV4Schema = registryV4StorageSchema.superRefine((data, context) => {
  assertUnique(data.sessions, (session) => session.sessionId, "sessionId", context);
  assertUnique(data.tabs, (tab) => tab.tabId, "tabId", context);
  assertUnique(data.bindings, (binding) => binding.tabId, "binding tabId", context);

  const sessions = new Map(data.sessions.map((session) => [session.sessionId, session]));
  const tabs = new Map(data.tabs.map((tab) => [tab.tabId, tab]));
  const bindings = new Map(data.bindings.map((binding) => [binding.tabId, binding]));

  for (const tab of data.tabs) {
    const session = sessions.get(tab.sessionId);
    const binding = bindings.get(tab.tabId);
    if (!session) {
      addConsistencyIssue(context, `Tab ${tab.tabId} references a missing session.`);
      continue;
    }
    if (!binding) {
      addConsistencyIssue(context, `Tab ${tab.tabId} is missing its remote binding.`);
      continue;
    }
    if (
      binding.sessionId !== tab.sessionId ||
      binding.remoteTabId !== tab.remoteTabId ||
      binding.remoteIndex !== tab.remoteIndex
    ) {
      addConsistencyIssue(context, `Tab ${tab.tabId} has an inconsistent remote binding.`);
    }
  }

  for (const binding of data.bindings) {
    if (!tabs.has(binding.tabId)) {
      addConsistencyIssue(context, `Binding ${binding.tabId} does not have a registered tab.`);
    }
  }
});

const registryV5StorageSchema = z
  .object({
    schemaVersion: z.literal(5),
    browser: z.literal("chrome"),
    tabGroup: z.literal("MCP"),
    updatedAt: z.string().datetime(),
    sessions: z.array(browserSessionSchema).max(100),
    tasks: z.array(legacyBrowserTaskSchema).max(500),
    tabs: z.array(unifiedBrowserTabSchema).max(500),
    bindings: z.array(browserTabBindingSchema).max(500),
  })
  .strict();

const registryV5Schema = registryV5StorageSchema.superRefine((data, context) => {
  assertUnique(data.sessions, (session) => session.sessionId, "sessionId", context);
  assertUnique(data.tasks, (task) => task.taskId, "taskId", context);
  assertUnique(data.tabs, (tab) => tab.tabId, "tabId", context);
  assertUnique(data.bindings, (binding) => binding.tabId, "binding tabId", context);

  const sessions = new Map(data.sessions.map((session) => [session.sessionId, session]));
  const tasks = new Map(data.tasks.map((task) => [task.taskId, task]));
  const tabs = new Map(data.tabs.map((tab) => [tab.tabId, tab]));
  const bindings = new Map(data.bindings.map((binding) => [binding.tabId, binding]));

  for (const tab of data.tabs) {
    const session = sessions.get(tab.sessionId);
    const task = tasks.get(tab.taskId);
    const binding = bindings.get(tab.tabId);
    if (!session) addConsistencyIssue(context, `Tab ${tab.tabId} references a missing session.`);
    if (!task) addConsistencyIssue(context, `Tab ${tab.tabId} references a missing task.`);
    else if (!task.tabIds.includes(tab.tabId)) {
      addConsistencyIssue(context, `Task ${task.taskId} does not reference tab ${tab.tabId}.`);
    }
    if (!binding) addConsistencyIssue(context, `Tab ${tab.tabId} is missing its remote binding.`);
    else if (
      binding.sessionId !== tab.sessionId ||
      binding.remoteTabId !== tab.remoteTabId ||
      binding.remoteIndex !== tab.remoteIndex
    ) {
      addConsistencyIssue(context, `Tab ${tab.tabId} has an inconsistent remote binding.`);
    }
  }

  for (const task of data.tasks) {
    assertUnique(task.tabIds, (tabId) => tabId, `tab id in task ${task.taskId}`, context);
    for (const tabId of task.tabIds) {
      const tab = tabs.get(tabId);
      if (!tab) addConsistencyIssue(context, `Task ${task.taskId} references missing tab ${tabId}.`);
      else if (tab.taskId !== task.taskId) {
        addConsistencyIssue(context, `Task ${task.taskId} crosses into tab ${tabId} owned by another task.`);
      }
    }
  }

  for (const binding of data.bindings) {
    if (!tabs.has(binding.tabId)) {
      addConsistencyIssue(context, `Binding ${binding.tabId} does not have a registered tab.`);
    }
  }
});

const registryV6StorageSchema = z
  .object({
    schemaVersion: z.literal(6),
    browser: z.literal("chrome"),
    tabGroup: z.literal("MCP"),
    updatedAt: z.string().datetime(),
    sessions: z.array(browserSessionSchema).max(100),
    tasks: z.array(browserTaskSchema).max(500),
    tabs: z.array(unifiedBrowserTabSchema).max(500),
    bindings: z.array(browserTabBindingSchema).max(500),
  })
  .strict();

const registryV6Schema = registryV6StorageSchema.superRefine((data, context) => {
  assertUnique(data.sessions, (session) => session.sessionId, "sessionId", context);
  assertUnique(data.tasks, (task) => task.taskId, "taskId", context);
  assertUnique(data.tabs, (tab) => tab.tabId, "tabId", context);
  assertUnique(data.bindings, (binding) => binding.tabId, "binding tabId", context);

  const sessions = new Map(data.sessions.map((session) => [session.sessionId, session]));
  const tasks = new Map(data.tasks.map((task) => [task.taskId, task]));
  const tabs = new Map(data.tabs.map((tab) => [tab.tabId, tab]));
  const bindings = new Map(data.bindings.map((binding) => [binding.tabId, binding]));

  for (const tab of data.tabs) {
    const session = sessions.get(tab.sessionId);
    const task = tasks.get(tab.taskId);
    const binding = bindings.get(tab.tabId);
    if (!session) addConsistencyIssue(context, `Tab ${tab.tabId} references a missing session.`);
    if (!task) addConsistencyIssue(context, `Tab ${tab.tabId} references a missing task.`);
    else if (!task.tabIds.includes(tab.tabId)) {
      addConsistencyIssue(context, `Task ${task.taskId} does not reference tab ${tab.tabId}.`);
    } else if (task.state === "finished" || task.state === "expired") {
      addConsistencyIssue(context, `Terminal task ${task.taskId} cannot retain tab ${tab.tabId}.`);
    }
    if (!binding) addConsistencyIssue(context, `Tab ${tab.tabId} is missing its remote binding.`);
    else if (
      binding.sessionId !== tab.sessionId ||
      binding.remoteTabId !== tab.remoteTabId ||
      binding.remoteIndex !== tab.remoteIndex
    ) {
      addConsistencyIssue(context, `Tab ${tab.tabId} has an inconsistent remote binding.`);
    }
  }

  for (const task of data.tasks) {
    assertUnique(task.tabIds, (tabId) => tabId, `tab id in task ${task.taskId}`, context);
    if ((task.state === "finished" || task.state === "expired") && task.tabIds.length > 0) {
      addConsistencyIssue(context, `Terminal task ${task.taskId} must not retain tabs.`);
    }
    for (const tabId of task.tabIds) {
      const tab = tabs.get(tabId);
      if (!tab) addConsistencyIssue(context, `Task ${task.taskId} references missing tab ${tabId}.`);
      else if (tab.taskId !== task.taskId) {
        addConsistencyIssue(context, `Task ${task.taskId} crosses into tab ${tabId} owned by another task.`);
      }
    }
  }

  for (const binding of data.bindings) {
    if (!tabs.has(binding.tabId)) {
      addConsistencyIssue(context, `Binding ${binding.tabId} does not have a registered tab.`);
    }
  }
});

export interface BrowserSessionRegistryData {
  schemaVersion: 6;
  browser: "chrome";
  tabGroup: "MCP";
  updatedAt: string;
  sessions: BrowserSession[];
  tasks: BrowserTask[];
  tabs: UnifiedBrowserTab[];
  bindings: BrowserTabBinding[];
}

export class BrowserSessionRegistry {
  readonly filePath: string;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(runtimeDirectory: string) {
    this.filePath = path.join(runtimeDirectory, "registry", "browser-session.json");
  }

  async load(): Promise<BrowserSessionRegistryData> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const json: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
      const v6 = registryV6StorageSchema.safeParse(json);
      if (v6.success) return recoverV6Registry(v6.data);
      const v5 = registryV5StorageSchema.safeParse(json);
      if (v5.success) return migrateV5Registry(v5.data);
      const v4 = registryV4StorageSchema.safeParse(json);
      if (v4.success) return migrateV4Registry(v4.data);
      const v3 = registryV3StorageSchema.safeParse(json);
      if (v3.success) return migrateV3Registry(v3.data);
      if (registryV2Schema.safeParse(json).success || registryV1Schema.safeParse(json).success) {
        return emptyRegistry();
      }
      return registryV6Schema.parse(json);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyRegistry();
    }
  }

  async save(
    sessions: readonly BrowserSession[],
    tabs: readonly UnifiedBrowserTab[],
    bindings: readonly BrowserTabBinding[],
    tasks: readonly BrowserTask[] = [],
  ): Promise<void> {
    if (tabs.length > 0 && tasks.length === 0) {
      throw new Error("Browser tasks are required when persisted tabs are present.");
    }
    const data = registryV6Schema.parse({
      schemaVersion: 6,
      browser: "chrome",
      tabGroup: "MCP",
      updatedAt: new Date().toISOString(),
      sessions,
      tasks,
      tabs,
      bindings,
    });
    const persist = async (): Promise<void> => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporaryPath, JSON.stringify(data, null, 2), {
          encoding: "utf8",
          flag: "wx",
        });
        await renameWithRetry(temporaryPath, this.filePath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    };
    const pending = this.saveTail.then(persist, persist);
    this.saveTail = pending.catch(() => undefined);
    return pending;
  }
}

const TRANSIENT_RENAME_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "ENOTEMPTY",
  "EPERM",
]);

async function renameWithRetry(
  source: string,
  destination: string,
  attempts = 6,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 10 * (attempt + 1)),
      );
    }
  }
}

function recoverV4Registry(
  data: z.infer<typeof registryV4StorageSchema>,
): z.infer<typeof registryV4StorageSchema> {
  const originalStates = new Map(
    data.sessions.map((session) => [session.sessionId, session.state]),
  );
  const sessions = deduplicateBy(
    [...data.sessions].sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt)),
    (session) => session.sessionId,
  ).map((session) => ({
    ...session,
    state: session.state === "starting" || session.state === "connected"
      ? "disconnected" as const
      : session.state,
  }));
  const sessionMap = new Map(sessions.map((session) => [session.sessionId, session]));
  const bindings = deduplicateBy(data.bindings, (binding) => binding.tabId);
  const bindingMap = new Map(bindings.map((binding) => [binding.tabId, binding]));
  const tabs = deduplicateBy(data.tabs, (tab) => tab.tabId).filter((tab) => {
    const session = sessionMap.get(tab.sessionId);
    const binding = bindingMap.get(tab.tabId);
    return Boolean(
      session &&
      binding &&
      binding.sessionId === tab.sessionId &&
      binding.remoteTabId === tab.remoteTabId &&
      binding.remoteIndex === tab.remoteIndex,
    );
  });
  const tabIds = new Set(tabs.map((tab) => tab.tabId));
  const tabSessionIds = new Set(tabs.map((tab) => tab.sessionId));
  const retainedSessions = sessions.filter((session) => {
    if (tabSessionIds.has(session.sessionId)) return true;
    const originalState = originalStates.get(session.sessionId);
    return originalState === "disconnected";
  });
  const retainedSessionIds = new Set(retainedSessions.map((session) => session.sessionId));
  return registryV4Schema.parse({
    schemaVersion: 4,
    browser: "chrome",
    tabGroup: "MCP",
    updatedAt: data.updatedAt,
    sessions: retainedSessions,
    tabs: tabs.filter((tab) => retainedSessionIds.has(tab.sessionId)),
    bindings: bindings.filter(
      (binding) => tabIds.has(binding.tabId) && retainedSessionIds.has(binding.sessionId),
    ),
  });
}

function recoverV6Registry(
  data: z.infer<typeof registryV6StorageSchema>,
): BrowserSessionRegistryData {
  const originalTabs = new Map(data.tabs.map((tab) => [tab.tabId, tab]));
  const recoveredV4 = recoverV4Registry({
    schemaVersion: 4,
    browser: data.browser,
    tabGroup: data.tabGroup,
    updatedAt: data.updatedAt,
    sessions: data.sessions,
    tabs: data.tabs.map(({ taskId: _taskId, lifecycle: _lifecycle, ...tab }) => tab),
    bindings: data.bindings,
  });
  const retainedTabIds = new Set(recoveredV4.tabs.map((tab) => tab.tabId));
  const tasks = deduplicateBy(data.tasks, (task) => task.taskId).map((task) => {
    const terminal = task.state === "finished" || task.state === "expired";
    return browserTaskSchema.parse({
      ...task,
      state: task.state === "active" || task.state === "finishing"
        ? "suspended"
        : task.state,
      tabIds: terminal
        ? []
        : task.tabIds.filter((tabId) => retainedTabIds.has(tabId)),
    });
  });
  const restorableTaskIds = new Set(
    tasks
      .filter((task) => task.state === "active" || task.state === "suspended")
      .map((task) => task.taskId),
  );
  const tabs = recoveredV4.tabs
    .map((tab) => {
      const original = originalTabs.get(tab.tabId);
      if (!original || !restorableTaskIds.has(original.taskId)) return undefined;
      return unifiedBrowserTabSchema.parse({
        ...tab,
        taskId: original.taskId,
        lifecycle: original.lifecycle,
      });
    })
    .filter((tab): tab is UnifiedBrowserTab => tab !== undefined);
  const finalTabIds = new Set(tabs.map((tab) => tab.tabId));
  return registryV6Schema.parse({
    schemaVersion: 6,
    browser: "chrome",
    tabGroup: "MCP",
    updatedAt: data.updatedAt,
    sessions: recoveredV4.sessions,
    tasks: tasks.map((task) => ({
      ...task,
      tabIds: task.tabIds.filter((tabId) => finalTabIds.has(tabId)),
    })),
    tabs,
    bindings: recoveredV4.bindings.filter((binding) => finalTabIds.has(binding.tabId)),
  });
}

function migrateV5Registry(
  data: z.infer<typeof registryV5StorageSchema>,
): BrowserSessionRegistryData {
  const recoveredV4 = recoverV4Registry({
    schemaVersion: 4,
    browser: data.browser,
    tabGroup: data.tabGroup,
    updatedAt: data.updatedAt,
    sessions: data.sessions,
    tabs: data.tabs.map(({ taskId: _taskId, lifecycle: _lifecycle, ...tab }) => tab),
    bindings: data.bindings,
  });
  const tasks = deduplicateBy(data.tasks, (task) => task.taskId).map((task) =>
    browserTaskSchema.parse({
      ...task,
      state: task.state === "finished" ? "finished" : "expired",
      tabIds: [],
      expiresAt: task.state === "finished" || task.state === "expired"
        ? task.expiresAt
        : task.lastActivityAt,
      lifecycleVersion: CURRENT_BROWSER_TASK_LIFECYCLE_VERSION,
    }),
  );
  return registryV6Schema.parse({
    schemaVersion: 6,
    browser: "chrome",
    tabGroup: "MCP",
    updatedAt: data.updatedAt,
    sessions: recoveredV4.sessions,
    tasks,
    tabs: [],
    bindings: [],
  });
}

function migrateV4Registry(
  data: z.infer<typeof registryV4StorageSchema>,
): BrowserSessionRegistryData {
  const recovered = recoverV4Registry(data);
  const now = Date.now();
  const tasks = recovered.sessions.map((session) => {
    const taskId = `task-${session.sessionId}`;
    const tabIds = recovered.tabs
      .filter((tab) => tab.sessionId === session.sessionId)
      .map((tab) => tab.tabId);
    return legacyBrowserTaskSchema.parse({
      taskId,
      ownerScopeHash: LEGACY_UNCLAIMED_OWNER_SCOPE_HASH,
      state: "suspended",
      tabIds,
      createdAt: session.createdAt,
      lastActivityAt: session.lastUsedAt,
      expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
      lifecycleVersion: LEGACY_BROWSER_TASK_LIFECYCLE_VERSION,
    });
  });
  const taskBySession = new Map(
    recovered.sessions.map((session) => [session.sessionId, `task-${session.sessionId}`]),
  );
  return migrateV5Registry(registryV5StorageSchema.parse({
    schemaVersion: 5,
    browser: "chrome",
    tabGroup: "MCP",
    updatedAt: recovered.updatedAt,
    sessions: recovered.sessions,
    tasks,
    tabs: recovered.tabs.map((tab) => ({
      ...tab,
      taskId: taskBySession.get(tab.sessionId)!,
      lifecycle: "task-scoped" as const,
    })),
    bindings: recovered.bindings,
  }));
}

function migrateV3Registry(
  data: z.infer<typeof registryV3StorageSchema>,
): BrowserSessionRegistryData {
  const sessions: BrowserSession[] = data.sessions
    .filter((session) => session.driver === "direct" && session.profileType === "persistent")
    .map((session) => browserSessionSchema.parse({
      sessionId: session.sessionId,
      driver: "direct",
      mode: session.mode,
      state: session.state,
      profileType: "persistent",
      ...(session.routingReason === undefined ? {} : { routingReason: session.routingReason }),
      ...(session.routingPolicyReason === undefined
        ? {}
        : { routingPolicyReason: session.routingPolicyReason }),
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
    }));
  const sessionIds = new Set(sessions.map((session) => session.sessionId));
  const tabs: UnifiedBrowserTabV4[] = data.tabs
    .filter((tab) => tab.driver === "direct" && sessionIds.has(tab.sessionId))
    .map((tab) => unifiedBrowserTabV4Schema.parse({ ...tab, driver: "direct" }));
  const tabIds = new Set(tabs.map((tab) => tab.tabId));
  const bindings: BrowserTabBinding[] = data.bindings
    .filter((binding) =>
      binding.driver === "direct" &&
      sessionIds.has(binding.sessionId) &&
      tabIds.has(binding.tabId),
    )
    .map((binding) => browserTabBindingSchema.parse({
      ...binding,
      driver: "direct",
    }));
  return migrateV4Registry(registryV4StorageSchema.parse({
    schemaVersion: 4,
    browser: "chrome",
    tabGroup: "MCP",
    updatedAt: data.updatedAt,
    sessions,
    tabs,
    bindings,
  }));
}

function emptyRegistry(): BrowserSessionRegistryData {
  return {
    schemaVersion: 6,
    browser: "chrome",
    tabGroup: "MCP",
    updatedAt: new Date(0).toISOString(),
    sessions: [],
    tasks: [],
    tabs: [],
    bindings: [],
  };
}

function assertUnique<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
  label: string,
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) {
      addConsistencyIssue(context, `Duplicate ${label}: ${key}.`);
    }
    seen.add(key);
  }
}

function addConsistencyIssue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: "custom", message });
}

function deduplicateBy<T>(
  values: readonly T[],
  keyOf: (value: T) => string,
): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = keyOf(value);
    if (!result.has(key)) result.set(key, value);
  }
  return [...result.values()];
}
