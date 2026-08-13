import { describe, expect, it, jest } from "@jest/globals";
import type { Frame } from "playwright";
import type { BrowserDriverResponse } from "../../drivers/browser-driver.js";
import { BrowserFrameOperationService } from "../../services/browser-frame-operation-service.js";

describe("BrowserFrameOperationService", () => {
  it("extracts text from a native frame locator", async () => {
    const locator = fakeLocator({ innerText: "frame text" });
    const driver = fakeDriver(locator);
    const service = new BrowserFrameOperationService({ driver });

    await expect(
      service.extract({ tabId: "tab-1", frame: "content" }),
    ).resolves.toEqual({ format: "text", value: "frame text" });

    expect(driver.resolveFrame).toHaveBeenCalledWith("content");
    expect(locator.frame.locator).toHaveBeenCalledWith("body");
    expect(locator.innerText).toHaveBeenCalledTimes(1);
  });

  it("extracts typed JSON and HTML without textual parsing", async () => {
    const jsonLocator = fakeLocator({
      evaluateResult: {
        tagName: "DIV",
        text: "content",
        attributes: { id: "result" },
      },
    });
    const jsonService = new BrowserFrameOperationService({
      driver: fakeDriver(jsonLocator),
    });
    await expect(
      jsonService.extract({
        tabId: "tab-1",
        frame: "content",
        selector: "#result",
        format: "json",
      }),
    ).resolves.toEqual({
      format: "json",
      value: {
        tagName: "DIV",
        text: "content",
        attributes: { id: "result" },
      },
    });
    expect(jsonLocator.frame.locator).toHaveBeenCalledWith("#result");

    const htmlLocator = fakeLocator({ evaluateResult: "<main>content</main>" });
    const htmlService = new BrowserFrameOperationService({
      driver: fakeDriver(htmlLocator),
    });
    await expect(
      htmlService.extract({
        tabId: "tab-1",
        frame: "content",
        format: "html",
      }),
    ).resolves.toEqual({ format: "html", value: "<main>content</main>" });
  });

  it("clicks a native frame locator with selector, text filter and index", async () => {
    const locator = fakeLocator();
    const driver = fakeDriver(locator);
    const service = new BrowserFrameOperationService({ driver });

    await expect(
      service.click({
        tabId: "tab-1",
        frame: "content",
        selector: "button.action",
        text: "Confirm",
        match: "exact",
        index: 2,
      }),
    ).resolves.toEqual(driver.response);

    expect(locator.frame.locator).toHaveBeenCalledWith("button.action");
    expect(locator.filter).toHaveBeenCalledWith({ hasText: "Confirm" });
    expect(locator.nth).toHaveBeenCalledWith(2);
    expect(locator.click).toHaveBeenCalledTimes(1);
  });

  it("uses getByText when no selector is provided", async () => {
    const locator = fakeLocator();
    const driver = fakeDriver(locator);
    const service = new BrowserFrameOperationService({ driver });

    await service.click({
      tabId: "tab-1",
      frame: "menu",
      text: "Open",
      match: "contains",
    });

    expect(locator.frame.getByText).toHaveBeenCalledWith("Open", { exact: false });
    expect(locator.nth).toHaveBeenCalledWith(0);
  });

  it("fills a native frame input", async () => {
    const locator = fakeLocator();
    const driver = fakeDriver(locator);
    const service = new BrowserFrameOperationService({ driver });

    await expect(
      service.fill({
        tabId: "tab-1",
        frame: "form-frame",
        selector: "input[name=email]",
        value: "user@example.com",
      }),
    ).resolves.toEqual(driver.response);

    expect(locator.frame.locator).toHaveBeenCalledWith("input[name=email]");
    expect(locator.fill).toHaveBeenCalledWith("user@example.com");
  });
});

interface FakeLocatorOptions {
  innerText?: string;
  evaluateResult?: unknown;
}

function fakeLocator(options: FakeLocatorOptions = {}) {
  const click = jest.fn<() => Promise<void>>(async () => undefined);
  const fill = jest.fn<(value: string) => Promise<void>>(async () => undefined);
  const innerText = jest.fn<() => Promise<string>>(async () => options.innerText ?? "");
  const textContent = jest.fn<() => Promise<string | null>>(async () => options.innerText ?? null);
  const evaluate = jest.fn<(expression: unknown) => Promise<unknown>>(async () => options.evaluateResult);
  const locator = {
    click,
    fill,
    innerText,
    textContent,
    evaluate,
    filter: jest.fn<(options: unknown) => unknown>(),
    nth: jest.fn<(index: number) => unknown>(),
  } as {
    click: typeof click;
    fill: typeof fill;
    innerText: typeof innerText;
    textContent: typeof textContent;
    evaluate: typeof evaluate;
    filter: ReturnType<typeof jest.fn>;
    nth: ReturnType<typeof jest.fn>;
  };
  locator.filter.mockReturnValue(locator);
  locator.nth.mockReturnValue(locator);
  const frame = {
    locator: jest.fn<(selector: string) => typeof locator>(() => locator),
    getByText: jest.fn<(text: string, options?: unknown) => typeof locator>(() => locator),
  };
  return { ...locator, frame };
}

function fakeDriver(locator: ReturnType<typeof fakeLocator>) {
  const response: BrowserDriverResponse = {
    page: {
      id: "page-1",
      url: "https://example.test/",
      title: "Example",
    },
  };
  return {
    response,
    resolveFrame: jest.fn(async (_name: string) => locator.frame as unknown as Frame),
    currentPageResponse: jest.fn(async () => response),
  };
}
