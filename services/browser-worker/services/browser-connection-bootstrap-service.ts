import { AppError } from "@vs-code-gpt/shared";
import { TabRegistry } from "../domain/tab-registry.js";
import type {
  BrowserDriver,
  BrowserDriverTab,
} from "../drivers/browser-driver.js";
import type { BrowserPersistentTabService } from "./browser-persistent-tab-service.js";
import type { BrowserTabBindingService } from "./browser-tab-binding-service.js";
import type { BrowserTabSelectionService } from "./browser-tab-selection-service.js";

export interface BrowserConnectionBootstrapServiceOptions {
  driver: Pick<BrowserDriver, "connect" | "listTabs" | "newTab">;
  adoptExistingTabs: boolean;
  defaultTaskId?(): string;
  tabsRegistry: TabRegistry;
  tabBindings: Pick<BrowserTabBindingService, "bind">;
  tabSelection: Pick<BrowserTabSelectionService, "reconcileBindings">;
  persistentTabs: Pick<
    BrowserPersistentTabService,
    "restore" | "adopt" | "closeUnclaimedBlankTabs"
  >;
}

export class BrowserConnectionBootstrapService {
  constructor(
    private readonly options: BrowserConnectionBootstrapServiceOptions,
  ) {}

  async connect(): Promise<void> {
    await this.options.driver.connect();
    let remoteTabs: readonly BrowserDriverTab[] =
      await this.options.driver.listTabs();

    await this.options.tabSelection.reconcileBindings(false, remoteTabs);
    remoteTabs = await this.options.persistentTabs.restore(remoteTabs);

    await this.options.tabSelection.reconcileBindings(true, remoteTabs);
    if (this.options.tabsRegistry.list().length === 0) {
      const adopted = this.options.adoptExistingTabs
        ? this.options.persistentTabs.adopt(remoteTabs)
        : undefined;
      if (!adopted) {
        remoteTabs = await this.options.driver.newTab("about:blank");
        const current = requireCurrentTab(remoteTabs);
        const tab = this.options.tabsRegistry.registerMcp({
          taskId: this.options.defaultTaskId?.() ?? "task-local",
          lifecycle: "task-scoped",
          purpose: "mcp-default",
          reusable: true,
          url: current.url,
          requestedUrl: "about:blank",
          title: current.title,
        });
        this.options.tabBindings.bind(
          tab.tabId,
          current,
          remoteTabs.length,
        );
      }
    }

    await this.options.tabSelection.reconcileBindings(true, remoteTabs);
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
