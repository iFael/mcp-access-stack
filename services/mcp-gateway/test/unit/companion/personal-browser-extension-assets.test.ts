import vm from "node:vm";
import { describe, expect, it } from "@jest/globals";
import { buildPersonalBrowserExtensionAssets, sanitizePersonalDiagnosticText, PERSONAL_BROWSER_MUTATING_OPERATIONS } from "../../../src/companion/personal-browser-extension-assets.js";
import { summarizeCdpAccessibility } from "../../../src/companion/personal-browser-accessibility.js";

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

  it("dispatches advanced guarded sequence steps and returns bounded action summary", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    let now = 0;
    const dispatched: string[] = [];
    const stub = (action: string) => async () => {
      dispatched.push(action);
      now += 7;
      return { completed: true };
    };
    const context = vm.createContext({
      performance: { now: () => now },
      throwIfAborted: () => undefined,
      hover: stub("hover"), scroll: stub("scroll"), drag: stub("drag"),
      formInput: stub("formInput"), typeText: stub("type"),
    });
    vm.runInContext(extractFunction(serviceWorker, "sequence"), context);
    const sequence = vm.runInContext("sequence", context) as (input: unknown) => Promise<Record<string, unknown>>;
    const result = await sequence({ tabId: "personal:7", steps: [
      { action: "hover", ref: "p-1", guard: { url: "https://example.test/" } },
      { action: "scroll", direction: "down", amount: 300, guard: { url: "https://example.test/" } },
      { action: "drag", from: { ref: "p-1" }, to: { ref: "p-2" }, steps: 10 },
      { action: "formInput", ref: "p-3", value: true, guard: { url: "https://example.test/" } },
      { action: "type", text: "hello", guard: { url: "https://example.test/" } },
    ] });
    expect(dispatched).toEqual(["hover", "scroll", "drag", "formInput", "type"]);
    expect(result).toMatchObject({ tabId: "personal:7", completed: true });
    expect(result.steps).toEqual([
      { index: 0, action: "hover", completed: true, durationMs: 7 },
      { index: 1, action: "scroll", completed: true, durationMs: 7 },
      { index: 2, action: "drag", completed: true, durationMs: 7 },
      { index: 3, action: "formInput", completed: true, durationMs: 7 },
      { index: 4, action: "type", completed: true, durationMs: 7 },
    ]);
    expect(result.actionSummary).toHaveLength(5);
    expect(JSON.stringify(result.actionSummary)).not.toMatch(/https|hello|private/);
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

  it("generates the extension mutation queue from the shared mutation contract", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    expect(serviceWorker).toContain(
      `const MUTATING_OPERATIONS = new Set(${JSON.stringify(PERSONAL_BROWSER_MUTATING_OPERATIONS)});`,
    );
  });

  it("dispatches guarded click, fill and keyboard through Chrome CDP rather than synthetic DOM events", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    let attachCount = 0;
    let detachCount = 0;
    const context = vm.createContext({
      Number, String, RegExp, Object, Array,
      chromeTabIdFrom: () => 7,
      probeGuardedElement: () => ({ x: 30, y: 40 }),
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        scripting: { executeScript: async () => [{ result: { x: 30, y: 40 } }] },
        debugger: {
          attach: async () => { attachCount += 1; },
          detach: async () => { detachCount += 1; },
          sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
            commands.push({ method, params });
          },
        },
      },
    });
    for (const fn of ["parseChromeKey", "click", "fill", "press"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const guardedClick = vm.runInContext("click", context) as (arg: unknown) => Promise<unknown>;
    const guardedFill = vm.runInContext("fill", context) as (arg: unknown) => Promise<unknown>;
    const guardedPress = vm.runInContext("press", context) as (arg: unknown) => Promise<unknown>;
    await guardedClick({ tabId: "personal:7", ref: "target", guard: { url: "https://example.com/", ref: "target" } });
    await guardedFill({ tabId: "personal:7", ref: "target", value: "secret", guard: { url: "https://example.com/", ref: "target" } });
    await guardedPress({ tabId: "personal:7", key: "Ctrl+A", guard: { url: "https://example.com/" } });
    expect(commands.map((entry) => entry.method)).toEqual([
      "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
      "Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
    ]);
    expect(commands[1]).toMatchObject({ params: { type: "mousePressed", button: "left", x: 30, y: 40 } });
    expect(commands[7]).toMatchObject({ params: { text: "secret" } });
    expect(commands[8]).toMatchObject({ params: { key: "a", modifiers: 2 } });
    expect(attachCount).toBe(3);
    expect(detachCount).toBe(3);
    await expect(guardedClick({ tabId: "personal:7", ref: "target" })).rejects.toMatchObject({
      code: "BROWSER_CONFIRMATION_INVALID",
    });
    expect(attachCount).toBe(3);
  });

  it("hit-tests viewport coordinates against authoritative isolated-world refs", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const button = {
      tagName: "BUTTON", isConnected: true, innerText: "Help", textContent: "Help",
      parentElement: null, getRootNode: () => ({}), labels: [],
      getAttribute: (_key: string) => null,
      scrollIntoView: () => undefined,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
      contains: (_other: unknown) => false,
    };
    const context = vm.createContext({
      button, innerWidth: 800, innerHeight: 600,
      location: { href: "https://example.test/" },
      document: { elementFromPoint: () => button },
    });
    vm.runInContext(`globalThis.__mcpV3OwnedRefElements = new Map([["p-7",button]]);
      globalThis.__mcpV3OwnedRefMetadata = new Map([["p-7",{ref:"p-7",role:"button",name:"Help"}]]);`, context);
    for (const name of ["inspectPointInDocument", "probeGuardedElement"]) {
      vm.runInContext(extractFunction(serviceWorker, name), context);
    }
    const inspect = vm.runInContext("inspectPointInDocument", context) as (x: number, y: number) => unknown;
    expect(inspect(21, 40)).toEqual({ ref: "p-7", role: "button", name: "Help" });
    expect(inspect(900, 40)).toBeNull();
    const probe = vm.runInContext("probeGuardedElement", context) as
      (ref: string, guard: unknown, focus: boolean, x: number, y: number) => { x?: number; y?: number; error?: string };
    const guard = { ref: "p-7", role: "button", name: "Help", url: "https://example.test/" };
    expect(probe("p-7", guard, false, 21, 40)).toMatchObject({ x: 21, y: 40 });
    expect(probe("p-7", guard, false, 150, 40)).toMatchObject({ error: "point_outside_target" });
    expect(probe("p-7", { ...guard, name: "Wrong" }, false, 21, 40))
      .toMatchObject({ error: "target_changed" });
    button.tagName = "CANVAS";
    vm.runInContext('globalThis.__mcpV3OwnedRefMetadata.set("p-7", {ref:"p-7",role:"canvas",name:"Help"})', context);
    expect(inspect(21, 40)).toEqual({ ref: "p-7", role: "canvas", name: "Help" });
    expect(probe("p-7", { ...guard, role: "canvas" }, false, 21, 40))
      .toMatchObject({ x: 21, y: 40 });
  });

  it("drags with trusted CDP events and always releases the mouse on abort", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    let aborted = false;
    const ctx = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      probeGuardedElement: () => undefined,
      throwIfAborted: () => { if (aborted) throw Object.assign(new Error("abort"), { code: "OPERATION_CANCELLED" }); },
      chrome: {
        scripting: { executeScript: async (request: { args: unknown[] }) => [{
          result: { x: request.args[0] === "source" ? 20 : 80, y: 40 },
        }] },
        debugger: {
          attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
            commands.push({ method, params });
          },
        },
      },
    });
    vm.runInContext(extractFunction(serviceWorker, "drag"), ctx);
    const drag = vm.runInContext("drag", ctx) as (input: unknown) => Promise<unknown>;
    const input = {
      tabId: "personal:7", from: { ref: "source" }, to: { ref: "destination" }, steps: 3,
      fromGuard: { ref: "source", url: "https://example.com/", role: "link", name: "Source" },
      toGuard: { ref: "destination", url: "https://example.com/", role: "link", name: "Destination" },
    };
    await drag(input);
    expect(commands.filter((event) => event.method === "Input.dispatchMouseEvent")
      .map((event) => event.params.type)).toEqual([
        "mouseMoved", "mousePressed", "mouseMoved", "mouseMoved", "mouseMoved", "mouseReleased",
      ]);
    expect(commands.find((event) => event.params.type === "mouseReleased")?.params).toMatchObject({ x: 80, y: 40 });
    commands.length = 0;
    await expect(drag({ ...input, fromGuard: undefined })).rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    expect(commands).toHaveLength(0);
  });

  it("operates native form controls with trusted CDP and rejects mismatched values", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    let kind: Record<string, unknown> = { kind: "checkbox", checked: false };
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    const context = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      probeGuardedElement: () => undefined,
      inspectGuardedForm: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        scripting: { executeScript: async (request: { func: { name: string } }) => [{
          result: request.func.name === "inspectGuardedForm" ? kind : { x: 45, y: 55 },
        }] },
        debugger: {
          attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
            commands.push({ method, params });
            return {};
          },
        },
      },
    });
    vm.runInContext(extractFunction(serviceWorker, "formInput"), context);
    const update = vm.runInContext("formInput", context) as (input: unknown) => Promise<unknown>;
    const common = { tabId: "personal:7", ref: "target",
      guard: { ref: "target", role: "checkbox", name: "Subscribe", url: "https://example.com/" } };
    await update({ ...common, value: true });
    expect(commands.filter((event) => event.method === "Input.dispatchMouseEvent").map((event) => event.params.type))
      .toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    commands.length = 0;
    kind = { kind: "checkbox", checked: true };
    await update({ ...common, value: true });
    expect(commands).toEqual([]);
    kind = { kind: "text" };
    await expect(update({ ...common, value: true })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    commands.length = 0;
    kind = { kind: "select", multiple: false, options: [
      { index: 0, value: "BR", label: "Brazil", selected: true, disabled: false },
      { index: 1, value: "US", label: "United States", selected: false, disabled: false },
    ] };
    await update({ ...common, value: ["US"] });
    expect(commands.filter((event) => event.method === "Input.dispatchKeyEvent" && event.params.type === "keyDown")
      .map((event) => event.params.key)).toEqual(["Home", "ArrowDown", "Enter"]);
    commands.length = 0;
    kind = { kind: "text" };
    await update({ ...common, value: "Updated" });
    expect(commands).toContainEqual({ method: "Input.insertText", params: { text: "Updated" } });
  });

  it("evaluates confirmed JavaScript via native CDP", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const context = vm.createContext({
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        debugger: { attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
            calls.push({ method, params });
            return { result: { type: "object", value: { title: "Hello" } } };
          },
        },
      },
    });
    vm.runInContext(extractFunction(serviceWorker, "evaluatePage"), context);
    const evaluate = vm.runInContext("evaluatePage", context) as (input: unknown) => Promise<unknown>;
    await expect(evaluate({ tabId: "personal:7", function: "() => 1" }))
      .rejects.toMatchObject({ code: "BROWSER_CAPABILITY_UNSUPPORTED" });
    await expect(evaluate({
      tabId: "personal:7", function: "() => document.title",
      guard: { url: "https://example.com/" },
    })).resolves.toMatchObject({ tabId: "personal:7", value: { title: "Hello" } });
    expect(calls.map((entry) => entry.method)).toEqual(["Runtime.evaluate"]);
    expect(calls[0]?.params).toMatchObject({
      expression: "(() => document.title)()", returnByValue: true, awaitPromise: true,
    });
  });

  it("types through Chrome trusted input and submits only under a page guard", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const events: Array<{ method: string; params: unknown }> = [];
    const context = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        debugger: {
          attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params: unknown) => {
            events.push({ method, params });
          },
        },
      },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
    });
    vm.runInContext(extractFunction(serviceWorker, "typeText"), context);
    const typeText = vm.runInContext("typeText", context) as (input: unknown) => Promise<unknown>;
    await expect(typeText({ tabId: "personal:7", text: "hello" }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    await typeText({ tabId: "personal:7", text: "hello", submit: true, guard: { url: "https://example.com/" } });
    expect(events.map((e) => e.method)).toEqual([
      "Input.insertText", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
    ]);
    expect(events[0]?.params).toEqual({ text: "hello" });
    expect(events[1]?.params).toMatchObject({ key: "Enter", type: "keyDown" });
  });

  it("routes scroll through explicit CSS viewport coordinates with bounded Chrome wheel origin", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const origins: unknown[] = [];
    const emitted: Array<Record<string, unknown>> = [];
    const context = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        scripting: { executeScript: async (payload: { args?: unknown[] }) => {
          origins.push(payload.args);
          const x = payload.args?.[0], y = payload.args?.[1];
          return [{ result: typeof x === "number" && x < 800 && typeof y === "number" && y < 600 ? { x, y } : null }];
        } },
        debugger: {
          attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, _name: string, event: Record<string, unknown>) => { emitted.push(event); },
        },
      },
    });
    vm.runInContext(extractFunction(serviceWorker, "scroll"), context);
    const scroll = vm.runInContext("scroll", context) as (input: unknown) => Promise<unknown>;
    await expect(scroll({ tabId: "personal:7", x: 160, y: 250,
      direction: "down", amount: 300, guard: { url: "https://example.com/" },
    })).resolves.toMatchObject({ completed: true });
    expect(origins).toEqual([[160, 250]]);
    expect(emitted).toEqual([{ type: "mouseWheel", x: 160, y: 250, deltaX: 0, deltaY: 300 }]);
    await expect(scroll({ tabId: "personal:7", x: 850, y: 250,
      direction: "up", amount: 50, guard: { url: "https://example.com/" },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(emitted).toHaveLength(1);
  });

  it("uses guarded CDP movement and wheel events for hover and scroll", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const methods: Array<{ method: string; params: Record<string, unknown> }> = [];
    const context = vm.createContext({
      Number, Math,
      chromeTabIdFrom: () => 7,
      probeGuardedElement: () => ({ x: 20, y: 25 }),
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        scripting: { executeScript: async () => [{ result: { x: 20, y: 25 } }] },
        debugger: {
          attach: async () => undefined,
          detach: async () => undefined,
          sendCommand: async (_: unknown, method: string, params: Record<string, unknown>) => { methods.push({ method, params }); },
        },
      },
    });
    for (const fn of ["hover", "scroll"]) vm.runInContext(extractFunction(serviceWorker, fn), context);
    const hover = vm.runInContext("hover", context) as (input: unknown) => Promise<unknown>;
    const scroll = vm.runInContext("scroll", context) as (input: unknown) => Promise<unknown>;
    await hover({ tabId: "personal:7", ref: "target", guard: { url: "https://example.com/", ref: "target" } });
    await scroll({ tabId: "personal:7", direction: "up", amount: 350, guard: { url: "https://example.com/" } });
    expect(methods.map((entry) => entry.method)).toEqual(["Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
    expect(methods[0]).toMatchObject({ params: { type: "mouseMoved", x: 20, y: 25 } });
    expect(methods[1]).toMatchObject({ params: { type: "mouseWheel", deltaX: 0, deltaY: -350 } });
    await expect(hover({ tabId: "personal:7", ref: "target" })).rejects.toMatchObject({
      code: "BROWSER_CONFIRMATION_INVALID",
    });
  });

  it("returns sanitized CDP AX for an MCP-owned tab only when explicitly requested", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const commands: string[] = [];
    let attaches = 0;
    let detaches = 0;
    let actualUrl = "https://example.com/";
    let failTree = false;
    const context = vm.createContext({
      crypto: { randomUUID: () => "document-uuid" },
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      snapshotPage: () => undefined,
      summarizeCdpAccessibility,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: actualUrl }) },
        scripting: { executeScript: async () => [{ result: {
          url: "https://example.com/", title: "Example", pageInstanceId: "document-uuid",
          content: "Visible UI", refs: [{ ref: "p-1", role: "button", name: "Save" }],
        } }] },
        debugger: {
          attach: async () => { attaches += 1; },
          detach: async () => { detaches += 1; },
          sendCommand: async (_target: unknown, method: string) => {
            commands.push(method);
            if (method === "Accessibility.getFullAXTree") {
              if (failTree) throw new Error("DevTools unavailable");
              return { nodes: [
                { nodeId: "1", role: { value: "RootWebArea" }, childIds: ["2"] },
                { nodeId: "2", role: { value: "textbox" }, name: { value: "Password" }, value: { value: "user-private-value" } },
              ] };
            }
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
            return {};
          },
        },
      },
    });
    vm.runInContext("const axTargetsByTab = new Map();", context);
    for (const fn of ["readNativeAccessibility", "snapshot"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const snapshot = vm.runInContext("snapshot", context) as (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const ordinary = await snapshot({ tabId: "personal:7" });
    expect(ordinary).toMatchObject({ pageInstanceId: "document-uuid" });
    expect(ordinary.accessibility).toBeUndefined();
    expect(attaches).toBe(0);
    const native = await snapshot({ tabId: "personal:7", includeAccessibility: true });
    expect(native.accessibility).toMatchObject({
      source: "cdp", coverage: "main-frame-only", frameCount: 1,
      nodes: [expect.objectContaining({ role: "RootWebArea" }), expect.objectContaining({ role: "textbox", name: "Password" })],
    });
    expect(JSON.stringify(native)).not.toContain("user-private-value");
    expect(commands).toEqual(["Accessibility.enable", "Accessibility.getFullAXTree", "Page.getFrameTree"]);
    expect(attaches).toBe(1);
    expect(detaches).toBe(1);
    failTree = true;
    await expect(snapshot({ tabId: "personal:7", includeAccessibility: true })).rejects.toMatchObject({
      code: "BROWSER_CAPABILITY_UNSUPPORTED",
    });
    expect(detaches).toBe(2);
    failTree = false;
    actualUrl = "https://other.example.com/";
    await expect(snapshot({ tabId: "personal:7", includeAccessibility: true })).rejects.toMatchObject({
      code: "BROWSER_DISCONNECTED",
    });
    expect(detaches).toBe(3);
  });

  it("turns native AX nodes into guarded actionable refs and rejects stale targets", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const inputs: Array<{ method: string; params: Record<string, unknown> }> = [];
    const context = vm.createContext({
      Map, Set, Number, Array, String, crypto: { randomUUID: () => "uuidax" },
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      summarizeCdpAccessibility,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        scripting: { executeScript: async () => [{ result: "document-7" }] },
        debugger: {
          attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
            inputs.push({ method, params });
            if (method === "Accessibility.getFullAXTree") return { nodes: [
              { nodeId: "root", role: { value: "RootWebArea" }, childIds: ["button"] },
              { nodeId: "button", role: { value: "button" },
                name: { value: "Delete account" }, backendDOMNodeId: 42 },
            ] };
            if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
            if (method === "Accessibility.getPartialAXTree") return { nodes: [
              { backendDOMNodeId: 42, role: { value: "button" }, name: { value: "Delete account" } },
            ] };
            if (method === "DOM.getBoxModel") return { model: { content: [20,30,120,30,120,60,20,60] } };
            if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
            if (method === "DOM.getNodeForLocation") return { backendNodeId: 42 };
            return {};
          },
        },
      },
    });
    vm.runInContext("const axTargetsByTab = new Map();", context);
    for (const name of ["readNativeAccessibility", "resolveGuardedAxPoint", "click"]) {
      vm.runInContext(extractFunction(serviceWorker, name), context);
    }
    const read = vm.runInContext("readNativeAccessibility", context) as
      (tab: number, url: string, doc: string) => Promise<{ refs: Array<{ ref: string; role: string; name: string }> }>;
    const native = await read(7, "https://example.com/", "document-7");
    expect(native.refs).toHaveLength(1);
    const ref = native.refs[0]!;
    expect(ref).toMatchObject({ role: "button", name: "Delete account" });
    expect(JSON.stringify(native)).not.toContain("backendDOMNodeId");
    const click = vm.runInContext("click", context) as (input: unknown) => Promise<unknown>;
    await click({
      tabId: "personal:7", ref: ref.ref,
      guard: { url: "https://example.com/", ...ref },
    });
    expect(inputs.filter((x) => x.method === "Input.dispatchMouseEvent").map((x) => x.params.type))
      .toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    await expect(click({
      tabId: "personal:7", ref: ref.ref,
      guard: { url: "https://example.com/", ...ref, name: "Wrong name" },
    })).rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
  });

  it("records full request and response detail across subsequent browser operations in one Chrome CDP session", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const listeners = new Set<(target: { tabId: number }, method: string, params: unknown) => void>();
    const commands: string[] = [];
    const context = vm.createContext({
      URL, Date, Map, Object, String, Promise, Number, Uint8Array, TextDecoder, atob,
      setTimeout: (fn: () => void) => { fn(); return 1; },
      crypto: { randomUUID: () => "uuid" },
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      sanitizePersonalDiagnosticText,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { debugger: {
        onEvent: {
          addListener(listener: (target: { tabId: number }, method: string, params: unknown) => void) { listeners.add(listener); },
          removeListener(listener: (target: { tabId: number }, method: string, params: unknown) => void) { listeners.delete(listener); },
        },
        attach: async () => { commands.push("attach"); },
        detach: async () => { commands.push("detach"); },
        sendCommand: async (_target: unknown, method: string) => {
          commands.push(method);
          if (method === "Network.getResponseBody") {
            return { body: '{"token":"secret-token","message":"ok"}', base64Encoded: false };
          }
          return {};
        },
      } },
    });
    vm.runInContext("const personalNetworkEntries = new Map(); const personalNetworkCaptures = new Map();", context);
    vm.runInContext(extractFunction(serviceWorker, "readPersonalNetwork"), context);
    vm.runInContext(extractFunction(serviceWorker, "inspectPersonalNetwork"), context);
    for (const fn of ["borrowPersonalDebugger", "attachGuardedDebugger", "detachGuardedDebugger"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const read = vm.runInContext("readPersonalNetwork", context) as (input: unknown) => Promise<Record<string, unknown>>;
    const inspect = vm.runInContext("inspectPersonalNetwork", context) as (input: unknown) => Promise<Record<string, unknown>>;
    await read({ tabId: "personal:7", capture: "start", captureHeaders: true, captureBodies: true });
    expect(commands).toEqual(["attach", "Network.enable"]);
    for (const listener of listeners) {
      listener({ tabId: 7 }, "Network.requestWillBeSent", {
        requestId: "req-1", type: "Fetch",
        request: { url: "https://secure.test/login?password=private",
          method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer private-bearer", Cookie: "session=private-cookie" },
          postData: '{"api_key":"secret-request","payload":"hello"}' },
      });
      listener({ tabId: 7 }, "Network.responseReceived", { requestId: "req-1",
        response: { status: 202, mimeType: "application/json", headers: { "Content-Type": "application/json", "Set-Cookie": "secret-cookie", "X-Test": "safe" } },
      });
      listener({ tabId: 7 }, "Network.loadingFinished", { requestId: "req-1" });
    }
    await Promise.resolve();
    await Promise.resolve();
    const list = await read({ tabId: "personal:7", capture: "read" });
    expect(list.text).toContain("POST https://secure.test/login 202");
    expect(JSON.stringify(list)).not.toMatch(/private|secret-token|secret-request|bearer/);
    const reqHeaders = await inspect({ tabId: "personal:7", index: 1, detail: "request-headers" });
    expect(reqHeaders.text).toContain("redacted");
    expect(reqHeaders.text).toContain("Content-Type");
    expect(reqHeaders.text).not.toMatch(/private-bearer|private-cookie/);
    const resHeaders = await inspect({ tabId: "personal:7", index: 1, detail: "response-headers" });
    expect(resHeaders.text).toContain('"X-Test":"safe"');
    expect(resHeaders.text).not.toContain("secret-cookie");
    const reqBody = await inspect({ tabId: "personal:7", index: 1, detail: "request-body" });
    expect(reqBody.text).toContain("[redacted]");
    expect(reqBody.text).not.toContain("secret-request");
    const resBody = await inspect({ tabId: "personal:7", index: 1, detail: "response-body" });
    expect(resBody.text).toContain('"message":"ok"');
    expect(resBody.text).not.toContain("secret-token");
    // Borrowing while recording must not attach a second Chrome debugger.
    const borrow = vm.runInContext("attachGuardedDebugger", context) as (target: unknown) => Promise<boolean>;
    const release = vm.runInContext("detachGuardedDebugger", context) as (target: unknown, owns: boolean) => Promise<void>;
    expect(await borrow({ tabId: 7 })).toBe(false);
    expect(commands.filter((name) => name === "attach")).toHaveLength(1);
    await expect(read({ tabId: "personal:7", capture: "stop" })).rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
    await release({ tabId: 7 }, false);
    await read({ tabId: "personal:7", capture: "stop" });
    expect(commands.filter((name) => name === "detach")).toHaveLength(1);
    expect(listeners.size).toBe(0);
    expect((await inspect({ tabId: "personal:7", index: 1, detail: "response-body" })).text).toContain("ok");
    await read({ tabId: "personal:7", clear: true });
    expect(vm.runInContext("personalNetworkEntries.size", context)).toBe(0);
  });

  it("lists and inspects bounded Chrome-owned network metadata without retaining credentials", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const listeners = new Set<(source: { tabId: number }, method: string, params: unknown) => void>();
    const commands: string[] = [];
    const context = vm.createContext({
      URL, Date, Map, String,
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      setTimeout: (fn: () => void) => { fn(); return 1; },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      sanitizePersonalDiagnosticText,
      chrome: { debugger: {
        onEvent: {
          addListener(fn: (source: { tabId: number }, method: string, params: unknown) => void) { listeners.add(fn); },
          removeListener(fn: (source: { tabId: number }, method: string, params: unknown) => void) { listeners.delete(fn); },
        },
        attach: async () => { commands.push("attach"); },
        detach: async () => { commands.push("detach"); },
        sendCommand: async (_target: unknown, method: string) => {
          commands.push(method);
          if (method === "Network.enable") {
            for (const listener of listeners) {
              listener({ tabId: 99 }, "Network.requestWillBeSent", { requestId: "wrong-tab", request: { method: "GET", url: "https://secret.test/admin" } });
              listener({ tabId: 7 }, "Network.requestWillBeSent", { requestId: "id-1", type: "Fetch",
                request: { method: "POST", url: "https://api.test/submit?token=mySecret&session=private#fragment", headers: { authorization: "Bearer forbidden" }, postData: "private body" } });
              listener({ tabId: 7 }, "Network.responseReceived", { requestId: "id-1",
                response: { status: 201, headers: { cookie: "private-cookie" } } });
              listener({ tabId: 7 }, "Network.requestWillBeSent", { requestId: "id-2", type: "Image",
                request: { method: "GET", url: "https://cdn.test/image.png?apikey=private" } });
            }
          }
          return {};
        },
      } },
    });
    vm.runInContext("const personalNetworkEntries = new Map(); const personalNetworkCaptures = new Map();", context);
    for (const fn of ["readPersonalNetwork", "inspectPersonalNetwork"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const list = vm.runInContext("readPersonalNetwork", context) as (input: unknown) => Promise<Record<string, unknown>>;
    const inspect = vm.runInContext("inspectPersonalNetwork", context) as (input: unknown) => Promise<Record<string, unknown>>;
    const result = await list({ tabId: "personal:7", filter: "api[.]test", includeStatic: false });
    expect(result).toMatchObject({ tabId: "personal:7", truncated: false });
    expect(result.text).toContain("1. POST https://api.test/submit 201");
    expect(JSON.stringify(result)).not.toMatch(/mySecret|private|forbidden|cookie|secret\.test|apikey|cdn\.test/);
    expect(commands).toEqual(["attach", "Network.enable", "detach"]);
    expect(listeners.size).toBe(0);
    await expect(inspect({ tabId: "personal:7", index: 1 })).resolves.toMatchObject({
      text: expect.stringContaining('"status":"201"'),
    });
    await expect(inspect({ tabId: "personal:7", index: 1, detail: "response-body" }))
      .rejects.toMatchObject({ code: "BROWSER_CAPABILITY_UNSUPPORTED" });
    await expect(inspect({ tabId: "personal:7", index: 99 }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await list({ tabId: "personal:7", clear: true });
    expect(vm.runInContext("personalNetworkEntries.size", context)).toBe(0);
  });

  it("intercepts a trusted upload trigger and selects the underlying Chrome file input natively", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const listeners = new Set<(target: { tabId: number }, method: string, params: unknown) => void>();
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const context = vm.createContext({
      setTimeout, clearTimeout, Date,
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      probeGuardedElement: () => undefined,
      chrome: {
        tabs: { get: async () => ({ url: "https://upload.example/" }) },
        scripting: { executeScript: async () => [{ result: { x: 10, y: 20 } }] },
        debugger: {
          attach: async () => undefined,
          detach: async () => undefined,
          onEvent: {
            addListener: (fn: (target: { tabId: number }, method: string, params: unknown) => void) => { listeners.add(fn); },
            removeListener: (fn: (target: { tabId: number }, method: string, params: unknown) => void) => { listeners.delete(fn); },
          },
          sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => {
            commands.push({ method, ...(params ? { params } : {}) });
            if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
              for (const listener of listeners) {
                listener({ tabId: 7 }, "Page.fileChooserOpened", { backendNodeId: 99 });
              }
            }
            if (method === "DOM.describeNode") {
              return { node: { nodeName: "INPUT", attributes: ["type", "file"] } };
            }
            return {};
          },
        },
      },
    });
    for (const fn of ["borrowPersonalDebugger", "attachGuardedDebugger", "detachGuardedDebugger",
      "uploadPersonalFiles"]) vm.runInContext(extractFunction(serviceWorker, fn), context);
    const upload = vm.runInContext("uploadPersonalFiles", context) as (input: unknown) => Promise<Record<string, unknown>>;
    await expect(upload({
      tabId: "personal:7", triggerRef: "p-1",
      guard: { url: "https://upload.example/", ref: "p-1", role: "button", name: "Attach" },
      files: [{ name: "report.pdf", path: "C:\\Private\\report.pdf" }], totalBytes: 12,
    })).resolves.toMatchObject({ completed: true, fileCount: 1, totalBytes: 12 });
    expect(commands.find((command) => command.method === "Page.setInterceptFileChooserDialog" &&
      command.params?.enabled === true)).toBeTruthy();
    expect(commands.find((command) => command.method === "DOM.setFileInputFiles")?.params)
      .toMatchObject({ backendNodeId: 99, files: ["C:\\Private\\report.pdf"] });
    expect(commands.at(-1)).toMatchObject({ method: "Page.setInterceptFileChooserDialog", params: { enabled: false } });
    expect(listeners.size).toBe(0);
  });

  it("selects a native file input in the owned Chrome tab through CDP and rejects changed targets", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const context = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://upload.example/" }) },
        debugger: {
          attach: async () => { commands.push({ method: "attach" }); },
          detach: async () => { commands.push({ method: "detach" }); },
          sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => {
            commands.push({ method, ...(params ? { params } : {}) });
            if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
            if (method === "DOM.querySelectorAll") return { nodeIds: [42] };
            if (method === "DOM.describeNode") return { node: {
              nodeName: "INPUT", attributes: ["type", "file", "name", "document"],
            } };
            return {};
          },
        },
      },
    });
    for (const name of ["borrowPersonalDebugger", "attachGuardedDebugger", "detachGuardedDebugger",
      "uploadPersonalFiles"]) {
      vm.runInContext(extractFunction(serviceWorker, name), context);
    }
    const upload = vm.runInContext("uploadPersonalFiles", context) as
      (input: unknown) => Promise<Record<string, unknown>>;
    const input = {
      tabId: "personal:7", guard: { url: "https://upload.example/" },
      files: [{ name: "test.pdf", path: "C:\\MCP-private\\staged-1\\test.pdf" }],
      totalBytes: 300, selector: "input[type=file]",
    };
    await expect(upload(input)).resolves.toMatchObject({
      tabId: "personal:7", completed: true, fileCount: 1, totalBytes: 300,
    });
    const setFiles = commands.find((command) => command.method === "DOM.setFileInputFiles");
    expect(setFiles?.params).toMatchObject({ nodeId: 42,
      files: ["C:\\MCP-private\\staged-1\\test.pdf"] });
    expect(commands.filter((c) => c.method === "attach")).toHaveLength(1);
    expect(commands.filter((c) => c.method === "detach")).toHaveLength(1);
    await expect(upload({ ...input, guard: { url: "https://other.example/" } }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    expect(commands.filter((c) => c.method === "DOM.setFileInputFiles")).toHaveLength(1);
  });

  it("prints the single MCP-owned Chrome tab to a bounded CDP PDF", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const calls: string[] = [];
    const ctx = vm.createContext({
      chromeTabIdFrom: (id: string) => Number(id.slice("personal:".length)),
      requireOwnedMetadata: async (id: number) => {
        if (id !== 7) throw Object.assign(new Error("not owned"), { code: "TAB_NOT_FOUND" });
      },
      throwIfAborted: () => undefined,
      base64ByteLength: (data: string) => Buffer.from(data, "base64").length,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { debugger: {
        attach: async () => { calls.push("attach"); },
        detach: async () => { calls.push("detach"); },
        sendCommand: async (_target: unknown, method: string) => {
          calls.push(method);
          return method === "Page.printToPDF" ? { data: "JVBERi0xLjQK" } : {};
        },
      } },
    });
    vm.runInContext(extractFunction(serviceWorker, "printPersonalPdf"), ctx);
    const print = vm.runInContext("printPersonalPdf", ctx) as (input: unknown) => Promise<Record<string, unknown>>;
    const result = await print({ tabId: "personal:7" });
    expect(result).toMatchObject({
      tabId: "personal:7", kind: "pdf", contentBase64: "JVBERi0xLjQK", sizeBytes: 9,
    });
    expect(calls).toEqual(["attach", "Page.enable", "Page.printToPDF", "detach"]);
    await expect(print({ tabId: "personal:8" })).rejects.toMatchObject({ code: "TAB_NOT_FOUND" });
    expect(calls).toHaveLength(4);
  });

  it("persists mobile viewport, shares network CDP, and resets only the owned tab", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const methods: string[] = [];
    let attached = 0;
    let detached = 0;
    const listeners = new Set<Function>();
    const ctx = vm.createContext({
      Date, Map, Promise,
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async (id: number) => {
          if (id !== 7) throw new Error("not owned");
          return { url: "https://example.com/", width: 1280, height: 720 };
        } },
        debugger: {
          attach: async () => { attached++; },
          detach: async () => { detached++; },
          onEvent: {
            addListener: (fn: Function) => { listeners.add(fn); },
            removeListener: (fn: Function) => { listeners.delete(fn); },
          },
          sendCommand: async (_target: unknown, method: string) => {
            methods.push(method);
            if (method === "Page.getLayoutMetrics") {
              return { cssVisualViewport: { clientWidth: 1280, clientHeight: 720 } };
            }
            if (method === "Runtime.evaluate") {
              return { result: { value: { dpr: 1.25, dark: true, ua: "Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36", platform: "Win32" } } };
            }
            return {};
          },
        },
      },
    });
    vm.runInContext("const personalViewportSessions = new Map(); globalThis.__mcpV3PersonalViewportSessions = personalViewportSessions; const personalDialogArms = new Map(); globalThis.__mcpV3PersonalDialogArms = personalDialogArms; const personalNetworkCaptures = new Map(); const personalNetworkEntries = new Map(); globalThis.__mcpV3PersonalNetworkCaptures = personalNetworkCaptures;", ctx);
    for (const name of ["borrowPersonalDebugger", "attachGuardedDebugger", "detachGuardedDebugger",
      "resetPersonalViewport", "configurePersonalViewport", "startPersonalNetworkCapture",
      "stopPersonalNetworkCapture"]) {
      vm.runInContext(extractFunction(serviceWorker, name), ctx);
    }
    const setViewport = vm.runInContext("configurePersonalViewport", ctx) as
      (input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const attachDebugger = vm.runInContext("attachGuardedDebugger", ctx) as
      (input: Record<string, unknown>) => Promise<boolean>;
    const detachDebugger = vm.runInContext("detachGuardedDebugger", ctx) as
      (input: Record<string, unknown>, attached: boolean) => Promise<void>;
    const startNetwork = vm.runInContext("startPersonalNetworkCapture", ctx) as
      (tabId: number, input: Record<string, unknown>) => Promise<void>;
    const stopNetwork = vm.runInContext("stopPersonalNetworkCapture", ctx) as
      (tabId: number) => Promise<void>;
    await expect(setViewport({ tabId: "personal:7", preset: "mobile", colorScheme: "dark" }))
      .resolves.toMatchObject({ width: 375, height: 812, deviceScaleFactor: 3,
        touch: true, mobile: true, colorScheme: "dark", emulated: true });
    expect(attached).toBe(1);
    expect(await attachDebugger({ tabId: 7 })).toBe(false);
    await detachDebugger({ tabId: 7 }, false);
    await startNetwork(7, { captureHeaders: false, captureBodies: false });
    expect(attached).toBe(1);
    await stopNetwork(7);
    expect(detached).toBe(0);
    expect(methods).toContain("Emulation.setDeviceMetricsOverride");
    expect(methods).toContain("Network.enable");
    await expect(setViewport({ tabId: "personal:7", preset: "reset" }))
      .resolves.toMatchObject({ width: 1280, height: 720,
        deviceScaleFactor: 1.25, colorScheme: "dark", emulated: false });
    expect(methods).toContain("Emulation.clearDeviceMetricsOverride");
    expect(detached).toBe(1);
    expect(listeners.size).toBe(0);
    expect(vm.runInContext("personalViewportSessions.size", ctx)).toBe(0);
  });

  it("observes, inspects and responds to Chrome JavaScript dialogs without blind acceptance", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const listeners = new Set<(source: { tabId: number }, method: string, params: Record<string, unknown>) => void>();
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let deadline: (() => void) | undefined;
    const ctx = vm.createContext({
      Date,
      setTimeout: (fn: () => void) => { deadline = fn; return 10; },
      clearTimeout: () => { deadline = undefined; },
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        debugger: {
          onEvent: {
            addListener: (fn: (source: { tabId: number }, method: string, params: Record<string, unknown>) => void) => { listeners.add(fn); },
            removeListener: (fn: (source: { tabId: number }, method: string, params: Record<string, unknown>) => void) => { listeners.delete(fn); },
          },
          attach: async () => { sent.push({ method: "attach" }); },
          detach: async () => { sent.push({ method: "detach" }); },
          sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => {
            sent.push({ method, ...(params ? { params } : {}) });
          },
        },
      },
    });
    vm.runInContext("const personalDialogArms = new Map(); const personalNetworkCaptures = new Map(); globalThis.__mcpV3PersonalDialogArms = personalDialogArms;", ctx);
    for (const fn of ["borrowPersonalDebugger", "attachGuardedDebugger", "detachGuardedDebugger",
      "finalizePersonalDialog", "observePersonalDialog"]) vm.runInContext(extractFunction(serviceWorker, fn), ctx);
    const dialog = vm.runInContext("observePersonalDialog", ctx) as
      (args: Record<string, unknown>) => Promise<{ state: string; message?: string; dialogType?: string }>;
    await expect(dialog({ tabId: "personal:7", action: "arm" })).resolves.toMatchObject({ state: "armed" });
    for (const emit of listeners) emit({ tabId: 7 }, "Page.javascriptDialogOpening", {
      type: "confirm", message: "Delete everything?",
    });
    expect(await dialog({ tabId: "personal:7", action: "inspect" }))
      .toMatchObject({ state: "open", dialogType: "confirm", message: "Delete everything?" });
    await expect(dialog({ tabId: "personal:7", action: "respond",
      response: "accept", expectedMessage: "Different dialog" }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    expect(sent.some((call) => call.method === "Page.handleJavaScriptDialog")).toBe(false);
    await expect(dialog({ tabId: "personal:7", action: "respond",
      response: "dismiss", expectedMessage: "Delete everything?" }))
      .resolves.toMatchObject({ state: "idle" });
    expect(sent.filter((call) => call.method === "Page.handleJavaScriptDialog")).toEqual([{
      method: "Page.handleJavaScriptDialog", params: { accept: false },
    }]);
    expect(sent.filter((call) => call.method === "detach")).toHaveLength(1);
    expect(listeners.size).toBe(0);

    await dialog({ tabId: "personal:7", action: "arm" });
    for (const emit of listeners) emit({ tabId: 7 }, "Page.javascriptDialogOpening", {
      type: "prompt", message: "Name?",
    });
    const expire = deadline!;
    expire();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.filter((call) => call.method === "Page.handleJavaScriptDialog")).toHaveLength(2);
    expect(sent.filter((call) => call.method === "Page.handleJavaScriptDialog").at(-1)?.params)
      .toEqual({ accept: false });
  });

  it("captures and sanitizes CDP console on the MCP-owned Chrome tab with filters and cleanup", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const listeners = new Set<(source: { tabId: number }, name: string, args: unknown) => void>();
    const commands: string[] = [];
    const context = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      setTimeout: (fn: () => void) => { fn(); return 1; },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      sanitizePersonalDiagnosticText,
      chrome: { debugger: {
        onEvent: {
          addListener(fn: (source: { tabId: number }, name: string, args: unknown) => void) { listeners.add(fn); },
          removeListener(fn: (source: { tabId: number }, name: string, args: unknown) => void) { listeners.delete(fn); },
        },
        attach: async () => { commands.push("attach"); },
        detach: async () => { commands.push("detach"); },
        sendCommand: async (_target: unknown, method: string) => {
          commands.push(method);
          if (method === "Runtime.enable") {
            for (const listener of listeners) {
              listener({ tabId: 999 }, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "wrong tab" }] });
              listener({ tabId: 7 }, "Runtime.consoleAPICalled", { type: "log", args: [{ value: "ordinary event" }] });
              listener({ tabId: 7 }, "Runtime.consoleAPICalled", { type: "error", args: [{ value: "Authorization: Bearer hidden-key" }] });
              listener({ tabId: 7 }, "Runtime.exceptionThrown", { exceptionDetails: { text: "TypeError: failed" } });
            }
          }
          return {};
        },
      } },
    });
    vm.runInContext("const personalConsoleEntries = new Map();", context);
    vm.runInContext(extractFunction(serviceWorker, "readPersonalConsole"), context);
    const consoleRead = vm.runInContext("readPersonalConsole", context) as (input: unknown) => Promise<Record<string, unknown>>;
    const result = await consoleRead({ tabId: "personal:7", onlyErrors: true, pattern: "Authorization|TypeError", limit: 1, clear: true });
    expect(result).toMatchObject({ tabId: "personal:7", truncated: true });
    expect(result.text).toContain("Authorization: [redacted]");
    expect(JSON.stringify(result)).not.toContain("hidden-key");
    expect(JSON.stringify(result)).not.toContain("ordinary event");
    expect(commands).toEqual(["attach", "Runtime.enable", "Log.enable", "detach"]);
    expect(listeners.size).toBe(0);
    expect(vm.runInContext("personalConsoleEntries.size", context)).toBe(0);
    await expect(consoleRead({ tabId: "personal:7", pattern: "[" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("captures a bounded CSS viewport region using page scroll offsets and device scale", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const commands: Array<{ name: string; params: Record<string, unknown> }> = [];
    const context = vm.createContext({
      MAX_FULL_PAGE_PIXELS: 40_000_000,
      MAX_SCREENSHOT_BASE64_CHARS: 3_000_000,
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      crypto: { randomUUID: () => "example" },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      base64ByteLength: () => 3,
      chrome: { debugger: {
        attach: async () => undefined, detach: async () => undefined,
        sendCommand: async (_target: unknown, name: string, params: Record<string, unknown>) => {
          commands.push({ name, params });
          if (name === "Page.getLayoutMetrics") return {
            cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageX: 32, pageY: 80 },
          };
          if (name === "Runtime.evaluate") return { result: { value: 2 } };
          if (name === "Page.captureScreenshot") return { data: "AQID" };
          return {};
        },
      } },
    });
    vm.runInContext(extractFunction(serviceWorker, "screenshot"), context);
    const screenshot = vm.runInContext("screenshot", context) as (args: unknown) => Promise<unknown>;
    await expect(screenshot({
      tabId: "personal:7",
      region: { x: 10, y: 20, width: 200, height: 100 },
      scale: "device",
    })).resolves.toMatchObject({ sizeBytes: 3, mimeType: "image/jpeg" });
    expect(commands.find((c) => c.name === "Page.captureScreenshot")?.params).toMatchObject({
      clip: { x: 42, y: 100, width: 200, height: 100, scale: 2 },
    });
    commands.length = 0;
    await expect(screenshot({
      tabId: "personal:7",
      region: { x: 780, y: 30, width: 50, height: 100 },
    })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(commands.some((c) => c.name === "Page.captureScreenshot")).toBe(false);
  });

  it("activates only a verified MCP-owned tab and does not adopt another user's tab", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const updates: number[] = [];
    const context = vm.createContext({
      chromeTabIdFrom: (tabId: string) => Number(tabId.replace("personal:", "")),
      requireOwnedMetadata: async (tabId: number) => {
        if (tabId !== 7) throw Object.assign(new Error("not owned"), { code: "TAB_PROTECTED" });
        return { tabId: "personal:7", taskId: "t-1" };
      },
      throwIfAborted: () => undefined,
      toBrowserTab: (metadata: unknown, tab: unknown) => ({ ...metadata as object, ...tab as object }),
      chrome: {
        tabs: { update: async (tabId: number, options: { active: boolean }) => {
          expect(options).toEqual({ active: true });
          updates.push(tabId);
          return { id: tabId, url: "https://example.test/", active: true };
        } },
      },
    });
    vm.runInContext(extractFunction(serviceWorker, "selectOwnedTab"), context);
    const select = vm.runInContext("selectOwnedTab", context) as (input: unknown) => Promise<unknown>;
    await expect(select({ tabId: "personal:7" })).resolves.toMatchObject({
      tab: { tabId: "personal:7", active: true },
    });
    await expect(select({ tabId: "personal:8" })).rejects.toMatchObject({ code: "TAB_PROTECTED" });
    expect(updates).toEqual([7]);
  });

  it("announces a versioned capability handshake and blocks private navigation targets", () => {
    const { manifest, serviceWorker } = buildPersonalBrowserExtensionAssets(
      "x".repeat(43),
      3361,
      ["https://private.example.test"],
    );
    const parsedManifest = JSON.parse(manifest) as { version: string; permissions: string[] };
    expect(parsedManifest.version).toBe("1.2.0");
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

  it("blocks page-driven redirects to private sites but still permits task cleanup", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361, ["https://internal.example.test"]);
    const context = vm.createContext({
      URL, String, Number, Object, Array, Set,
      chrome: {
        tabs: { get: async () => ({ id: 7, url: "https://internal.example.test/dashboard" }) },
      },
      readOwnedTabs: async () => ({ "7": { tabId: "personal:7" } }),
      writeOwnedTabs: async () => undefined,
      withOwnershipLock: async (fn: () => Promise<unknown>) => fn(),
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
    });
    vm.runInContext('const BLOCKED_PRIVATE_ORIGINS = new Set(["https://internal.example.test"]);', context);
    for (const fn of ["isPrivateIpv4", "isPrivateHost", "assertPersonalNavigationTarget", "requireOwnedMetadata"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const requireOwnedMetadata = vm.runInContext("requireOwnedMetadata", context) as
      (tabId: number, forCleanup?: boolean) => Promise<Record<string, unknown>>;
    await expect(requireOwnedMetadata(7)).rejects.toMatchObject({ code: "NAVIGATION_BLOCKED" });
    await expect(requireOwnedMetadata(7, true)).resolves.toMatchObject({ tabId: "personal:7" });
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

  it("keeps stable refs and page identity across observations without modifying DOM attributes", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const element = fakeElement({
      tagName: "BUTTON", text: "Submit",
      attributes: { "data-mcp-v3-ref": "site-owned-value" },
    });
    const dom = createDom([element]);
    const snapshotPage = vm.runInContext(
      `(${extractFunction(serviceWorker, "snapshotPage")})`,
      dom.context,
    ) as (generation: string) => {
      pageInstanceId: string;
      refs: Array<{ ref: string }>;
    };
    const first = snapshotPage("first-generation");
    const second = snapshotPage("second-generation");
    expect(second.pageInstanceId).toBe(first.pageInstanceId);
    expect(second.refs[0]!.ref).toBe(first.refs[0]!.ref);
    expect(element.getAttribute("data-mcp-v3-ref")).toBe("site-owned-value");
    expect(element.clickCount).toBe(0);
  });

  it("includes controls inside open shadow roots without altering the host DOM", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const inside = fakeElement({ tagName: "BUTTON", text: "Inside shadow" });
    const host = fakeElement({ tagName: "DIV" });
    (host as FakeElement & { shadowRoot?: unknown }).shadowRoot = {
      querySelectorAll: (_selector: string) => [inside],
    };
    const dom = createDom([host]);
    const snapshotPage = vm.runInContext(
      `(${extractFunction(serviceWorker, "snapshotPage")})`,
      dom.context,
    ) as (generation: string) => {
      refs: Array<{ ref: string; role: string; name: string }>;
      content: string;
    };
    const result = snapshotPage("shadow-1");
    expect(result.refs).toContainEqual(expect.objectContaining({
      role: "button", name: "Inside shadow",
    }));
    expect(result.content).toContain("Inside shadow");
    expect(inside.getAttribute("data-mcp-v3-ref")).toBeNull();
    expect(host.getAttribute("data-mcp-v3-ref")).toBeNull();
  });

  it("invalidates refs from an older snapshot generation", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const snapshotPageSource = extractFunction(serviceWorker, "snapshotPage");
    // References live only in Chrome's isolated extension world, never as DOM attributes.

    const first = fakeElement({ tagName: "BUTTON", text: "First" });
    const second = fakeElement({ tagName: "BUTTON", text: "Second" });
    const dom = createDom([first, second]);
    const snapshotPage = vm.runInContext(
      `(${snapshotPageSource})`,
      dom.context,
    ) as (generation: string) => {
      refs: Array<{ ref: string; role: string; name: string }>;
    };
    const hasRef = vm.runInContext(
      `(ref) => globalThis.__mcpV3OwnedRefElements.has(ref)`,
      dom.context,
    ) as (ref: string) => boolean;

    const firstSnapshot = snapshotPage("generation1");
    const staleRef = firstSnapshot.refs[0]!.ref;

    dom.setInteractiveElements([second]);
    const secondSnapshot = snapshotPage("generation2");
    const currentRef = secondSnapshot.refs[0]!.ref;

    expect(staleRef).not.toBe(currentRef);
    expect(hasRef(staleRef)).toBe(false);
    expect(hasRef(currentRef)).toBe(true);
    expect(first.getAttribute("data-mcp-v3-ref")).toBeNull();
    expect(second.getAttribute("data-mcp-v3-ref")).toBeNull();
    expect(first.clickCount).toBe(0);
    expect(second.clickCount).toBe(0);
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
      if (depth === 0) {
        const body = source.slice(start, index + 1);
        if (name === "readPersonalNetwork") {
          return ["safeNetworkUrl", "safeNetworkHeaders", "safeNetworkBody",
            "startPersonalNetworkCapture", "stopPersonalNetworkCapture"]
            .map((helper) => extractFunction(source, helper)).join("\n") + "\n" + body;
        }
        if (name !== "attachGuardedDebugger" && name !== "detachGuardedDebugger" &&
            name !== "borrowPersonalDebugger" &&
            (body.includes("attachGuardedDebugger(") || body.includes("detachGuardedDebugger("))) {
          return ["borrowPersonalDebugger", "attachGuardedDebugger", "detachGuardedDebugger"]
            .map((helper) => extractFunction(source, helper)).join("\n") + "\n" + body;
        }
        return body;
      }
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
