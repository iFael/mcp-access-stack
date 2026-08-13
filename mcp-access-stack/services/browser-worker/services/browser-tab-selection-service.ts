import { AppError, type BrowserTab } from "@vs-code-gpt/shared";
import type { BrowserTabBinding } from "../domain/session-registry.js";
import { TabRegistry } from "../domain/tab-registry.js";
import type {
  BrowserDriver,
  BrowserDriverTab,
} from "../drivers/browser-driver.js";
import { BrowserTabBindingService } from "./browser-tab-binding-service.js";

type BrowserTabSelectionDriver = Pick<
  BrowserDriver,
  "listTabs" | "selectTab" | "selectTabByRemoteId"
>;

export interface BrowserTabSelectionServiceOptions {
  driver: BrowserTabSelectionDriver;
  tabsRegistry: TabRegistry;
  bindings: Map<string, BrowserTabBinding>;
  tabBindings: BrowserTabBindingService;
  ensureConnection(): Promise<void>;
  checkpoint(): Promise<void>;
  discardOrphan(tabId: string): void;
}

export class BrowserTabSelectionService {
  constructor(private readonly options: BrowserTabSelectionServiceOptions) {}

  async reconcileBindings(
    pruneOrphans = false,
    knownRemoteTabs?: readonly BrowserDriverTab[],
  ): Promise<readonly BrowserDriverTab[]> {
    const remoteTabs =
      knownRemoteTabs ?? (await this.options.driver.listTabs());

    for (const tab of this.options.tabsRegistry.list()) {
      const match = this.options.tabBindings.findRemoteTab(tab, remoteTabs);
      if (match) {
        this.options.tabBindings.bind(
          tab.tabId,
          match.tab,
          remoteTabs.length,
          { clearNavigation: match.mode === "navigation-transition" },
        );
      } else if (pruneOrphans) {
        this.options.discardOrphan(tab.tabId);
      }
    }

    return remoteTabs;
  }

  async selectTab(
    tab: BrowserTab,
    knownRemoteTabs?: readonly BrowserDriverTab[],
  ): Promise<BrowserDriverTab> {
    await this.options.ensureConnection();

    const binding = this.options.bindings.get(tab.tabId);
    if (!binding || !this.options.tabBindings.isActive(binding)) {
      throw new AppError(
        "TAB_NOT_FOUND",
        "The MCP tab does not have an active browser binding.",
      );
    }

    if (
      knownRemoteTabs === undefined &&
      this.options.driver.selectTabByRemoteId
    ) {
      try {
        const selected = await this.options.driver.selectTabByRemoteId(
          binding.remoteTabId,
        );
        this.options.tabBindings.bind(
          tab.tabId,
          selected.tab,
          selected.tabCount,
        );
        if (selected.tab.index !== binding.remoteIndex) {
          await this.options.checkpoint();
        }
        return selected.tab;
      } catch (error) {
        if (
          error instanceof AppError &&
          !["TAB_NOT_FOUND", "BROWSER_DISCONNECTED"].includes(error.code)
        ) {
          throw error;
        }
        // A restart can invalidate in-memory page ids. Reconcile by signature.
      }
    }

    if (knownRemoteTabs === undefined) {
      try {
        const selectedTabs = await this.options.driver.selectTab(
          binding.remoteIndex,
        );
        const directMatch = this.options.tabBindings.findRemoteTab(
          tab,
          selectedTabs,
        );
        const selected = selectedTabs.find(
          (remote) => remote.current && !remote.crashed,
        );

        if (
          directMatch &&
          selected &&
          directMatch.tab.index === selected.index &&
          this.options.tabBindings.sameRemoteIdentity(
            directMatch,
            selected,
            binding,
            selectedTabs.length,
          )
        ) {
          this.options.tabBindings.bind(
            tab.tabId,
            selected,
            selectedTabs.length,
            {
              clearNavigation:
                directMatch.mode === "navigation-transition",
            },
          );
          if (
            directMatch.mode !== "exact" ||
            selected.index !== binding.remoteIndex
          ) {
            await this.options.checkpoint();
          }
          return selected;
        }
      } catch {
        // Fall through to full reconciliation before any page action executes.
      }
    }

    const remoteTabs =
      knownRemoteTabs ?? (await this.options.driver.listTabs());
    const match = this.options.tabBindings.findRemoteTab(tab, remoteTabs);
    if (!match) {
      throw new AppError(
        "TAB_NOT_FOUND",
        "The MCP tab could not be identified safely. A personal tab will not be selected as a fallback.",
      );
    }

    const selectedTabs = match.tab.current
      ? remoteTabs
      : await this.options.driver.selectTab(match.tab.index);
    const selected = requireCurrentTab(selectedTabs);
    const currentBinding = this.options.bindings.get(tab.tabId);

    if (
      !currentBinding ||
      !this.options.tabBindings.isActive(currentBinding) ||
      !this.options.tabBindings.sameRemoteIdentity(
        match,
        selected,
        currentBinding,
        selectedTabs.length,
      )
    ) {
      throw new AppError(
        "TAB_NOT_OWNED",
        "The selected browser tab no longer matches the MCP registry.",
      );
    }

    this.options.tabBindings.bind(
      tab.tabId,
      selected,
      selectedTabs.length,
      { clearNavigation: match.mode === "navigation-transition" },
    );
    if (
      match.mode !== "exact" ||
      selected.index !== currentBinding.remoteIndex
    ) {
      await this.options.checkpoint();
    }
    return selected;
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
