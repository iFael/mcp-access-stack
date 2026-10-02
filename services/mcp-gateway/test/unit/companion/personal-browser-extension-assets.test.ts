import vm from "node:vm";
import { describe, expect, it } from "@jest/globals";
import { buildPersonalBrowserExtensionAssets } from "../../../src/companion/personal-browser-extension-assets.js";

type FakeElement = ReturnType<typeof fakeElement>;

describe("personal browser extension assets", () => {
  it("returns isolated bounded timing on concurrent and sequential requests without putting page data in telemetry", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const sent: Array<Record<string, unknown>> = [];
    let clock = 0;
    const context = vm.createContext({ URL, AbortController, TextEncoder, performance: { now: () => clock },
      setTimeout, clearTimeout, setInterval: () => 0,
      WebSocket: class { static OPEN = 1; static CONNECTING = 0; readyState = 1; send(raw: string) { sent.push(JSON.parse(raw) as Record<string, unknown>); } },
      chrome: { tabs: { onRemoved: { addListener() {} } }, runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} } } },
      collect: (m: Record<string, unknown>) => sent.push(m), tick: () => { clock += 10; } });
    vm.runInContext(serviceWorker, context);
    vm.runInContext('perform = async (operation, input) => { tick(); await Promise.resolve(); return { tabId: input.tabId, completed: true, content: "secret-page" }; };', context);
    const handle = vm.runInContext("handleMessage", context) as (raw: string) => Promise<void>;
    const make = (id: string, tabId: string) => JSON.stringify({ type: "request", id, operation: "fill", input: { tabId, value: "secret-fill" }, measureTiming: true });
    await Promise.all([handle(make("one", "personal:1")), handle(make("two", "personal:2"))]);
    await handle(make("three", "personal:1"));
    expect(sent.map(m => m.id)).toEqual(["one", "two", "three"]);
    const times = sent.map(m => m.timing as Record<string, number>);
    for (const t of times) {
      expect(t).toBeDefined();
      expect(t.totalMs).toBeGreaterThanOrEqual(t.queueMs! + t.actionMs! + t.snapshotMs! + t.serializationMs!);
      expect(t.queueMs).toBeGreaterThanOrEqual(0);
      expect(JSON.stringify(t)).not.toMatch(/secret|personal|value|content/);
      expect(JSON.stringify(t).length).toBeLessThan(256);
    }
    expect(times[2]?.actionMs).toBe(10);
    expect(times[2]?.snapshotMs).toBe(0);
    expect(vm.runInContext("inFlightRequests.size", context)).toBe(0);
  });

  it("measures final snapshot separately from action in the actual sequence", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    let clock = 0;
    const context = vm.createContext({ performance: { now: () => clock },
      throwIfAborted() {}, fill: async () => { clock += 4; return { completed: true }; },
      snapshot: async () => { clock += 7; return { content: "secret-dom", refs: [] }; } });
    vm.runInContext(extractFunction(serviceWorker, "sequence"), context);
    const sequence = vm.runInContext("sequence", context) as (input: unknown, signal: unknown, timing: Record<string, number>) => Promise<unknown>;
    const timing = { snapshotMs: 0 };
    await sequence({ tabId: "personal:1", steps: [{ action: "fill", value: "secret-fill" }], finalSnapshot: true }, undefined, timing);
    expect(timing.snapshotMs).toBe(7);
  });

  it("announces a versioned capability handshake and blocks private navigation targets", () => {
    const { manifest, serviceWorker } = buildPersonalBrowserExtensionAssets(
      "x".repeat(43),
      3361,
      ["https://private.example.test"],
    );
    const parsedManifest = JSON.parse(manifest) as { version: string; permissions: string[] };
    expect(parsedManifest.version).toBe("0.3.0");
    expect(parsedManifest.permissions).toEqual(expect.arrayContaining(["debugger", "tabGroups"]));
    expect(serviceWorker).toContain("protocolVersion: PROTOCOL_VERSION");
    expect(serviceWorker).toContain("capabilities: CAPABILITIES");
    expect(serviceWorker).toContain('"screenshot"');
    expect(serviceWorker).toContain('"tabGroups"');
    expect(serviceWorker).toContain('chrome.tabs.group({ tabIds: chromeTabId');
    expect(serviceWorker).toContain('chrome.tabs.ungroup(groupedTabIds)');
    expect(serviceWorker).toContain('await requireOwnedMetadata(chromeTabId);');
    expect(serviceWorker).toContain('chrome.debugger.attach(target, "1.3")');
    expect(serviceWorker).toContain('"Page.captureScreenshot"');
    expect(serviceWorker).toContain('chrome.debugger.detach(target)');
    expect(serviceWorker).toContain('input.keepOpen === true');
    expect(serviceWorker).toContain('throw coded("TAB_PROTECTED"');

    const context = vm.createContext({ URL, Set, String, Number, Error });
    vm.runInContext(
      [
        'const BLOCKED_PRIVATE_ORIGINS = new Set(["https://private.example.test"]);',
        extractFunction(serviceWorker, "coded"),
        extractFunction(serviceWorker, "isPrivateIpv4"),
        extractFunction(serviceWorker, "isPrivateHost"),
        extractFunction(serviceWorker, "assertPersonalNavigationTarget"),
      ].join("\n"),
      context,
    );
    const assertTarget = vm.runInContext(
      "assertPersonalNavigationTarget",
      context,
    ) as (url: string) => string;

    expect(assertTarget("https://example.com/path")).toBe(
      "https://example.com/path",
    );
    for (const blocked of [
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://192.168.1.10/",
      "https://private.example.test/app",
      "file:///tmp/test",
    ]) {
      try {
        assertTarget(blocked);
        throw new Error(`Expected navigation to be blocked: ${blocked}`);
      } catch (error) {
        expect((error as { code?: string }).code).toBe("NAVIGATION_BLOCKED");
      }
    }
  });

  it("keeps private ownership metadata out of public tab responses", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const context = vm.createContext({ String });
    const toBrowserTab = vm.runInContext(
      `(${extractFunction(serviceWorker, "toBrowserTab")})`,
      context,
    ) as (metadata: Record<string, unknown>, tab: Record<string, unknown>) => Record<string, unknown>;

    const result = toBrowserTab(
      {
        tabId: "personal:41",
        sticky: true,
        protected: true,
        mcpGroupId: 17,
        lockedUrl: "https://example.com/locked",
      },
      { url: "https://example.com/current", title: "Current" },
    );

    expect(result).toMatchObject({
      tabId: "personal:41",
      sticky: true,
      protected: true,
      url: "https://example.com/current",
      title: "Current",
    });
    expect(result).not.toHaveProperty("mcpGroupId");
    expect(result).not.toHaveProperty("lockedUrl");
  });

  it("never exposes a password input value as an accessible name", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const password = fakeElement({
      tagName: "INPUT",
      attributes: {
        type: "password",
      },
      labels: [{ innerText: "Password", textContent: "Password" }],
      value: "fictional-super-secret",
    });
    const dom = createDom([password]);
    const snapshotPage = vm.runInContext(
      `(${extractFunction(serviceWorker, "snapshotPage")})`,
      dom.context,
    ) as (generation: string) => {
      content: string;
      refs: Array<{ ref: string; role: string; name: string }>;
    };

    const result = snapshotPage("generation1");

    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]).toMatchObject({
      role: "textbox",
      name: "Password",
    });
    expect(JSON.stringify(result)).not.toContain("fictional-super-secret");
  });

  it("emits richer safe DOM semantics without exposing input values", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const checkbox = fakeElement({
      tagName: "INPUT",
      attributes: { type: "checkbox", "aria-label": "Remember me" },
      checked: true,
      required: true,
      value: "must-not-leak",
    });
    const dom = createDom([checkbox]);
    const snapshotPage = vm.runInContext(
      `(${extractFunction(serviceWorker, "snapshotPage")})`,
      dom.context,
    ) as (generation: string) => {
      content: string;
      refs: Array<{ ref: string; role: string; name: string }>;
    };

    const result = snapshotPage("generation-semantic");

    expect(result.refs[0]).toMatchObject({ role: "checkbox", name: "Remember me" });
    expect(result.content).toContain('checkbox "Remember me" [required] [checked] [ref=p-generation-semantic-1]');
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("invalidates refs from an older snapshot generation", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const snapshotPageSource = extractFunction(serviceWorker, "snapshotPage");
    const clickRefSource = extractFunction(serviceWorker, "clickRef");

    const first = fakeElement({ tagName: "BUTTON", text: "First" });
    const second = fakeElement({ tagName: "BUTTON", text: "Second" });
    const dom = createDom([first, second]);
    const snapshotPage = vm.runInContext(
      `(${snapshotPageSource})`,
      dom.context,
    ) as (generation: string) => {
      refs: Array<{ ref: string; role: string; name: string }>;
    };
    const clickRef = vm.runInContext(
      `(${clickRefSource})`,
      dom.context,
    ) as (ref: string) => boolean;

    const firstSnapshot = snapshotPage("generation1");
    const staleRef = firstSnapshot.refs[0]!.ref;

    dom.setInteractiveElements([second]);
    const secondSnapshot = snapshotPage("generation2");
    const currentRef = secondSnapshot.refs[0]!.ref;

    expect(staleRef).not.toBe(currentRef);
    expect(clickRef(staleRef)).toBe(false);
    expect(first.clickCount).toBe(0);
    expect(clickRef(currentRef)).toBe(true);
    expect(second.clickCount).toBe(1);
  });

  it("groups only explicit MCP-created tab ids for the same task", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const groupCalls: Array<Record<string, unknown>> = [];
    const updates: Array<{ groupId: number; value: Record<string, unknown> }> = [];
    const context = vm.createContext({
      Map,
      Number,
      chrome: {
        tabs: {
          group: async (input: Record<string, unknown>) => {
            groupCalls.push(input);
            return typeof input.groupId === "number" ? input.groupId : 17;
          },
        },
        tabGroups: {
          update: async (groupId: number, value: Record<string, unknown>) => {
            updates.push({ groupId, value });
          },
        },
      },
    });
    vm.runInContext("const taskGroups = new Map();", context);
    const assignMcpTaskGroup = vm.runInContext(
      `(${extractFunction(serviceWorker, "assignMcpTaskGroup")})`,
      context,
    ) as (tabId: number, taskId: string, owned: Record<string, unknown>) => Promise<number>;

    const owned: Record<string, unknown> = {};
    await expect(assignMcpTaskGroup(41, "task-a", owned)).resolves.toBe(17);
    owned["41"] = { taskId: "task-a", mcpGroupId: 17 };
    await expect(assignMcpTaskGroup(42, "task-a", owned)).resolves.toBe(17);

    expect(groupCalls).toEqual([
      { tabIds: 41 },
      { tabIds: 42, groupId: 17 },
    ]);
    expect(updates).toEqual([{ groupId: 17, value: { title: "MCP" } }]);
  });

  it("recovers a task group from persisted MCP-owned metadata after worker state loss", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const groupCalls: Array<Record<string, unknown>> = [];
    const context = vm.createContext({
      Map,
      Number,
      Object,
      chrome: {
        tabs: {
          group: async (input: Record<string, unknown>) => {
            groupCalls.push(input);
            return Number(input.groupId);
          },
        },
        tabGroups: { update: async () => undefined },
      },
    });
    vm.runInContext("const taskGroups = new Map();", context);
    const assignMcpTaskGroup = vm.runInContext(
      `(${extractFunction(serviceWorker, "assignMcpTaskGroup")})`,
      context,
    ) as (tabId: number, taskId: string, owned: Record<string, unknown>) => Promise<number>;

    await expect(assignMcpTaskGroup(52, "task-recovered", {
      "51": { taskId: "task-recovered", mcpGroupId: 23 },
      "90": { taskId: "other-task", mcpGroupId: 99 },
    })).resolves.toBe(23);

    expect(groupCalls).toEqual([{ tabIds: 52, groupId: 23 }]);
  });

  it("serializes mutations that share the same queue key", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const context = vm.createContext({ Map, Promise });
    vm.runInContext("const mutationQueues = new Map();", context);
    const enqueueMutation = vm.runInContext(
      `(${extractFunction(serviceWorker, "enqueueMutation")})`,
      context,
    ) as <T>(key: string, work: () => Promise<T>) => Promise<T>;

    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const events: string[] = [];

    const first = enqueueMutation("tab:personal:1", async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
      return "first";
    });
    await firstStarted.promise;

    const second = enqueueMutation("tab:personal:1", async () => {
      events.push("second:start");
      return "second";
    });
    await Promise.resolve();

    expect(events).toEqual(["first:start"]);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("serializes ownership read-modify-write sections", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const context = vm.createContext({ Promise });
    vm.runInContext("let ownershipTail = Promise.resolve();", context);
    const withOwnershipLock = vm.runInContext(
      `(${extractFunction(serviceWorker, "withOwnershipLock")})`,
      context,
    ) as <T>(work: () => Promise<T>) => Promise<T>;

    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const events: string[] = [];

    const first = withOwnershipLock(async () => {
      events.push("first:start");
      firstStarted.resolve();
      await releaseFirst.promise;
      events.push("first:end");
      return 1;
    });
    await firstStarted.promise;

    const second = withOwnershipLock(async () => {
      events.push("second:start");
      return 2;
    });
    await Promise.resolve();

    expect(events).toEqual(["first:start"]);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("materializes cooperative cancellation and owned-tab removal hooks", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);

    expect(serviceWorker).toContain('message?.type === "cancel"');
    expect(serviceWorker).toContain('inFlightRequests.get(message.id)?.abort("cancelled")');
    expect(serviceWorker).toContain("chrome.tabs.onRemoved.addListener");
    expect(serviceWorker).toContain("void removeOwnedTab(tabId)");
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function extractFunction(source: string, name: string): string {
  const functionStart = source.indexOf(`function ${name}(`);
  if (functionStart < 0) throw new Error(`Function not found: ${name}`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === "async "
    ? functionStart - 6
    : functionStart;
  const brace = source.indexOf("{", functionStart);
  if (brace < 0) throw new Error(`Function body not found: ${name}`);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Function body is incomplete: ${name}`);
}

function createDom(initialElements: FakeElement[]) {
  let interactiveElements = initialElements;
  const allElements = new Set<FakeElement>(initialElements);
  const document = {
    body: { innerText: "Login page" },
    title: "Test",
    querySelectorAll(selector: string) {
      if (selector === "[data-mcp-v3-ref]") {
        return [...allElements].filter((element) =>
          element.getAttribute("data-mcp-v3-ref") !== null
        );
      }
      return interactiveElements;
    },
    querySelector(selector: string) {
      const match = /^\[data-mcp-v3-ref='(.+)'\]$/u.exec(selector);
      if (!match) return null;
      return [...allElements].find(
        (element) => element.getAttribute("data-mcp-v3-ref") === match[1],
      ) ?? null;
    },
    getElementById() {
      return null;
    },
  };
  const context = vm.createContext({
    document,
    location: { href: "https://example.test/" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    CSS: { escape: (value: string) => value },
    Array,
    String,
  });
  return {
    context,
    setInteractiveElements(elements: FakeElement[]) {
      interactiveElements = elements;
      for (const element of elements) allElements.add(element);
    },
  };
}

function fakeElement(options: {
  tagName: string;
  text?: string;
  value?: string;
  attributes?: Record<string, string>;
  labels?: Array<{ innerText?: string; textContent?: string }>;
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  selected?: boolean;
  multiple?: boolean;
}) {
  const attributes = new Map(Object.entries(options.attributes ?? {}));
  let clickCount = 0;
  return {
    tagName: options.tagName,
    innerText: options.text ?? "",
    textContent: options.text ?? "",
    value: options.value ?? "",
    labels: options.labels ?? [],
    checked: options.checked,
    disabled: options.disabled,
    required: options.required,
    selected: options.selected,
    multiple: options.multiple,
    get clickCount() {
      return clickCount;
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    getBoundingClientRect() {
      return { width: 100, height: 30 };
    },
    scrollIntoView() {},
    focus() {},
    click() {
      clickCount += 1;
    },
  };
}
