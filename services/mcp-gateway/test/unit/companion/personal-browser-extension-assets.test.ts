import vm from "node:vm";
import { describe, expect, it } from "@jest/globals";
import { buildPersonalBrowserExtensionAssets, sanitizePersonalDiagnosticText, PERSONAL_BROWSER_MUTATING_OPERATIONS } from "../../../src/companion/personal-browser-extension-assets.js";
import { summarizeCdpAccessibility } from "../../../src/companion/personal-browser-accessibility.js";

type FakeElement = ReturnType<typeof fakeElement>;

describe("personal browser extension assets", () => {
  it("reads an owned top-level document to bounded completeness and fails closed on navigation", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const invoked: string[] = [];
    let stale = false;
    const context = vm.createContext({
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      assertPersonalNavigationTarget: (url: string) => url,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        scripting: { executeScript: async ({ func, args }: {
          func: { name: string }; args: unknown[];
        }) => {
          invoked.push(func.name);
          expect(args[3]).toBe("https://example.com/");
          return [{ result: stale ? { stale: true } : {
            found: true, value: "Entire document",
            ...(func.name === "extractCompletePersonalFrame" ? {
              completeness: { status: "complete", reason: "end-of-document",
                mode: "document", pages: 1, scrolls: 2, bytes: 15 },
            } : {}),
          } }];
        } },
      },
    });
    for (const name of ["extractPage", "extractCompletePersonalFrame", "extract"]) {
      vm.runInContext(extractFunction(serviceWorker, name), context);
    }
    const extract = vm.runInContext("extract", context) as (input: unknown) => Promise<unknown>;
    await expect(extract({ tabId: "personal:7", completion: "document", format: "text" }))
      .resolves.toMatchObject({
        tabId: "personal:7", value: "Entire document",
        completeness: { status: "complete", mode: "document" },
      });
    await expect(extract({ tabId: "personal:7", completion: "visible" }))
      .resolves.toMatchObject({ value: "Entire document" });
    expect(invoked).toEqual(["extractCompletePersonalFrame", "extractPage"]);
    await expect(extract({ tabId: "personal:7",
      completion: "document-and-safe-pagination" })).rejects.toMatchObject({
      code: "BROWSER_CAPABILITY_UNSUPPORTED",
    });
    expect(invoked).toHaveLength(2);
    stale = true;
    await expect(extract({ tabId: "personal:7", completion: "document" }))
      .rejects.toMatchObject({ code: "FRAME_NOT_READY" });
  });

  it("collects a previously observed element ref in document mode without leaking unrelated DOM", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const scroll = { scrollTop: 3, scrollHeight: 100, clientHeight: 100 };
    const child = Object.assign(scroll, {
      tagName: "DIV", isConnected: true, innerText: "Bound element text",
    });
    const context = vm.createContext({
      document: { body: { tagName: "BODY", innerText: "Sensitive unrelated text" },
        scrollingElement: { scrollTop: 0, clientHeight: 500, scrollHeight: 500 } },
      location: { href: "https://example.com/" },
      TextEncoder, Date, setTimeout: (fn: () => void) => { fn(); return 0; },
    });
    vm.runInContext(extractFunction(serviceWorker, "extractCompletePersonalFrame"), context);
    vm.runInContext("globalThis.__mcpV3OwnedRefElements = new Map([['p-1', globalThis.testChild]])",
      Object.assign(context, { testChild: child }));
    const collect = vm.runInContext("extractCompletePersonalFrame", context) as
      (...args: unknown[]) => Promise<Record<string, unknown>>;
    const response = await collect("p-1", null, "text", "https://example.com/");
    expect(response).toMatchObject({ found: true, value: "Bound element text",
      completeness: { mode: "document", status: "complete" } });
    expect(JSON.stringify(response)).not.toContain("Sensitive unrelated text");
    expect(child.scrollTop).toBe(3);
    child.isConnected = false;
    await expect(collect("p-1", null, "text", "https://example.com/"))
      .resolves.toMatchObject({ found: false });
  });

  it("runs multi-frame read-only legacy sequences with indexed refs, assertions and bounded waits", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const calls: string[] = [];
    let waits = 0;
    const frame = { frameId: 15, documentId: "doc1", status: "ready",
      path: ["menu"], url: "https://child.example/" };
    const context = vm.createContext({
      performance: { now: () => 20 }, Date,
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      inspectPersonalFrameGraph: async () => ({ byId: new Map([[15, frame]]) }),
      domIndex: async (input: { framePath: string[] }) => {
        calls.push("index");
        return { items: [{ ref: "lref_12345678", selector: "#save",
          tag: "button", text: "Save" }], truncated: false, totalCount: 1, ...input };
      },
      delay: async () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { scripting: { executeScript: async ({ target, func, args }: {
        target: { frameIds: number[] }; func: { name: string }; args: unknown[];
      }) => {
        calls.push("probe");
        expect(func.name).toBe("probePersonalLegacyReadStep");
        expect(target.frameIds).toEqual([15]);
        expect(args[0]).toBe("https://child.example/");
        const step = args[1] as { action: string };
        const value = step.action === "waitFor"
          ? { satisfied: ++waits >= 2 }
          : step.action === "assert" ? { asserted: true }
            : { found: true, value: "Sanitized content" };
        return [{ frameId: 15, documentId: "doc1", result: value }];
      } } },
    });
    vm.runInContext(extractFunction(serviceWorker, "probePersonalLegacyReadStep"), context);
    vm.runInContext(extractFunction(serviceWorker, "frameSequence"), context);
    const sequence = vm.runInContext("frameSequence", context) as
      (value: unknown) => Promise<Record<string, unknown>>;
    const input = {
      tabId: "personal:7", steps: [
        { action: "index", framePath: ["menu"], limit: 5 },
        { action: "extract", framePath: ["menu"],
          locator: { ref: "lref_12345678" } },
        { action: "assert", framePath: ["menu"],
          locator: { selector: "#save" }, condition: "exists" },
        { action: "waitFor", framePath: ["menu"],
          locator: { selector: "#save" }, state: "visible", timeoutMs: 1000 },
      ],
    };
    const result = await sequence(input);
    expect(result).toMatchObject({ tabId: "personal:7", completed: true,
      steps: [{ action: "index", completed: true },
        { action: "extract", value: "Sanitized content" },
        { action: "assert", completed: true }, { action: "waitFor", completed: true }],
      telemetry: { strategy: "chrome-frame-readonly" } });
    expect(calls.filter(c => c === "index")).toHaveLength(2);
    expect(waits).toBe(2);
  });

  it("rejects unguarded legacy mutations before executing any read, and rejects stale indexed refs", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    let injected = 0;
    const context = vm.createContext({
      performance: { now: () => 1 }, Date,
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      inspectPersonalFrameGraph: async () => ({ byId: new Map([
        [15, { frameId: 15, path: ["menu"], url: "https://child.example/", status: "ready",
          documentId: "doc1" }],
      ]) }),
      domIndex: async () => ({ items: [], truncated: false, totalCount: 0 }),
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { scripting: { executeScript: async () => {
        injected += 1;
        return [{ frameId: 15, documentId: "doc1", result: { asserted: false } }];
      } } },
    });
    vm.runInContext(extractFunction(serviceWorker, "probePersonalLegacyReadStep"), context);
    vm.runInContext(extractFunction(serviceWorker, "frameSequence"), context);
    const sequence = vm.runInContext("frameSequence", context) as
      (input: unknown) => Promise<unknown>;
    await expect(sequence({ tabId: "personal:7", steps: [
      { action: "assert", condition: "frameReady" },
      { action: "click", framePath: ["menu"], locator: { selector: "#danger" } },
    ] })).rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    expect(injected).toBe(0);
    await expect(sequence({ tabId: "personal:7", steps: [
      { action: "extract", framePath: ["menu"], locator: { ref: "lref_deadbeef" } },
    ] })).rejects.toMatchObject({ code: "LOCATOR_NOT_FOUND" });
    expect(injected).toBe(0);
    await expect(sequence({ tabId: "personal:7", steps: [
      { action: "assert", framePath: ["menu"], condition: "frameReady" },
    ] })).rejects.toMatchObject({ code: "STATE_NOT_REACHED" });
    expect(injected).toBe(1);
  });

  it("describes legacy mutation targets without field values and resolves select options exactly", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const option = (value: string, text: string, disabled = false) =>
      ({ value, textContent: text, disabled });
    const options = [option("", "Escolha"), option("sp", "São Paulo"), option("rj", "Rio", true), option("mg", "Minas")];
    const select = {
      tagName: "SELECT", disabled: false, multiple: false, options, value: "SECRET_SELECTED", isContentEditable: false,
      getAttribute: (name: string) => (name === "name" ? "uf" : null),
      getBoundingClientRect: () => ({ left: 10, top: 10, width: 100, height: 20 }),
      scrollIntoView: () => undefined, innerText: "", textContent: "",
    };
    const button = {
      tagName: "INPUT", disabled: false, value: "Salvar", isContentEditable: false, form: {},
      getAttribute: (name: string) => ({ type: "submit" })[name as "type"] ?? null,
      getBoundingClientRect: () => ({ left: 10, top: 40, width: 80, height: 20 }),
      scrollIntoView: () => undefined, innerText: "", textContent: "",
      contains: () => true,
    };
    let current: unknown = select;
    const ctx = vm.createContext({
      location: { href: "https://child.example/" }, innerWidth: 800, innerHeight: 600,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      globalThis: {} as Record<string, unknown>,
      document: { readyState: "complete", body: { innerText: "" },
        querySelectorAll: () => [current], elementFromPoint: () => current },
    });
    vm.runInContext(extractFunction(serviceWorker, "probePersonalLegacyReadStep"), ctx);
    const probe = vm.runInContext("probePersonalLegacyReadStep", ctx) as
      (...args: unknown[]) => Record<string, unknown>;
    const url = "https://child.example/";
    const chosen = probe(url, { action: "select", locator: { name: "uf" }, value: "Minas" }, undefined);
    expect(chosen).toMatchObject({ found: true, point: { x: 60, y: 20 },
      option: { value: "mg", moves: 2 } });
    expect(JSON.stringify(chosen)).not.toContain("SECRET_SELECTED");
    expect(probe(url, { action: "select", locator: { name: "uf" }, value: "Rio" }, undefined))
      .toMatchObject({ missingOption: true });
    expect(probe(url, { action: "select", locator: { name: "uf" }, value: "nope" }, undefined))
      .toMatchObject({ missingOption: true });
    current = button;
    const locator = { selector: "#salvar" };
    expect(probe(url, { action: "click", locator, describeOnly: true }, undefined))
      .toEqual({ found: true, target: { label: "Salvar", role: "input:submit", submitLike: true } });
    expect(probe(url, { action: "fill", locator, value: "v" }, undefined))
      .toMatchObject({ notEditable: true });
    button.contains = () => false;
    (ctx as unknown as { document: { elementFromPoint: () => unknown } }).document.elementFromPoint = () => ({});
    expect(probe(url, { action: "click", locator }, undefined)).toMatchObject({ obscured: true });
    expect(probe("https://other.example/", { action: "click", locator }, undefined))
      .toMatchObject({ stale: true });
  });

  it("maps a nested frame point through each verified parent host and rejects transformed hosts", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const host = (overrides: Record<string, unknown> = {}) => ({
      src: "https://child.example/", clientLeft: 1, clientTop: 1, clientWidth: 200, clientHeight: 100,
      offsetWidth: 202, offsetHeight: 102,
      getAttribute: (name: string) => (name === "name" ? "inner" : null),
      getBoundingClientRect: () => ({ left: 50, top: 60, width: 202, height: 102 }),
      scrollIntoView: () => undefined, ...overrides,
    });
    let hosts = [host()];
    let transform = "none";
    const ctx = vm.createContext({
      location: { href: "https://parent.example/" }, innerWidth: 800, innerHeight: 600, Math, parseFloat,
      getComputedStyle: () => ({ transform, paddingLeft: "0px", paddingTop: "0px",
        paddingRight: "0px", paddingBottom: "0px" }),
      document: { querySelectorAll: () => hosts, elementFromPoint: () => hosts[0] },
    });
    vm.runInContext(extractFunction(serviceWorker, "probePersonalChildFramePoint"), ctx);
    const map = vm.runInContext("probePersonalChildFramePoint", ctx) as
      (...args: unknown[]) => Record<string, unknown>;
    const child = { name: "inner", url: "https://child.example/", width: 200, height: 100 };
    expect(map("https://parent.example/", child, { x: 20, y: 30 }))
      .toMatchObject({ x: 71, y: 91, viewport: { width: 800, height: 600 } });
    expect(map("https://parent.example/", { ...child, width: 150 }, { x: 20, y: 30 }))
      .toMatchObject({ missing: true });
    hosts = [host(), host()];
    expect(map("https://parent.example/", child, { x: 20, y: 30 })).toMatchObject({ ambiguous: true });
    hosts = [host()];
    transform = "scale(2)";
    expect(map("https://parent.example/", child, { x: 20, y: 30 })).toMatchObject({ unsupported: true });
    expect(map("https://elsewhere.example/", child, { x: 1, y: 1 })).toMatchObject({ stale: true });
    // Out-of-view hosts are only scrolled on the first, scroll-allowed pass.
    transform = "none";
    let top = 900;
    let scrolled = 0;
    hosts = [host({ getBoundingClientRect: () => ({ left: 50, top, width: 202, height: 102 }),
      scrollIntoView: () => { scrolled += 1; top = 100; } })];
    expect(map("https://parent.example/", child, { x: 20, y: 30 }, false)).toMatchObject({ outside: true });
    expect(scrolled).toBe(0);
    expect(map("https://parent.example/", child, { x: 20, y: 30 }, true)).toMatchObject({ x: 71, y: 131 });
    expect(scrolled).toBe(1);
  });

  it("runs guarded native fill, select, click and Enter inside a nested frame and waits for its navigation", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    const listeners = { begin: new Set<(d: unknown) => void>(), end: new Set<(d: unknown) => void>() };
    const parent = { frameId: 0, parentFrameId: -1, url: "https://parent.example/", status: "ready",
      documentId: "d0", path: [], data: { name: "" } };
    const mid = { frameId: 4, parentFrameId: 0, url: "https://mid.example/", status: "ready",
      documentId: "d4", path: ["a"], data: { name: "a" } };
    const leaf = { frameId: 9, parentFrameId: 4, url: "https://leaf.example/", status: "ready",
      documentId: "d9", path: ["a", "b"], data: { name: "b" } };
    const graph = { byId: new Map([[0, parent], [4, mid], [9, leaf]]) };
    const labels: Record<string, { label: string; role: string; submitLike: boolean }> = {
      "#nome": { label: "Nome", role: "input:text", submitLike: false },
      "#uf": { label: "UF", role: "select", submitLike: false },
      "#salvar": { label: "Salvar", role: "input:submit", submitLike: true },
    };
    const probed: string[] = [];
    let changedLabel = false;
    let selected = false;
    const context = vm.createContext({
      performance: { now: () => 5 }, Date, JSON, Math, setTimeout,
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      delay: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      inspectPersonalFrameGraph: async () => graph,
      domIndex: async () => ({ items: [] }),
      attachGuardedDebugger: async () => true, detachGuardedDebugger: async () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      parseChromeKey: (key: string) => ({ key, code: key, keyCode: 13, modifiers: 0 }),
      chrome: {
        tabs: { get: async () => ({ url: "https://parent.example/" }) },
        webNavigation: {
          onBeforeNavigate: { addListener: (fn: (d: unknown) => void) => listeners.begin.add(fn),
            removeListener: (fn: (d: unknown) => void) => listeners.begin.delete(fn) },
          onCompleted: { addListener: (fn: (d: unknown) => void) => listeners.end.add(fn),
            removeListener: (fn: (d: unknown) => void) => listeners.end.delete(fn) },
          onErrorOccurred: { addListener: () => undefined, removeListener: () => undefined },
        },
        debugger: { attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_t: unknown, method: string, params: Record<string, unknown>) => {
          commands.push({ method, params });
          if (params.key === "Enter" && params.type === "keyDown") selected = true;
          if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased" &&
              probed.at(-1) === "#salvar") {
            for (const fn of listeners.begin) fn({ tabId: 7, frameId: 9 });
            setTimeout(() => { for (const fn of listeners.end) fn({ tabId: 7, frameId: 9 }); }, 5);
          }
        } },
        scripting: { executeScript: async ({ target, func, args }: {
          target: { frameIds: number[] }; func: { name: string }; args: unknown[];
        }) => {
          const [frameId] = target.frameIds;
          if (func.name === "probePersonalChildFramePoint") {
            const childInfo = args[1] as { name: string };
            return [{ frameId, documentId: frameId === 0 ? "d0" : "d4",
              result: { x: frameId === 0 ? 300 : 100 + (childInfo.name === "b" ? 10 : 0),
                y: frameId === 0 ? 200 : 50, viewport: { width: 800, height: 600 } } }];
          }
          if (func.name === "verifyPersonalLegacyActionTarget") {
            return [{ frameId, documentId: "d9", result: args[1] === "value" ? selected : true }];
          }
          const step = args[1] as { action: string; locator: { selector: string }; describeOnly?: boolean; value?: string };
          const selector = step.locator?.selector;
          probed.push(selector);
          const target2 = { ...labels[selector]!, ...(changedLabel && selector === "#salvar" ? { label: "Excluir" } : {}) };
          if (step.describeOnly) return [{ frameId, documentId: "d9", result: { found: true, target: target2 } }];
          return [{ frameId, documentId: "d9", result: { found: true, target: target2,
            point: { x: 5, y: 6 }, viewport: { width: 400, height: 300 }, editable: selector === "#nome",
            ...(step.action === "select" ? { option: { value: "mg", moves: 2 } } : {}) } }];
        } },
      },
    });
    for (const fn of ["probePersonalLegacyReadStep", "probePersonalChildFramePoint", "resolvePersonalFramePoint",
      "mapPersonalFramePoint",
      "verifyPersonalLegacyActionTarget", "personalLegacyEnter",
      "watchPersonalFrameNavigations", "probePersonalLegacyTarget", "preflightPersonalLegacyTargets",
      "runPersonalLegacyMutation", "frameSequence"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const sequence = vm.runInContext("frameSequence", context) as
      (input: unknown) => Promise<{ steps: Array<Record<string, unknown>>; telemetry: Record<string, unknown> }>;
    const steps = [
      { action: "fill", framePath: ["a", "b"], locator: { selector: "#nome" }, value: "Maria" },
      { action: "select", framePath: ["a", "b"], locator: { selector: "#uf" }, value: "Minas" },
      { action: "click", framePath: ["a", "b"], locator: { selector: "#salvar" } },
      { action: "press", framePath: ["a", "b"], key: "Enter" },
    ];
    const guard = { url: "https://parent.example/" };
    const base = { tabId: "personal:7", steps, guard };
    const described = await sequence({ ...base, phase: "preflight" });
    const keyboard = { label: "keyboard:Enter", role: "keyboard", submitLike: true };
    expect(described.steps).toEqual([
      { index: 2, action: "click", completed: true, value: labels["#salvar"], strategy: "chrome-frame-preflight" },
      { index: 3, action: "press", completed: true, value: keyboard, strategy: "chrome-frame-preflight" },
    ]);
    expect(commands).toHaveLength(0);
    const expectedTargets = [{ index: 2, ...labels["#salvar"] }, { index: 3, ...keyboard }];
    await expect(sequence({ ...base, phase: "execute", expectedTargets: [] }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    changedLabel = true;
    await expect(sequence({ ...base, phase: "execute", expectedTargets }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    expect(commands).toHaveLength(0);
    changedLabel = false;
    const done = await sequence({ ...base, phase: "execute", expectedTargets });
    expect(done.steps.map((step) => step.action)).toEqual(["fill", "select", "click", "press"]);
    expect(done.telemetry.strategy).toBe("chrome-frame-native-input");
    expect(commands.filter((c) => c.method === "Input.insertText").map((c) => c.params.text)).toEqual(["Maria"]);
    // Nested point: leaf (5,6) -> mid host (110,50) -> top host (300,200).
    const pressed = commands.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params.type === "mousePressed");
    expect(pressed.map((c) => [c.params.x, c.params.y])).toEqual([[300, 200], [300, 200], [300, 200]]);
    expect(commands.filter((c) => c.params.key === "ArrowDown")).toHaveLength(4);
    expect(commands.filter((c) => c.params.key === "Enter")).toHaveLength(4);
    expect(listeners.begin.size + listeners.end.size).toBe(0);
  });

  it("walks legacy menu paths with trusted clicks, keeps expanded levels and refuses unconfirmed submits", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const reads: Array<Record<string, unknown>> = [];
    const clicks: string[] = [];
    const visible = new Set(["Cadastros"]);
    let submitLabel = "";
    const context = vm.createContext({
      performance: { now: () => 1 }, Date, Math, JSON,
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}), throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { tabs: { get: async () => ({ url: "https://legacy.example/" }) } },
      frameSequence: async (input: { steps: Array<Record<string, unknown>> }) => {
        const step = input.steps[0]!;
        reads.push(step);
        const label = (step.locator as { text?: string } | undefined)?.text;
        if (step.action === "assert" && (!label || !visible.has(label))) {
          throw Object.assign(new Error("not visible"), { code: "STATE_NOT_REACHED" });
        }
        return { steps: [{ index: 0, action: step.action, completed: true,
          ...(step.action === "extract" ? { value: "Clientes" } : {}) }] };
      },
      probePersonalLegacyTarget: async (_input: unknown, _tab: number, step: { locator: { text: string } }) => ({
        observed: { target: { label: step.locator.text, role: step.locator.text === submitLabel ? "input:submit" : "a",
          submitLike: step.locator.text === submitLabel } } }),
      runPersonalLegacyMutation: async (_input: unknown, _tab: number, _level: number,
        step: { locator: { text: string } }) => {
        clicks.push(step.locator.text);
        if (step.locator.text === "Cadastros") visible.add("Clientes");
        return { completed: true };
      },
    });
    for (const fn of ["personalLegacySignature", "navigatePath"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const navigatePath = vm.runInContext("navigatePath", context) as
      (input: unknown) => Promise<Record<string, unknown>>;
    const route = { tabId: "personal:7", guard: { url: "https://legacy.example/" },
      path: ["Cadastros", "Clientes"], sourceFramePath: ["menu"], targetFramePath: ["main"],
      checkpoint: { action: "extract", framePath: ["main"], locator: { id: "title" } } };
    await expect(navigatePath({ ...route, guard: undefined }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    const first = await navigatePath(route);
    expect(clicks).toEqual(["Cadastros", "Clientes"]);
    expect(first).toMatchObject({ completed: true, destinationReady: true,
      resolved: [{ level: 0, label: "Cadastros", strategy: "chrome-frame-native-input", framePath: ["menu"] },
        { level: 1, label: "Clientes" }],
      checkpoint: { step: { action: "extract", value: "Clientes" } } });
    expect(reads).toContainEqual(expect.objectContaining({ action: "waitFor", framePath: ["main"], state: "ready" }));
    clicks.length = 0;
    const second = await navigatePath(route) as { resolved: Array<{ strategy: string }> };
    expect(clicks).toEqual(["Clientes"]);
    expect(second.resolved[0]!.strategy).toBe("already-expanded");
    clicks.length = 0;
    submitLabel = "Clientes";
    await expect(navigatePath(route)).rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });
    expect(clicks).toEqual([]);
    await expect(navigatePath({ ...route, authorized: true })).resolves.toMatchObject({ completed: true });
    expect(clicks).toEqual(["Clientes"]);
  });

  it("probes read-only legacy elements without exposing sensitive form field values", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const node = {
      tagName: "INPUT", disabled: false, value: "PRIVATE_FORM_VALUE",
      getAttribute: (name: string) => ({ "aria-label": "Search", placeholder: "Search", type: "text" })[name as "type"] ?? null,
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
    };
    const ctx = vm.createContext({
      location: { href: "https://child.example/" },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      document: {
        readyState: "complete",
        body: { innerText: "Safe visible content" },
        querySelectorAll: () => [node],
      },
    });
    vm.runInContext(extractFunction(serviceWorker, "probePersonalLegacyReadStep"), ctx);
    const probe = vm.runInContext("probePersonalLegacyReadStep", ctx) as
      (...args: unknown[]) => Record<string, unknown>;
    const extracted = probe("https://child.example/", {
      action: "extract", format: "text", locator: { selector: "input" },
    }, undefined);
    expect(JSON.stringify(extracted)).not.toContain("PRIVATE_FORM_VALUE");
    expect(probe("https://child.example/", {
      action: "assert", condition: "exists", locator: { selector: "input" },
    }, undefined)).toMatchObject({ asserted: true });
    expect(probe("https://other.example/", {
      action: "assert", condition: "exists", locator: { selector: "input" },
    }, undefined)).toMatchObject({ stale: true });
  });

  it("dispatches confirmed pixel clicks through native Chrome CDP on the unchanged owned tab", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    let pageUrl = "https://example.com/";
    const context = vm.createContext({
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: pageUrl }) },
        scripting: { executeScript: async ({ func, args }: {
          func: { name: string }; args?: unknown[];
        }) => func.name === "probePersonalPixelTarget"
          ? [{ result: { x: args?.[0], y: args?.[1] } }] : [] },
        debugger: {
          attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) =>
            { events.push({ method, params }); },
        },
      },
    });
    for (const fn of ["probePersonalPixelTarget", "click"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const click = vm.runInContext("click", context) as (input: unknown) => Promise<unknown>;
    await expect(click({ tabId: "personal:7", x: 220, y: 170,
      button: "right", guard: { url: pageUrl, pixel: true, x: 220, y: 170 } }))
      .resolves.toMatchObject({ completed: true });
    expect(events.map(e => e.method)).toEqual([
      "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
    ]);
    expect(events[1]?.params).toMatchObject({ type: "mousePressed",
      x: 220, y: 170, button: "right", buttons: 2 });
    events.length = 0;
    await expect(click({ tabId: "personal:7", x: 220, y: 170,
      guard: { url: pageUrl, pixel: true, x: 219, y: 170 } }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    pageUrl = "https://changed.example/";
    await expect(click({ tabId: "personal:7", x: 220, y: 170,
      guard: { url: "https://example.com/", pixel: true, x: 220, y: 170 } }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    expect(events).toHaveLength(0);
  });

  it("rejects stale, empty and out-of-viewport pixel probes", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const location = { href: "https://example.com/" };
    const doc = { elementFromPoint: (x: number, y: number) =>
      (x >= 10 && y >= 10 ? { tagName: "CANVAS" } : null) };
    const context = vm.createContext({ location, document: doc,
      Number, innerWidth: 800, innerHeight: 600 });
    vm.runInContext(extractFunction(serviceWorker, "probePersonalPixelTarget"), context);
    const probe = vm.runInContext("probePersonalPixelTarget", context) as
      (...args: unknown[]) => Record<string, unknown>;
    expect(probe(20, 30, location.href)).toEqual({ x: 20, y: 30 });
    expect(probe(1, 1, location.href)).toMatchObject({ empty: true });
    expect(probe(900, 30, location.href)).toMatchObject({ outside: true });
    expect(probe(20, 30, "https://older.example/")).toMatchObject({ stale: true });
  });

  it("profiles exact Chrome webNavigation frame ancestry and indexes one owned frame without exposing private values", async () => {
    const { serviceWorker, manifest } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    expect((JSON.parse(manifest) as { permissions: string[] }).permissions).toContain("webNavigation");
    const host = {
      url: "https://host.example/", name: "", title: "Portal", readyState: "complete",
      childElementCount: 12, embedded: [
        { id: "menu", name: "menu", src: "https://child.example/path?private=secret" },
      ],
      signals: { layoutTables: 1, inlineHandlers: 2, hashLinks: 1,
        targetedNavigation: 0, postForms: 1 },
    };
    const child = {
      url: "https://child.example/path?private=secret", name: "menu", title: "Menu",
      readyState: "complete", childElementCount: 7, embedded: [],
      signals: { layoutTables: 0, inlineHandlers: 0, hashLinks: 0,
        targetedNavigation: 0, postForms: 0 },
    };
    const routes: string[] = [];
    const navigation = [
      { frameId: 0, parentFrameId: -1, url: host.url },
      { frameId: 15, parentFrameId: 0, url: child.url },
      { frameId: 16, parentFrameId: 0, url: "http://127.0.0.1/admin" },
    ];
    const context = vm.createContext({
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined, performance: { now: () => 50 },
      assertPersonalNavigationTarget: (url: string) => {
        if (url.startsWith("http://127.0.0.1/")) throw new Error("blocked");
        return url;
      },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://host.example/" }) },
        webNavigation: { getAllFrames: async () => navigation },
        scripting: { executeScript: async ({ target, func }: {
          target: { allFrames?: boolean; frameIds?: number[] }; func: { name: string };
        }) => {
          routes.push(func.name);
          if (target.allFrames) return [
            { frameId: 0, documentId: "root", result: host },
            { frameId: 15, documentId: "child-1", result: child },
          ];
          return [{ frameId: 15, documentId: "child-1", result: { items: [
            { id: "save", tag: "button", text: "Save", visible: true,
              enabled: true, selector: "#save", ancestors: [] },
          ], truncated: false, totalCount: 1 } }];
        } },
      },
    });
    for (const name of ["inspectPersonalLegacyDocument", "personalLegacySignature",
      "inspectPersonalFrameGraph", "profilePage", "collectPersonalLegacyIndex", "domIndex"]) {
      vm.runInContext(extractFunction(serviceWorker, name), context);
    }
    const profilePage = vm.runInContext("profilePage", context) as
      (input: unknown) => Promise<Record<string, unknown>>;
    const domIndex = vm.runInContext("domIndex", context) as
      (input: unknown) => Promise<Record<string, unknown>>;
    const profile = await profilePage({ tabId: "personal:7", maxDepth: 8 });
    expect(profile).toMatchObject({
      tabId: "personal:7", profile: "hybrid", signals: {
        frames: 2, nestedFrames: 0, layoutTables: 1, postForms: 1,
      },
    });
    expect((profile.frames as Array<Record<string, unknown>>)[0]).toMatchObject({
      path: ["menu"], status: "ready", index: 0,
    });
    expect((profile.frames as Array<Record<string, unknown>>)[1]).toMatchObject({
      path: ["1"], status: "inaccessible", index: 1,
    });
    const indexed = await domIndex({ tabId: "personal:7", framePath: ["menu"], limit: 10 });
    expect(indexed).toMatchObject({
      framePath: ["menu"], totalCount: 1, truncated: false,
      items: [{ tag: "button", id: "save", ref: expect.stringMatching(/^lref_[a-f0-9]{8}$/),
        framePath: ["menu"] }],
    });
    expect(routes).toContain("collectPersonalLegacyIndex");
    expect(JSON.stringify(indexed)).not.toContain("private=secret");
    expect(JSON.stringify(profile)).not.toContain("127.0.0.1");
    await expect(domIndex({ tabId: "personal:7", framePath: ["missing"] }))
      .rejects.toMatchObject({ code: "FRAME_NOT_FOUND" });
    await expect(domIndex({ tabId: "personal:7", framePath: ["1"] }))
      .rejects.toMatchObject({ code: "FRAME_NOT_READY" });
    navigation[1]!.parentFrameId = 16;
    navigation[2]!.parentFrameId = 15;
    await expect(profilePage({ tabId: "personal:7" }))
      .rejects.toMatchObject({ code: "FRAME_NOT_READY" });
  });

  it("builds legacy selectors without reading personal input or password values", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const input = {
      tagName: "INPUT", nodeType: 1, id: "password", disabled: false,
      value: "DO_NOT_EXPOSE_PRIVATE_VALUE", parentElement: null,
      getAttribute: (name: string) => ({
        id: "password", name: "password", type: "password", placeholder: "Password",
      })[name as "id"] ?? null,
      getBoundingClientRect: () => ({ width: 100, height: 20 }),
    };
    const document = { querySelectorAll: (selector: string) =>
      selector === "#password" ? [input] : [input] };
    const ctx = vm.createContext({ document, location: { href: "https://host.example/" },
      CSS: { escape: (str: string) => str }, URL,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }) });
    vm.runInContext(extractFunction(serviceWorker, "collectPersonalLegacyIndex"), ctx);
    const index = vm.runInContext("collectPersonalLegacyIndex", ctx) as
      (...args: unknown[]) => Record<string, unknown>;
    const result = index("https://host.example/", { visibleOnly: true });
    expect(result).toMatchObject({ totalCount: 1,
      items: [{ id: "password", tag: "input", selector: "#password" }] });
    expect(JSON.stringify(result)).not.toContain("DO_NOT_EXPOSE_PRIVATE_VALUE");
    expect(result).not.toHaveProperty("private");
    expect(index("https://changed.example/", { visibleOnly: false })).toMatchObject({ stale: true });
  });

  it("extracts an exact named cross-origin child frame in the owned Chrome tab without a second browser", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const targets: Array<{ tabId: number; allFrames?: boolean; frameIds?: number[] }> = [];
    const context = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      assertPersonalNavigationTarget: (url: string) => {
        if (url.startsWith("http://127.0.0.1")) throw Object.assign(new Error("private"), { code: "NAVIGATION_BLOCKED" });
        return url;
      },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { scripting: { executeScript: async ({ target }: { target: { tabId: number; allFrames?: boolean; frameIds?: number[] } }) => {
        targets.push(target);
        if (target.allFrames) return [
          { frameId: 0, result: { url: "https://host.example/", name: "", title: "Host" } },
          { frameId: 17, documentId: "child-1", result: { url: "https://frame.example/", name: "content", title: "Details" } },
          { frameId: 18, documentId: "child-2", result: { url: "https://other.example/", name: "other", title: "Other" } },
        ];
        return [{ frameId: 17, documentId: "child-1", result: { found: true, value: "Cross-origin detail" } }];
      } } },
    });
    for (const name of ["describePersonalFrame", "extractPage", "extractCompletePersonalFrame", "frameExtract"]) vm.runInContext(extractFunction(serviceWorker, name), context);
    const extract = vm.runInContext("frameExtract", context) as (input: unknown) => Promise<unknown>;
    await expect(extract({ tabId: "personal:7", frame: "content", format: "text" }))
      .resolves.toEqual({ tabId: "personal:7", frame: "content", format: "text", value: "Cross-origin detail" });
    expect(targets).toEqual([{ tabId: 7, allFrames: true }, { tabId: 7, frameIds: [17] }]);
    await expect(extract({ tabId: "personal:7", frame: "missing" }))
      .rejects.toMatchObject({ code: "FRAME_NOT_FOUND" });
    expect(targets).toHaveLength(3);
    await expect(extract({ tabId: "personal:7", frame: "content", completion: "document" }))
      .resolves.toMatchObject({ tabId: "personal:7", frame: "content", value: "Cross-origin detail" });
    expect(targets).toHaveLength(5);
  });

  it("collects bounded named-frame document text with explicit completeness and restores scroll", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const scroll = { scrollTop: 0, scrollHeight: 260, clientHeight: 100 };
    const body = { tagName: "BODY", get innerText() {
      return scroll.scrollTop < 80 ? "First" : scroll.scrollTop < 160 ? "First Second" : "First Second Third";
    } };
    const context = vm.createContext({ document: { body, scrollingElement: scroll },
      location: { href: "https://child.example/" }, Date, TextEncoder,
      setTimeout: (callback: () => void) => { callback(); return 0; } });
    vm.runInContext(extractFunction(serviceWorker, "extractCompletePersonalFrame"), context);
    const collect = vm.runInContext("extractCompletePersonalFrame", context) as
      (...args: unknown[]) => Promise<Record<string, unknown>>;
    const result = await collect(null, null, "text", "https://child.example/");
    expect(result).toMatchObject({
      found: true, value: "First Second Third",
      completeness: { status: "complete", reason: "end-of-document",
        mode: "document", pages: 1 },
    });
    expect(scroll.scrollTop).toBe(0);
    await expect(collect(null, null, "text", "https://wrong.example/"))
      .resolves.toMatchObject({ found: false, stale: true });
  });

  it("reports partial frame data instead of claiming document completeness when scroll budget is exhausted", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const scroll = { scrollTop: 10, scrollHeight: 100_000, clientHeight: 100 };
    const context = vm.createContext({ document: { body: { tagName: "BODY",
      get innerText() { return "Section " + scroll.scrollTop; } },
    scrollingElement: scroll }, location: { href: "https://child.example/" },
    Date, TextEncoder, setTimeout: (cb: () => void) => { cb(); return 0; } });
    vm.runInContext(extractFunction(serviceWorker, "extractCompletePersonalFrame"), context);
    const collect = vm.runInContext("extractCompletePersonalFrame", context) as
      (...args: unknown[]) => Promise<Record<string, unknown>>;
    const result = await collect(null, null, "text", "https://child.example/");
    expect(result).toMatchObject({
      found: true,
      completeness: { status: "partial", reason: "scroll-limit", scrolls: 12 },
    });
    expect(scroll.scrollTop).toBe(10);
  });

  it("resolves the iframe title attribute across origins only when its URL identifies one child", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const targets: number[][] = [];
    const context = vm.createContext({
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined, assertPersonalNavigationTarget: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { scripting: { executeScript: async ({ target }: { target: { allFrames?: boolean; frameIds?: number[] } }) => {
        if (target.allFrames) return [
          { frameId: 0, result: { url: "https://portal.example/", name: "", title: "Portal",
            embedded: [{ id: "", name: "", title: "Corpo do conteúdo", src: "https://content.example/view" }] } },
          { frameId: 42, documentId: "same-document", result: {
            url: "https://content.example/view", name: "", title: "Unrelated document title" } },
        ];
        targets.push(target.frameIds!);
        return [{ frameId: 42, documentId: "same-document", result: { found: true, value: "Panel content" } }];
      } } },
    });
    for (const name of ["describePersonalFrame", "extractPage", "frameExtract"]) vm.runInContext(extractFunction(serviceWorker, name), context);
    const extract = vm.runInContext("frameExtract", context) as (input: unknown) => Promise<unknown>;
    await expect(extract({ tabId: "personal:7", frame: "Corpo do conteúdo" }))
      .resolves.toEqual({ tabId: "personal:7", frame: "Corpo do conteúdo", format: "text", value: "Panel content" });
    expect(targets).toEqual([[42]]);
  });

  it("rejects ambiguous, private and navigated frames before exposing their contents", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    let mode: "ambiguous" | "private" | "navigated" = "ambiguous";
    let reads = 0;
    const context = vm.createContext({
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      assertPersonalNavigationTarget: (url: string) => {
        if (url.includes("127.0.0.1")) throw Object.assign(new Error("private"), { code: "NAVIGATION_BLOCKED" });
      },
      chrome: { scripting: { executeScript: async ({ target }: { target: { allFrames?: boolean } }) => {
        if (target.allFrames) {
          const url = mode === "private" ? "http://127.0.0.1/admin" : "https://frame.example/";
          return [
            { frameId: 0, result: { url: "https://host.example/", title: "Host" } },
            { frameId: 17, documentId: "before", result: { url, name: "content" } },
            ...(mode === "ambiguous" ? [{ frameId: 18, result: { url, name: "content" } }] : []),
          ];
        }
        reads += 1;
        return [{ frameId: 17, documentId: "after", result: { found: true, value: "not safe" } }];
      } } },
    });
    for (const name of ["describePersonalFrame", "extractPage", "frameExtract"]) vm.runInContext(extractFunction(serviceWorker, name), context);
    const extract = vm.runInContext("frameExtract", context) as (input: unknown) => Promise<unknown>;
    await expect(extract({ tabId: "personal:7", frame: "content" }))
      .rejects.toMatchObject({ code: "LOCATOR_AMBIGUOUS" });
    mode = "private";
    await expect(extract({ tabId: "personal:7", frame: "content" }))
      .rejects.toMatchObject({ code: "NAVIGATION_BLOCKED" });
    expect(reads).toBe(0);
    mode = "navigated";
    await expect(extract({ tabId: "personal:7", frame: "content" }))
      .rejects.toMatchObject({ code: "FRAME_NOT_READY" });
    expect(reads).toBe(1);
  });

  it("uses real CDP events for a uniquely identified direct cross-origin frame and verifies focus before filling", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    let changed = false;
    let focused = true;
    const context = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      assertPersonalNavigationTarget: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      attachGuardedDebugger: async () => true,
      detachGuardedDebugger: async () => undefined,
      chrome: {
        tabs: { get: async () => ({ url: changed ? "https://changed.example/" : "https://host.example/" }) },
        debugger: { attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
          events.push({ method, params });
        } },
        scripting: { executeScript: async ({ target, func }: {
          target: { allFrames?: boolean; frameIds?: number[] }; func: { name: string };
        }) => {
          if (target.allFrames) return [
            { frameId: 0, result: { url: "https://host.example/", embedded: [
              { id: "inner", name: "content", title: "", src: "https://child.example/" },
            ] } },
            { frameId: 17, documentId: "child-1", result: {
              url: "https://child.example/", name: "content", title: "Details",
            } },
          ];
          if (func.name === "probeDirectFrameControl") return [
            { frameId: 17, documentId: "child-1", result: { x: 25, y: 30 } },
          ];
          if (func.name === "probeDirectFrameElement") return [
            { frameId: 0, result: { x: 225, y: 130 } },
          ];
          if (func.name === "confirmDirectFrameFocus") return [
            { frameId: 17, documentId: "child-1", result: focused },
          ];
          throw new Error("Unexpected Chrome script " + func.name);
        } },
      },
    });
    for (const fn of ["describePersonalFrame", "probeDirectFrameControl",
      "probeDirectFrameElement", "confirmDirectFrameFocus",
      "directFrameAction", "frameClick", "frameFill"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const frameClick = vm.runInContext("frameClick", context) as (input: unknown) => Promise<unknown>;
    const frameFill = vm.runInContext("frameFill", context) as (input: unknown) => Promise<unknown>;
    const guard = { url: "https://host.example/" };
    await expect(frameClick({ tabId: "personal:7", frame: "content", selector: "#submit", guard }))
      .resolves.toMatchObject({ completed: true });
    expect(events.map(x => x.method)).toEqual([
      "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
    ]);
    expect(events[1]?.params).toMatchObject({
      x: 225, y: 130, type: "mousePressed", button: "left",
    });
    events.length = 0;
    await expect(frameFill({ tabId: "personal:7", frame: "content",
      selector: "#message", value: "hello", guard })).resolves.toMatchObject({ completed: true });
    expect(events.map(x => x.method)).toEqual([
      "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent",
      "Input.dispatchKeyEvent", "Input.dispatchKeyEvent", "Input.insertText",
    ]);
    expect(events[5]?.params).toEqual({ text: "hello" });
    events.length = 0;
    focused = false;
    await expect(frameFill({ tabId: "personal:7", frame: "content",
      selector: "#message", value: "secret", guard })).rejects.toMatchObject({ code: "FRAME_NOT_READY" });
    expect(events.map(x => x.method)).not.toContain("Input.insertText");
    changed = true;
    await expect(frameClick({ tabId: "personal:7", frame: "content", selector: "#submit", guard }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
  });

  it("refuses obscured direct frames and transformed or ambiguous iframe geometry", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const iframe = { src: "https://child.example/", offsetWidth: 220, offsetHeight: 150,
      clientLeft: 1, clientTop: 1,
      getBoundingClientRect: () => ({ left: 100, top: 80, width: 220, height: 150 }) };
    const document = { querySelectorAll: () => [iframe], elementFromPoint: () => null };
    const context = vm.createContext({ document, location: { href: "https://host.example/" },
      innerWidth: 800, innerHeight: 600, getComputedStyle: () => ({ transform: "none" }), Math });
    vm.runInContext(extractFunction(serviceWorker, "probeDirectFrameElement"), context);
    const probe = vm.runInContext("probeDirectFrameElement", context) as
      (...args: unknown[]) => Record<string, unknown>;
    const args = ["https://host.example/", "https://child.example/", { x: 20, y: 20 }];
    expect(probe(...args)).toMatchObject({ obscured: true });
    document.elementFromPoint = () => iframe as never;
    expect(probe(...args)).toEqual({ x: 121, y: 101 });
    document.querySelectorAll = () => [iframe, iframe];
    expect(probe(...args)).toMatchObject({ ambiguous: true });
    document.querySelectorAll = () => [iframe];
    expect(probe("https://changed.example/", ...args.slice(1))).toMatchObject({ stale: true });
  });

  it("returns a stale-frame guard if navigation occurred before document extraction", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const context = vm.createContext({ location: { href: "https://new.example/" }, document: { body: { innerText: "private" } } });
    vm.runInContext(extractFunction(serviceWorker, "extractPage"), context);
    const read = vm.runInContext("extractPage", context) as (...args: unknown[]) => unknown;
    expect(read(null, null, "text", "https://old.example/")).toEqual({ found: false, stale: true });
  });

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

  it("drags across canvas pixels with native CDP and refuses unmatched screenshot guards", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    const ctx = vm.createContext({
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        scripting: { executeScript: async (request: { args: unknown[] }) => [{
          result: { x: request.args[0], y: request.args[1] },
        }] },
        debugger: { attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
            commands.push({ method, params });
          } },
      },
    });
    for (const fn of ["probePersonalPixelTarget", "drag"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), ctx);
    }
    const drag = vm.runInContext("drag", ctx) as (input: unknown) => Promise<unknown>;
    const input = { tabId: "personal:7", from: { x: 40, y: 60 },
      to: { x: 210, y: 160 }, steps: 4,
      fromGuard: { url: "https://example.com/", pixel: true, x: 40, y: 60 },
      toGuard: { url: "https://example.com/", pixel: true, x: 210, y: 160 } };
    await expect(drag(input)).resolves.toMatchObject({ completed: true });
    expect(commands.find(e => e.params.type === "mousePressed")?.params)
      .toMatchObject({ x: 40, y: 60, buttons: 1 });
    expect(commands.find(e => e.params.type === "mouseReleased")?.params)
      .toMatchObject({ x: 210, y: 160, buttons: 0 });
    commands.length = 0;
    await expect(drag({ ...input, fromGuard: { ...input.fromGuard, x: 41 } }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    expect(commands).toHaveLength(0);
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
      setTimeout: (callback: () => void) => { callback(); return 0; },
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
    vm.runInContext(extractFunction(serviceWorker, "physicalTypingKey"), context);
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
    events.length = 0;
    await typeText({ tabId: "personal:7", text: "Ab7!é", slowly: true,
      guard: { url: "https://example.com/" } });
    expect(events.map(event => event.method)).toEqual([
      "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent", "Input.dispatchKeyEvent",
      "Input.dispatchKeyEvent", "Input.dispatchKeyEvent", "Input.insertText",
    ]);
    expect(events[0]?.params).toMatchObject({ type: "keyDown", key: "A", code: "KeyA", modifiers: 8, text: "A" });
    expect(events[1]?.params).toMatchObject({ type: "keyUp", key: "A" });
    expect(events[2]?.params).toMatchObject({ type: "keyDown", key: "b", code: "KeyB", modifiers: 0, text: "b" });
    expect(events[6]?.params).toMatchObject({ type: "keyDown", key: "!", code: "Digit1", modifiers: 8, text: "!" });
    expect(events[8]?.params).toEqual({ text: "é" });
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

  it("downloads only from an owned tab into an isolated Chrome staging subdirectory", async () => {
    const { serviceWorker, manifest } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const permissions = (JSON.parse(manifest) as { permissions: string[] }).permissions;
    expect(permissions).toContain("downloads");
    const runId = "00000000-0000-4000-8000-000000000007";
    let requestedFilename = "";
    const ctx = vm.createContext({
      URL, Date, setTimeout, clearTimeout,
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      assertPersonalNavigationTarget: (url: string) => url,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.test/" }) },
        downloads: {
          download: async (input: { url: string; filename: string }) => {
            requestedFilename = input.filename;
            expect(input.url).toBe("https://example.test/report.pdf?token=private");
            return 17;
          },
          search: async () => [{
            id: 17, state: "complete",
            filename: "C:\\Users\\Tester\\Downloads\\" + requestedFilename.replaceAll("/", "\\"),
            fileSize: 123,
          }],
          cancel: async () => undefined,
          onCreated: { addListener: () => undefined, removeListener: () => undefined },
          onDeterminingFilename: { addListener: () => undefined, removeListener: () => undefined },
        },
      },
    });
    for (const fn of ["safeChromeDownloadName", "detachGuardedDebugger", "downloadPersonalFile"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), ctx);
    }
    const download = vm.runInContext("downloadPersonalFile", ctx) as
      (input: unknown) => Promise<Record<string, unknown>>;
    const result = await download({
      tabId: "personal:7", url: "https://example.test/report.pdf?token=private", runId,
      guard: { url: "https://example.test/" },
    });
    expect(requestedFilename).toBe("MCP-V3-Staging/" + runId + "/report.pdf");
    expect(result).toMatchObject({ tabId: "personal:7", suggestedFilename: "report.pdf", sizeBytes: 123 });
    expect(String(result.path)).toContain(runId);
    await expect(download({
      tabId: "personal:7", url: "https://example.test/report.pdf", runId,
      guard: { url: "https://different.example/" },
    })).rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
  });

  it("attributes a click download via tab-scoped CDP without relying on nonexistent DownloadItem.tabId", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const runId = "00000000-0000-4000-8000-000000000008";
    const created = new Set<(item: unknown) => void>();
    const determining = new Set<(item: unknown, suggest: (data?: unknown) => void) => void>();
    const cdpListeners = new Set<(target: { tabId: number }, method: string, params: unknown) => void>();
    let filename = "";
    let unrelatedTouched = false;
    const commands: string[] = [];
    const ctx = vm.createContext({
      URL, Date, setTimeout, clearTimeout,
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      probeGuardedElement: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ url: "https://example.test/" }) },
        scripting: { executeScript: async () => [{ result: { x: 25, y: 30 } }] },
        debugger: {
          attach: async () => undefined, detach: async () => undefined,
          onEvent: {
            addListener: (fn: (target: { tabId: number }, method: string, params: unknown) => void) => { cdpListeners.add(fn); },
            removeListener: (fn: (target: { tabId: number }, method: string, params: unknown) => void) => { cdpListeners.delete(fn); },
          },
          sendCommand: async (_target: unknown, method: string, params?: { type?: string }) => {
            commands.push(method);
            if (method === "Input.dispatchMouseEvent" && params?.type === "mouseReleased") {
              // DownloadItem has url/id but no tabId in the real Chrome downloads API.
              for (const listener of created) listener({ id: 100, url: "https://unrelated.test/secret" });
              for (const listener of created) listener({ id: 18, url: "https://example.test/export.csv" });
              for (const listener of cdpListeners) {
                listener({ tabId: 99 }, "Page.downloadWillBegin", { url: "https://unrelated.test/secret" });
                listener({ tabId: 7 }, "Page.downloadWillBegin", { url: "https://example.test/export.csv" });
              }
              for (const listener of determining) {
                listener({ id: 55, url: "https://unrelated.test/secret", filename: "other.txt" }, (data?: unknown) => {
                  if (data !== undefined) unrelatedTouched = true;
                });
                listener({ id: 18, url: "https://example.test/export.csv", filename: "export.csv" }, (data?: unknown) => {
                  filename = (data as { filename: string }).filename;
                });
              }
            }
          },
        },
        downloads: {
          search: async () => [{ id: 18, state: "complete",
            filename: "C:\\Users\\Tester\\Downloads\\" + filename.replaceAll("/", "\\"), fileSize: 5, danger: "safe" }],
          cancel: async () => undefined,
          onCreated: {
            addListener: (fn: (item: unknown) => void) => { created.add(fn); },
            removeListener: (fn: (item: unknown) => void) => { created.delete(fn); },
          },
          onDeterminingFilename: {
            addListener: (fn: (item: unknown, suggest: (data?: unknown) => void) => void) => { determining.add(fn); },
            removeListener: (fn: (item: unknown, suggest: (data?: unknown) => void) => void) => { determining.delete(fn); },
          },
        },
      },
    });
    for (const fn of ["safeChromeDownloadName", "borrowPersonalDebugger",
      "attachGuardedDebugger", "detachGuardedDebugger", "downloadPersonalFile"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), ctx);
    }
    const download = vm.runInContext("downloadPersonalFile", ctx) as
      (input: unknown) => Promise<Record<string, unknown>>;
    const result = await download({ tabId: "personal:7", ref: "p-1", runId,
      guard: { url: "https://example.test/", ref: "p-1", role: "link", name: "Export" } });
    expect(filename).toBe("MCP-V3-Staging/" + runId + "/export.csv");
    expect(result).toMatchObject({ sizeBytes: 5, suggestedFilename: "export.csv" });
    expect(unrelatedTouched).toBe(false);
    expect(commands).toContain("Page.enable");
    expect(commands).toContain("Input.dispatchMouseEvent");
    expect(created.size).toBe(0);
    expect(determining.size).toBe(0);
    expect(cdpListeners.size).toBe(0);
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
    expect(parsedManifest.version).toBe("1.9.0");
    expect(parsedManifest.permissions).toEqual(expect.arrayContaining(["debugger", "tabGroups", "webNavigation"]));
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
