import { randomUUID } from "node:crypto";
import type { BrowserTab } from "@vs-code-gpt/shared";
import { z } from "zod";
import type { BrowserDriverKind, BrowserDriverTab } from "../drivers/browser-driver.js";
import {
  browserOperationModeSchema,
  type BrowserOperationMode,
} from "../policies/browser-operation-mode.js";

export const browserDriverKindSchema = z.literal("direct");
export const browserSessionModeSchema = browserOperationModeSchema;
export const browserSessionStateSchema = z.enum([
  "starting",
  "connected",
  "disconnected",
  "failed",
]);
export const browserProfileTypeSchema = z.literal("persistent");

export const browserSessionSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    driver: browserDriverKindSchema,
    mode: browserSessionModeSchema,
    state: browserSessionStateSchema,
    profileType: browserProfileTypeSchema,
    routingReason: z.string().min(1).max(200).optional(),
    routingPolicyReason: z.string().min(1).max(200).optional(),
    createdAt: z.string().datetime(),
    lastUsedAt: z.string().datetime(),
  })
  .strict();

export type BrowserSession = z.infer<typeof browserSessionSchema>;
export type BrowserSessionMode = BrowserOperationMode;
export type BrowserSessionState = z.infer<typeof browserSessionStateSchema>;
export type BrowserProfileType = z.infer<typeof browserProfileTypeSchema>;

export interface BrowserSessionRoutingMetadata {
  mode?: BrowserSessionMode;
  routingReason?: string;
  routingPolicyReason?: string;
}

export const unifiedBrowserTabSchema = z
  .object({
    tabId: z.string().min(1).max(128),
    taskId: z.string().min(1).max(128),
    lifecycle: z.enum(["task-scoped", "persistent", "external"]),
    sessionId: z.string().min(1).max(128),
    driver: browserDriverKindSchema,
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
    requestedUrl: z.url().optional(),
    title: z.string().max(500).optional(),
    lockedUrl: z.url().optional(),
  })
  .strict();

export type UnifiedBrowserTab = z.infer<typeof unifiedBrowserTabSchema>;

export function createBrowserSession(
  driver: BrowserDriverKind,
  now = new Date().toISOString(),
  routing: BrowserSessionRoutingMetadata = {},
): BrowserSession {
  return {
    sessionId: randomUUID(),
    driver,
    mode: routing.mode ?? "interactive",
    state: "disconnected",
    profileType: "persistent",
    ...(routing.routingReason === undefined
      ? {}
      : { routingReason: routing.routingReason }),
    ...(routing.routingPolicyReason === undefined
      ? {}
      : { routingPolicyReason: routing.routingPolicyReason }),
    createdAt: now,
    lastUsedAt: now,
  };
}

export function applyBrowserSessionRouting(
  session: BrowserSession,
  routing: BrowserSessionRoutingMetadata,
): BrowserSession {
  return {
    ...session,
    ...(routing.mode === undefined ? {} : { mode: routing.mode }),
    ...(routing.routingReason === undefined
      ? {}
      : { routingReason: routing.routingReason }),
    ...(routing.routingPolicyReason === undefined
      ? {}
      : { routingPolicyReason: routing.routingPolicyReason }),
  };
}

export function toPublicBrowserTab(tab: UnifiedBrowserTab): BrowserTab {
  return {
    tabId: tab.tabId,
    taskId: tab.taskId,
    lifecycle: tab.lifecycle,
    ownership: tab.ownership,
    purpose: tab.purpose,
    reusable: tab.reusable,
    protected: tab.protected,
    sticky: tab.sticky,
    createdAt: tab.createdAt,
    lastUsedAt: tab.lastUsedAt,
    ...(tab.url === undefined ? {} : { url: tab.url }),
    ...(tab.requestedUrl === undefined ? {} : { requestedUrl: tab.requestedUrl }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.lockedUrl === undefined ? {} : { lockedUrl: tab.lockedUrl }),
  };
}

export function toUnifiedBrowserTab(
  tab: BrowserTab,
  session: BrowserSession,
  remoteTabId: string,
  remoteIndex: number,
  taskId = tab.taskId ?? `task-${session.sessionId}`,
  lifecycle = tab.lifecycle ?? "task-scoped",
): UnifiedBrowserTab {
  if (tab.ownership !== "mcp") {
    throw new Error("Only MCP-owned tabs can be stored in the unified browser registry.");
  }
  return {
    tabId: tab.tabId,
    taskId,
    lifecycle,
    sessionId: session.sessionId,
    driver: "direct",
    remoteTabId,
    remoteIndex,
    ownership: "mcp",
    purpose: tab.purpose,
    reusable: tab.reusable,
    protected: tab.protected,
    sticky: tab.sticky,
    createdAt: tab.createdAt,
    lastUsedAt: tab.lastUsedAt,
    ...(tab.url === undefined ? {} : { url: tab.url }),
    ...(tab.requestedUrl === undefined ? {} : { requestedUrl: tab.requestedUrl }),
    ...(tab.title === undefined ? {} : { title: tab.title }),
    ...(tab.lockedUrl === undefined ? {} : { lockedUrl: tab.lockedUrl }),
  };
}

export function remoteTabIdFor(
  _driver: BrowserDriverKind,
  tab: BrowserDriverTab,
): string {
  if (!tab.id) {
    throw new Error("The direct browser engine requires a stable page id.");
  }
  return `direct:page:${tab.id}`;
}

export function touchBrowserSession(
  session: BrowserSession,
  state: BrowserSessionState = session.state,
  now = new Date().toISOString(),
): BrowserSession {
  return { ...session, state, lastUsedAt: now };
}
