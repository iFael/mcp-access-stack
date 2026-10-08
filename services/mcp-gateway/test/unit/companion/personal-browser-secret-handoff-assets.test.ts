import vm from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it } from "@jest/globals";
import {
  HANDOFF_EXTENSION_VERSION,
  HANDOFF_POPUP_HTML,
  HANDOFF_POPUP_SCRIPT,
  HANDOFF_WORKER_SOURCE,
} from "../../../src/companion/personal-browser-secret-handoff-assets.js";
import { buildPersonalBrowserExtensionAssets } from "../../../src/companion/personal-browser-extension-assets.js";

type MessageHandler = (message: unknown, sender: { id: string; url: string }, reply: (value: unknown) => void) => boolean;
type Reply = Record<string, unknown>;

function harness() {
  const storage = new Map<string, unknown>();
  let ownedTabs: unknown = undefined;
  let ownershipReadFails = false;
  let beforeTabsQuery: (() => void) | undefined;
  let ownershipTail = Promise.resolve();
  let handler: MessageHandler | undefined;
  let activeUrl = "https://github.com/iFael/mcp-access-stack/settings/environments/22362070741/edit";
  let injectedUrl: string | undefined;
  let focusedField: MockInput | undefined;
  const scriptCalls: Array<{ args: unknown[]; tabId: number }> = [];
  class MockInput {
    private stored = "";
    type = "text";
    name = "secret_value";
    id = "secret_value";
    placeholder = "Value";
    disabled = false;
    readOnly = false;
    labels: { textContent: string }[] = [];
    dispatched: string[] = [];
    constructor(initial = "") { this.stored = initial; }
    get value() { return this.stored; }
    set value(value: string) { this.stored = value; }
    getAttribute(_name: string) { return ""; }
    dispatchEvent(event: { type: string }) { this.dispatched.push(event.type); }
  }
  const named = new MockInput("MCP_CONTRACT_PREPARE_TOKEN");
  named.name = "secret_name";
  named.id = "secret_name";
  focusedField = new MockInput();
  const fakeDocument = {
    get activeElement() { return focusedField; },
    querySelectorAll: () => [named, focusedField],
  };
  class FakeEvent {
    constructor(public readonly type: string, public readonly options: unknown) {}
  }
  const chrome = {
    runtime: {
      id: "trusted-extension-id",
      getURL: (p: string) => "chrome-extension://trusted-extension-id/" + p,
      onMessage: { addListener: (fn: MessageHandler) => { handler = fn; } },
    },
    storage: { session: {
      setAccessLevel: async ({ accessLevel }: { accessLevel: string }) => {
        if (accessLevel !== "TRUSTED_CONTEXTS") throw Error("unsafe access level");
      },
      get: async (name: string) => ({ [name]: storage.get(name) }),
      set: async (entries: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(entries)) storage.set(key, value);
      },
      remove: async (name: string) => { storage.delete(name); },
    }, local: {
      get: async (_name: string) => {
        if (ownershipReadFails) throw Error("ownership-unavailable");
        return { mcpV3OwnedTabs: ownedTabs };
      },
    } },
    commands: { onCommand: { addListener: (_fn: unknown) => undefined } },
    tabs: { query: async () => {
      beforeTabsQuery?.();
      return [{ id: 42, url: activeUrl }];
    } },
    scripting: { executeScript: async (input: {
      target: { tabId: number };
      func: (...args: unknown[]) => string;
      args: unknown[];
    }) => {
      scriptCalls.push({ args: input.args, tabId: input.target.tabId });
      return [{ result: input.func(...input.args) }];
    } },
  };
  const context = vm.createContext({
    withOwnershipLock: async (work: () => Promise<unknown>) => {
      const task = ownershipTail.then(work);
      ownershipTail = task.then(() => undefined, () => undefined);
      return task;
    },
    OWNED_TABS_KEY: "mcpV3OwnedTabs", // gitleaks:allow -- fixed ownership registry slot, not a credential
    chrome, crypto: webcrypto, URL, Date, Array, Number, Math, Uint8Array,
    document: fakeDocument, location: { get href() { return injectedUrl ?? activeUrl; } },
    HTMLInputElement: MockInput, HTMLTextAreaElement: class {},
    Event: FakeEvent,
  });
  vm.runInContext(HANDOFF_WORKER_SOURCE, context);
  async function send(type: string, trusted = true): Promise<{ allowed: boolean; response?: Reply }> {
    if (!handler) throw Error("handler missing");
    let response: Reply | undefined;
    const allowed = handler({ type }, {
      id: trusted ? "trusted-extension-id" : "untrusted",
      url: "chrome-extension://trusted-extension-id/secret-provision.html",
    }, (value) => { response = value as Reply; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return response === undefined ? { allowed } : { allowed, response };
  }
  return {
    storage,
    scriptCalls,
    send,
    setUrl: (value: string) => { activeUrl = value; },
    setInjectedUrl: (value: string) => { injectedUrl = value; },
    setOwnedTabs: (value: unknown) => { ownedTabs = value; },
    failOwnershipRead: (value: boolean) => { ownershipReadFails = value; },
    onTabsQuery: (callback: (() => void) | undefined) => { beforeTabsQuery = callback; },
    getFocused: () => focusedField!,
    focus: (field: MockInput) => { focusedField = field; },
    createInput: (value: string) => new MockInput(value),
  };
}

describe("native MCP V3 browser secret handoff", () => {
  it("adds only browser-local popup, command and ephemeral session channel", () => {
    const assets = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const manifest = JSON.parse(assets.manifest) as {
      version: string; action: { default_popup: string }; commands: Record<string, unknown>;
    };
    expect(manifest.version).toBe(HANDOFF_EXTENSION_VERSION);
    expect(manifest.action.default_popup).toBe("secret-provision.html");
    expect(manifest.commands).toHaveProperty("fill-mcp-preparation-secret");
    expect(assets.popupHtml).toBe(HANDOFF_POPUP_HTML);
    expect(assets.popupScript).toBe(HANDOFF_POPUP_SCRIPT);
    expect(assets.popupScript).not.toContain("BRIDGE_TOKEN");
    expect(assets.serviceWorker).toContain("chrome.storage.session");
    expect(assets.serviceWorker).toContain("function withOwnershipLock(work)");
    expect(assets.serviceWorker).toContain("return withOwnershipLock(async () => {");
    expect(assets.serviceWorker).toContain("chrome.storage.local.get(OWNED_TABS_KEY)");
    expect(HANDOFF_WORKER_SOURCE).not.toContain("chrome.storage.local.set");
    expect(HANDOFF_WORKER_SOURCE).not.toContain("chrome.storage.sync.set");
    expect(assets.popupHtml).toContain("Salvar no Cloudflare realiza um deploy");
  });

  it("generates 48 random bytes in Chrome and never returns secret through popup messages", async () => {
    const h = harness();
    const first = await h.send("mcp-secret-generate");
    expect(first).toEqual({ allowed: true, response: { ok: true, ready: true } });
    const state = [...h.storage.values()][0] as { value: string; createdAt: number };
    expect(state.value).toMatch(/^[a-f0-9]{96}$/);
    expect(JSON.stringify(first)).not.toContain(state.value);
    expect(await h.send("mcp-secret-status")).toMatchObject({
      response: { ok: true, ready: true, remainingSeconds: expect.any(Number) },
    });
    const second = await h.send("mcp-secret-generate");
    const unchanged = [...h.storage.values()][0] as { value: string };
    expect(unchanged.value).toBe(state.value);
    expect(second.response).toMatchObject({ ok: true, alreadyExisting: true });
    expect(JSON.stringify(second)).not.toContain(state.value);
    await h.send("mcp-secret-clear");
    await h.send("mcp-secret-generate");
    const rotated = [...h.storage.values()][0] as { value: string };
    expect(rotated.value).not.toBe(state.value);
  });

  it("coalesces simultaneous generate requests instead of silently rotating the session secret", async () => {
    const h = harness();
    const results = await Promise.all([
      h.send("mcp-secret-generate"),
      h.send("mcp-secret-generate"),
      h.send("mcp-secret-generate"),
    ]);
    expect(results.every(r => r.response?.ok === true)).toBe(true);
    expect(results.filter(r => r.response?.alreadyExisting === true)).toHaveLength(2);
    expect([...h.storage.values()]).toHaveLength(1);
  });

  it("fills the exact same value on only two pinned first-party forms without submitting", async () => {
    const h = harness();
    await h.send("mcp-secret-generate");
    const secret = ([...h.storage.values()][0] as { value: string }).value;
    expect(await h.send("mcp-secret-fill")).toEqual({
      allowed: true, response: { ok: true, destination: "github" },
    });
    expect(h.getFocused().value).toBe(secret);
    expect(h.getFocused().dispatched).toEqual(["input", "change"]);
    h.focus(h.createInput(""));
    h.setUrl("https://dash.cloudflare.com/06bfcc0655690697e74ecd3ba200faca/workers/services/view/mcp-access-stack/production/settings");
    expect(await h.send("mcp-secret-fill")).toEqual({
      allowed: true, response: { ok: true, destination: "cloudflare" },
    });
    expect(h.getFocused().value).toBe(secret);
    expect(h.scriptCalls).toHaveLength(2);
    expect(h.scriptCalls.map(c => c.args[0])).toEqual([secret, secret]);
    expect(JSON.stringify(await h.send("mcp-secret-status"))).not.toContain(secret);
  });

  it("rejects other repositories, Cloudflare workers, ports, insecure transport and non-value fields", async () => {
    const h = harness();
    await h.send("mcp-secret-generate");
    const before = h.scriptCalls.length;
    for (const url of [
      "https://evil.example/secret",
      "http://github.com/iFael/mcp-access-stack/settings/environments/22362070741/edit",
      "https://github.com/Other/repo/settings/environments/22362070741/edit",
      "https://github.com:8443/iFael/mcp-access-stack/settings/environments/22362070741/edit",
      "https://dash.cloudflare.com/06bfcc0655690697e74ecd3ba200faca/workers/services/view/other/production/settings",
    ]) {
      h.setUrl(url);
      const result = await h.send("mcp-secret-fill");
      expect(result.response).toEqual({ ok: false, code: "refused" });
    }
    expect(h.scriptCalls).toHaveLength(before);
    h.setUrl("https://github.com/iFael/mcp-access-stack/settings/environments/22362070741/edit");
    const field = h.createInput("");
    field.name = "search";
    field.id = "search";
    field.placeholder = "Search";
    h.focus(field);
    expect((await h.send("mcp-secret-fill")).response).toEqual({ ok: false, code: "refused" });
    expect(field.value).toBe("");
  });

  it("allows an ordinary human tab even when other tabs belong to MCP", async () => {
    const h = harness();
    await h.send("mcp-secret-generate");
    h.setOwnedTabs({ "41": { ownership: "mcp" } });
    expect((await h.send("mcp-secret-fill")).response).toEqual({
      ok: true, destination: "github",
    });
    expect(h.scriptCalls).toHaveLength(1);
  });

  it("rejects MCP-owned tabs before any secret is injected or returned", async () => {
    const h = harness();
    await h.send("mcp-secret-generate");
    h.setOwnedTabs({ "42": { ownership: "mcp" } });
    const response = await h.send("mcp-secret-fill");
    expect(response.response).toEqual({ ok: false, code: "refused" });
    expect(h.scriptCalls).toHaveLength(0);
    expect(h.getFocused().value).toBe("");
  });

  it("fails closed when the ownership registry cannot be read or is malformed", async () => {
    const h = harness();
    await h.send("mcp-secret-generate");
    h.failOwnershipRead(true);
    expect((await h.send("mcp-secret-fill")).response).toEqual({ ok: false, code: "refused" });
    h.failOwnershipRead(false);
    for (const malformed of [null, [], "invalid", 42]) {
      h.setOwnedTabs(malformed);
      expect((await h.send("mcp-secret-fill")).response).toEqual({ ok: false, code: "refused" });
    }
    expect(h.scriptCalls).toHaveLength(0);
    expect(h.getFocused().value).toBe("");
  });

  it("rejects a tab that becomes MCP-owned during tab lookup", async () => {
    const h = harness();
    await h.send("mcp-secret-generate");
    h.onTabsQuery(() => h.setOwnedTabs({ "42": { ownership: "mcp" } }));
    expect((await h.send("mcp-secret-fill")).response).toEqual({ ok: false, code: "refused" });
    expect(h.scriptCalls).toHaveLength(0);
    expect(h.getFocused().value).toBe("");
  });

  it("rejects a navigation to a different port between initial URL check and script injection", async () => {
    const h = harness();
    await h.send("mcp-secret-generate");
    h.setInjectedUrl("https://github.com:8443/iFael/mcp-access-stack/settings/environments/22362070741/edit");
    expect((await h.send("mcp-secret-fill")).response).toEqual({ ok: false, code: "refused" });
    expect(h.getFocused().value).toBe("");
  });

  it("blocks untrusted runtime senders and expires and clears session secrets", async () => {
    const h = harness();
    expect(await h.send("mcp-secret-generate", false)).toEqual({ allowed: false });
    expect(h.storage.size).toBe(0);
    await h.send("mcp-secret-generate");
    const [key, record] = [...h.storage.entries()][0] as [string, { value: string; createdAt: number }];
    h.storage.set(key, { ...record, createdAt: Date.now() - 16 * 60 * 1000 });
    expect((await h.send("mcp-secret-status")).response).toMatchObject({ ok: true, ready: false });
    expect(h.storage.size).toBe(0);
    expect((await h.send("mcp-secret-fill")).response).toEqual({ ok: false, code: "refused" });
    await h.send("mcp-secret-generate");
    expect((await h.send("mcp-secret-clear")).response).toEqual({ ok: true, ready: false });
    expect(h.storage.size).toBe(0);
  });
});
