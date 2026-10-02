import { AppError, type BrowserExecutor } from "@vs-code-gpt/shared";

export interface PersonalBrowserConnectionInfo {
  connected: boolean;
  browser: "chrome";
  profile: "personal";
  protocolVersion: number;
  extensionVersion?: string;
  capabilities: string[];
}

export interface PersonalBrowserExecutor extends BrowserExecutor {
  isConnected(): boolean;
  connectionInfo(): PersonalBrowserConnectionInfo;
}

const PERSONAL_TAB_PREFIX = "personal:";

export class BrowserModeRouter implements BrowserExecutor {
  private readonly personalTabIds = new Set<string>();
  private readonly taskModes = new Map<string, "managed" | "personal">();

  constructor(
    private readonly managed: BrowserExecutor,
    private readonly personal?: PersonalBrowserExecutor,
  ) {}

  async status(
    ...args: Parameters<BrowserExecutor["status"]>
  ): ReturnType<BrowserExecutor["status"]> {
    const managed = await this.managed.status(...args);
    return {
      ...managed,
      ...(this.personal === undefined
        ? {}
        : { personal: this.personal.connectionInfo() }),
    };
  }

  async connect(
    ...args: Parameters<BrowserExecutor["connect"]>
  ): ReturnType<BrowserExecutor["connect"]> {
    const managed = await this.managed.connect(...args);
    return {
      ...managed,
      ...(this.personal === undefined
        ? {}
        : { personal: this.personal.connectionInfo() }),
    };
  }

  async tabs(
    ...args: Parameters<BrowserExecutor["tabs"]>
  ): ReturnType<BrowserExecutor["tabs"]> {
    const [input, context] = args;
    if (input.taskId) {
      const knownMode = this.taskModes.get(input.taskId);
      if (knownMode === "personal") return this.requirePersonal().tabs(input, context);
      if (knownMode === "managed") return this.managed.tabs(input, context);

      if (this.personal?.isConnected()) {
        const personal = await this.personal.tabs(input, context);
        if (personal.tabs.length > 0) {
          this.taskModes.set(input.taskId, "personal");
          for (const tab of personal.tabs) this.personalTabIds.add(tab.tabId);
          return personal;
        }
      }
      const managed = await this.managed.tabs(input, context);
      if (managed.tabs.length > 0) this.taskModes.set(input.taskId, "managed");
      return managed;
    }

    const managed = await this.managed.tabs(input, context);
    if (!this.personal?.isConnected()) return managed;
    const personal = await this.personal.tabs(input, context);
    for (const tab of managed.tabs) {
      if (tab.taskId) this.taskModes.set(tab.taskId, "managed");
    }
    for (const tab of personal.tabs) {
      if (tab.taskId) this.taskModes.set(tab.taskId, "personal");
      this.personalTabIds.add(tab.tabId);
    }
    return { tabs: [...managed.tabs, ...personal.tabs] };
  }

  async open(
    ...args: Parameters<BrowserExecutor["open"]>
  ): ReturnType<BrowserExecutor["open"]> {
    const [input, context] = args;
    const { browserMode = "managed", ...browserInput } = input;
    if (input.taskId) {
      const existingMode = this.taskModes.get(input.taskId);
      if (existingMode && existingMode !== browserMode) {
        throw new AppError(
          "BROWSER_OPERATION_MODE_UNSUPPORTED",
          `Browser task ${input.taskId} is already bound to ${existingMode} mode.`,
        );
      }
    }
    if (browserMode === "personal") {
      const personal = this.requirePersonal();
      const result = await personal.open(browserInput, context);
      this.personalTabIds.add(result.tab.tabId);
      if (input.taskId) this.taskModes.set(input.taskId, "personal");
      else if (result.tab.taskId) this.taskModes.set(result.tab.taskId, "personal");
      return result;
    }
    const result = await this.managed.open(browserInput, context);
    if (input.taskId) this.taskModes.set(input.taskId, "managed");
    else if (result.tab.taskId) this.taskModes.set(result.tab.taskId, "managed");
    return result;
  }

  openAuthorizedSite(
    ...args: Parameters<BrowserExecutor["openAuthorizedSite"]>
  ): ReturnType<BrowserExecutor["openAuthorizedSite"]> {
    return this.managed.openAuthorizedSite(...args);
  }

  navigate(...args: Parameters<BrowserExecutor["navigate"]>): ReturnType<BrowserExecutor["navigate"]> {
    return this.forTab(args[0].tabId).navigate(...args);
  }

