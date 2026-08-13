import { describe, expect, it } from "@jest/globals";
import { BrowserConfirmationRegistry } from "../../domain/confirmation-registry.js";

describe("BrowserConfirmationRegistry", () => {
  it("binds a one-time confirmation to the exact action", () => {
    const registry = new BrowserConfirmationRegistry(60_000);
    const binding = {
      tabId: "tab-1",
      origin: "https://example.com",
      url: "https://example.com/delete",
      category: "delete-or-cancel" as const,
      action: "click",
      target: "delete-account",
    };
    const confirmation = registry.create(binding);
    expect(() =>
      registry.consume(confirmation.confirmationId, { ...binding, target: "other" }),
    ).toThrow(/does not match/i);
    registry.consume(confirmation.confirmationId, binding);
    expect(() => registry.consume(confirmation.confirmationId, binding)).toThrow(
      /missing or expired/i,
    );
  });
});
