import { AppError, type BrowserTab } from "@vs-code-gpt/shared";
import {
  remoteTabIdFor,
  toUnifiedBrowserTab,
  touchBrowserSession,
  type BrowserSession,
  type UnifiedBrowserTab,
} from "../domain/browser-session-model.js";
import type {
  BrowserNavigationTransition,
  BrowserTabBinding,
} from "../domain/session-registry.js";
import { TabRegistry } from "../domain/tab-registry.js";
import type {
  BrowserDriverKind,
  BrowserDriverTab,
} from "../drivers/browser-driver.js";

export interface RemoteTabMatch {
  tab: BrowserDriverTab;
  mode:
    | "exact"
    | "title-drift"
    | "sticky-origin-drift"
    | "signature-recovery"
    | "navigation-transition";
}

export interface BrowserTabBindingServiceOptions {
  driverKind: BrowserDriverKind;
  tabsRegistry: TabRegistry;
  bindings: Map<string, BrowserTabBinding>;
  unifiedTabs: Map<string, UnifiedBrowserTab>;
  getSession(): BrowserSession;
  setSession(session: BrowserSession): void;
  normalizeUrl(value: string): string;
}

export class BrowserTabBindingService {
  constructor(private readonly options: BrowserTabBindingServiceOptions) {}

  isActive(binding: BrowserTabBinding): boolean {
    const session = this.options.getSession();
    return (
      binding.sessionId === session.sessionId &&
      binding.driver === this.options.driverKind
    );
  }

  findRemoteTab(
    tab: BrowserTab,
    remoteTabs: readonly BrowserDriverTab[],
  ): RemoteTabMatch | undefined {
    const binding = this.options.bindings.get(tab.tabId);
    if (!binding || !this.isActive(binding)) return undefined;

    const session = this.options.getSession();
    const unified = this.options.unifiedTabs.get(tab.tabId);
    if (
      !unified ||
      unified.sessionId !== session.sessionId ||
      unified.driver !== this.options.driverKind ||
      unified.remoteTabId !== binding.remoteTabId
    ) {
      return undefined;
    }

    const indexed = remoteTabs.find((remote) => remote.index === binding.remoteIndex);
    if (indexed && !indexed.crashed) {
      const remoteUrl = this.options.normalizeUrl(indexed.url);
      if (remoteUrl === binding.url && indexed.title === binding.title) {
        return { tab: indexed, mode: "exact" };
      }
      if (remoteUrl === binding.url) {
        return { tab: indexed, mode: "title-drift" };
      }
      if (matchesStickyLockedOrigin(tab, binding.url, remoteUrl)) {
        return { tab: indexed, mode: "sticky-origin-drift" };
      }
    }

    const claimedIndexes = new Set(
      [...this.options.bindings.values()]
        .filter((candidate) =>
          candidate.tabId !== tab.tabId && this.isActive(candidate),
        )
        .map((candidate) => candidate.remoteIndex),
    );
    const signatureMatches = remoteTabs.filter((remote) =>
      !remote.crashed &&
      !claimedIndexes.has(remote.index) &&
      this.options.normalizeUrl(remote.url) === binding.url &&
      remote.title === binding.title,
    );
    if (signatureMatches.length === 1) {
      return { tab: signatureMatches[0]!, mode: "signature-recovery" };
    }

    const navigation = this.activeNavigation(binding.navigation);
    if (!navigation || !indexed || indexed.crashed || !indexed.current) {
      return undefined;
    }
    if (
      binding.remoteTabCount !== undefined &&
      binding.remoteTabCount !== remoteTabs.length
    ) {
      return undefined;
    }
    const remoteUrl = this.options.normalizeUrl(indexed.url);
    if (
      navigation.expectedUrl &&
      !matchesExpectedNavigation(
        navigation.expectedUrl,
        remoteUrl,
        this.options.normalizeUrl,
      )
    ) {
      return undefined;
    }
    return { tab: indexed, mode: "navigation-transition" };
  }

