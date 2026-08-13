import type {
  BrowserClickRequest,
  BrowserDriver,
  BrowserDriverCallOptions,
  BrowserDriverResponse,
  BrowserDriverTab,
  BrowserEvaluateRequest,
  BrowserFillRequest,
  BrowserNavigateRequest,
  BrowserPressRequest,
  BrowserScreenshotRequest,
  BrowserWaitRequest,
} from "../../drivers/browser-driver.js";

export interface FakeDirectDriverCall {
  name: string;
  input: unknown;
}

export class FakeDirectDriver implements BrowserDriver {
  readonly kind = "direct" as const;
  readonly calls: FakeDirectDriverCall[] = [];
  protected connected = true;
  protected tabs: BrowserDriverTab[] = [{
    id: "page-1",
    index: 0,
    current: true,
    title: "Fake page",
    url: "about:blank",
    crashed: false,
  }];

  isConnected(): boolean {
    return this.connected;
  }

  hasUsablePage(): boolean {
    return this.tabs.some((tab) => !tab.crashed);
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  navigate(
    input: BrowserNavigateRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    const current = this.currentTab();
    current.url = new URL(input.url).href;
    current.title = "Navigated";
    return this.record("navigate", input);
  }

  goBack(_options?: BrowserDriverCallOptions): Promise<BrowserDriverResponse> {
    return this.record("goBack", undefined);
  }

  goForward(_options?: BrowserDriverCallOptions): Promise<BrowserDriverResponse> {
    return this.record("goForward", undefined);
  }

  snapshot(_options?: BrowserDriverCallOptions): Promise<BrowserDriverResponse> {
    return this.record("snapshot", undefined, { snapshot: "" });
  }

  click(
    input: BrowserClickRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    return this.record("click", input);
  }

  fill(
    input: BrowserFillRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    return this.record("fill", input);
  }

  press(
    input: BrowserPressRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    return this.record("press", input);
  }

  wait(
    input: BrowserWaitRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    return this.record("wait", input);
  }

  evaluate(
    input: BrowserEvaluateRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    return this.record("evaluate", input);
  }

  takeScreenshot(
    input: BrowserScreenshotRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    return this.record("takeScreenshot", input);
  }

  async listTabs(): Promise<BrowserDriverTab[]> {
    return structuredClone(this.tabs);
  }

  async newTab(url = "about:blank"): Promise<BrowserDriverTab[]> {
    for (const tab of this.tabs) tab.current = false;
    this.tabs.push({
      id: `page-${this.tabs.length + 1}`,
      index: this.tabs.length,
      current: true,
      title: "",
      url: new URL(url).href,
      crashed: false,
    });
    return structuredClone(this.tabs);
  }

  async selectTab(index: number): Promise<BrowserDriverTab[]> {
    for (const tab of this.tabs) tab.current = tab.index === index;
    return structuredClone(this.tabs);
  }

  async closeTab(index: number): Promise<BrowserDriverTab[]> {
    this.tabs = this.tabs.filter((tab) => tab.index !== index);
    this.tabs.forEach((tab, currentIndex) => {
      tab.index = currentIndex;
      tab.current = currentIndex === 0;
    });
    return structuredClone(this.tabs);
  }

  async selectTabByRemoteId(
    remoteTabId: string,
  ): Promise<{ tab: BrowserDriverTab; tabCount: number }> {
    const id = remoteTabId.includes(":page:")
      ? remoteTabId.slice(remoteTabId.indexOf(":page:") + 6)
      : remoteTabId;
    const selected = this.tabs.find((tab) => tab.id === id);
    if (!selected) throw new Error(`Unknown page id: ${id}`);
    for (const tab of this.tabs) tab.current = tab === selected;
    return { tab: structuredClone(selected), tabCount: this.tabs.length };
  }

  uploadFiles(paths: readonly string[]): Promise<BrowserDriverResponse> {
    return this.record("uploadFiles", [...paths]);
  }

  protected currentTab(): BrowserDriverTab {
    const current = this.tabs.find((tab) => tab.current);
    if (!current) throw new Error("Expected a current fake page.");
    return current;
  }

  protected response(overrides: Partial<BrowserDriverResponse> = {}): BrowserDriverResponse {
    const current = this.currentTab();
    return {
      page: {
        ...(current.id === undefined ? {} : { id: current.id }),
        url: current.url,
        title: current.title,
      },
      ...overrides,
    };
  }

  protected async record(
    name: string,
    input: unknown,
    overrides: Partial<BrowserDriverResponse> = {},
  ): Promise<BrowserDriverResponse> {
    this.calls.push({ name, input });
    return this.response(overrides);
  }
}
