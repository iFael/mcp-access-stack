import { describe, expect, it } from "@jest/globals";
import {
  clickAuthorizationAction,
  BrowserInteractionContextService,
  containsBrowserEnterKey,
  validateBrowserKeySequence,
} from "../src/browser-interaction.js";

describe("browser action-key classification", () => {
  it("does not ask to confirm ordinary navigation or dialog dismissal", () => {
    const interactions = new BrowserInteractionContextService();
    const context = { tabId: "personal:7", url: "https://trello.com/b/test", title: "Automation" };
    for (const name of ["Mensagens", "Posts", "Cancelar", "Cancel"]) {
      expect(interactions.prepareDangerousAction(context, { ref: "r1", role: "button", name }, "click")).toBeUndefined();
    }
    expect(interactions.prepareDangerousAction(
      { ...context, url: "https://example.test/close-account", title: "Close account" },
      { ref: "r1", role: "button", name: "Cancelar" }, "click",
    )).toMatchObject({ category: "delete-or-cancel" });
    expect(interactions.prepareDangerousAction(context,
      { ref: "r2", role: "button", name: "Cancelar assinatura" }, "click",
    )).toMatchObject({ category: "delete-or-cancel" });
    expect(interactions.prepareDangerousAction(context,
      { ref: "r3", role: "button", name: "Enviar mensagem" }, "click",
    )).toMatchObject({ category: "send-message" });
  });
  it("permits ordinary links and toggles while guarding sensitive links and consent", () => {
    const interactions = new BrowserInteractionContextService();
    const context = { tabId: "personal:7", url: "https://example.test/dashboard", title: "Dashboard" };
    for (const [role, name] of [
      ["link", "Read messages"], ["link", "Help"], ["checkbox", "Show details"], ["switch", "Enable filters"],
    ] as const) {
      expect(interactions.prepareDangerousAction(context, { ref: "r", role, name }, "click")).toBeUndefined();
    }
    for (const [role, name, category] of [
      ["link", "Place order", "purchase-or-payment"],
      ["link", "Transfer funds", "purchase-or-payment"],
      ["link", "Subscribe", "purchase-or-payment"],
      ["link", "Delete account", "delete-or-cancel"],
      ["checkbox", "Accept terms", "accept-terms-or-contract"],
      ["switch", "Delete all records", "delete-or-cancel"],
    ] as const) {
      expect(interactions.prepareDangerousAction(context, { ref: "r", role, name }, "click"))
        .toMatchObject({ category });
    }
    expect(interactions.prepareDangerousAction(
      { ...context, url: "https://example.test/checkout", title: "Checkout" },
      { ref: "r", role: "link", name: "Continue" }, "click",
    )).toMatchObject({ category: "purchase-or-payment" });
  });

  it("recognizes Enter in single keys, chords and sequences", () => {
    for (const key of ["Enter", "Return", "NumpadEnter", "Ctrl+Enter", "Control+Shift+Return", "Tab Ctrl+Enter", "Alt+A NumpadEnter"]) {
      expect(containsBrowserEnterKey(key)).toBe(true);
    }
    for (const key of ["Tab", "Ctrl+A", "Enterprises", "Alt+Escape", "NumpadEnter2"]) {
      expect(containsBrowserEnterKey(key)).toBe(false);
    }
  });

  it("rejects repeated Enter and unbounded combined keyboard actions", () => {
    expect(() => validateBrowserKeySequence("Ctrl+A Tab", 20)).not.toThrow();
    expect(() => validateBrowserKeySequence("Enter", 2)).toThrow(
      expect.objectContaining({ code: "ACTION_BLOCKED_BY_POLICY" }),
    );
    expect(() => validateBrowserKeySequence("Alt+A Ctrl+Enter", 2)).toThrow(
      expect.objectContaining({ code: "ACTION_BLOCKED_BY_POLICY" }),
    );
    expect(() => validateBrowserKeySequence("Ctrl+A Tab", 100)).toThrow(
      expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
    );
  });

  it("binds click variants deterministically while preserving legacy click identity", () => {
    expect(clickAuthorizationAction({})).toBe("click");
    expect(clickAuthorizationAction({ button: "left", clickCount: 1 })).toBe("click");
    expect(clickAuthorizationAction({ button: "right", clickCount: 2, modifiers: ["Shift", "Control"] }))
      .toBe("click:right:2:Control+Shift");
  });
});
