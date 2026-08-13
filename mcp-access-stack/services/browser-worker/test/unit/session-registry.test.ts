import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  createBrowserSession,
  toUnifiedBrowserTab,
} from "../../domain/browser-session-model.js";
import {
  BrowserSessionRegistry,
  type BrowserTabBinding,
} from "../../domain/session-registry.js";
import type { BrowserTab } from "@vs-code-gpt/shared";
import { hashOwnerScope } from "../../domain/browser-task-registry.js";

const directories: string[] = [];
const now = "2026-07-29T20:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("BrowserSessionRegistry", () => {
  it("rejects persisted tabs without an explicit owning task", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "browser-session-registry-"),
    );
    directories.push(directory);
    const registry = new BrowserSessionRegistry(directory);
    const fixture = registryFixture();

    await expect(registry.save(
      [fixture.session],
      [fixture.unifiedTab],
      [fixture.binding],
    )).rejects.toThrow("Browser tasks are required");
  });

  it("keeps concurrent atomic saves valid and removes every temporary file", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "browser-session-registry-"),
    );
    directories.push(directory);
    const registry = new BrowserSessionRegistry(directory);
    const fixture = registryFixture();

    await Promise.all(
      Array.from({ length: 24 }, () =>
        registry.save(
          [fixture.session],
          [fixture.unifiedTab],
          [fixture.binding],
          [fixture.task],
        ),
      ),
    );

    const loaded = await registry.load();
    expect(loaded.sessions).toHaveLength(1);
    expect(loaded.tabs).toHaveLength(1);
    expect(loaded.bindings).toHaveLength(1);
    expect(loaded.tabs[0]?.tabId).toBe(fixture.tab.tabId);

    const registryDirectory = path.dirname(registry.filePath);
    const files = await readdir(registryDirectory);
    expect(files).toEqual(["browser-session.json"]);
  });
});

function registryFixture() {
  const session = {
    ...createBrowserSession("direct", now),
    sessionId: "direct-session",
    state: "connected" as const,
  };
  const tab: BrowserTab = {
    tabId: "direct-tab",
    ownership: "mcp",
    purpose: "registry-test",
    reusable: true,
    protected: false,
    sticky: false,
    createdAt: now,
    lastUsedAt: now,
    url: "https://example.test/",
    title: "Registry test",
  };
  const binding: BrowserTabBinding = {
    tabId: tab.tabId,
    sessionId: session.sessionId,
    driver: "direct",
    remoteTabId: "direct:page:test-page",
    remoteIndex: 0,
    url: tab.url!,
    title: tab.title!,
    remoteTabCount: 1,
  };
  const unifiedTab = toUnifiedBrowserTab(
    tab,
    session,
    binding.remoteTabId,
    binding.remoteIndex,
  );
  const task = {
    taskId: unifiedTab.taskId,
    ownerScopeHash: hashOwnerScope("registry-test-owner"),
    state: "suspended" as const,
    tabIds: [unifiedTab.tabId],
    createdAt: now,
    lastActivityAt: now,
    expiresAt: "2026-07-29T20:10:00.000Z",
    lifecycleVersion: 2 as const,
  };
  return { session, tab, binding, unifiedTab, task };
}