  sameRemoteIdentity(
    match: RemoteTabMatch,
    selected: BrowserDriverTab,
    binding: BrowserTabBinding,
    selectedTabCount: number,
  ): boolean {
    if (match.tab.index !== selected.index || !selected.current) return false;
    if (match.mode !== "navigation-transition") {
      return (
        this.options.normalizeUrl(match.tab.url) ===
        this.options.normalizeUrl(selected.url)
      );
    }
    if (
      binding.remoteTabCount !== undefined &&
      binding.remoteTabCount !== selectedTabCount
    ) {
      return false;
    }
    const navigation = this.activeNavigation(binding.navigation);
    if (!navigation) return false;
    return (
      navigation.expectedUrl === undefined ||
      matchesExpectedNavigation(
        navigation.expectedUrl,
        this.options.normalizeUrl(selected.url),
        this.options.normalizeUrl,
      )
    );
  }

  bind(
    tabId: string,
    remote: BrowserDriverTab,
    remoteTabCount?: number,
    options: { clearNavigation?: boolean } = {},
  ): void {
    const previous = this.options.bindings.get(tabId);
    if (previous && !this.isActive(previous)) {
      throw new AppError(
        "TAB_NOT_OWNED",
        "The tab belongs to another browser session.",
      );
    }

    const session = this.options.getSession();
    const navigation = options.clearNavigation
      ? undefined
      : this.activeNavigation(previous?.navigation);
    const tabCount = remoteTabCount ?? previous?.remoteTabCount;
    const remoteTabId = remoteTabIdFor(this.options.driverKind, remote);
    const normalizedUrl = this.options.normalizeUrl(remote.url);

    this.options.bindings.set(tabId, {
      tabId,
      sessionId: session.sessionId,
      driver: this.options.driverKind,
      remoteTabId,
      remoteIndex: remote.index,
      url: normalizedUrl,
      title: remote.title,
      ...(tabCount === undefined ? {} : { remoteTabCount: tabCount }),
      ...(navigation === undefined ? {} : { navigation }),
    });

    const updated = this.options.tabsRegistry.touch(tabId, {
      url: normalizedUrl,
      title: remote.title,
    });
    this.options.unifiedTabs.set(
      tabId,
      toUnifiedBrowserTab(updated, session, remoteTabId, remote.index),
    );
    this.options.setSession(touchBrowserSession(session));
  }

  syncUnifiedTab(tabId: string): void {
    const binding = this.options.bindings.get(tabId);
    if (!binding || !this.isActive(binding)) {
      throw new AppError(
        "TAB_NOT_OWNED",
        "The tab does not belong to the active browser session.",
      );
    }
    const tab = this.options.tabsRegistry.assertMcpOwned(tabId);
    this.options.unifiedTabs.set(
      tabId,
      toUnifiedBrowserTab(
        tab,
        this.options.getSession(),
        binding.remoteTabId,
        binding.remoteIndex,
      ),
    );
  }

  activeNavigation(
    navigation: BrowserNavigationTransition | undefined,
  ): BrowserNavigationTransition | undefined {
    if (!navigation) return undefined;
    const expiresAt = Date.parse(navigation.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > Date.now()
      ? navigation
      : undefined;
  }
}

function matchesStickyLockedOrigin(
  tab: BrowserTab,
  bindingUrl: string,
  remoteUrl: string,
): boolean {
  if (!tab.sticky || !tab.lockedUrl) return false;
  try {
    const locked = new URL(tab.lockedUrl);
    const binding = new URL(bindingUrl);
    const remote = new URL(remoteUrl);
    return binding.origin === locked.origin && remote.origin === locked.origin;
  } catch {
    return false;
  }
}

function matchesExpectedNavigation(
  expectedUrl: string,
  actualUrl: string,
  normalizeUrl: (value: string) => string,
): boolean {
  if (normalizeUrl(expectedUrl) === normalizeUrl(actualUrl)) return true;
  try {
    return new URL(expectedUrl).origin === new URL(actualUrl).origin;
  } catch {
    return false;
  }
}
