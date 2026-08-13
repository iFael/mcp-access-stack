import type {
  BrowserFrameClickInput,
  BrowserFrameExtractInput,
  BrowserFrameExtractResult,
  BrowserFrameFillInput,
} from "@vs-code-gpt/shared";
import type { Frame } from "playwright";
import type { BrowserDriverResponse } from "../drivers/browser-driver.js";

export interface BrowserFrameOperationDriver {
  resolveFrame(name: string): Promise<Frame>;
  currentPageResponse(content?: string): Promise<BrowserDriverResponse>;
}

export interface BrowserFrameOperationServiceOptions {
  driver: BrowserFrameOperationDriver;
}

export class BrowserFrameOperationService {
  constructor(private readonly options: BrowserFrameOperationServiceOptions) {}

  async extract(
    input: BrowserFrameExtractInput,
  ): Promise<Pick<BrowserFrameExtractResult, "format" | "value">> {
    const format = input.format ?? "text";
    const frame = await this.options.driver.resolveFrame(input.frame);
    const locator = input.selector
      ? frame.locator(input.selector)
      : frame.locator("body");
    const value = format === "html"
      ? await locator.evaluate("(element) => element.outerHTML" as never)
      : format === "json"
        ? await locator.evaluate(`(element) => ({
            tagName: element.tagName,
            text: element.innerText || element.textContent || "",
            attributes: Object.fromEntries(
              Array.from(element.attributes).map(attribute => [
                attribute.name,
                attribute.value,
              ]),
            ),
          })` as never)
        : await locator.innerText().catch(() => locator.textContent());
    return { format, value };
  }

  async click(input: BrowserFrameClickInput): Promise<BrowserDriverResponse> {
    const frame = await this.options.driver.resolveFrame(input.frame);
    let locator = input.selector
      ? frame.locator(input.selector)
      : frame.getByText(input.text!, {
          exact: (input.match ?? "contains") === "exact",
        });
    if (input.text && input.selector) {
      locator = locator.filter({ hasText: input.text });
    }
    await locator.nth(input.index ?? 0).click();
    return this.options.driver.currentPageResponse();
  }

  async fill(input: BrowserFrameFillInput): Promise<BrowserDriverResponse> {
    const frame = await this.options.driver.resolveFrame(input.frame);
    await frame.locator(input.selector).fill(input.value);
    return this.options.driver.currentPageResponse();
  }
}
