import { describe, expect, it } from "@jest/globals";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import type {
  BrowserDriverCallOptions,
  BrowserDriverResponse,
  BrowserPressRequest,
} from "../../drivers/browser-driver.js";
import {
  BrowserLegacyAutomationService,
  type BrowserLegacyAutomationDriver,
} from "../../services/browser-legacy-automation-service.js";

interface LegacySiteFixtureContract {
  frames: { menu: string; content: string; detail: string };
  menu: {
    homeSelector: string;
    financeClickSelector: string;
    cpxClickSelector: string;
    encodingSelector: string;
  };
  content: {
    headerSelector: string;
    refreshSelector: string;
    tableSelector: string;
    loadCountSelector: string;
  };
  encoding: { expectedText: string };
}

interface LegacySiteFixture {
  origin: string;
  legacySiteContract: LegacySiteFixtureContract;
  legacySiteUrl(nonce: string): string;
  getLegacySiteRequestCount(nonce: string, route: string): number;
  close(): Promise<void>;
}

describe("Legacy Automation Engine against deterministic LegacySite fixture", () => {
  it("waits through async menu expansion, chained replacement and a warm already-expanded path", async () => {
    await withFixture("stage12-navigation", async ({ fixture, page, service }) => {
      const input = {
        tabId: "tab-1",
        path: ["Financeiro", "CPX-Finance"],
        sourceFramePath: ["Menu"],
        targetFramePath: ["MenuContent"],
        timeoutMs: 5_000,
      };

      const cold = await service.navigatePath(input, false);
      const content = requireFrame(page, fixture.legacySiteContract.frames.content);

      expect(cold.result.completed).toBe(true);
      expect(cold.result.destinationReady).toBe(true);
      expect(content.url()).toMatch(/\/legacySite\/cpx-finance\.html/u);
      expect(fixture.getLegacySiteRequestCount("stage12-navigation", "loading")).toBe(1);
      expect(fixture.getLegacySiteRequestCount("stage12-navigation", "cpx-finance")).toBe(1);

      await service.frameSequence({
        tabId: "tab-1",
        steps: [{
          action: "click",
          framePath: ["Menu"],
          locator: { selector: fixture.legacySiteContract.menu.homeSelector },
        }],
        timeoutMs: 3_000,
      });
      expect(content.url()).toMatch(/\/legacySite\/home\.html/u);

      const warm = await service.navigatePath(input, false);
      expect(warm.result.completed).toBe(true);
      expect(warm.result.destinationReady).toBe(true);
      expect(content.url()).toMatch(/\/legacySite\/cpx-finance\.html/u);
      expect(fixture.getLegacySiteRequestCount("stage12-navigation", "loading")).toBe(2);
      expect(fixture.getLegacySiteRequestCount("stage12-navigation", "cpx-finance")).toBe(2);
      expect(warm.result.resolved).toHaveLength(2);
    });
  });

  it("preserves focus, fill, selection, keyboard and delayed grid postconditions", async () => {
    await withFixture("stage12-controls", async ({ fixture, page, service }) => {
      await service.navigatePath({
        tabId: "tab-1",
        path: ["Financeiro", "CPX-Finance"],
        sourceFramePath: ["Menu"],
        targetFramePath: ["MenuContent"],
        timeoutMs: 5_000,
      }, false);
      const content = requireFrame(page, fixture.legacySiteContract.frames.content);

      const result = await service.frameSequence({
        tabId: "tab-1",
        timeoutMs: 5_000,
        steps: [
          { action: "fill", framePath: ["MenuContent"], locator: { id: "IN2" }, value: "empresa-fixture" },
          { action: "select", framePath: ["MenuContent"], locator: { id: "legacy-status" }, value: "pending" },
          { action: "press", framePath: ["MenuContent"], locator: { id: "IN2" }, key: "Enter" },
          { action: "click", framePath: ["MenuContent"], locator: { text: "Histórico", exact: true } },
          { action: "waitFor", framePath: ["MenuContent"], locator: { selector: "body[data-active-view=\"historico\"]" }, state: "visible", timeoutMs: 1_500 },
          { action: "click", framePath: ["MenuContent"], locator: { text: "Conferências", exact: true } },
          { action: "waitFor", framePath: ["MenuContent"], locator: { selector: "body[data-active-view=\"conferencias\"]" }, state: "visible", timeoutMs: 1_500 },
          { action: "click", framePath: ["MenuContent"], locator: { selector: fixture.legacySiteContract.content.refreshSelector } },
          { action: "waitFor", framePath: ["MenuContent"], locator: { selector: fixture.legacySiteContract.content.tableSelector }, state: "visible", timeoutMs: 1_500 },
          { action: "extract", framePath: ["MenuContent"], locator: { selector: fixture.legacySiteContract.content.loadCountSelector }, format: "text" },
        ],
      });

      expect(await content.locator("#focus-state").innerText()).toBe("IN2");
      expect(await content.locator("#selection-state").innerText()).toBe("pending");
      expect(await content.locator("#keyboard-state").innerText()).toBe("Enter");
      expect(result.result.steps.at(-1)?.value).toBe("2 lançamentos");
      expect(await content.locator(`${fixture.legacySiteContract.content.tableSelector} tbody tr`).count()).toBe(2);
    });
  });

  it("waits for a nested legacy frame that is created after the wait begins", async () => {
    await withFixture("stage12-detail", async ({ fixture, page, service }) => {
      const content = requireFrame(page, fixture.legacySiteContract.frames.content);
      await content.goto(`${fixture.origin}/legacySite/home.html?nonce=stage12-detail`, { waitUntil: "load" });
      await content.evaluate(`(() => {
        document.body.dataset.detailState = "pending";
        setTimeout(() => {
          const frame = document.createElement("iframe");
          frame.name = "DetailPane";
          frame.src = "/legacySite/detail.html?nonce=stage12-detail";
          document.body.appendChild(frame);
          document.body.dataset.detailState = "ready";
        }, 150);
      })()`);

      const result = await service.frameSequence({
        tabId: "tab-1",
        timeoutMs: 2_000,
        steps: [{
          action: "waitFor",
          framePath: ["MenuContent", "DetailPane"],
          locator: { id: "detail-ready" },
          state: "visible",
          timeoutMs: 1_500,
        }],
      });

      expect(result.result.steps[0]).toMatchObject({ action: "waitFor", completed: true });
      expect(requireFrame(page, fixture.legacySiteContract.frames.detail).url()).toMatch(/\/legacySite\/detail\.html/u);
    });
  });

  it("reads Windows-1252 text after legacy framed navigation", async () => {
    await withFixture("stage12-encoding", async ({ fixture, page, service }) => {
      const result = await service.navigatePath({
        tabId: "tab-1",
        path: ["Financeiro", "Relatório ANSI"],
        sourceFramePath: ["Menu"],
        targetFramePath: ["MenuContent"],
        timeoutMs: 5_000,
        checkpoint: {
          action: "extract",
          framePath: ["MenuContent"],
          locator: { id: "encoded-text" },
          format: "text",
        },
      }, false);

      expect(result.result.checkpoint?.step.value).toBe(fixture.legacySiteContract.encoding.expectedText);
      expect(requireFrame(page, fixture.legacySiteContract.frames.content).url()).toMatch(/\/legacySite\/encoding\.html/u);
      expect(fixture.getLegacySiteRequestCount("stage12-encoding", "encoding")).toBe(1);
    });
  });
});