  snapshot(...args: Parameters<BrowserExecutor["snapshot"]>): ReturnType<BrowserExecutor["snapshot"]> {
    return this.forTab(args[0].tabId).snapshot(...args);
  }

  click(...args: Parameters<BrowserExecutor["click"]>): ReturnType<BrowserExecutor["click"]> {
    return this.forTab(args[0].tabId).click(...args);
  }

  fill(...args: Parameters<BrowserExecutor["fill"]>): ReturnType<BrowserExecutor["fill"]> {
    return this.forTab(args[0].tabId).fill(...args);
  }

  press(...args: Parameters<BrowserExecutor["press"]>): ReturnType<BrowserExecutor["press"]> {
    return this.forTab(args[0].tabId).press(...args);
  }

  wait(...args: Parameters<BrowserExecutor["wait"]>): ReturnType<BrowserExecutor["wait"]> {
    return this.forTab(args[0].tabId).wait(...args);
  }

  extract(...args: Parameters<BrowserExecutor["extract"]>): ReturnType<BrowserExecutor["extract"]> {
    return this.forTab(args[0].tabId).extract(...args);
  }

  sequence(...args: Parameters<BrowserExecutor["sequence"]>): ReturnType<BrowserExecutor["sequence"]> {
    return this.forTab(args[0].tabId).sequence(...args);
  }

