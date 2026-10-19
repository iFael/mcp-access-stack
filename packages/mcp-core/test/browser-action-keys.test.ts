import { describe, expect, it } from "@jest/globals";
import {
  clickAuthorizationAction,
  containsBrowserEnterKey,
  validateBrowserKeySequence,
} from "../src/browser-interaction.js";

describe("browser action-key classification", () => {
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