async function withFixture(
  nonce: string,
  run: (context: {
    fixture: LegacySiteFixture;
    browser: Browser;
    page: Page;
    service: BrowserLegacyAutomationService;
  }) => Promise<void>,
): Promise<void> {
  const fixture = await startLegacySiteFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(fixture.legacySiteUrl(nonce), { waitUntil: "load" });
    const service = new BrowserLegacyAutomationService({
      driver: new PlaywrightLegacyDriver(page),
    });
    await run({ fixture, browser, page, service });
  } finally {
    await browser.close();
    await fixture.close();
  }
}

async function startLegacySiteFixture(): Promise<LegacySiteFixture> {
  const modulePath = "../../../../tooling/benchmarks/browser/flow-benchmark-fixture.mjs";
  const module = await import(modulePath) as {
    startFlowBenchmarkFixture(): Promise<LegacySiteFixture>;
  };
  return module.startFlowBenchmarkFixture();
}

function requireFrame(page: Page, name: string): Frame {
  const frame = page.frames().find((candidate) => candidate.name() === name);
  if (!frame) throw new Error(`Fixture frame not found: ${name}`);
  return frame;
}

class PlaywrightLegacyDriver implements BrowserLegacyAutomationDriver {
  constructor(private readonly page: Page) {}

  activePage(): Page {
    return this.page;
  }

  async resolveFramePath(framePath: readonly string[]): Promise<Frame> {
    let frame = this.page.mainFrame();
    for (const segment of framePath) {
      const child = frame.childFrames().find((candidate) => candidate.name() === segment);
      if (!child) {
        const error = new Error(`Fixture frame not found: ${segment}`) as Error & { code?: string };
        error.code = "FRAME_NOT_FOUND";
        throw error;
      }
      frame = child;
    }
    return frame;
  }

  async currentPageResponse(): Promise<BrowserDriverResponse> {
    return {
      page: {
        id: "legacySite-fixture-page",
        url: this.page.url(),
        title: await this.page.title(),
      },
    };
  }

  async press(
    input: BrowserPressRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    await this.page.keyboard.press(input.key);
    return this.currentPageResponse();
  }
}
