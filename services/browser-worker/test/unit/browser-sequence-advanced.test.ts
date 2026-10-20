import { describe, expect, it, jest } from "@jest/globals";
import { BrowserRuntime } from "../../services/browser-runtime.js";

describe("managed browser advanced sequence", () => {
  it("dispatches hover, scroll, drag, form input and typing through the guarded runtime and captures final screenshot", async () => {
    const tab = {
      tabId: "tab-7", ownership: "mcp", purpose: "test", reusable: false,
      protected: false, sticky: false,
      createdAt: "2026-10-20T10:00:00.000Z",
      lastUsedAt: "2026-10-20T10:00:00.000Z", url: "https://example.test/",
    };
    const actions: string[] = [];
    const run = (action: string) => jest.fn(async () => {
      actions.push(action);
      return { tabId: tab.tabId, completed: true };
    });
    const runtime = Object.assign(Object.create(BrowserRuntime.prototype), {
      tabsRegistry: { assertMcpOwned: () => tab },
      assertBusinessReadOnlySequence: () => undefined,
      selectBrowserTab: async () => undefined,
      hover: run("hover"), scroll: run("scroll"), drag: run("drag"),
      formInput: run("formInput"), type: run("type"),
      screenshot: jest.fn(async () => ({ tabId: tab.tabId, path: "/private/screen.png", sizeBytes: 1024 })),
      checkpoint: async () => undefined,
      recordNavigation: async () => undefined,
    }) as BrowserRuntime;
    const result = await runtime.sequence({ tabId: tab.tabId, finalScreenshot: true, steps: [
      { action: "hover", ref: "a" },
      { action: "scroll", direction: "down", amount: 200 },
      { action: "drag", from: { ref: "a" }, to: { ref: "b" }, steps: 10 },
      { action: "formInput", ref: "c", value: true },
      { action: "type", text: "hello" },
    ] });
    expect(actions).toEqual(["hover", "scroll", "drag", "formInput", "type"]);
    expect(result.screenshot).toMatchObject({ path: "/private/screen.png", sizeBytes: 1024 });
    expect(result.actionSummary).toHaveLength(5);
    expect(result.steps.map((step) => step.action)).toEqual(actions);
    expect(result.steps.every((step) => step.durationMs !== undefined && step.durationMs >= 0)).toBe(true);
  });
});
