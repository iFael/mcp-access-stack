import { createHash } from "node:crypto";
import { describe, expect, it, jest } from "@jest/globals";
import { BrowserRuntime } from "../../services/browser-runtime.js";

const tab = { tabId: "tab-7", url: "https://example.com/page" };

function makeRuntime(readOnly = false) {
  const confirm = jest.fn((_id: string, _binding: unknown) => undefined);
  const create = jest.fn((_binding: unknown) => ({
    confirmationId: "pending-confirmation", expiresAt: "2099-01-01T00:00:00.000Z",
  }));
  const evaluate = jest.fn(async (_input: unknown) => ({
    page: { url: tab.url, title: "Example" },
    result: { title: "Example", password: "secret" },
  }));
  const type = jest.fn(async (_input: unknown) => ({
    page: { url: tab.url, title: "Example" },
  }));
  const prepareConfirmation = jest.fn((_tab: unknown, category: string, action: string, target: string) => ({
    tabId: tab.tabId, origin: "https://example.com", url: tab.url, category, action, target,
  }));
  const runtime = Object.assign(Object.create(BrowserRuntime.prototype), {
    tabsRegistry: { assertMcpOwned: (tabId: string) => {
      if (tabId !== tab.tabId) throw Error("Wrong tab");
      return tab;
    } },
    isBusinessReadOnlyTab: () => readOnly,
    assertBusinessReadOnlyKey: (_tab: unknown, _key: string) => {
      if (readOnly) throw Object.assign(Error("Read-only"), { code: "ACTION_BLOCKED_BY_POLICY" });
    },
    interactionContext: {
      prepareConfirmation,
      requireReference: jest.fn((_tabId: string, ref: string) => ({ ref })),
    },
    confirmations: { create, consume: confirm },
    selectTab: jest.fn(async () => undefined),
    driver: { evaluate, type },
    beginNavigation: jest.fn(async () => undefined),
    updateSelectedTab: jest.fn(() => tab),
    updateRequestedUrl: jest.fn(() => tab),
    checkpoint: jest.fn(async () => undefined),
    withActionState: jest.fn(async () => ({ tabId: tab.tabId, completed: true })),
  }) as BrowserRuntime;
  return { runtime, confirm, create, evaluate, type, prepareConfirmation };
}

describe("managed browser autonomous type and evaluate", () => {
  it("requires confirmation bound to SHA-256 of function and sanitizes the result", async () => {
    const { runtime, evaluate, prepareConfirmation, confirm } = makeRuntime();
    const source = "() => document.title";
    await expect(runtime.evaluate({ tabId: tab.tabId, function: source }))
      .rejects.toMatchObject({ code: "ACTION_REQUIRES_CONFIRMATION" });
    expect(evaluate).not.toHaveBeenCalled();
    expect(prepareConfirmation).toHaveBeenCalledWith(
      tab, "execute-script", "evaluate", "sha256:" + createHash("sha256").update(source).digest("hex"),
    );
    await expect(runtime.evaluate({ tabId: tab.tabId, function: source, confirmationId: "allowed" }))
      .resolves.toMatchObject({ tabId: tab.tabId, value: { title: "Example", password: "[redacted]" } });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("blocks evaluation on read-only business sites", async () => {
    const { runtime, evaluate } = makeRuntime(true);
    await expect(runtime.evaluate({ tabId: tab.tabId, function: "() => 1" }))
      .rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("types in the focused control, requiring text-bound confirmation only for submit", async () => {
    const { runtime, type, prepareConfirmation } = makeRuntime();
    await expect(runtime.type({ tabId: tab.tabId, text: "query" }))
      .resolves.toMatchObject({ tabId: tab.tabId, completed: true });
    expect(type).toHaveBeenCalledWith({ text: "query" });
    await expect(runtime.type({ tabId: tab.tabId, text: "query", submit: true }))
      .rejects.toMatchObject({ code: "ACTION_REQUIRES_CONFIRMATION" });
    expect(prepareConfirmation).toHaveBeenCalledWith(
      tab, "submit-form", "type", "keyboard:Enter:sha256:" + createHash("sha256").update("query").digest("hex"),
    );
    expect(type).toHaveBeenCalledTimes(1);
    await expect(runtime.type({ tabId: tab.tabId, text: "query", submit: true, confirmationId: "allowed" }))
      .resolves.toMatchObject({ completed: true });
    expect(type).toHaveBeenCalledWith({ text: "query", submit: true });
  });
});
