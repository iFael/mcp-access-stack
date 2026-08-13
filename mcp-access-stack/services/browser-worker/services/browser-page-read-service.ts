import {
  AppError,
  type BrowserExtractInput,
  type BrowserTab,
  type BrowserWaitInput,
} from "@vs-code-gpt/shared";
import type {
  BrowserDriver,
  BrowserDriverResponse,
} from "../drivers/browser-driver.js";
import type {
  BrowserElementReference,
  BrowserInteractionContextService,
} from "./browser-interaction-context-service.js";

export interface BrowserPageSnapshot {
  tab: BrowserTab;
  content: string;
  refs: BrowserElementReference[];
}

export interface BrowserPageReadServiceOptions {
  driver: Pick<BrowserDriver, "snapshot" | "wait" | "evaluate">;
  interactionContext: Pick<
    BrowserInteractionContextService,
    "captureReferences"
  >;
  updateSelectedTab(
    tabId: string,
    response: BrowserDriverResponse,
    fallbackUrl?: string,
  ): BrowserTab;
  actionTimeoutMs: number;
  pollIntervalMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

export class BrowserPageReadService {
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(private readonly options: BrowserPageReadServiceOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? sleep;
  }

  async captureSnapshot(tabId: string): Promise<BrowserPageSnapshot> {
    const response = await this.options.driver.snapshot();
    const tab = this.options.updateSelectedTab(tabId, response);
    const content = response.snapshot ?? "";
    if (/\b(?:captcha|recaptcha|hcaptcha)\b/i.test(content)) {
      throw new AppError(
        "CAPTCHA_DETECTED",
        "A CAPTCHA requires manual completion in Chrome.",
      );
    }
    const refs = this.options.interactionContext.captureReferences(
      tabId,
      content,
    );
    return { tab, content, refs };
  }

  async wait(
    tabId: string,
    input: Pick<BrowserWaitInput, "timeoutMs" | "text" | "ref">,
  ): Promise<void> {
    if (input.ref) {
      const deadline =
        this.now() + (input.timeoutMs ?? this.options.actionTimeoutMs);
      while (this.now() < deadline) {
        const snapshot = await this.captureSnapshot(tabId);
        if (snapshot.refs.some((reference) => reference.ref === input.ref)) {
          return;
        }
        await this.delay(this.pollIntervalMs);
      }
      throw new AppError(
        "BROWSER_WORKER_TIMEOUT",
        `Element reference ${input.ref} did not appear in time.`,
      );
    }

    const response = await this.options.driver.wait({
      ...(input.timeoutMs === undefined
        ? {}
        : { time: input.timeoutMs / 1_000 }),
      ...(input.text === undefined ? {} : { text: input.text }),
    });
    this.options.updateSelectedTab(tabId, response);
  }

  async extract(
    input: Pick<BrowserExtractInput, "ref" | "selector" | "format">,
  ): Promise<unknown> {
    const target = input.ref ?? input.selector;
    const format = input.format ?? "text";
    const response = await this.options.driver.evaluate({
      function: extractionFunction(format, Boolean(target)),
      ...(target === undefined ? {} : { target, element: target }),
    });
    return response.result;
  }
}

function extractionFunction(
  format: "text" | "html" | "json",
  hasTarget: boolean,
): string {
  if (format === "html") {
    return hasTarget
      ? "(element) => element.outerHTML"
      : "() => document.documentElement.outerHTML";
  }
  if (format === "json") {
    return hasTarget
      ? "(element) => ({ tagName: element.tagName, text: element.innerText ?? element.textContent ?? '', attributes: Object.fromEntries([...element.attributes].map(a => [a.name, a.value])) })"
      : "() => ({ title: document.title, url: location.href, text: document.body?.innerText ?? '' })";
  }
  return hasTarget
    ? "(element) => element.innerText ?? element.textContent ?? ''"
    : "() => document.body?.innerText ?? ''";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
