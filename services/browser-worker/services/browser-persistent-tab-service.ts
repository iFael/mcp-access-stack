import { AppError, type BrowserTab } from "@vs-code-gpt/shared";
import type { BrowserTabBinding } from "../domain/session-registry.js";
import { TabRegistry } from "../domain/tab-registry.js";
import type {
  BrowserDriver,
  BrowserDriverTab,
} from "../drivers/browser-driver.js";
import type { BrowserTabBindingService } from "./browser-tab-binding-service.js";
import type { BrowserTabSelectionService } from "./browser-tab-selection-service.js";

export interface BrowserPersistentTabServiceOptions {
  driver: Pick<
    BrowserDriver,
    "newTab" | "newTabWithAllowedOrigins" | "closeTab"
  >;
  tabsRegistry: TabRegistry;
  bindings: Map<string, BrowserTabBinding>;
  tabBindings: Pick<
    BrowserTabBindingService,
    "findRemoteTab" | "isActive" | "bind"
  >;
  primaryPrivateSite?: { url: string; siteId: string };
  normalizeUrl(value: string): string;
  resolveRestoreTarget?(tab: BrowserTab, targetUrl: string): {
    url: string;
    allowedOrigins?: string[];
    expiresAt?: string;
  };
  tabSelection: Pick<BrowserTabSelectionService, "reconcileBindings">;
}

export class BrowserPersistentTabService {
  constructor(private readonly options: BrowserPersistentTabServiceOptions) {}

  async restore(
    initialRemoteTabs: readonly BrowserDriverTab[],
  ): Promise<readonly BrowserDriverTab[]> {
    let remoteTabs = initialRemoteTabs;
    for (const tab of this.options.tabsRegistry.list()) {
      if (this.options.tabBindings.findRemoteTab(tab, remoteTabs)) continue;
      const requestedUrl = this.options.normalizeUrl(
        tab.lockedUrl ?? tab.requestedUrl ?? tab.url ?? "about:blank",
      );
      const restoreTarget = this.options.resolveRestoreTarget?.(
        tab,
        requestedUrl,
      ) ?? { url: requestedUrl };
      const targetUrl = this.options.normalizeUrl(restoreTarget.url);
      const claimedIndexes = new Set(
        [...this.options.bindings.values()]
          .filter((binding) => this.options.tabBindings.isActive(binding))
          .map((binding) => binding.remoteIndex),
      );
      const blankCandidate =
        targetUrl === "about:blank"
          ? remoteTabs.find(
              (remote) =>
                !remote.crashed &&
                !claimedIndexes.has(remote.index) &&
                this.options.normalizeUrl(remote.url) === "about:blank",
            )
          : undefined;
      if (blankCandidate) {
        this.options.tabBindings.bind(
          tab.tabId,
          blankCandidate,
          remoteTabs.length,
        );
        continue;
      }
      remoteTabs =
        restoreTarget.allowedOrigins &&
        this.options.driver.newTabWithAllowedOrigins
          ? await this.options.driver.newTabWithAllowedOrigins(
              targetUrl,
              restoreTarget.allowedOrigins,
              restoreTarget.expiresAt,
            )
          : await this.options.driver.newTab(targetUrl);
      this.options.tabBindings.bind(
        tab.tabId,
        requireCurrentTab(remoteTabs),
        remoteTabs.length,
      );
    }
    return remoteTabs;
  }

  adopt(remoteTabs: readonly BrowserDriverTab[]): BrowserTab | undefined {
    const current =
      remoteTabs.find(
        (tab) =>
          tab.current &&
          !tab.crashed &&
          this.options.normalizeUrl(tab.url) !== "about:blank",
      ) ??
      remoteTabs.find(
        (tab) =>
          !tab.crashed &&
          this.options.normalizeUrl(tab.url) !== "about:blank",
      ) ??
      remoteTabs.find((tab) => tab.current && !tab.crashed) ??
      remoteTabs.find((tab) => !tab.crashed);
    if (!current) return undefined;

    const url = this.options.normalizeUrl(current.url);
    const primaryPrivateSite = this.options.primaryPrivateSite;
    const isPrimaryPrivateSite = primaryPrivateSite?.url === url;
    const tab = this.options.tabsRegistry.registerMcp({
      purpose: isPrimaryPrivateSite ? primaryPrivateSite.siteId : "mcp-default",
      reusable: !isPrimaryPrivateSite,
      protected: isPrimaryPrivateSite,
      sticky: isPrimaryPrivateSite,
      url,
      requestedUrl: url,
      title: current.title,
      ...(isPrimaryPrivateSite ? { lockedUrl: primaryPrivateSite.url } : {}),
    });
    this.options.tabBindings.bind(tab.tabId, current, remoteTabs.length);
    return tab;
  }

  async closeUnclaimedBlankTabs(
    initialRemoteTabs: readonly BrowserDriverTab[],
  ): Promise<readonly BrowserDriverTab[]> {
    let remoteTabs = initialRemoteTabs;
    while (remoteTabs.length > 1) {
      const claimedIndexes = new Set<number>();
      for (const tab of this.options.tabsRegistry.list()) {
        const match = this.options.tabBindings.findRemoteTab(tab, remoteTabs);
        if (match) claimedIndexes.add(match.tab.index);
      }
      const blank = remoteTabs.find(
        (remote) =>
          !remote.crashed &&
          !claimedIndexes.has(remote.index) &&
          this.options.normalizeUrl(remote.url) === "about:blank",
      );
      if (!blank) break;
      remoteTabs = await this.options.driver.closeTab(blank.index);
      await this.options.tabSelection.reconcileBindings(false, remoteTabs);
    }
    return remoteTabs;
  }
}

function requireCurrentTab(
  tabs: readonly BrowserDriverTab[],
): BrowserDriverTab {
  const current = tabs.find((tab) => tab.current);
  if (!current) {
    throw new AppError(
      "TAB_NOT_FOUND",
      "Playwright did not report a current browser tab.",
    );
  }
  if (current.crashed) {
    throw new AppError(
      "TAB_NOT_FOUND",
      "The current browser tab has crashed.",
    );
  }
  return current;
}