  frameExtract(
    ...args: Parameters<NonNullable<BrowserExecutor["frameExtract"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameExtract"]>> {
    const executor = this.forTab(args[0].tabId);
    if (!executor.frameExtract) throw unsupported("browser_frame_extract");
    return executor.frameExtract(...args);
  }

  frameClick(
    ...args: Parameters<NonNullable<BrowserExecutor["frameClick"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameClick"]>> {
    const executor = this.forTab(args[0].tabId);
    if (!executor.frameClick) throw unsupported("browser_frame_click");
    return executor.frameClick(...args);
  }

  frameFill(
    ...args: Parameters<NonNullable<BrowserExecutor["frameFill"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameFill"]>> {
    const executor = this.forTab(args[0].tabId);
    if (!executor.frameFill) throw unsupported("browser_frame_fill");
    return executor.frameFill(...args);
  }

  profilePage(
    ...args: Parameters<NonNullable<BrowserExecutor["profilePage"]>>
  ): ReturnType<NonNullable<BrowserExecutor["profilePage"]>> {
    const executor = this.forTab(args[0].tabId);
    if (!executor.profilePage) throw unsupported("browser_profile_page");
    return executor.profilePage(...args);
  }

  domIndex(
    ...args: Parameters<NonNullable<BrowserExecutor["domIndex"]>>
  ): ReturnType<NonNullable<BrowserExecutor["domIndex"]>> {
    const executor = this.forTab(args[0].tabId);
    if (!executor.domIndex) throw unsupported("browser_dom_index");
    return executor.domIndex(...args);
  }

  frameSequence(
    ...args: Parameters<NonNullable<BrowserExecutor["frameSequence"]>>
  ): ReturnType<NonNullable<BrowserExecutor["frameSequence"]>> {
    const executor = this.forTab(args[0].tabId);
    if (!executor.frameSequence) throw unsupported("browser_frame_sequence");
    return executor.frameSequence(...args);
  }

  navigatePath(
    ...args: Parameters<NonNullable<BrowserExecutor["navigatePath"]>>
  ): ReturnType<NonNullable<BrowserExecutor["navigatePath"]>> {
    const executor = this.forTab(args[0].tabId);
    if (!executor.navigatePath) throw unsupported("browser_navigate_path");
    return executor.navigatePath(...args);
  }

  screenshot(
    ...args: Parameters<BrowserExecutor["screenshot"]>
  ): ReturnType<BrowserExecutor["screenshot"]> {
    return this.forTab(args[0].tabId).screenshot(...args);
  }

  goBack(...args: Parameters<BrowserExecutor["goBack"]>): ReturnType<BrowserExecutor["goBack"]> {
    return this.forTab(args[0].tabId).goBack(...args);
  }

  goForward(
    ...args: Parameters<BrowserExecutor["goForward"]>
  ): ReturnType<BrowserExecutor["goForward"]> {
    return this.forTab(args[0].tabId).goForward(...args);
  }

  async closeTab(
    ...args: Parameters<BrowserExecutor["closeTab"]>
  ): ReturnType<BrowserExecutor["closeTab"]> {
    const personal = isPersonalTabId(args[0].tabId);
    const result = await this.forTab(args[0].tabId).closeTab(...args);
    if (personal) this.personalTabIds.delete(args[0].tabId);
    return result;
  }

  async finishTask(
    ...args: Parameters<BrowserExecutor["finishTask"]>
  ): ReturnType<BrowserExecutor["finishTask"]> {
    const [input] = args;
    if (input.taskId) {
      let mode = this.taskModes.get(input.taskId);
      if (!mode && this.personal?.isConnected()) {
        const personalTabs = await this.personal.tabs({ taskId: input.taskId }, args[1]);
        if (personalTabs.tabs.length > 0) mode = "personal";
      }
      if (mode === "personal") {
        const result = await this.requirePersonal().finishTask(...args);
        for (const tabId of result.closedTabIds ?? []) this.personalTabIds.delete(tabId);
        this.taskModes.delete(input.taskId);
        return result;
      }
      const result = await this.managed.finishTask(...args);
      this.taskModes.delete(input.taskId);
      return result;
    }

    const managedResult = await this.managed.finishTask(...args);
    if (!this.personal?.isConnected()) return managedResult;
    const personalResult = await this.personal.finishTask(...args);
    for (const tabId of personalResult.closedTabIds ?? []) this.personalTabIds.delete(tabId);
    this.taskModes.clear();
    return {
      completed: true,
      closedTabs: managedResult.closedTabs + personalResult.closedTabs,
      closedTabIds: [
        ...(managedResult.closedTabIds ?? []),
        ...(personalResult.closedTabIds ?? []),
      ],
      browserClosed: managedResult.browserClosed,
    };
  }

  download(...args: Parameters<BrowserExecutor["download"]>): ReturnType<BrowserExecutor["download"]> {
    return this.forTab(args[0].tabId).download(...args);
  }

  upload(...args: Parameters<BrowserExecutor["upload"]>): ReturnType<BrowserExecutor["upload"]> {
    return this.forTab(args[0].tabId).upload(...args);
  }

  console(...args: Parameters<BrowserExecutor["console"]>): ReturnType<BrowserExecutor["console"]> {
    return this.forTab(args[0].tabId).console(...args);
  }

  networkList(
    ...args: Parameters<BrowserExecutor["networkList"]>
  ): ReturnType<BrowserExecutor["networkList"]> {
    return this.forTab(args[0].tabId).networkList(...args);
  }

  networkInspect(
    ...args: Parameters<BrowserExecutor["networkInspect"]>
  ): ReturnType<BrowserExecutor["networkInspect"]> {
    return this.forTab(args[0].tabId).networkInspect(...args);
  }

  traceStart(
    ...args: Parameters<BrowserExecutor["traceStart"]>
  ): ReturnType<BrowserExecutor["traceStart"]> {
    return this.forTab(args[0].tabId).traceStart(...args);
  }

  traceStop(
    ...args: Parameters<BrowserExecutor["traceStop"]>
  ): ReturnType<BrowserExecutor["traceStop"]> {
    return this.forTab(args[0].tabId).traceStop(...args);
  }

  videoStart(
    ...args: Parameters<BrowserExecutor["videoStart"]>
  ): ReturnType<BrowserExecutor["videoStart"]> {
    return this.forTab(args[0].tabId).videoStart(...args);
  }

  videoStop(
    ...args: Parameters<BrowserExecutor["videoStop"]>
  ): ReturnType<BrowserExecutor["videoStop"]> {
    return this.forTab(args[0].tabId).videoStop(...args);
  }

  pdf(...args: Parameters<BrowserExecutor["pdf"]>): ReturnType<BrowserExecutor["pdf"]> {
    return this.forTab(args[0].tabId).pdf(...args);
  }

  diagnostics(
    ...args: Parameters<BrowserExecutor["diagnostics"]>
  ): ReturnType<BrowserExecutor["diagnostics"]> {
    return this.forTab(args[0].tabId).diagnostics(...args);
  }

  private forTab(tabId: string): BrowserExecutor {
    if (isPersonalTabId(tabId)) return this.requirePersonal();
    return this.managed;
  }

  private requirePersonal(): PersonalBrowserExecutor {
    if (!this.personal?.isConnected()) {
      throw new AppError(
        "BROWSER_CAPABILITY_UNSUPPORTED",
        "Personal browser mode requires the MCP V3 Chrome extension to be loaded and connected.",
      );
    }
    return this.personal;
  }
}

export function isPersonalTabId(tabId: string): boolean {
  return tabId.startsWith(PERSONAL_TAB_PREFIX);
}

function unsupported(operation: string): AppError {
  return new AppError(
    "BROWSER_CAPABILITY_UNSUPPORTED",
    `${operation} is not supported by the selected personal browser tab.`,
  );
}
