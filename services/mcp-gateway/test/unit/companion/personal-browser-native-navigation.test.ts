import vm from "node:vm";
import { describe, expect, it } from "@jest/globals";
import { buildPersonalBrowserExtensionAssets } from "../../../src/companion/personal-browser-extension-assets.js";

describe("personal Chrome SPA navigation", () => {
  it("rechecks a click after debugger-induced viewport changes and blocks unsafe pixels", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const start = serviceWorker.indexOf("async function revalidatePersonalClickAfterAttach(");
    const end = serviceWorker.indexOf("\n}\n", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const context = vm.createContext({
      settlePersonalViewport: async () => undefined,
      probePersonalPixelTarget: () => undefined,
      probeGuardedElement: () => undefined,
      throwIfAborted: () => undefined,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { scripting: { executeScript: async () =>
        [{ result: { x: 30, y: 40, width: 740, height: 600 } }] } },
    });
    const probe = vm.runInContext(`(${serviceWorker.slice(start, end + 2)})`, context) as
      (chromeTabId: number, target: unknown, input: unknown, point: unknown,
        pixel: boolean, attached: boolean) => Promise<unknown>;
    await expect(probe(7, { tabId: 7 },
      { x: 30, y: 40, guard: { url: "https://example.test/" } },
      { x: 30, y: 40, width: 800, height: 600 }, true, true))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    vm.runInContext('chrome.scripting.executeScript = async () => [{ result: { x: 30, y: 40, width: 800, height: 600, hitId: 2 } }]', context);
    await expect(probe(7, { tabId: 7 },
      { x: 30, y: 40, guard: { url: "https://example.test/" } },
      { x: 30, y: 40, width: 800, height: 600, hitId: 1 }, true, true))
      .rejects.toMatchObject({ code: "BROWSER_CONFIRMATION_INVALID" });
    await expect(probe(7, { tabId: 7 },
      { ref: "p-1", guard: { url: "https://example.test/", ref: "p-1" } },
      { x: 10, y: 10 }, false, true))
      .resolves.toMatchObject({ x: 30, y: 40 });
  });
  it("waits natively for a URL or disappearance of a loading label", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const start = serviceWorker.indexOf("function waitProbe(text, ref, url, absentText, observeMs = 0) {");
    const end = serviceWorker.indexOf("\n}\n", start);
    expect(start).toBeGreaterThanOrEqual(0);
    const page = { innerText: "Loading records" };
    const context = vm.createContext({
      document: { body: page },
      location: { href: "https://example.test/app" },
    });
    const probe = vm.runInContext(`(${serviceWorker.slice(start, end + 2)})`, context) as
      (text: string | null, ref: string | null, url: string | null, absent: string | null) => boolean;
    expect(probe(null, null, "https://example.test/app", "Loading")).toBe(false);
    page.innerText = "Records ready";
    expect(probe(null, null, "https://example.test/app", "Loading")).toBe(true);
    expect(probe(null, null, "https://example.test/other", "Loading")).toBe(false);
  });
  it("does not claim navigation readiness when Chrome never confirms the document load", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const start = serviceWorker.indexOf("async function navigate(input, signal) {");
    const end = serviceWorker.indexOf("\n}\n", start);
    let updates = 0;
    let metadataSaved = false;
    const context = vm.createContext({
      axTargetsByTab: new Map(),
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({ sticky: false }),
      assertPersonalNavigationTarget: (url: string) => url,
      throwIfAborted: () => undefined,
      preservePersonalConsole: async () => undefined,
      waitForTabComplete: async () => { throw new Error("Tab load timeout"); },
      settlePersonalDom: async () => true,
      updateMetadata: async () => { metadataSaved = true; },
      toBrowserTab: (_metadata: unknown, tab: unknown) => tab,
      coded: (code: string, message: string) => Object.assign(new Error(message), { code }),
      chrome: { tabs: {
        update: async () => { updates += 1; },
        get: async () => ({ url: "https://example.test/app", status: "loading" }),
      } },
    });
    const navigate = vm.runInContext("(" + serviceWorker.slice(start, end + 2) + ")", context) as
      (input: unknown) => Promise<unknown>;
    await expect(navigate({ tabId: "personal:7", url: "https://example.test/app" }))
      .rejects.toMatchObject({ code: "NAVIGATION_TIMEOUT" });
    expect(updates).toBe(1);
    expect(metadataSaved).toBe(true);
  });

  it("observes DOM stabilization after tab load before reporting navigation ready", async () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const source = serviceWorker.indexOf("async function navigate(input, signal) {");
    const end = serviceWorker.indexOf("\n}\n", source);
    expect(source).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(source);
    const order: string[] = [];
    const target = "https://example.test/app";
    const context = vm.createContext({
      axTargetsByTab: new Map(),
      chromeTabIdFrom: () => 7,
      requireOwnedMetadata: async () => ({ sticky: false }),
      assertPersonalNavigationTarget: (url: string) => url,
      throwIfAborted: () => undefined,
      preservePersonalConsole: async () => undefined,
      waitForTabComplete: async () => { order.push("load"); },
      settlePersonalDom: async () => { order.push("settle"); return true; },
      updateMetadata: async () => undefined,
      toBrowserTab: (_metadata: unknown, tab: unknown) => tab,
      chrome: { tabs: {
        update: async () => { order.push("navigate"); },
        get: async () => ({ url: target }),
      } },
    });
    const navigate = vm.runInContext(`(${serviceWorker.slice(source, end + 2)})`, context) as
      (input: unknown) => Promise<unknown>;
    await expect(navigate({ tabId: "personal:7", url: target }))
      .resolves.toMatchObject({ tab: { url: target } });
    expect(order).toEqual(["navigate", "load", "settle"]);
  });
});
