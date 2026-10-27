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
    for (const name of ["extractPage", "extractCompletePersonalFrame", "readPersonalExtraction", "extract"]) {
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
    stale = true;
    await expect(extract({ tabId: "personal:7", completion: "document" }))
      .rejects.toMatchObject({ code: "FRAME_NOT_READY" });
  });

  it("follows only same-origin public rel=next pages within bounds and stops on cycles", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const site = (path: string) => `https://shop.example/${path}`;
    let pages: Record<string, { text: string; next?: string }> = {};
    let current = "";
    const updates: string[] = [];
    const listeners = new Set<(tabId: number, change: { status?: string }) => void>();
    const metadata: Record<string, unknown> = {};
    const context = vm.createContext({
      chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => metadata,
      updateMetadata: async () => undefined, throwIfAborted: () => undefined,
      axTargetsByTab: new Map(), cancellationError: () => new Error("cancelled"),
      preservePersonalConsole: async () => undefined,
      assertPersonalNavigationTarget: (url: string) => {
        if (new URL(url).hostname.endsWith(".internal")) {
          throw Object.assign(new Error("private"), { code: "NAVIGATION_BLOCKED" });
        }
        return url;
      },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      URL, TextEncoder, Date, Math, Number, JSON, String, Promise, Set, setTimeout, clearTimeout,
      chrome: {
        tabs: {
          get: async () => ({ url: current }),
          update: async (_tabId: number, { url }: { url: string }) => {
            updates.push(url);
            setTimeout(() => {
              current = url;
              for (const listener of [...listeners]) listener(7, { status: "loading" });
              for (const listener of [...listeners]) listener(7, { status: "complete" });
            }, 0);
          },
          onUpdated: {
            addListener: (listener: (tabId: number, change: { status?: string }) => void) => listeners.add(listener),
            removeListener: (listener: (tabId: number, change: { status?: string }) => void) => listeners.delete(listener),
          },
        },
        scripting: { executeScript: async ({ func, args }: { func: { name: string }; args: unknown[] }) => {
          const page = pages[current];
          if (func.name === "readPersonalNextPageLink") {
            expect(args[0]).toBe(current);
            return [{ result: page?.next ?? null }];
          }
          return [{ result: { found: true, value: page!.text, completeness: {
            status: "complete", reason: "end-of-document", mode: "document", pages: 1, scrolls: 1, bytes: 1,
          } } }];
        } },
      },
    });
    for (const name of ["extractPage", "extractCompletePersonalFrame", "readPersonalExtraction",
      "extractWithSafePagination", "withoutPersonalHash", "personalTextSignature", "boundPersonalText",
      "probePersonalNextPage", "readPersonalNextPageLink", "loadPersonalTabUrl", "extract"]) {
      vm.runInContext(extractFunction(serviceWorker, name), context);
    }
    vm.runInContext("const PERSONAL_PAGINATION_MAX_PAGES = 5; const PERSONAL_PAGINATION_MAX_BYTES = 480000;" +
      " const PERSONAL_PAGINATION_BUDGET_MS = 50000;", context);
    const extract = vm.runInContext("extract", context) as (input: unknown) => Promise<{
      value: unknown; completeness: Record<string, unknown>;
    }>;
    const run = async (start: string, input: Record<string, unknown> = {}) => {
      current = start;
      updates.length = 0;
      return extract({ tabId: "personal:7", completion: "document-and-safe-pagination", ...input });
    };

    pages = {
      [site("list?page=1")]: { text: "Pedido 1", next: "list?page=2" },
      [site("list?page=2")]: { text: "Pedido 2", next: site("list?page=3#topo") },
      [site("list?page=3#topo")]: { text: "Pedido 3" },
    };
    for (const [url, page] of Object.entries(pages)) {
      if (page.next && !page.next.startsWith("https:")) page.next = new URL(page.next, url).href;
    }
    await expect(run(site("list?page=1"))).resolves.toMatchObject({
      value: "Pedido 1\n\nPedido 2\n\nPedido 3",
      completeness: { status: "complete", reason: "pagination-end", mode: "document-and-safe-pagination",
        pages: 3, scrolls: 3 },
    });
    expect(updates).toEqual([site("list?page=2"), site("list?page=3#topo")]);
    expect(metadata.requestedUrl).toBe(site("list?page=3#topo"));

    pages = {
      [site("a")]: { text: "A", next: "https://other.example/b" },
    };
    await expect(run(site("a"))).resolves.toMatchObject({ value: "A",
      completeness: { status: "partial", reason: "unsafe-pagination", pages: 1, paginationAvailable: true } });
    pages = { [site("a")]: { text: "A", next: "https://shop.internal/b" } };
    await expect(run(site("a"))).resolves.toMatchObject({
      completeness: { reason: "unsafe-pagination", paginationAvailable: true } });
    expect(updates).toEqual([]);

    pages = {
      [site("a")]: { text: "A", next: site("b") },
      [site("b")]: { text: "B", next: site("a#again") },
    };
    await expect(run(site("a"))).resolves.toMatchObject({ value: "A\n\nB",
      completeness: { status: "partial", reason: "cycle", pages: 2 } });
    pages = {
      [site("a")]: { text: "Same", next: site("b") },
      [site("b")]: { text: "Same", next: site("c") },
    };
    await expect(run(site("a"))).resolves.toMatchObject({ value: "Same",
      completeness: { reason: "cycle", pages: 1 } });

    pages = Object.fromEntries(Array.from({ length: 7 }, (_, index) =>
      [site(`p${index}`), { text: `P${index}`, next: site(`p${index + 1}`) }]));
    await expect(run(site("p0"))).resolves.toMatchObject({
      completeness: { status: "partial", reason: "page-limit", pages: 5, paginationAvailable: true } });
    expect(updates).toHaveLength(4);

    pages = { [site("a")]: { text: "A", next: site("b") } };
    await expect(run(site("a"), { format: "html" })).resolves.toMatchObject({
      completeness: { reason: "unsafe-pagination", paginationAvailable: true } });
    await expect(run(site("a"), { ref: "p-1" })).resolves.toMatchObject({
      completeness: { reason: "unsafe-pagination" } });
    metadata.sticky = true;
    await expect(run(site("a"))).resolves.toMatchObject({ completeness: { reason: "unsafe-pagination" } });
    expect(updates).toEqual([]);

    const queue = vm.createContext({ MUTATING_OPERATIONS: new Set(PERSONAL_BROWSER_MUTATING_OPERATIONS) });
    vm.runInContext(extractFunction(serviceWorker, "mutationQueueKey"), queue);
    const queueKey = vm.runInContext("mutationQueueKey", queue) as (operation: string, input: unknown) => unknown;
    expect(queueKey("extract", { tabId: "personal:7", completion: "document-and-safe-pagination" }))
      .toBe("tab:personal:7");
    expect(queueKey("extract", { tabId: "personal:7", completion: "document" })).toBeNull();
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
      .toMatchObject({ missing: true, sizes: ["200x100"] });
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
    expect(map("https://parent.example/", child, { x: 20, y: 30 }, false))
      .toMatchObject({ outside: true, at: "71,931", size: "800x600" });
    expect(scrolled).toBe(0);
    expect(map("https://parent.example/", child, { x: 20, y: 30 }, true)).toMatchObject({ x: 71, y: 131 });
    expect(scrolled).toBe(1);
    (ctx as unknown as { document: { elementFromPoint: () => unknown } }).document.elementFromPoint = () => ({ tagName: "DIV" });
    expect(map("https://parent.example/", child, { x: 20, y: 30 })).toMatchObject({ obscured: true, by: "div" });
    // A frame Chrome has not sized yet is neither measured nor scrolled.
    vm.runInContext(extractFunction(serviceWorker, "revealPersonalChildFrame"), ctx);
    const reveal = vm.runInContext("revealPersonalChildFrame", ctx) as (...args: unknown[]) => boolean;
    top = 900;
    scrolled = 0;
    (ctx as unknown as { innerWidth: number }).innerWidth = 0;
    expect(map("https://parent.example/", child, { x: 20, y: 30 }, true)).toEqual({ unsized: true });
    expect(reveal("https://parent.example/", { name: "inner", url: child.url })).toBe(false);
    expect(scrolled).toBe(0);
    (ctx as unknown as { innerWidth: number }).innerWidth = 800;
    expect(reveal("https://parent.example/", { name: "inner", url: child.url })).toBe(true);
    expect(scrolled).toBe(1);
  });

  it("waits for Chrome to size a nested frame and scrolls ancestors to an outside host before refusing", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const top = { frameId: 0, parentFrameId: -1, url: "https://parent.example/", status: "ready", documentId: "d0", data: {} };
    const mid = { frameId: 4, parentFrameId: 0, url: "https://mid.example/", status: "ready", documentId: "d4", data: { name: "a" } };
    const leaf = { frameId: 9, parentFrameId: 4, url: "https://leaf.example/", status: "ready", documentId: "d9", data: { name: "b" } };
    const graph = { byId: new Map([[0, top], [4, mid], [9, leaf]]) };
    const calls: string[] = [];
    let unsized = 2;
    let outside = 0;
    const context = vm.createContext({
      Math, delay: async () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { scripting: { executeScript: async ({ target, func, args }: {
        target: { frameIds: number[] }; func: { name: string }; args: unknown[];
      }) => {
        const [frameId] = target.frameIds;
        const child = args[1] as { name: string };
        if (func.name === "revealPersonalChildFrame") {
          calls.push("reveal " + frameId + ">" + child.name);
          return [{ frameId, result: true }];
        }
        calls.push("map " + frameId);
        // Chrome gives the mid frame its size only after a few polls.
        let result: Record<string, unknown> = { x: frameId === 0 ? 300 : 110, y: frameId === 0 ? 200 : 50,
          viewport: { width: 800, height: 600 } };
        if (frameId === 4 && unsized > 0) {
          unsized -= 1;
          result = { unsized: true };
        } else if (frameId === 4 && outside > 0) {
          outside -= 1;
          result = { outside: true, at: "110,650", size: "800x600" };
        }
        return [{ frameId, documentId: frameId === 0 ? "d0" : "d4", result }];
      } } },
    });
    for (const fn of ["resolvePersonalFramePoint", "revealPersonalFrameChain", "revealPersonalChildFrame",
      "probePersonalChildFramePoint", "mapPersonalFramePoint"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const resolve = vm.runInContext("resolvePersonalFramePoint", context) as
      (...args: unknown[]) => Promise<{ x: number; y: number }>;
    await expect(resolve(7, graph, leaf, { x: 5, y: 6 }, { width: 400, height: 300 })).resolves.toEqual({ x: 300, y: 200 });
    expect(calls.slice(0, 7)).toEqual(["map 4", "reveal 0>a", "reveal 4>b", "map 4", "reveal 0>a", "reveal 4>b", "map 4"]);

    // A frame that stays unsized is waited for much longer than a host that stays outside.
    unsized = 1000;
    calls.length = 0;
    await expect(resolve(7, graph, leaf, { x: 5, y: 6 }, { width: 400, height: 300 })).rejects.toMatchObject({
      code: "FRAME_NOT_READY",
      message: "Chrome has not given a frame on the way to the target a size yet (its viewport is 0x0), " +
        "so the action point cannot be verified.",
    });
    expect(calls.filter((call) => call === "map 4")).toHaveLength(101);
    unsized = 0;
    outside = 1000;
    calls.length = 0;
    await expect(resolve(7, graph, leaf, { x: 5, y: 6 }, { width: 400, height: 300 })).rejects.toMatchObject({
      code: "BROWSER_CAPABILITY_UNSUPPORTED",
      message: "The frame host is outside the viewport even after scrolling (point 110,650, viewport 800x600).",
    });
    expect(calls.filter((call) => call === "map 4")).toHaveLength(11);
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
    const order: string[] = [];
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
      // Geometry is measured only after the fresh attach's infobar settles.
      settlePersonalViewport: async () => { order.push("settle"); },
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
            order.push("map");
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
    expect(order.filter((entry, index) => entry === "settle" && order[index + 1] === "map")).toHaveLength(3);
    expect(order[0]).toBe("settle");
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
      chrome: { tabs: { onRemoved: { addListener() {} } }, runtime: { onStartup: { addListener() {} }, onInstalled: { addListener() {} } },
        storage: { session: { get: async () => ({}) }, local: { get: async () => ({}) }, onChanged: { addListener() {} } } },
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
    const parseChromeKey = vm.runInContext("parseChromeKey", context) as (key: string) => unknown;
    expect(parseChromeKey("Shift+End")).toEqual({ key: "End", code: "End", keyCode: 35, modifiers: 8 });
    expect(parseChromeKey("pagedown")).toMatchObject({ key: "PageDown", keyCode: 34 });
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
      throwIfAborted: () => undefined, delay: async () => undefined,
      settlePersonalViewport: async () => false,
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
      delay: async () => undefined,
      settlePersonalViewport: async () => false,
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

  it("intercepts native HTML5 drags and re-resolves endpoints after the debugging infobar resizes the page", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const listeners = new Set<(source: { tabId: number }, method: string, params: unknown) => void>();
    let shift = 0;
    let metricsReads = 0;
    const data = { items: [{ mimeType: "text/plain", data: "card" }], dragOperationsMask: -1 };
    const ctx = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      probeGuardedElement: () => undefined,
      throwIfAborted: () => undefined,
      delay: async () => undefined,
      chrome: {
        scripting: { executeScript: async (request: { args: unknown[] }) => [{
          result: { x: request.args[0] === "card" ? 60 : 120, y: (request.args[0] === "card" ? 30 : 230) - shift },
        }] },
        debugger: {
          attach: async () => undefined,
          detach: async () => undefined,
          onEvent: {
            addListener: (fn: (source: { tabId: number }, method: string, params: unknown) => void) => { listeners.add(fn); },
            removeListener: (fn: (source: { tabId: number }, method: string, params: unknown) => void) => { listeners.delete(fn); },
          },
          sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => {
            if (method === "Page.getLayoutMetrics") {
              // The infobar appears just after attach and shifts the layout.
              metricsReads += 1;
              if (metricsReads > 1) shift = 20;
              return { cssLayoutViewport: { clientWidth: 1000, clientHeight: metricsReads > 1 ? 660 : 700 } };
            }
            commands.push({ method, ...(params ? { params } : {}) });
            if (method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved" && params.buttons === 1) {
              for (const listener of listeners) listener({ tabId: 7 }, "Input.dragIntercepted", { data });
            }
            return {};
          },
        },
      },
    });
    for (const fn of ["settlePersonalViewport", "drag"]) vm.runInContext(extractFunction(serviceWorker, fn), ctx);
    const drag = vm.runInContext("drag", ctx) as (input: unknown) => Promise<unknown>;
    await expect(drag({
      tabId: "personal:7", from: { ref: "card" }, to: { ref: "column" }, steps: 5,
      fromGuard: { ref: "card", url: "https://example.com/", role: "button", name: "Card" },
      toGuard: { ref: "column", url: "https://example.com/", role: "button", name: "Column" },
    })).resolves.toMatchObject({ completed: true });
    expect(commands.find((command) => command.params?.type === "mousePressed")?.params).toMatchObject({ x: 60, y: 10 });
    const drags = commands.filter((command) => command.method === "Input.dispatchDragEvent");
    expect(drags.map((command) => command.params?.type)).toEqual(["dragEnter", "dragOver", "drop"]);
    expect(drags[2]?.params).toMatchObject({ x: 120, y: 210, data });
    expect(commands.filter((command) => command.params?.type === "mouseMoved" && command.params.buttons === 1)).toHaveLength(1);
    expect(commands.filter((command) => command.method === "Input.setInterceptDrags").map((command) => command.params?.enabled))
      .toEqual([true, false]);
    expect(commands.at(-1)).toMatchObject({ method: "Input.setInterceptDrags", params: { enabled: false } });
    expect(listeners.size).toBe(0);
    expect(metricsReads).toBeGreaterThanOrEqual(4);
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
    for (const name of ["physicalTypingKey", "imeComposedCharacter", "typeText"]) {
      vm.runInContext(extractFunction(serviceWorker, name), context);
    }
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
    await typeText({ tabId: "personal:7", text: "Ab7!\t", slowly: true,
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
    expect(events[8]?.params).toEqual({ text: "\t" });
  });

  it("types international text as native keystrokes and composes CJK runs through an IME", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    let checks = 0;
    let abortAfter = Number.POSITIVE_INFINITY;
    const context = vm.createContext({
      setTimeout: (callback: () => void) => { callback(); return 0; },
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => {
        checks += 1;
        if (checks > abortAfter) throw Object.assign(new Error("cancelled"), { code: "CANCELLED" });
      },
      chrome: {
        tabs: { get: async () => ({ url: "https://example.com/" }) },
        debugger: {
          attach: async () => undefined, detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params: Record<string, unknown>) => {
            events.push({ method, params });
          },
        },
      },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
    });
    for (const name of ["physicalTypingKey", "imeComposedCharacter", "typeText"]) {
      vm.runInContext(extractFunction(serviceWorker, name), context);
    }
    const typeText = vm.runInContext("typeText", context) as (input: unknown) => Promise<unknown>;
    const guard = { url: "https://example.com/" };
    await typeText({ tabId: "personal:7", text: "çÃß🙂", slowly: true, guard });
    const keyDowns = events.filter((event) => event.params.type === "keyDown").map((event) => event.params);
    expect(events.every((event) => event.method === "Input.dispatchKeyEvent")).toBe(true);
    expect(keyDowns).toEqual([
      expect.objectContaining({ key: "ç", code: "KeyC", windowsVirtualKeyCode: 67, modifiers: 0, text: "ç" }),
      expect.objectContaining({ key: "Ã", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 8, text: "Ã" }),
      expect.objectContaining({ key: "ß", code: "", windowsVirtualKeyCode: 0, modifiers: 0, text: "ß" }),
      expect.objectContaining({ key: "🙂", code: "", windowsVirtualKeyCode: 0, text: "🙂" }),
    ]);

    events.length = 0;
    await typeText({ tabId: "personal:7", text: "a東京b", slowly: true, guard });
    expect(events.map((event) => event.method === "Input.dispatchKeyEvent"
      ? event.method + ":" + String(event.params.type) + ":" + String(event.params.key)
      : event.method + ":" + String(event.params.text))).toEqual([
      "Input.dispatchKeyEvent:keyDown:a", "Input.dispatchKeyEvent:keyUp:a",
      "Input.dispatchKeyEvent:rawKeyDown:Process", "Input.imeSetComposition:東", "Input.dispatchKeyEvent:keyUp:Process",
      "Input.dispatchKeyEvent:rawKeyDown:Process", "Input.imeSetComposition:東京", "Input.dispatchKeyEvent:keyUp:Process",
      "Input.insertText:東京",
      "Input.dispatchKeyEvent:keyDown:b", "Input.dispatchKeyEvent:keyUp:b",
    ]);
    expect(events[3]?.params).toEqual({ text: "東", selectionStart: 1, selectionEnd: 1 });

    events.length = 0;
    checks = 0;
    abortAfter = 3;
    await expect(typeText({ tabId: "personal:7", text: "東京都", slowly: true, guard }))
      .rejects.toMatchObject({ code: "CANCELLED" });
    expect(events.map((event) => event.method)).not.toContain("Input.insertText");
    expect(events.at(-1)).toEqual({
      method: "Input.imeSetComposition", params: { text: "", selectionStart: 0, selectionEnd: 0 },
    });
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

  it("drops staged files on a confirmed drop zone with trusted CDP drag events", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    let probe: Record<string, unknown> = { x: 40, y: 60 };
    const context = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      probeGuardedElement: () => undefined,
      chrome: {
        tabs: { get: async () => ({ url: "https://upload.example/" }) },
        scripting: { executeScript: async ({ args }: { args: unknown[] }) => {
          expect(args).toEqual(["p-9", expect.objectContaining({ ref: "p-9" }), false, null, null]);
          return [{ result: probe }];
        } },
        debugger: {
          attach: async () => undefined,
          detach: async () => undefined,
          sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => {
            commands.push({ method, ...(params ? { params } : {}) });
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
      tabId: "personal:7", dropRef: "p-9",
      guard: { url: "https://upload.example/", ref: "p-9", role: "button", name: "Soltar arquivos" },
      files: [{ name: "a.txt", path: "/private/staged-1/a.txt" }, { name: "b.txt", path: "/private/staged-1/b.txt" }],
      totalBytes: 10,
    };
    await expect(upload(input)).resolves.toEqual({ tabId: "personal:7", completed: true, fileCount: 2, totalBytes: 10 });
    const drags = commands.filter((command) => command.method === "Input.dispatchDragEvent");
    expect(drags.map((command) => command.params?.type)).toEqual(["dragEnter", "dragOver", "drop"]);
    expect(drags[2]?.params).toMatchObject({ x: 40, y: 60,
      data: { items: [], files: ["/private/staged-1/a.txt", "/private/staged-1/b.txt"] } });
    expect(commands.some((command) => command.method === "DOM.setFileInputFiles")).toBe(false);

    commands.length = 0;
    probe = { error: "obscured" };
    await expect(upload(input)).rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    await expect(upload({ ...input, guard: { ...input.guard, ref: "p-1" } }))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    await expect(upload({ ...input, selector: "input[type=file]" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(commands.filter((command) => command.method === "Input.dispatchDragEvent")).toHaveLength(0);
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

  it("records fresh captures as WebP stills, skips unchanged pages and the user's turn, and ends with the page as it is", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const methods: Array<[string, Record<string, unknown> | undefined]> = [];
    const sent: Array<Record<string, unknown>> = [];
    const decoded: string[] = [];
    const draws: unknown[][] = [];
    const timers = new Map<number, () => void>();
    let nextTimer = 0;
    let attached = 0;
    let detached = 0;
    let handoff: unknown;
    let active = true;
    let page = "white";
    class FakeCanvas {
      constructor(readonly width: number, readonly height: number) {}
      getContext() {
        return { fillStyle: "", fillRect() {}, drawImage: (...args: unknown[]) => { draws.push(args.slice(1)); } };
      }
      async convertToBlob(options: { type: string }) {
        return new Blob([`${options.type} ${this.width}x${this.height} ${decoded.at(-1)}`]);
      }
    }
    const ctx = vm.createContext({
      Map, Promise, Math, Number, String, Uint8Array, Blob, atob, btoa,
      OffscreenCanvas: FakeCanvas,
      createImageBitmap: async (blob: Blob) => {
        decoded.push(await blob.text());
        return { width: 801, height: 451, close() {} };
      },
      setTimeout: (callback: () => void) => {
        nextTimer += 1;
        timers.set(nextTimer, callback);
        return nextTimer;
      },
      clearTimeout: (id: number) => { timers.delete(id); },
      delay: () => new Promise(() => undefined),
      chromeTabIdFrom: (id: string) => Number(id.slice("personal:".length)),
      requireOwnedMetadata: async () => ({}),
      readPersonalHandoff: async () => handoff,
      throwIfAborted: () => undefined,
      cancellationError: () => new Error("cancelled"),
      send: (value: Record<string, unknown>) => { sent.push(value); },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ id: 7, active }) },
        debugger: {
          attach: async () => { attached += 1; },
          detach: async () => { detached += 1; },
          sendCommand: async (_target: unknown, method: string, params?: Record<string, unknown>) => {
            methods.push([method, params]);
            if (method === "Page.getLayoutMetrics") {
              return { cssVisualViewport: { clientWidth: 1600, clientHeight: 900, pageX: 0, pageY: 40 } };
            }
            return method === "Page.captureScreenshot" ? { data: Buffer.from(page).toString("base64") } : {};
          },
        },
      },
    });
    vm.runInContext("const personalViewportSessions = new Map(); globalThis.__mcpV3PersonalViewportSessions = personalViewportSessions; " +
      "const personalDialogArms = new Map(); globalThis.__mcpV3PersonalDialogArms = personalDialogArms; " +
      "const personalNetworkCaptures = new Map(); globalThis.__mcpV3PersonalNetworkCaptures = personalNetworkCaptures; " +
      "const PERSONAL_RECORDING_FRAME_MS = 200; const personalRecordings = new Map(); " +
      "globalThis.__mcpV3PersonalRecordings = personalRecordings;", ctx);
    for (const name of ["startPersonalRecording", "schedulePersonalRecordingFrame", "capturePersonalRecordingFrame",
      "sendPersonalRecordingFrame", "stopPersonalRecording", "endPersonalRecording", "releasePersonalRecordingDebugger",
      "endAllPersonalRecordings", "cancelPersonalRecording", "personalBase64Bytes", "personalBytesBase64"]) {
      vm.runInContext(extractFunction(serviceWorker, name), ctx);
    }
    const start = vm.runInContext("startPersonalRecording", ctx) as (input: unknown) => Promise<Record<string, unknown>>;
    const stop = vm.runInContext("stopPersonalRecording", ctx) as (input: unknown) => Promise<Record<string, unknown>>;
    const attachDebugger = vm.runInContext("attachGuardedDebugger", ctx) as (target: unknown) => Promise<boolean>;
    const detachDebugger = vm.runInContext("detachGuardedDebugger", ctx) as (target: unknown, attached: boolean) => Promise<void>;
    const tick = async () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
      await vm.runInContext("personalRecordings.get('7')?.flight", ctx);
    };
    const frames = () => sent.filter((message) => message.type === "recording-frame")
      .map((message) => Buffer.from(String(message.data), "base64").toString());
    const recordingId = "3f1c2b9a-1111-4222-8333-444455556666";

    await expect(start({ tabId: "personal:7", recordingId: "nope" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(start({ tabId: "personal:7", recordingId })).resolves.toEqual({ tabId: "personal:7", recordingId, active: true });
    await expect(start({ tabId: "personal:7", recordingId })).resolves.toMatchObject({ active: true });
    await expect(start({ tabId: "personal:7", recordingId: "3f1c2b9a-1111-4222-8333-000000000000" }))
      .rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
    expect(attached).toBe(1);
    // The visible page, scaled to fit 1280x720, opens the recording on an even canvas.
    expect(methods.find(([method]) => method === "Page.captureScreenshot")?.[1]).toEqual({
      format: "jpeg", quality: 80, optimizeForSpeed: true,
      clip: { x: 0, y: 40, width: 1600, height: 900, scale: 0.8 },
    });
    expect(frames()).toEqual(["image/webp 802x452 white"]);
    expect(sent[0]).toMatchObject({ type: "recording-frame", recordingId });
    expect(draws[0]).toEqual([0, 0, 802, 452]);

    // Unchanged pages, background tabs and the user's turn add nothing.
    await tick();
    active = false;
    page = "hidden";
    await tick();
    active = true;
    handoff = { reason: "login" };
    page = "password";
    await tick();
    expect(frames()).toEqual(["image/webp 802x452 white"]);
    handoff = undefined;
    page = "green";
    await tick();
    expect(frames()).toEqual(["image/webp 802x452 white", "image/webp 802x452 green"]);

    // A borrowed debugger keeps the recording until its borrower ends.
    expect(await attachDebugger({ tabId: 7 })).toBe(false);
    await expect(stop({ tabId: "personal:7", recordingId })).rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
    await detachDebugger({ tabId: 7 }, false);
    page = "final";
    await expect(stop({ tabId: "personal:7", recordingId })).resolves.toEqual({ tabId: "personal:7", recordingId, active: false });
    expect(frames().at(-1)).toBe("image/webp 802x452 final");
    expect([attached, detached]).toEqual([1, 1]);
    expect(timers.size).toBe(0);
    await expect(stop({ tabId: "personal:7", recordingId })).resolves.toMatchObject({ active: false });

    // Chrome ending the session tells the bridge; losing the bridge ends every recording.
    await start({ tabId: "personal:7", recordingId, width: 640, height: 360 });
    expect(methods.filter(([method]) => method === "Page.captureScreenshot").at(-1)?.[1])
      .toMatchObject({ clip: { scale: 0.4 } });
    vm.runInContext("endPersonalRecording(personalRecordings.get('7'), true)", ctx);
    expect(sent.at(-1)).toEqual({ type: "recording-ended", recordingId });
    await start({ tabId: "personal:7", recordingId });
    vm.runInContext("endAllPersonalRecordings()", ctx);
    await Promise.resolve();
    expect(vm.runInContext("personalRecordings.size", ctx)).toBe(0);
    expect(detached).toBe(2);
    // The bridge cancels only the recording it no longer wants.
    await start({ tabId: "personal:7", recordingId });
    vm.runInContext("cancelPersonalRecording('3f1c2b9a-1111-4222-8333-000000000000')", ctx);
    expect(vm.runInContext("personalRecordings.size", ctx)).toBe(1);
    vm.runInContext(`cancelPersonalRecording("${recordingId}")`, ctx);
    await Promise.resolve();
    expect(vm.runInContext("personalRecordings.size", ctx)).toBe(0);
    expect(detached).toBe(3);
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
    // The reset result must satisfy the strict viewport result contract.
    await expect(setViewport({ tabId: "personal:7", preset: "reset" }))
      .resolves.toEqual({ tabId: "personal:7", width: 1280, height: 720,
        deviceScaleFactor: 1.25, colorScheme: "dark", emulated: false, mobile: false, touch: false,
        userAgent: "Mozilla/5.0 Chrome/155.0.0.0 Safari/537.36" });
    expect(methods).toContain("Emulation.clearDeviceMetricsOverride");
    expect(detached).toBe(1);
    expect(listeners.size).toBe(0);
    expect(vm.runInContext("personalViewportSessions.size", ctx)).toBe(0);
  });

  it("resizes a real window only after moving a shared owned tab into its own window", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const calls: Array<[string, unknown]> = [];
    let windowId = 1;
    let tabCount = 3;
    let pageWidth = 1280;
    const resets: number[] = [];
    const ctx = vm.createContext({
      Map, Promise,
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      delay: async () => undefined,
      resetPersonalViewport: async (chromeTabId: number) => {
        resets.push(chromeTabId);
        vm.runInContext("personalViewportSessions.clear()", ctx);
      },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async () => ({ id: 7, windowId, url: "https://example.com/" }) },
        windows: {
          get: async (id: number, options: unknown) => {
            calls.push(["get", { id, options }]);
            return { id, type: "normal", tabs: Array.from({ length: tabCount }, (_, index) => ({ id: index })) };
          },
          create: async (options: Record<string, unknown>) => {
            calls.push(["create", options]);
            windowId = 2;
            tabCount = 1;
            return { id: 2 };
          },
          update: async (id: number, options: Record<string, unknown>) => {
            calls.push(["update", { id, ...options }]);
            pageWidth = Number(options.width) - 16;
            return { id, width: options.width, height: options.height };
          },
        },
        scripting: {
          executeScript: async () => [{ result: {
            width: pageWidth, height: 600, dpr: 1.5, userAgent: "Mozilla/5.0 Chrome/155.0.0.0",
            touch: false, colorScheme: "light",
          } }],
        },
      },
    });
    vm.runInContext("const personalViewportSessions = new Map([['7', { borrowers: 0 }]]);", ctx);
    for (const name of ["resizePersonalWindow", "configurePersonalViewport"]) {
      vm.runInContext(extractFunction(serviceWorker, name), ctx);
    }
    const setViewport = vm.runInContext("configurePersonalViewport", ctx) as
      (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

    await expect(setViewport({ tabId: "personal:7", preset: "window", width: 900, height: 700 }))
      .resolves.toEqual({
        tabId: "personal:7", width: 884, height: 600, deviceScaleFactor: 1.5, mobile: false, touch: false,
        colorScheme: "light", userAgent: "Mozilla/5.0 Chrome/155.0.0.0", emulated: false,
        window: { width: 900, height: 700 },
      });
    expect(resets).toEqual([7]);
    expect(calls).toEqual([
      ["get", { id: 1, options: { populate: true } }],
      ["create", { tabId: 7, focused: false, state: "normal", width: 900, height: 700 }],
      ["update", { id: 2, state: "normal", width: 900, height: 700 }],
    ]);

    calls.length = 0;
    await expect(setViewport({ tabId: "personal:7", preset: "window", width: 1024, height: 768 }))
      .resolves.toMatchObject({ width: 1008, window: { width: 1024, height: 768 } });
    expect(calls.map(([kind]) => kind)).toEqual(["get", "update"]);
    expect(resets).toEqual([7]);
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
    const session = new Map<string, unknown>();
    const context = vm.createContext({
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({}),
      throwIfAborted: () => undefined,
      cancellationError: () => new Error("cancelled"),
      setTimeout: (fn: () => void) => { fn(); return 1; },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      sanitizePersonalDiagnosticText,
      chrome: {
        storage: { session: {
          get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
          set: async (value: Record<string, unknown>) => {
            for (const [key, item] of Object.entries(value)) session.set(key, JSON.parse(JSON.stringify(item)));
          },
          remove: async (key: string) => { session.delete(key); },
        } },
        debugger: {
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
                listener({ tabId: 999 }, "Runtime.consoleAPICalled", { type: "error", timestamp: 1, args: [{ value: "wrong tab" }] });
                listener({ tabId: 7 }, "Runtime.consoleAPICalled", { type: "log", timestamp: 2, args: [{ value: "ordinary event" }] });
                listener({ tabId: 7 }, "Runtime.consoleAPICalled", { type: "error", timestamp: 3, args: [{ value: "Authorization: Bearer hidden-key" }] });
                listener({ tabId: 7 }, "Runtime.exceptionThrown", { timestamp: 4, exceptionDetails: { text: "TypeError: failed" } });
              }
            }
            return {};
          },
        },
      },
    });
    vm.runInContext("const personalConsoleEntries = new Map();" +
      " const PERSONAL_CONSOLE_STORAGE_PREFIX = 'mcpV3PersonalConsole:'; const PERSONAL_CONSOLE_MAX_ENTRIES = 500;", context);
    for (const name of ["loadPersonalConsoleHistory", "savePersonalConsoleHistory", "clearPersonalConsoleHistory",
      "collectPersonalConsole", "readPersonalConsole"]) {
      vm.runInContext(extractFunction(serviceWorker, name), context);
    }
    const consoleRead = vm.runInContext("readPersonalConsole", context) as (input: unknown) => Promise<Record<string, unknown>>;
    const result = await consoleRead({ tabId: "personal:7", onlyErrors: true, pattern: "Authorization|TypeError", limit: 1, clear: true });
    expect(result).toMatchObject({ tabId: "personal:7", truncated: true });
    expect(result.text).toContain("Authorization: [redacted]");
    expect(JSON.stringify(result)).not.toContain("hidden-key");
    expect(JSON.stringify(result)).not.toContain("ordinary event");
    expect(commands).toEqual(["attach", "Runtime.enable", "Log.enable", "detach"]);
    expect(listeners.size).toBe(0);
    expect(vm.runInContext("personalConsoleEntries.size", context)).toBe(0);
    expect(session.size).toBe(0);
    await expect(consoleRead({ tabId: "personal:7", pattern: "[" }))
      .rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("keeps a deduplicated console history across reads, worker restarts and MCP navigations", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const listeners = new Set<(source: { tabId: number }, name: string, args: unknown) => void>();
    const session = new Map<string, unknown>();
    let documentMessages: Array<{ type: string; timestamp: number; text: string }> = [
      { type: "error", timestamp: 10, text: "first page failed" },
      { type: "log", timestamp: 11, text: "first page ready" },
    ];
    const chrome = {
      storage: { session: {
        get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (value: Record<string, unknown>) => {
          for (const [key, item] of Object.entries(value)) session.set(key, JSON.parse(JSON.stringify(item)));
        },
        remove: async (key: string) => { session.delete(key); },
      } },
      debugger: {
        onEvent: {
          addListener(fn: (source: { tabId: number }, name: string, args: unknown) => void) { listeners.add(fn); },
          removeListener(fn: (source: { tabId: number }, name: string, args: unknown) => void) { listeners.delete(fn); },
        },
        attach: async () => undefined,
        detach: async () => undefined,
        sendCommand: async (_target: unknown, method: string) => {
          if (method === "Runtime.enable") {
            for (const listener of listeners) {
              for (const message of documentMessages) {
                listener({ tabId: 7 }, "Runtime.consoleAPICalled",
                  { type: message.type, timestamp: message.timestamp, args: [{ value: message.text }] });
              }
            }
          }
          return {};
        },
      },
    };
    const worker = () => {
      const context = vm.createContext({
        chromeTabIdFrom: () => 7, requireOwnedMetadata: async () => ({}), throwIfAborted: () => undefined,
        cancellationError: () => new Error("cancelled"), setTimeout: (fn: () => void) => { fn(); return 1; },
        coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
        sanitizePersonalDiagnosticText, chrome,
      });
      vm.runInContext("const personalConsoleEntries = new Map();" +
        " const PERSONAL_CONSOLE_STORAGE_PREFIX = 'mcpV3PersonalConsole:'; const PERSONAL_CONSOLE_MAX_ENTRIES = 500;", context);
      for (const name of ["loadPersonalConsoleHistory", "savePersonalConsoleHistory", "clearPersonalConsoleHistory",
        "hasPersonalConsoleHistory", "collectPersonalConsole", "preservePersonalConsole", "readPersonalConsole"]) {
        vm.runInContext(extractFunction(serviceWorker, name), context);
      }
      return {
        read: vm.runInContext("readPersonalConsole", context) as (input: unknown) => Promise<{ text: string }>,
        preserve: vm.runInContext("preservePersonalConsole", context) as (tabId: number) => Promise<void>,
      };
    };

    const first = worker();
    await first.preserve(7);
    expect(session.size).toBe(0);
    expect((await first.read({ tabId: "personal:7" })).text).toBe("[error] first page failed\n[info] first page ready");
    expect((await first.read({ tabId: "personal:7" })).text).toBe("[error] first page failed\n[info] first page ready");
    documentMessages.push({ type: "warning", timestamp: 12, text: "late warning" });
    await first.preserve(7);
    documentMessages = [{ type: "error", timestamp: 20, text: "second page failed" }];

    const restarted = worker();
    expect((await restarted.read({ tabId: "personal:7", level: "warning" })).text)
      .toBe("[error] first page failed\n[warning] late warning\n[error] second page failed");
    await restarted.read({ tabId: "personal:7", clear: true });
    expect(session.size).toBe(0);
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

    // Zoom re-renders the clip at a higher resolution, bounded by the pixel budget.
    await screenshot({ tabId: "personal:7", region: { x: 10, y: 20, width: 200, height: 100 }, scale: "device", zoom: 3 });
    expect(commands.find((c) => c.name === "Page.captureScreenshot")?.params).toMatchObject({
      clip: { x: 42, y: 100, width: 200, height: 100, scale: 6 },
    });
    commands.length = 0;
    await expect(screenshot({ tabId: "personal:7", region: { x: 0, y: 0, width: 800, height: 600 },
      scale: "device", zoom: 8 }))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(screenshot({ tabId: "personal:7", zoom: 2 })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
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
    const parsedManifest = JSON.parse(manifest) as { version: string; permissions: string[];
      content_security_policy: { extension_pages: string } };
    expect(parsedManifest.version).toBe("1.11.2");
    // Notification icons are data: URLs that Chrome fetches under this policy.
    expect(parsedManifest.content_security_policy.extension_pages)
      .toBe("script-src 'self'; object-src 'self'; connect-src 'self' data: ws://127.0.0.1:3361");
    expect(parsedManifest.permissions).toEqual(expect.arrayContaining(["debugger", "tabGroups", "webNavigation",
      "declarativeNetRequest"]));
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

  it("shares only tabs the user picks in the popup, lists other tabs only on opt-in and never closes shared tabs", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const owned: Record<string, Record<string, unknown>> = {
      "3": { tabId: "personal:3", ownership: "mcp", taskId: "t1", purpose: "x" },
    };
    const session = new Map<string, unknown>();
    const badges: Array<[number, string]> = [];
    const removed: number[] = [];
    const openTabs = new Map<number, Record<string, unknown>>([
      [3, { id: 3, url: "https://mcp.example/", title: "MCP", active: false }],
      [5, { id: 5, url: "https://mail.example/inbox?token=abc#msg", title: "Inbox (3)", active: true }],
      [6, { id: 6, url: "http://intranet.local/", title: "Intranet", active: false }],
      [8, { id: 8, url: "chrome://settings/", title: "Settings", active: false }],
    ]);
    const context = vm.createContext({
      URL, String, Number, Object, Array, Set, Date, Promise,
      withOwnershipLock: async (fn: () => Promise<unknown>) => fn(),
      readOwnedTabs: async () => owned,
      writeOwnedTabs: async () => undefined,
      removeOwnedTab: async (id: number) => { delete owned[String(id)]; },
      finalizePersonalDialog: async () => undefined,
      resetPersonalViewport: async () => undefined,
      axTargetsByTab: new Map(),
      taskGroups: new Map(),
      clearPersonalPlans: async () => undefined,
      clearPersonalTaskApprovals: async () => undefined,
      clearPersonalTabApprovals: async () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: {
          get: async (id: number) => {
            const tab = openTabs.get(id);
            if (!tab) throw new Error("No tab");
            return tab;
          },
          query: async () => [...openTabs.values()],
          remove: async (id: number) => { removed.push(id); openTabs.delete(id); },
          ungroup: async () => undefined,
        },
        storage: { session: {
          get: async (key: string) => ({ [key]: session.get(key) }),
          set: async (entries: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(entries)) session.set(key, value);
          },
          remove: async (key: string) => { session.delete(key); },
        }, local: { get: async () => ({}) } },
        action: { setBadgeText: async ({ tabId, text }: { tabId: number; text: string }) => { badges.push([tabId, text]); } },
      },
    });
    vm.runInContext('const BLOCKED_PRIVATE_ORIGINS = new Set(); const PERSONAL_PREFIX = "personal:"; ' +
      'const PERSONAL_TAB_CONTEXT_KEY = "mcpV3PersonalTabContext";', context);
    vm.runInContext('const PERSONAL_HANDOFF_PREFIX = "mcpV3PersonalHandoff:"; ' +
      'const PERSONAL_NOTIFY_ON_FINISH_KEY = "mcpV3NotifyOnFinish"; const PERSONAL_REQUIRE_PLAN_KEY = "mcpV3RequirePlan"; ' +
      'const PERSONAL_SITE_GRANTS_KEY = "mcpV3SiteGrants"; const PERSONAL_AUTO_SITES_KEY = "mcpV3AutoApproveSites"; ' +
      'const PERSONAL_APPROVAL_REQUEST_PREFIX = "mcpV3ApprovalRequest:";', context);
    for (const fn of ["isPrivateIpv4", "isPrivateHost", "assertPersonalNavigationTarget", "toBrowserTab",
      "personalTabContextEnabled", "personalPlanRequired", "listPersonalOpenTabs", "personalTabSharingDispatch",
      "personalApprovalStatus", "readPersonalApprovalRequest", "readPersonalSiteGrants", "readPersonalAutoSites",
      "clearPersonalApprovalRequest",
      "releasePersonalSharedTab", "setPersonalSharedBadge", "tabs", "finishTask",
      "readPersonalHandoff", "resumePersonalHandoff", "clearPersonalHandoff", "settlePersonalHandoffSignals",
      "notifyPersonalTaskFinished"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const dispatch = vm.runInContext("personalTabSharingDispatch", context) as
      (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const listTabs = vm.runInContext("tabs", context) as
      (input: Record<string, unknown>) => Promise<{ tabs: Array<Record<string, unknown>>; openTabs?: unknown[] }>;
    const finish = vm.runInContext("finishTask", context) as
      (input: Record<string, unknown>) => Promise<Record<string, unknown>>;

    await expect(dispatch({ type: "mcp-tab-status", tabId: 5 })).resolves.toEqual({
      ok: true, shared: false, mcp: false, shareable: true, context: false, notify: false, requirePlan: false,
      autoEligible: true, auto: false, autoSites: [], grants: [],
    });
    expect((await listTabs({})).openTabs).toBeUndefined();
    await expect(dispatch({ type: "mcp-tab-share", tabId: 6 })).rejects.toMatchObject({ code: "NAVIGATION_BLOCKED" });
    await expect(dispatch({ type: "mcp-tab-share", tabId: 3 })).rejects.toThrow("already-owned");
    await expect(dispatch({ type: "mcp-tab-status", tabId: 3 })).resolves.toMatchObject({ mcp: true, shareable: false });
    await expect(dispatch({ type: "mcp-tab-share", tabId: 5 })).resolves.toMatchObject({ shared: true, shareable: false });
    expect(owned["5"]).toMatchObject({ tabId: "personal:5", ownership: "user", lifecycle: "external",
      protected: true, requestedUrl: "https://mail.example/inbox?token=abc#msg" });
    expect(badges).toEqual([[5, "MCP"]]);

    await dispatch({ type: "mcp-tab-context", tabId: 5, enabled: true });
    const listed = await listTabs({});
    expect(listed.tabs.map((tab) => [tab.tabId, tab.ownership])).toEqual([["personal:3", "mcp"], ["personal:5", "user"]]);
    // Owned tabs, private hosts and Chrome pages stay out; query and fragment are dropped.
    expect(listed.openTabs).toEqual([]);
    openTabs.set(9, { id: 9, url: "https://docs.example/d/1/edit?usp=sharing", title: "Plano", active: false });
    expect((await listTabs({})).openTabs).toEqual([{ url: "https://docs.example/d/1/edit", active: false, title: "Plano" }]);
    await dispatch({ type: "mcp-tab-context", tabId: 5, enabled: false });
    expect((await listTabs({})).openTabs).toBeUndefined();

    // Finishing every task closes MCP tabs but only releases the shared one.
    await expect(finish({})).resolves.toEqual({
      completed: true, closedTabs: 1, closedTabIds: ["personal:3"],
      releasedTabs: 1, releasedTabIds: ["personal:5"], browserClosed: false,
    });
    expect(removed).toEqual([3]);
    expect(openTabs.has(5)).toBe(true);
    expect(owned).toEqual({});
    expect(badges.at(-1)).toEqual([5, ""]);

    await dispatch({ type: "mcp-tab-share", tabId: 5 });
    await expect(dispatch({ type: "mcp-tab-unshare", tabId: 9 })).rejects.toThrow("not-shared");
    await expect(dispatch({ type: "mcp-tab-unshare", tabId: 5 })).resolves.toMatchObject({ shared: false, shareable: true });
    expect(owned).toEqual({});
  });

  it("hands a tab to the user, refuses MCP work there until they hand it back, and notifies them", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const session = new Map<string, unknown>();
    const local = new Map<string, unknown>();
    const badges: string[] = [];
    const notifications: Array<[string, string, Record<string, unknown>?]> = [];
    const owned: Record<string, Record<string, unknown>> = { "7": { tabId: "personal:7", ownership: "mcp" } };
    let onTick: (() => Promise<void>) | undefined;
    const storageArea = (map: Map<string, unknown>) => ({
      get: async (key: string) => ({ [key]: map.get(key) }),
      set: async (entries: Record<string, unknown>) => { for (const [key, value] of Object.entries(entries)) map.set(key, value); },
      remove: async (key: string) => { map.delete(key); },
    });
    const context = vm.createContext({
      Date, Number, String, Math, Promise, Array, Object,
      chromeTabIdFrom: (id: string) => Number(/^personal:(\d+)$/u.exec(id)![1]),
      requireOwnedMetadata: async (id: number) => {
        if (!owned[String(id)]) throw Object.assign(new Error("not owned"), { code: "TAB_NOT_OWNED" });
        return owned[String(id)];
      },
      readOwnedTabs: async () => owned,
      delay: async () => { await onTick?.(); },
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async (id: number) => ({ id, url: "https://login.example/" }) },
        storage: { session: storageArea(session), local: storageArea(local) },
        action: {
          setBadgeText: async ({ text }: { text: string }) => { badges.push(text); },
          setBadgeBackgroundColor: async () => undefined,
        },
        notifications: {
          create: async (id: string, options: Record<string, unknown>) => { notifications.push(["create", id, options]); },
          clear: async (id: string) => { notifications.push(["clear", id]); },
        },
      },
    });
    vm.runInContext('const PERSONAL_HANDOFF_PREFIX = "mcpV3PersonalHandoff:"; ' +
      'const PERSONAL_NOTIFY_ON_FINISH_KEY = "mcpV3NotifyOnFinish"; const PERSONAL_NOTIFICATION_ICON = "data:image/png;base64,AA=="; ' +
      'const PERSONAL_TAB_CONTEXT_KEY = "mcpV3PersonalTabContext"; const BLOCKED_PRIVATE_ORIGINS = new Set(); ' +
      'const PERSONAL_REQUIRE_PLAN_KEY = "mcpV3RequirePlan"; const PERSONAL_SITE_GRANTS_KEY = "mcpV3SiteGrants"; ' +
      'const PERSONAL_AUTO_SITES_KEY = "mcpV3AutoApproveSites"; const PERSONAL_APPROVAL_REQUEST_PREFIX = "mcpV3ApprovalRequest:";', context);
    for (const fn of ["readPersonalHandoff", "refuseDuringPersonalHandoff", "waitForUser", "resumePersonalHandoff",
      "clearPersonalHandoff", "settlePersonalHandoffSignals", "setPersonalSharedBadge", "notifyPersonalTaskFinished",
      "personalTabContextEnabled", "personalPlanRequired", "personalTabSharingDispatch",
      "personalApprovalStatus", "readPersonalApprovalRequest", "readPersonalSiteGrants", "readPersonalAutoSites",
      "isPrivateIpv4", "isPrivateHost", "assertPersonalNavigationTarget"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const waitForUser = vm.runInContext("waitForUser", context) as (input: Record<string, unknown>) => Promise<unknown>;
    const refuse = vm.runInContext("refuseDuringPersonalHandoff", context) as
      (operation: string, input: Record<string, unknown>) => Promise<void>;
    const dispatch = vm.runInContext("personalTabSharingDispatch", context) as
      (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const notifyFinished = vm.runInContext("notifyPersonalTaskFinished", context) as
      (taskId: string | undefined, closed: number, released: number) => Promise<void>;

    // Nobody answers: the call times out, the turn stays with the user and MCP is refused there.
    await expect(waitForUser({ tabId: "personal:7", forUser: "Faça login no banco", timeoutMs: 1 }))
      .rejects.toMatchObject({ code: "STATE_NOT_REACHED" });
    expect(notifications).toEqual([["create", "mcp-handoff:7", expect.objectContaining({
      title: "O MCP precisa de você", message: "Faça login no banco", requireInteraction: true,
      buttons: [{ title: "Pronto, pode continuar" }],
    })]]);
    expect(badges).toEqual(["VOCÊ"]);
    await expect(refuse("snapshot", { tabId: "personal:7" })).rejects.toMatchObject({ code: "EXECUTION_STATE_INVALID" });
    await expect(refuse("click", { tabId: "personal:8" })).resolves.toBeUndefined();
    await expect(refuse("wait", { tabId: "personal:7", forUser: "again" })).resolves.toBeUndefined();
    await expect(dispatch({ type: "mcp-tab-status", tabId: 7 })).resolves.toMatchObject({
      mcp: true, waiting: "Faça login no banco", notify: false,
    });

    // Waiting again neither re-notifies nor changes the reason; the user's click completes it.
    let ticks = 0;
    onTick = async () => {
      ticks += 1;
      if (ticks === 2) await dispatch({ type: "mcp-tab-resume", tabId: 7 });
    };
    await expect(waitForUser({ tabId: "personal:7", forUser: "outro motivo", timeoutMs: 60_000 }))
      .resolves.toEqual({ tabId: "personal:7", completed: true });
    expect(notifications.filter(([kind]) => kind === "create")).toHaveLength(1);
    expect(notifications.at(-1)).toEqual(["clear", "mcp-handoff:7"]);
    expect(badges.at(-1)).toBe("");
    await expect(refuse("snapshot", { tabId: "personal:7" })).resolves.toBeUndefined();
    await expect(dispatch({ type: "mcp-tab-resume", tabId: 7 })).rejects.toThrow("not-waiting");

    // Handed back between two calls: the next call completes at once, and nothing lingers.
    onTick = undefined;
    await expect(waitForUser({ tabId: "personal:7", forUser: "Aprove no celular", timeoutMs: 1 }))
      .rejects.toMatchObject({ code: "STATE_NOT_REACHED" });
    await expect(dispatch({ type: "mcp-tab-resume", tabId: 7 })).resolves.not.toHaveProperty("waiting");
    await expect(refuse("snapshot", { tabId: "personal:7" })).resolves.toBeUndefined();
    expect(session.size).toBe(0);
    await expect(waitForUser({ tabId: "personal:7", forUser: "Aprove no celular", timeoutMs: 1 }))
      .rejects.toMatchObject({ code: "STATE_NOT_REACHED" });
    await dispatch({ type: "mcp-tab-resume", tabId: 7 });
    await expect(waitForUser({ tabId: "personal:7", forUser: "Aprove no celular", timeoutMs: 1 }))
      .resolves.toEqual({ tabId: "personal:7", completed: true });
    expect(session.size).toBe(0);

    // If the user stops sharing instead of handing the tab back, the wait reports it.
    onTick = async () => { delete owned["7"]; session.clear(); };
    owned["7"] = { tabId: "personal:7", ownership: "mcp" };
    await expect(waitForUser({ tabId: "personal:7", forUser: "Resolva o CAPTCHA", timeoutMs: 60_000 }))
      .rejects.toMatchObject({ code: "TAB_NOT_OWNED" });

    // Finished-task notifications are opt-in from the popup.
    owned["7"] = { tabId: "personal:7", ownership: "mcp" };
    notifications.length = 0;
    await notifyFinished("t1", 2, 1);
    expect(notifications).toEqual([]);
    await dispatch({ type: "mcp-tab-notify", tabId: 7, enabled: true });
    await notifyFinished("t1", 2, 1);
    await notifyFinished("t2", 0, 0);
    expect(notifications).toEqual([["create", expect.stringMatching(/^mcp-finished:/u), expect.objectContaining({
      title: "O MCP terminou uma tarefa", message: "Tarefa t1: 2 aba(s) fechada(s), 1 devolvida(s) a você.",
    })]]);
  });

  it("hands the turn back or grants a site approval only from a notification button and focuses the tab on a body click", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const start = serviceWorker.indexOf("chrome.notifications?.onButtonClicked");
    const end = serviceWorker.indexOf("\n});\n", serviceWorker.indexOf("chrome.notifications?.onClicked")) + 4;
    let onButton: ((id: string) => void) | undefined;
    let onBody: ((id: string) => void) | undefined;
    const resumed: number[] = [];
    const granted: number[] = [];
    const focused: unknown[] = [];
    const context = vm.createContext({
      Number,
      resumePersonalHandoff: async (id: number) => { resumed.push(id); },
      grantPersonalSiteApproval: async (id: number) => { granted.push(id); },
      chrome: {
        notifications: {
          onButtonClicked: { addListener: (fn: typeof onButton) => { onButton = fn; } },
          onClicked: { addListener: (fn: typeof onBody) => { onBody = fn; } },
        },
        tabs: { update: async (id: number) => { focused.push(["tab", id]); return { windowId: 4 }; } },
        windows: { update: async (id: number, options: unknown) => { focused.push(["window", id, options]); } },
      },
    });
    vm.runInContext(serviceWorker.slice(start, end), context);
    onButton!("mcp-finished:1");
    onButton!("mcp-handoff:7");
    onButton!("mcp-approval:12");
    onBody!("mcp-handoff:9");
    await new Promise((resolve) => setImmediate(resolve));
    onBody!("mcp-approval:12");
    await new Promise((resolve) => setImmediate(resolve));
    expect(resumed).toEqual([7]);
    expect(granted).toEqual([12]);
    expect(focused).toEqual([["tab", 9], ["window", 4, { focused: true }], ["tab", 12], ["window", 4, { focused: true }]]);
  });

  it("answers tab sharing messages only from the extension popup", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const marker = 'message.type.startsWith("mcp-tab-")';
    const start = serviceWorker.lastIndexOf("if (chrome.runtime.onMessage", serviceWorker.indexOf(marker));
    const listenerSource = serviceWorker.slice(start, serviceWorker.indexOf("\n});\n", start) + 4);
    let handler: ((message: unknown, sender: Record<string, unknown>, reply: (value: unknown) => void) => boolean) | undefined;
    const dispatched: unknown[] = [];
    const context = vm.createContext({
      personalTabSharingDispatch: async (message: unknown) => { dispatched.push(message); return { ok: true }; },
      chrome: {
        runtime: {
          id: "ext", getURL: (file: string) => "chrome-extension://ext/" + file,
          onMessage: { addListener: (fn: typeof handler) => { handler = fn; } },
        },
        storage: { session: {} },
      },
    });
    vm.runInContext(listenerSource, context);
    const popup = { id: "ext", url: "chrome-extension://ext/secret-provision.html" };
    const replies: unknown[] = [];
    expect(handler!({ type: "mcp-secret-status" }, popup, (value) => replies.push(value))).toBe(false);
    expect(handler!({ type: "mcp-tab-share", tabId: 5 }, { ...popup, url: "https://evil.example/" }, () => undefined)).toBe(false);
    expect(handler!({ type: "mcp-tab-share", tabId: 5 }, { ...popup, id: "other" }, () => undefined)).toBe(false);
    expect(handler!({ type: "mcp-tab-share", tabId: 5 }, popup, (value) => replies.push(value))).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatched).toEqual([{ type: "mcp-tab-share", tabId: 5 }]);
    expect(replies).toEqual([{ ok: true }]);
  });

  it("shows a plan in its own window, lets the user trim it, and holds MCP to the approved sites and actions", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const start = serviceWorker.indexOf("const PERSONAL_PLANS_KEY");
    const end = serviceWorker.indexOf("async function finalizePersonalDialog");
    const session = new Map<string, unknown>();
    const local = new Map<string, unknown>();
    const storageArea = (map: Map<string, unknown>) => ({
      get: async (key: string) => ({ [key]: map.get(key) }),
      set: async (entries: Record<string, unknown>) => { for (const [key, value] of Object.entries(entries)) map.set(key, value); },
      remove: async (key: string) => { map.delete(key); },
    });
    const owned: Record<string, Record<string, unknown>> = {
      "7": { tabId: "personal:7", ownership: "mcp", taskId: "t1" },
      "8": { tabId: "personal:8", ownership: "user" },
      "9": { tabId: "personal:9", ownership: "mcp", taskId: "t2" },
    };
    const urls: Record<number, string> = {
      7: "https://www.shop.example/cart", 8: "https://help.shop.example/", 9: "https://other.example/",
    };
    const windows: Array<Record<string, unknown>> = [];
    const removedWindows: number[] = [];
    const notifications: Array<[string, string, Record<string, unknown>?]> = [];
    let onTick: (() => Promise<void>) | undefined;
    let uuid = 0;
    const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
    type Rule = Record<string, unknown> & { id: number };
    let sessionRules: Rule[] = [{ id: 1, priority: 1, action: { type: "allow" }, condition: { urlFilter: "other" } }];
    const context = vm.createContext({
      URL, Date, Number, String, Math, Promise, Array, Object, Set, coded,
      PERSONAL_NOTIFICATION_ICON: "data:image/png;base64,AA==",
      crypto: { randomUUID: () => `0000000${++uuid}-aaaa-bbbb-cccc-dddddddddddd` },
      chromeTabIdFrom: (id: string) => {
        const match = /^personal:(\d+)$/u.exec(String(id));
        if (!match) throw coded("INVALID_ARGUMENT", "bad tab id");
        return Number(match[1]);
      },
      requireOwnedMetadata: async (id: number) => {
        if (!owned[String(id)]) throw coded("TAB_NOT_OWNED", "not owned");
        return owned[String(id)];
      },
      readOwnedTabs: async () => owned,
      delay: async () => { await onTick?.(); },
      chrome: {
        runtime: { getURL: (file: string) => "chrome-extension://ext/" + file },
        tabs: { get: async (id: number) => ({ id, url: urls[id], title: "Aba " + id }) },
        windows: {
          create: async (options: Record<string, unknown>) => { windows.push(options); return { id: 100 + windows.length }; },
          remove: async (id: number) => { removedWindows.push(id); },
        },
        storage: { session: storageArea(session), local: storageArea(local) },
        notifications: {
          create: async (id: string, options: Record<string, unknown>) => { notifications.push(["create", id, options]); },
          clear: async (id: string) => { notifications.push(["clear", id]); },
        },
        declarativeNetRequest: {
          getSessionRules: async () => sessionRules,
          updateSessionRules: async ({ removeRuleIds, addRules }: { removeRuleIds: number[]; addRules: Rule[] }) => {
            sessionRules = [...sessionRules.filter((rule) => !removeRuleIds.includes(rule.id)), ...addRules];
          },
        },
      },
    });
    vm.runInContext(serviceWorker.slice(start, end), context);
    const syncRules = vm.runInContext("syncPersonalPlanNavigationRules", context) as () => Promise<void>;
    const planRules = async () => {
      await syncRules();
      return sessionRules.filter((rule) => rule.id !== 1);
    };
    const blockOutside = (tabIds: number[], domains: string[], id = 7000) => ({ id, priority: 1, action: { type: "block" },
      condition: { tabIds, resourceTypes: ["main_frame"], excludedRequestDomains: domains } });
    type Plan = Record<string, unknown> & { planId: string };
    const plan = vm.runInContext("personalPlan", context) as (input: Record<string, unknown>) => Promise<Plan>;
    const review = vm.runInContext("personalPlanReviewDispatch", context) as
      (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const enforce = vm.runInContext("enforcePersonalPlan", context) as
      (operation: string, input: Record<string, unknown>) => Promise<void>;
    const closeWindow = vm.runInContext("rejectPersonalPlanWindow", context) as (windowId: number) => Promise<void>;
    const clear = vm.runInContext("clearPersonalPlans", context) as (taskId?: string) => Promise<void>;
    const blocked = (text: string) => ({ code: "ACTION_BLOCKED_BY_POLICY", message: expect.stringContaining(text) });

    // Without a plan or the popup setting, nothing changes.
    await expect(enforce("evaluate", { tabId: "personal:7" })).resolves.toBeUndefined();
    await expect(planRules()).resolves.toEqual([]);

    // Nobody decides yet: MCP gets "pending", and the window and the notification wait for the user.
    const proposal = {
      taskId: "t1", summary: "Comprar o livro", steps: ["Abrir a loja", "Pagar"],
      domains: ["shop.example", "pay.example"], actions: ["navigate", "interact", "fill", "evaluate"],
      tabIds: ["personal:8"], timeoutMs: 1,
    };
    const first = await plan(proposal);
    const { planId } = first;
    expect(first).toEqual({ planId: expect.stringMatching(/^plan_0+1-/u), taskId: "t1", status: "pending",
      domains: ["shop.example", "pay.example"], actions: ["navigate", "interact", "fill", "evaluate"], tabIds: ["personal:8"] });
    expect(windows).toEqual([{ url: "chrome-extension://ext/plan-review.html#" + planId, type: "popup",
      width: 480, height: 840, focused: true }]);
    expect(notifications).toEqual([["create", "mcp-plan:" + planId, expect.objectContaining({
      title: "O MCP propõe um plano", message: "Comprar o livro Sites: shop.example, pay.example", requireInteraction: true,
    })]]);
    await expect(review({ type: "mcp-plan-get", planId })).resolves.toEqual({ ok: true, plan: {
      planId, taskId: "t1", summary: "Comprar o livro", steps: ["Abrir a loja", "Pagar"],
      domains: ["shop.example", "pay.example"], actions: ["navigate", "interact", "fill", "evaluate"],
      tabs: ["Aba 8"], status: "pending",
    } });
    await expect(review({ type: "mcp-plan-decide", planId, approve: true, domains: [], actions: [] }))
      .rejects.toThrow("no-domains");

    // While MCP waits again, the user keeps one site and drops JavaScript; extras are ignored.
    onTick = async () => {
      onTick = undefined;
      await review({ type: "mcp-plan-decide", planId, approve: true, domains: ["shop.example", "evil.example"],
        actions: ["navigate", "interact", "fill", "upload"], feedback: "  Sem JavaScript, por favor  " });
    };
    await expect(plan({ planId, timeoutMs: 60_000 })).resolves.toEqual({ planId, taskId: "t1", status: "approved",
      domains: ["shop.example"], actions: ["navigate", "interact", "fill"], tabIds: ["personal:8"],
      feedback: "Sem JavaScript, por favor" });
    expect(notifications.at(-1)).toEqual(["clear", "mcp-plan:" + planId]);
    expect(removedWindows).toEqual([]);
    await expect(review({ type: "mcp-plan-decide", planId, approve: false })).rejects.toThrow("not-pending");

    // Chrome itself blocks the task's MCP tabs from loading any other site. The shared tab stays the
    // user's to browse, another task's tab is untouched, and rules that are not the plan's are kept.
    await expect(planRules()).resolves.toEqual([blockOutside([7], ["shop.example"])]);
    expect(sessionRules[0]).toMatchObject({ id: 1 });

    // The task's tabs and the listed shared tab work on the approved site and its subdomains.
    await expect(enforce("click", { tabId: "personal:7" })).resolves.toBeUndefined();
    await expect(enforce("snapshot", { tabId: "personal:8" })).resolves.toBeUndefined();
    await expect(enforce("navigate", { tabId: "personal:7", url: "https://shop.example/checkout" })).resolves.toBeUndefined();
    await expect(enforce("frameSequence", { tabId: "personal:7", steps: [{ action: "index" }, { action: "select" }] }))
      .resolves.toBeUndefined();
    await expect(enforce("open", { taskId: "t1", url: "https://pay.example/" })).rejects.toMatchObject(
      blocked("pay.example is outside the sites approved in plan " + planId + " (shop.example)"));
    await expect(enforce("open", { taskId: "t1", url: "https://notshop.example/" })).rejects.toMatchObject(blocked("outside"));
    await expect(enforce("evaluate", { tabId: "personal:7" })).rejects.toMatchObject(blocked("does not allow evaluate"));
    await expect(enforce("upload", { tabId: "personal:8" })).rejects.toMatchObject(blocked("does not allow upload"));
    await expect(enforce("sequence", { tabId: "personal:7",
      steps: [{ action: "click" }, { action: "navigate", url: "https://evil.example/" }] })).rejects.toMatchObject(blocked("evil.example"));
    // A link or redirect that left the plan blocks the next action, but MCP may still go back.
    urls[7] = "https://evil.example/";
    await expect(enforce("snapshot", { tabId: "personal:7" })).rejects.toMatchObject(blocked("evil.example is outside"));
    await expect(enforce("goBack", { tabId: "personal:7" })).resolves.toBeUndefined();
    urls[7] = "https://www.shop.example/cart";
    // Other tasks and housekeeping are untouched.
    await expect(enforce("evaluate", { tabId: "personal:9" })).resolves.toBeUndefined();
    await expect(enforce("closeTab", { tabId: "personal:7" })).resolves.toBeUndefined();

    // With "Pedir um plano" on, nothing outside an approved plan runs.
    local.set("mcpV3RequirePlan", true);
    await expect(enforce("evaluate", { tabId: "personal:9" })).rejects.toMatchObject(blocked("requires an approved plan"));
    await expect(enforce("open", { url: "https://shop.example/" })).rejects.toMatchObject(blocked("open its tabs with that taskId"));
    await expect(enforce("open", { taskId: "t1", url: "https://shop.example/" })).resolves.toBeUndefined();
    await expect(enforce("dialog", { tabId: "personal:9", action: "respond" })).rejects.toMatchObject(blocked("requires"));
    for (const [operation, input] of [["tabs", {}], ["wait", { tabId: "personal:9", timeoutMs: 1 }],
      ["dialog", { tabId: "personal:9", action: "inspect" }], ["viewport", { tabId: "personal:9" }],
      ["finishTask", { taskId: "t2" }]] as const) {
      await expect(enforce(operation, input)).resolves.toBeUndefined();
    }

    // A newer proposal supersedes a pending one and closes its window; closing a window rejects its plan.
    const second = await plan({ ...proposal, tabIds: undefined, domains: ["pay.example"], actions: [] });
    const third = await plan({ ...proposal, tabIds: undefined, domains: ["pay.example"], actions: ["navigate"] });
    expect(removedWindows).toEqual([102]);
    await expect(plan({ planId: second.planId, timeoutMs: 1 })).resolves.toMatchObject({ status: "superseded" });
    await expect(enforce("click", { tabId: "personal:7" })).resolves.toBeUndefined();
    await closeWindow(103);
    await expect(plan({ planId: third.planId, timeoutMs: 1 })).resolves.toMatchObject({
      status: "rejected", domains: ["pay.example"], feedback: "The user closed the plan window without approving it." });

    // Approving a newer plan for the task replaces the previous one.
    const fourth = await plan({ ...proposal, tabIds: undefined, domains: ["pay.example"], actions: ["navigate"] });
    await review({ type: "mcp-plan-decide", planId: fourth.planId, approve: true, domains: ["pay.example"], actions: ["navigate"] });
    await expect(plan({ planId, timeoutMs: 1 })).resolves.toMatchObject({ status: "superseded" });
    await expect(enforce("open", { taskId: "t1", url: "https://pay.example/" })).resolves.toBeUndefined();
    await expect(planRules()).resolves.toEqual([blockOutside([7], ["pay.example"])]);
    await expect(enforce("snapshot", { tabId: "personal:8" })).rejects.toMatchObject(blocked("requires"));

    // Only owned or shared tabs can be listed, and finishing the task ends its plans.
    await expect(plan({ ...proposal, tabIds: ["personal:12"] })).rejects.toMatchObject({ code: "TAB_NOT_OWNED" });
    await clear("t1");
    await expect(planRules()).resolves.toEqual([]);
    expect(sessionRules).toEqual([expect.objectContaining({ id: 1 })]);
    await expect(plan({ planId: fourth.planId })).rejects.toMatchObject({ code: "EXECUTION_NOT_FOUND" });
    await expect(enforce("click", { tabId: "personal:7" })).rejects.toMatchObject(blocked("requires"));
  });

  it("offers site approvals only in Chrome, grants them only from the user's click and reports them to the bridge", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const start = serviceWorker.indexOf("const PERSONAL_SITE_GRANTS_KEY");
    const end = serviceWorker.indexOf("async function releasePersonalSharedTab");
    const session = new Map<string, unknown>();
    const local = new Map<string, unknown>();
    const storageArea = (map: Map<string, unknown>) => ({
      get: async (key: string) => ({ [key]: map.get(key) }),
      set: async (entries: Record<string, unknown>) => { for (const [key, value] of Object.entries(entries)) map.set(key, value); },
      remove: async (key: string) => { map.delete(key); },
    });
    const owned: Record<string, Record<string, unknown>> = {
      "7": { tabId: "personal:7", ownership: "mcp", taskId: "t1" },
      "8": { tabId: "personal:8", ownership: "user" },
    };
    const urls: Record<number, string> = { 7: "https://shop.example/cart", 8: "https://docs.example/d/1", 9: "http://intranet.local/" };
    const sent: Array<Record<string, unknown>> = [];
    const notifications: Array<[string, string, Record<string, unknown>?]> = [];
    const context = vm.createContext({
      URL, Date, Number, String, Math, Promise, Array, Object, Set,
      PERSONAL_NOTIFICATION_ICON: "data:image/png;base64,AA==",
      send: (message: Record<string, unknown>) => { sent.push(message); },
      chromeTabIdFrom: (id: string) => Number(/^personal:(\d+)$/u.exec(id)![1]),
      readOwnedTabs: async () => owned,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: {
        tabs: { get: async (id: number) => {
          if (!urls[id]) throw new Error("No tab");
          return { id, url: urls[id] };
        } },
        storage: { session: storageArea(session), local: storageArea(local) },
        notifications: {
          create: async (id: string, options: Record<string, unknown>) => { notifications.push(["create", id, options]); },
          clear: async (id: string) => { notifications.push(["clear", id]); },
        },
      },
    });
    vm.runInContext(serviceWorker.slice(start, end), context);
    vm.runInContext('const PERSONAL_PREFIX = "personal:"; const BLOCKED_PRIVATE_ORIGINS = new Set(); ' +
      'const PERSONAL_TAB_CONTEXT_KEY = "mcpV3PersonalTabContext"; const PERSONAL_HANDOFF_PREFIX = "mcpV3PersonalHandoff:"; ' +
      'const PERSONAL_NOTIFY_ON_FINISH_KEY = "mcpV3NotifyOnFinish"; const PERSONAL_REQUIRE_PLAN_KEY = "mcpV3RequirePlan";', context);
    for (const fn of ["isPrivateIpv4", "isPrivateHost", "assertPersonalNavigationTarget", "readPersonalHandoff",
      "personalTabContextEnabled", "personalPlanRequired", "personalApprovalStatus", "personalTabSharingDispatch"]) {
      vm.runInContext(extractFunction(serviceWorker, fn), context);
    }
    const record = vm.runInContext("recordPersonalApprovalRequest", context) as (message: Record<string, unknown>) => Promise<void>;
    const grant = vm.runInContext("grantPersonalSiteApproval", context) as (chromeTabId: number) => Promise<boolean>;
    const clearTask = vm.runInContext("clearPersonalTaskApprovals", context) as
      (taskId: string | undefined, chromeTabIds: number[]) => Promise<void>;
    const clearTab = vm.runInContext("clearPersonalTabApprovals", context) as (chromeTabId: number) => Promise<void>;
    const dispatch = vm.runInContext("personalTabSharingDispatch", context) as
      (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
    const ask = (tabId: string, origin: string, category = "upload-file") =>
      record({ type: "site-approval-request", tabId, origin, category });

    // Requests for tabs MCP does not hold, for another origin, or for categories that always ask are dropped.
    await ask("personal:9", "http://intranet.local");
    await ask("personal:7", "https://other.example");
    await ask("personal:7", "https://shop.example", "purchase-or-payment");
    expect(notifications).toEqual([]);
    await ask("personal:7", "https://shop.example");
    expect(notifications).toEqual([["create", "mcp-approval:7", expect.objectContaining({
      title: "O MCP pede permissão em shop.example", buttons: [{ title: "Permitir neste site" }], requireInteraction: true,
      message: "Enviar arquivos. Permitir libera isso neste site até o fim da tarefa.",
    })]]);
    await expect(dispatch({ type: "mcp-tab-status", tabId: 7 })).resolves.toMatchObject({
      approval: "upload-file", grants: [], auto: false, autoEligible: true });

    // If the tab left the site before the click, nothing is granted.
    urls[7] = "https://other.example/";
    await expect(grant(7)).resolves.toBe(false);
    expect(sent).toEqual([]);
    urls[7] = "https://shop.example/cart";
    await ask("personal:7", "https://shop.example");
    await expect(grant(7)).resolves.toBe(true);
    const report = sent.at(-1) as { type: string; grants: Array<Record<string, unknown>>; autoSites: string[] };
    expect(report).toEqual({ type: "site-approvals", autoSites: [],
      grants: [{ origin: "https://shop.example", category: "upload-file", taskId: "t1" }] });
    // No time limit: the grant is held until its task ends.
    expect(session.get("mcpV3SiteGrants")).toEqual([{ origin: "https://shop.example", category: "upload-file",
      tabId: "personal:7", taskId: "t1", grantedAt: expect.any(Number) }]);
    expect(notifications.at(-1)).toEqual(["clear", "mcp-approval:7"]);
    await expect(grant(7)).resolves.toBe(false);
    await expect(dispatch({ type: "mcp-tab-approve", tabId: 7 })).rejects.toThrow("not-requested");
    await expect(dispatch({ type: "mcp-tab-status", tabId: 7 })).resolves.toMatchObject({
      grants: [{ category: "upload-file", until: "task" }] });

    // A shared tab has no task: its grant is bound to that tab, granted from the popup.
    await ask("personal:8", "https://docs.example", "execute-script");
    expect(notifications.at(-1)).toEqual(["create", "mcp-approval:8", expect.objectContaining({
      message: "Executar JavaScript. Permitir libera isso neste site enquanto esta aba estiver com o MCP." })]);
    await expect(dispatch({ type: "mcp-tab-approve", tabId: 8 })).resolves.toMatchObject({
      grants: [{ category: "execute-script", until: "tab" }] });
    expect(session.has("mcpV3ApprovalRequest:8")).toBe(false);
    expect((sent.at(-1) as typeof report).grants).toEqual([
      { origin: "https://shop.example", category: "upload-file", taskId: "t1" },
      { origin: "https://docs.example", category: "execute-script", tabId: "personal:8" }]);

    // Finishing the task ends its grants and pending requests, but not those of a tab outside it.
    await ask("personal:7", "https://shop.example", "submit-form");
    await clearTask("t1", [7]);
    expect(session.has("mcpV3ApprovalRequest:7")).toBe(false);
    expect((sent.at(-1) as typeof report).grants).toEqual([
      { origin: "https://docs.example", category: "execute-script", tabId: "personal:8" }]);
    // Releasing or closing that tab ends its grant; the user can also revoke from the popup.
    await clearTab(8);
    expect((sent.at(-1) as typeof report).grants).toEqual([]);
    await ask("personal:8", "https://docs.example", "execute-script");
    await grant(8);
    await dispatch({ type: "mcp-tab-revoke", tabId: 8 });
    expect((sent.at(-1) as typeof report).grants).toEqual([]);
    // A click that arrives after MCP let go of the tab grants nothing.
    await ask("personal:8", "https://docs.example", "execute-script");
    const shared = owned["8"]!;
    delete owned["8"];
    await expect(grant(8)).resolves.toBe(false);
    owned["8"] = shared;

    // A grant and clean-ups started together never bring a removed grant back.
    await ask("personal:7", "https://shop.example");
    await grant(7);
    await ask("personal:8", "https://docs.example", "execute-script");
    await Promise.all([grant(8), clearTask("t1", [7]), clearTab(8)]);
    expect(session.get("mcpV3SiteGrants")).toEqual([]);
    expect((sent.at(-1) as typeof report).grants).toEqual([]);

    // Automatic approval is set per public host from the popup and reported to the bridge.
    await expect(dispatch({ type: "mcp-tab-auto", tabId: 9, enabled: true })).rejects.toMatchObject({ code: "NAVIGATION_BLOCKED" });
    await expect(dispatch({ type: "mcp-tab-auto", tabId: 7, enabled: true })).resolves.toMatchObject({
      auto: true, autoSites: ["shop.example"] });
    await dispatch({ type: "mcp-tab-auto", tabId: 8, enabled: true });
    expect(sent.at(-1)).toEqual({ type: "site-approvals", grants: [], autoSites: ["docs.example", "shop.example"] });
    await dispatch({ type: "mcp-tab-auto", tabId: 7, enabled: false });
    expect(local.get("mcpV3AutoApproveSites")).toEqual(["docs.example"]);
    await expect(dispatch({ type: "mcp-tab-status", tabId: 9 })).resolves.toMatchObject({ autoEligible: false, auto: false });
  });

  it("answers plan window messages only from the extension's plan page", async () => {
    const { serviceWorker, planReviewHtml, planReviewScript } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const marker = 'message.type.startsWith("mcp-plan-")';
    const start = serviceWorker.lastIndexOf("if (chrome.runtime.onMessage", serviceWorker.indexOf(marker));
    const listenerSource = serviceWorker.slice(start, serviceWorker.indexOf("\n});\n", start) + 4);
    let handler: ((message: unknown, sender: Record<string, unknown>, reply: (value: unknown) => void) => boolean) | undefined;
    const dispatched: unknown[] = [];
    const context = vm.createContext({
      String,
      personalPlanReviewDispatch: async (message: unknown) => { dispatched.push(message); return { ok: true }; },
      chrome: {
        runtime: {
          id: "ext", getURL: (file: string) => "chrome-extension://ext/" + file,
          onMessage: { addListener: (fn: typeof handler) => { handler = fn; } },
        },
        storage: { session: {} },
      },
    });
    vm.runInContext(listenerSource, context);
    const page = { id: "ext", url: "chrome-extension://ext/plan-review.html#plan_00000001" };
    const decide = { type: "mcp-plan-decide", planId: "plan_00000001", approve: true };
    expect(handler!({ type: "mcp-tab-share" }, page, () => undefined)).toBe(false);
    expect(handler!(decide, { ...page, url: "chrome-extension://ext/secret-provision.html" }, () => undefined)).toBe(false);
    expect(handler!(decide, { ...page, url: "https://evil.example/plan-review.html" }, () => undefined)).toBe(false);
    expect(handler!(decide, { ...page, id: "other" }, () => undefined)).toBe(false);
    const replies: unknown[] = [];
    expect(handler!(decide, page, (value) => replies.push(value))).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatched).toEqual([decide]);
    expect(replies).toEqual([{ ok: true }]);
    expect(planReviewHtml).toContain('<script src="plan-review.js"></script>');
    expect(() => new vm.Script(planReviewScript)).not.toThrow();
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
    vm.runInContext('const taskGroups = new Map(); const UNTASKED_GROUP_KEY = "mcp:untasked";', context);
    vm.runInContext(`${extractConst(serviceWorker, "MCP_TASK_GROUP_COLORS")}
${extractConst(serviceWorker, "MAX_MCP_GROUP_LABEL_CHARS")}
${extractFunction(serviceWorker, "mcpTaskGroupStyle")}`, context);
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
    expect(updates).toEqual([{ groupId: 17, value: { title: "MCP", color: expect.any(String) } }]);
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
    vm.runInContext('const taskGroups = new Map(); const UNTASKED_GROUP_KEY = "mcp:untasked";', context);
    vm.runInContext(`${extractConst(serviceWorker, "MCP_TASK_GROUP_COLORS")}
${extractConst(serviceWorker, "MAX_MCP_GROUP_LABEL_CHARS")}
${extractFunction(serviceWorker, "mcpTaskGroupStyle")}`, context);
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

  it("gives each task group its own label and color and keeps untasked tabs plain", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const context = vm.createContext({ URL });
    vm.runInContext(`${extractConst(serviceWorker, "MCP_TASK_GROUP_COLORS")}
${extractConst(serviceWorker, "MAX_MCP_GROUP_LABEL_CHARS")}`, context);
    const mcpTaskGroupStyle = vm.runInContext(
      `(${extractFunction(serviceWorker, "mcpTaskGroupStyle")})`,
      context,
    ) as (taskId: string | undefined, label?: string) => { title: string; color: string };

    expect(mcpTaskGroupStyle(undefined, "https://example.com/")).toEqual({ title: "MCP", color: "grey" });
    expect(mcpTaskGroupStyle("task-a", "https://www.example.com/path?q=1").title).toBe("MCP · example.com");
    expect(mcpTaskGroupStyle("task-a", "Conferir pedidos da loja online de roupas").title)
      .toBe("MCP · Conferir pedidos da loj…");
    expect(mcpTaskGroupStyle("task-a", "  ").title).toBe("MCP");
    expect(mcpTaskGroupStyle("task-a").color).toBe(mcpTaskGroupStyle("task-a", "other").color);
    const colors = new Set(["t1", "t2", "t3", "t4", "t5", "t6"].map((taskId) => mcpTaskGroupStyle(taskId).color));
    expect(colors.size).toBeGreaterThan(1);
    expect(colors.has("grey")).toBe(false);
  });

  it("groups tabs opened without a taskId into one shared MCP group", async () => {
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
            return typeof input.groupId === "number" ? input.groupId : 31;
          },
        },
        tabGroups: { update: async () => undefined },
      },
    });
    vm.runInContext('const taskGroups = new Map(); const UNTASKED_GROUP_KEY = "mcp:untasked";', context);
    vm.runInContext(`${extractConst(serviceWorker, "MCP_TASK_GROUP_COLORS")}
${extractConst(serviceWorker, "MAX_MCP_GROUP_LABEL_CHARS")}
${extractFunction(serviceWorker, "mcpTaskGroupStyle")}`, context);
    const assignMcpTaskGroup = vm.runInContext(
      `(${extractFunction(serviceWorker, "assignMcpTaskGroup")})`,
      context,
    ) as (tabId: number, taskId: string | undefined, owned: Record<string, unknown>) => Promise<number>;

    await expect(assignMcpTaskGroup(61, undefined, {})).resolves.toBe(31);
    await expect(assignMcpTaskGroup(62, undefined, {})).resolves.toBe(31);
    vm.runInContext("taskGroups.clear();", context);
    // After worker state loss the shared group comes back from untasked metadata only.
    await expect(assignMcpTaskGroup(63, undefined, {
      "70": { taskId: "task-a", mcpGroupId: 40 },
      "61": { mcpGroupId: 31 },
    })).resolves.toBe(31);

    expect(groupCalls).toEqual([
      { tabIds: 61 },
      { tabIds: 62, groupId: 31 },
      { tabIds: 63, groupId: 31 },
    ]);
  });

  it("never fails an open because Chrome refused to group or title the tab", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    let groupFails = true;
    const context = vm.createContext({
      Map,
      Number,
      Object,
      chrome: {
        tabs: {
          group: async () => {
            if (groupFails) throw new Error("Tabs cannot be grouped in this window.");
            return 8;
          },
        },
        tabGroups: { update: async () => { throw new Error("Group title refused."); } },
      },
    });
    vm.runInContext('const taskGroups = new Map(); const UNTASKED_GROUP_KEY = "mcp:untasked";', context);
    vm.runInContext(`${extractConst(serviceWorker, "MCP_TASK_GROUP_COLORS")}
${extractConst(serviceWorker, "MAX_MCP_GROUP_LABEL_CHARS")}
${extractFunction(serviceWorker, "mcpTaskGroupStyle")}`, context);
    const assignMcpTaskGroup = vm.runInContext(
      `(${extractFunction(serviceWorker, "assignMcpTaskGroup")})`,
      context,
    ) as (tabId: number, taskId: string, owned: Record<string, unknown>) => Promise<number | undefined>;

    await expect(assignMcpTaskGroup(71, "task-b", {})).resolves.toBeUndefined();
    groupFails = false;
    await expect(assignMcpTaskGroup(72, "task-b", {})).resolves.toBe(8);
  });

  it("groups a newly opened tab before waiting for the page to load", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const openSource = extractFunction(serviceWorker, "open");
    const grouping = openSource.indexOf("assignMcpTaskGroup(tab.id");
    expect(grouping).toBeGreaterThan(openSource.indexOf("chrome.tabs.create("));
    expect(grouping).toBeLessThan(openSource.indexOf("waitForTabComplete(tab.id"));
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

function extractConst(source: string, name: string): string {
  const line = source.split("\n").find((candidate) => candidate.startsWith(`const ${name} = `));
  if (!line) throw new Error(`Constant not found: ${name}`);
  return line;
}
