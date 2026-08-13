import { describe, expect, it } from "@jest/globals";
import { TabRegistry } from "../../domain/tab-registry.js";

describe("TabRegistry", () => {
  it("treats unknown tabs as user-owned", () => {
    const registry = new TabRegistry();
    expect(registry.ownershipOf("unregistered")).toBe("user");
    expect(() => registry.assertMcpOwned("unregistered")).toThrow(/not owned/i);
  });

  it("allows only unprotected MCP tabs to close", () => {
    const registry = new TabRegistry();
    const generic = registry.registerMcp({ purpose: "research" });
    const sticky = registry.registerMcp({
      purpose: "private-site",
      sticky: true,
      url: "https://dev-private.example.test/app",
      lockedUrl: "https://dev-private.example.test/app",
    });
    expect(registry.assertClosable(generic.tabId).tabId).toBe(generic.tabId);
    expect(() => registry.assertClosable(sticky.tabId)).toThrow(/protected/i);
    expect(() =>
      registry.assertNavigable(sticky.tabId, "https://example.com"),
    ).toThrow(/cannot navigate away/i);
  });
});
