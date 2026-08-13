import { AppError, type BrowserTab } from "@vs-code-gpt/shared";
import type { BrowserDriverResponse } from "../drivers/browser-driver.js";
import type {
  BrowserNavigationTransition,
  BrowserTabBinding,
} from "../domain/session-registry.js";
import { TabRegistry } from "../domain/tab-registry.js";
import { BrowserTabBindingService } from "./browser-tab-binding-service.js";

const NAVIGATION_TRANSITION_WINDOW_MS = 20_000;

export interface BrowserNavigationStateServiceOptions {
  navigationTimeoutMs: number;
  tabsRegistry: TabRegistry;
  bindings: Map<string, BrowserTabBinding>;
  tabBindings: BrowserTabBindingService;
  normalizeUrl(value: string): string;
  now?: () => Date;
}

export class BrowserNavigationStateService {
  private readonly now: () => Date;

  constructor(private readonly options: BrowserNavigationStateServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  begin(
    tabId: string,
    operation: BrowserNavigationTransition["operation"],
    expectedUrl?: string,
  ): void {
    const binding = this.options.bindings.get(tabId);
    if (!binding || !this.options.tabBindings.isActive(binding)) {
      throw new AppError(
        "TAB_NOT_FOUND",
        "The MCP tab does not have a remote binding.",
      );
    }

    const startedAt = this.now();
    const expiresAt = new Date(
      startedAt.getTime() +
        Math.min(
          this.options.navigationTimeoutMs,
          NAVIGATION_TRANSITION_WINDOW_MS,
        ),
    );
    this.options.bindings.set(tabId, {
      ...binding,
      navigation: {
        operation,
        startedAt: startedAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        ...(expectedUrl === undefined
          ? {}
          : { expectedUrl: this.options.normalizeUrl(expectedUrl) }),
      },
    });
  }

  updateSelectedTab(
    tabId: string,
    response: BrowserDriverResponse,
    fallbackUrl?: string,
  ): BrowserTab {
    const currentTab = this.options.tabsRegistry.assertMcpOwned(tabId);
    const nextUrl = this.options.normalizeUrl(
      response.page.url || fallbackUrl || currentTab.url || "about:blank",
    );
    const nextTitle = response.page.title || currentTab.title || "";
    const updatedTab = this.options.tabsRegistry.touch(tabId, {
      url: nextUrl,
      title: nextTitle,
    });
    const binding = this.options.bindings.get(tabId);
    if (binding) {
      const navigation =
        nextUrl === binding.url
          ? this.options.tabBindings.activeNavigation(binding.navigation)
          : undefined;
      this.options.bindings.set(tabId, {
        ...binding,
        url: nextUrl,
        title: nextTitle,
        ...(navigation === undefined
          ? { navigation: undefined }
          : { navigation }),
      });
      this.options.tabBindings.syncUnifiedTab(tabId);
    }
    return updatedTab;
  }
}
