import vm from "node:vm";
import { describe, expect, it } from "@jest/globals";
import { buildPersonalBrowserExtensionAssets } from "../../../src/companion/personal-browser-extension-assets.js";

type FakeElement = ReturnType<typeof fakeElement>;

describe("personal browser extension assets", () => {
  it("never exposes a password input value as an accessible name", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const password = fakeElement({
      tagName: "INPUT",
      attributes: {
        type: "password",
      },
      labels: [{ innerText: "Password", textContent: "Password" }],
      value: "fictional-super-secret",
    });
    const dom = createDom([password]);
    const snapshotPage = vm.runInContext(
      `(${extractFunction(serviceWorker, "snapshotPage")})`,
      dom.context,
    ) as (generation: string) => {
      content: string;
      refs: Array<{ ref: string; role: string; name: string }>;
    };

    const result = snapshotPage("generation1");

    expect(result.refs).toHaveLength(1);
    expect(result.refs[0]).toMatchObject({
      role: "textbox",
      name: "Password",
    });
    expect(JSON.stringify(result)).not.toContain("fictional-super-secret");
  });

  it("invalidates refs from an older snapshot generation", () => {
    const { serviceWorker } = buildPersonalBrowserExtensionAssets("x".repeat(43), 3361);
    const snapshotPageSource = extractFunction(serviceWorker, "snapshotPage");
    const clickRefSource = extractFunction(serviceWorker, "clickRef");

    const first = fakeElement({ tagName: "BUTTON", text: "First" });
    const second = fakeElement({ tagName: "BUTTON", text: "Second" });
    const dom = createDom([first, second]);
    const snapshotPage = vm.runInContext(
      `(${snapshotPageSource})`,
      dom.context,
    ) as (generation: string) => {
      refs: Array<{ ref: string; role: string; name: string }>;
    };
    const clickRef = vm.runInContext(
      `(${clickRefSource})`,
      dom.context,
    ) as (ref: string) => boolean;

    const firstSnapshot = snapshotPage("generation1");
    const staleRef = firstSnapshot.refs[0]!.ref;

    dom.setInteractiveElements([second]);
    const secondSnapshot = snapshotPage("generation2");
    const currentRef = secondSnapshot.refs[0]!.ref;

    expect(staleRef).not.toBe(currentRef);
    expect(clickRef(staleRef)).toBe(false);
    expect(first.clickCount).toBe(0);
    expect(clickRef(currentRef)).toBe(true);
    expect(second.clickCount).toBe(1);
  });
});

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Function not found: ${name}`);
  const brace = source.indexOf("{", start);
  if (brace < 0) throw new Error(`Function body not found: ${name}`);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Function body is incomplete: ${name}`);
}

function createDom(initialElements: FakeElement[]) {
  let interactiveElements = initialElements;
  const allElements = new Set<FakeElement>(initialElements);
  const document = {
    body: { innerText: "Login page" },
    title: "Test",
    querySelectorAll(selector: string) {
      if (selector === "[data-mcp-v3-ref]") {
        return [...allElements].filter((element) =>
          element.getAttribute("data-mcp-v3-ref") !== null
        );
      }
      return interactiveElements;
    },
    querySelector(selector: string) {
      const match = /^\[data-mcp-v3-ref='(.+)'\]$/u.exec(selector);
      if (!match) return null;
      return [...allElements].find(
        (element) => element.getAttribute("data-mcp-v3-ref") === match[1],
      ) ?? null;
    },
    getElementById() {
      return null;
    },
  };
  const context = vm.createContext({
    document,
    location: { href: "https://example.test/" },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    CSS: { escape: (value: string) => value },
    Array,
    String,
  });
  return {
    context,
    setInteractiveElements(elements: FakeElement[]) {
      interactiveElements = elements;
      for (const element of elements) allElements.add(element);
    },
  };
}

function fakeElement(options: {
  tagName: string;
  text?: string;
  value?: string;
  attributes?: Record<string, string>;
  labels?: Array<{ innerText?: string; textContent?: string }>;
}) {
  const attributes = new Map(Object.entries(options.attributes ?? {}));
  let clickCount = 0;
  return {
    tagName: options.tagName,
    innerText: options.text ?? "",
    textContent: options.text ?? "",
    value: options.value ?? "",
    labels: options.labels ?? [],
    get clickCount() {
      return clickCount;
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    getBoundingClientRect() {
      return { width: 100, height: 30 };
    },
    scrollIntoView() {},
    focus() {},
    click() {
      clickCount += 1;
    },
  };
}
