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
      { ref: "container-ref", role: "generic", name: "" },
      { ref: "button-ref", role: "button", name: "Increment" },
      { ref: "help-ref", role: "link", name: "Help" },
      { ref: "status-ref", role: "status", name: "" },
    ]));
    expect(service.currentReferences(tab.tabId)).toHaveLength(4);
  });

  it("never lets one reference consume content from a later snapshot line", () => {
    const service = new BrowserInteractionContextService();
    const references = service.captureReferences(
      tab.tabId,
      [
        '- option "Alpha"',
        '- option "Beta"',
        '- generic "Target" [ref=target-ref]',
        '- <changed> textbox "Email" [focused] [ref=email-ref]',
      ].join("\n"),
    );

    expect(references).toEqual([
      { ref: "target-ref", role: "generic", name: "Target" },
      { ref: "email-ref", role: "textbox", name: "Email" },
    ]);
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

  it("judges generic and save controls by the page they are on", () => {
    const service = new BrowserInteractionContextService();
    const button = (name: string): BrowserElementReference => ({ ref: "b", role: "button", name });
    const on = (url: string, title?: string) => ({ ...tab, url, ...(title ? { title } : {}) });
    const category = (page: Pick<BrowserTab, "tabId" | "url" | "title">, reference: BrowserElementReference) =>
      service.prepareDangerousAction(page, reference, "click")?.category;

    // Checkout, account deletion and security pages, by host label, path or title.
    expect(category(on("https://shop.example/checkout/review"), button("Confirmar"))).toBe("purchase-or-payment");
    expect(category(on("https://pay.example/session/1"), button("Continue"))).toBe("purchase-or-payment");
    expect(category(on("https://loja.example/p/1", "Pagamento - Loja"), button("Próximo"))).toBe("purchase-or-payment");
    expect(category(on("https://app.example/settings/close-account"), button("Continuar"))).toBe("delete-or-cancel");
    expect(category(on("https://app.example/conta/excluir"), button("Salvar"))).toBe("delete-or-cancel");
    expect(category(on("https://app.example/settings/security"), button("Save"))).toBe("change-credentials");
    expect(category(on("https://app.example/minha-conta/seguran%C3%A7a"), button("Salvar"))).toBe("change-credentials");
    // A label that already names a risk keeps it; links and unlabeled risk stay as they were.
    expect(category(on("https://shop.example/checkout"), button("Remove item"))).toBe("delete-or-cancel");
    expect(category(on("https://shop.example/checkout"), { ref: "l", role: "link", name: "Continue shopping" })).toBeUndefined();
    expect(category(on("https://shop.example/checkout"), button("Ver detalhes"))).toBeUndefined();
    expect(category(on("https://app.example/profile"), button("Continuar"))).toBeUndefined();
    expect(category(on("https://app.example/profile"), button("Salvar"))).toBe("submit-form");
    // Orders, subscriptions and transfers are payments wherever they are.
    for (const name of ["Confirmar pedido", "Finalizar pedido", "Assinar plano", "Transferir agora",
      "Confirmar transferência", "Subscribe", "Doar"]) {
      expect(category(on("https://app.example/profile"), button(name))).toBe("purchase-or-payment");
    }
    expect(service.pageRiskCategory(on("https://shop.example/carrinho"))).toBe("purchase-or-payment");
    expect(service.pageRiskCategory(on("https://shop.example/produtos"))).toBeUndefined();
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
