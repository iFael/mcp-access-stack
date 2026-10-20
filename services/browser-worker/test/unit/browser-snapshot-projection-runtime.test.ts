import { describe, expect, it, jest } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import { BrowserRuntime } from "../../services/browser-runtime.js";

const all = {
  tabId: "tab-7",
  url: "https://example.com/",
  content: [
    '- heading "Overview"',
    '- button "Submit" [ref=r1]',
    '- textbox "Search" [ref=r2]',
  ].join("\n"),
  refs: [
    { ref: "r1", role: "button", name: "Submit" },
    { ref: "r2", role: "textbox", name: "Search" },
  ],
};

describe("browser snapshot projection runtime", () => {
  it("preserves ownership checks and the unfiltered reference registry", async () => {
    const assertMcpOwned = jest.fn((_tabId: string) => ({ tabId: "tab-7" }));
    const capture = jest.fn(async (_tabId: string) => all);
    const runtime = Object.assign(Object.create(BrowserRuntime.prototype), {
      tabsRegistry: { assertMcpOwned },
      selectTab: jest.fn(async () => undefined),
      captureSnapshotSelected: capture,
      driver: {},
    }) as BrowserRuntime;
    const output = await runtime.snapshot({ tabId: "tab-7", filter: "interactive", maxChars: 80 });
    expect(assertMcpOwned).toHaveBeenCalledWith("tab-7");
    expect(output.content).toContain("Submit");
    expect(output.content).not.toContain("Overview");
    expect(output.refs).toEqual(all.refs);
    expect(capture).toHaveBeenCalledWith("tab-7");
  });

  it("fails closed for unsupported native AX, rather than showing a pretend full tree", async () => {
    const runtime = Object.assign(Object.create(BrowserRuntime.prototype), {
      tabsRegistry: { assertMcpOwned: () => ({ tabId: "tab-7" }) },
      selectTab: jest.fn(async () => undefined),
      driver: {},
    }) as BrowserRuntime;
    await expect(runtime.snapshot({ tabId: "tab-7", includeAccessibility: true }))
      .rejects.toMatchObject({ code: "BROWSER_CAPABILITY_UNSUPPORTED" });
  });

  it("rejects unauthorized tabs before projection", async () => {
    const runtime = Object.assign(Object.create(BrowserRuntime.prototype), {
      tabsRegistry: { assertMcpOwned: () => { throw new AppError("TAB_NOT_OWNED", "not owned"); } },
      selectTab: jest.fn(async () => undefined),
      driver: {},
    }) as BrowserRuntime;
    await expect(runtime.snapshot({ tabId: "tab-x", filter: "interactive" }))
      .rejects.toMatchObject({ code: "TAB_NOT_OWNED" });
  });
});
