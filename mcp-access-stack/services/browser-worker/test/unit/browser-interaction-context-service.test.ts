import { describe, expect, it } from "@jest/globals";
import type { BrowserTab } from "@vs-code-gpt/shared";
import {
  BrowserInteractionContextService,
  type BrowserElementReference,
} from "../../services/browser-interaction-context-service.js";

const tab: BrowserTab = {
  tabId: "tab-1",
  ownership: "mcp",
  purpose: "interaction-test",
  reusable: true,
  protected: false,
  sticky: false,
  createdAt: "2026-07-23T00:00:00.000Z",
  lastUsedAt: "2026-07-23T00:00:00.000Z",
  url: "https://example.test/form",
  title: "Example",
};

describe("BrowserInteractionContextService", () => {
  it("parses and stores snapshot references", () => {
    const service = new BrowserInteractionContextService();

    const references = service.captureReferences(
      tab.tabId,
      [
        '- button "Save changes" [ref=button-1]',
        "- textbox 'Email address' [required] [ref=input-1]",
        "- link Continue [ref=link-1]",
        "- invalid line without reference",
      ].join("\n"),
    );

    expect(references).toEqual([
      { ref: "button-1", role: "button", name: "Save changes" },
      { ref: "input-1", role: "textbox", name: "Email address" },
      { ref: "link-1", role: "link", name: "Continue" },
    ]);
    expect(service.requireReference(tab.tabId, "input-1")).toEqual(
      references[1],
    );
  });

  it("replaces references per tab and keeps tab caches isolated", () => {
    const service = new BrowserInteractionContextService();
    service.captureReferences(tab.tabId, '- button "Old" [ref=old-ref]');
    service.captureReferences("tab-2", '- button "Other" [ref=other-ref]');
    service.captureReferences(tab.tabId, '- button "New" [ref=new-ref]');

    expect(() => service.requireReference(tab.tabId, "old-ref")).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(service.requireReference(tab.tabId, "new-ref").name).toBe("New");
    expect(service.requireReference("tab-2", "other-ref").name).toBe("Other");
  });

  it("merges tracked delta references without dropping unchanged controls", () => {
    const service = new BrowserInteractionContextService();
    service.captureReferences(
      tab.tabId,
      [
        '- button "Increment" [ref=button-ref]',
        '- link "Help" [ref=help-ref]',
      ].join("\n"),
    );

    const merged = service.mergeReferences(
      tab.tabId,
      [
        '- <changed> generic [ref=container-ref]:',
        '  - button "Increment" [active] [ref=button-ref]',
        '  - status [ref=status-ref]: "1"',
      ].join("\n"),
    );

    expect(merged).toEqual(expect.arrayContaining([
      { ref: "button-ref", role: "button", name: "Increment" },
      { ref: "help-ref", role: "link", name: "Help" },
      { ref: "status-ref", role: "status", name: "" },
    ]));
    expect(service.currentReferences(tab.tabId)).toHaveLength(3);
  });

  it("discards one tab or clears every cached reference", () => {
    const service = new BrowserInteractionContextService();
    service.captureReferences(tab.tabId, '- button "One" [ref=one]');
    service.captureReferences("tab-2", '- button "Two" [ref=two]');

    service.discardReferences(tab.tabId);
    expect(() => service.requireReference(tab.tabId, "one")).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
    expect(service.requireReference("tab-2", "two").name).toBe("Two");

    service.clearReferences();
    expect(() => service.requireReference("tab-2", "two")).toThrow(
      expect.objectContaining({ code: "INVALID_ARGUMENT" }),
    );
  });

  it("classifies every protected action category", () => {
    const service = new BrowserInteractionContextService();
    const cases: Array<[string, string]> = [
      ["Delete account", "delete-or-cancel"],
      ["Pay order", "purchase-or-payment"],
      ["Send email", "send-message"],
      ["Publish post", "publish-content"],
      ["Change password", "change-credentials"],
      ["Accept contract", "accept-terms-or-contract"],
      ["Attach file", "upload-file"],
      ["Save form", "submit-form"],
    ];

    for (const [name, category] of cases) {
      const reference: BrowserElementReference = {
        ref: name.toLowerCase().replaceAll(" ", "-"),
        role: "button",
        name,
      };
      expect(
        service.prepareDangerousAction(tab, reference, "click"),
      ).toMatchObject({
        tabId: tab.tabId,
        category,
        action: "click",
        target: `button:${name}`,
      });
    }
  });

  it("returns no authorization for safe targets and prepares frame targets", () => {
    const service = new BrowserInteractionContextService();

    expect(
      service.prepareDangerousAction(
        tab,
        { ref: "help", role: "link", name: "Read help" },
        "click",
      ),
    ).toBeUndefined();
    expect(
      service.prepareDangerousTarget(
        tab,
        "Confirm purchase",
        "frame-click",
        "frame-element",
      ),
    ).toMatchObject({
      category: "purchase-or-payment",
      action: "frame-click",
      target: "Confirm purchase",
    });
  });

  it("builds stable bindings for HTTP and non-HTTP tabs", () => {
    const service = new BrowserInteractionContextService();

    expect(
      service.prepareConfirmation(
        tab,
        "upload-file",
        "upload",
        "input:file.txt",
      ),
    ).toEqual({
      tabId: tab.tabId,
      origin: "https://example.test",
      url: "https://example.test/form",
      category: "upload-file",
      action: "upload",
      target: "input:file.txt",
    });

    expect(
      service.prepareConfirmation(
        { ...tab, url: "about:blank" },
        "submit-form",
        "press",
        "keyboard:Enter",
      ),
    ).toMatchObject({ origin: "null", url: "about:blank" });
  });
});
