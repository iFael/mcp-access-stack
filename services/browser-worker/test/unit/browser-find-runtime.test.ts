import { describe, expect, it, jest } from "@jest/globals";
import { AppError } from "@vs-code-gpt/shared";
import { BrowserRuntime } from "../../services/browser-runtime.js";

describe("browser find runtime", () => {
  it("refreshes the owned tab snapshot and returns only matching live references", async () => {
    const snapshot = jest.fn(async (_input: unknown, _context?: unknown) => ({
      tabId: "tab-7",
      url: "https://example.com/",
      content: '- button "Enviar" [ref=r1]',
      refs: [
        { ref: "r1", role: "button", name: "Enviar" },
        { ref: "r2", role: "link", name: "Enviar relatório" },
      ],
    }));
    const runtime = Object.assign(Object.create(BrowserRuntime.prototype) as BrowserRuntime, { snapshot });
    const found = await runtime.find({ tabId: "tab-7", query: "enviar", role: "button" });
    expect(snapshot).toHaveBeenCalledWith({ tabId: "tab-7", forceFull: true }, {});
    expect(found).toMatchObject({
      tabId: "tab-7",
      url: "https://example.com/",
      matches: [{ ref: "r1", name: "Enviar", score: 100 }],
    });
  });

  it("does not silently bypass snapshot authorization failure", async () => {
    const runtime = Object.assign(Object.create(BrowserRuntime.prototype) as BrowserRuntime, {
      snapshot: jest.fn(async () => { throw new AppError("TAB_NOT_OWNED", "not owned"); }),
    });
    await expect(runtime.find({ tabId: "tab-x", query: "Enviar" })).rejects.toMatchObject({
      code: "TAB_NOT_OWNED",
    });
  });
});
