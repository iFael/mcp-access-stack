import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import type {
  BrowserDriverCallOptions,
  BrowserDriverResponse,
  BrowserPressRequest,
} from "../../drivers/browser-driver.js";
import { BrowserFrameOperationService } from "../../services/browser-frame-operation-service.js";
import { BrowserLegacyAutomationService } from "../../services/browser-legacy-automation-service.js";

const fixtureDirectory = fileURLToPath(new URL("../fixtures/legacy-app/", import.meta.url));
let server: Server;
let browser: Browser;
let page: Page;
let fixtureUrl: URL;

beforeAll(async () => {
  server = createServer((request, response) => {
    void serveFixture(request.url ?? "/", response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unexpected fixture server address.");
  fixtureUrl = new URL(`http://127.0.0.1:${address.port}/index.html`);

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
}, 30_000);

afterAll(async () => {
  await page?.close();
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
}, 30_000);

describe("Legacy Automation Engine E2E", () => {
  it("profiles recursive legacy signals and sanitizes a compact frame index", async () => {
    await loadFixture();
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);

    const profile = await service.profilePage({ tabId: "tab-1", maxDepth: 8 });
    expect(profile.result.profile).toBe("hybrid");
    expect(profile.result.signals.frames).toBe(2);
    expect(profile.result.signals.layoutTables).toBeGreaterThan(0);
    expect(profile.result.signals.inlineHandlers).toBeGreaterThan(0);
    expect(profile.result.signals.hashLinks).toBeGreaterThan(0);
    expect(profile.result.signals.targetedNavigation).toBeGreaterThan(0);
    expect(profile.result.signals.postForms).toBe(1);
    expect(profile.result.frames.map((frame) => frame.name)).toEqual(["Menu", "MenuContent"]);

    const contentFrame = requireFrame("MenuContent");
    await contentFrame.locator("#password").fill("runtime-sensitive-value");
    await contentFrame.locator("#query").fill("runtime-personal-value");
    const indexed = await service.domIndex({
      tabId: "tab-1",
      framePath: ["MenuContent"],
      limit: 100,
    });

    expect(indexed.result.items.some((item) => item.id === "analisar")).toBe(true);
    expect(JSON.stringify(indexed.result)).not.toContain("runtime-sensitive-value");
    expect(JSON.stringify(indexed.result)).not.toContain("runtime-personal-value");
    expect(indexed.result.items.every((item) => !("value" in item))).toBe(true);
    expect(driver.calls).toBeGreaterThanOrEqual(1);
  });

  it("navigates three menu levels in one call and revalidates the warm cache", async () => {
    await loadFixture();
    const baselineDriver = new PlaywrightEvaluationDriver(page);
    const baseline = new BrowserFrameOperationService({ driver: baselineDriver });

    const baselineStartedAt = performance.now();
    await baseline.click({ tabId: "tab-1", frame: "Menu", selector: "#financeiro" });
    await baseline.click({ tabId: "tab-1", frame: "Menu", selector: "#cpx-finance" });
    await baseline.click({ tabId: "tab-1", frame: "Menu", selector: "#historico" });
    await requireFrame("MenuContent").waitForURL(/historico\.html$/u);
    const baselineDurationMs = performance.now() - baselineStartedAt;
    const baselineCalls = baselineDriver.calls;

    const pathInput = {
      tabId: "tab-1",
      path: ["Financeiro", "CPX-Finance", "Histórico"],
      sourceFramePath: ["Menu"],
      targetFramePath: ["MenuContent"],
      timeoutMs: 10_000,
    };

    await loadFixture();
    const engineDriver = new PlaywrightEvaluationDriver(page);
    const engine = makeLegacyService(engineDriver);
    const coldStartedAt = performance.now();
    const cold = await engine.navigatePath(pathInput, false);
    await requireFrame("MenuContent").waitForURL(/historico\.html$/u);
    const coldDurationMs = performance.now() - coldStartedAt;
    const coldCalls = engineDriver.calls;

    expect(cold.result.completed).toBe(true);
    expect(cold.result.resolved).toHaveLength(3);
    expect(cold.result.resolved.map((level) => level.label)).toEqual(pathInput.path);
    expect(cold.result.destinationReady).toBe(true);
    expect(cold.result.cache.hit).toBe(false);
    expect(coldCalls).toBeGreaterThanOrEqual(1);
    expect(baselineCalls).toBe(3);

    await loadFixture();
    const warmStartedAt = performance.now();
    const warm = await engine.navigatePath(pathInput, false);
    await requireFrame("MenuContent").waitForURL(/historico\.html$/u);
    const warmDurationMs = performance.now() - warmStartedAt;

    expect(warm.result.cache).toEqual({
      hit: true,
      revalidated: true,
      invalidated: false,
    });
    expect(warm.result.resolved.every((level) => level.strategy === "cache-revalidated")).toBe(true);
    expect(engineDriver.calls).toBeGreaterThanOrEqual(2);

    console.info(JSON.stringify({
      benchmark: "legacy-menu-navigation",
      baselineCalls,
      coldEngineCalls: coldCalls,
      baselineDurationMs: roundMs(baselineDurationMs),
      coldEngineDurationMs: roundMs(coldDurationMs),
      warmEngineDurationMs: roundMs(warmDurationMs),
    }));
  });

  it("discovers a deep menu and navigates a segmented cross-frame path in one call", async () => {
    await loadFixture("segmented-index.html");
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);

    const directed = await service.domIndex({
      tabId: "tab-1",
      framePath: ["Menu"],
      rootSelector: "#main-menu",
      query: "CPX-Finance",
      limit: 10,
    });
    expect(directed.result.items.some((item) => item.id === "cpx-finance-segmented")).toBe(true);
    expect(directed.result.totalCount).toBeGreaterThanOrEqual(2);
    expect(directed.result.truncated).toBe(false);

    const paged = await service.domIndex({
      tabId: "tab-1",
      framePath: ["Menu"],
      offset: 2_000,
      limit: 600,
    });
    expect(paged.result.offset).toBe(2_000);
    expect(paged.result.totalCount).toBeGreaterThan(2_500);
    expect(paged.result.items.some((item) => item.id === "cpx-finance-segmented")).toBe(true);

    const pathInput = {
      tabId: "tab-1",
      path: ["Financeiro", "CPX-Finance", "Histórico", "Conferências"],
      segments: [
        {
          framePath: ["Menu"],
          rootSelector: "#main-menu",
          path: ["Financeiro", "CPX-Finance"],
          targetFramePath: ["MenuContent"],
        },
        {
          framePath: ["MenuContent"],
          path: ["Histórico", "Conferências"],
          waitFor: {
            locator: { selector: ".tab.is-active[data-view=\"conferencias\"]" },
            state: "visible" as const,
            timeoutMs: 2_000,
          },
        },
      ],
      timeoutMs: 10_000,
    };

    const cold = await service.navigatePath(pathInput, false);
    expect(cold.result.completed).toBe(true);
    expect(cold.result.resolved.map((level) => level.label)).toEqual(pathInput.path);
    expect(cold.result.resolved.map((level) => level.segment)).toEqual([0, 0, 1, 1]);
    expect(cold.result.segments).toHaveLength(2);
    expect(cold.result.destinationReady).toBe(true);
    expect(await requireFrame("MenuContent").locator('.tab[data-view="conferencias"]').getAttribute("class"))
      .toContain("is-active");
    expect(driver.calls).toBeGreaterThanOrEqual(1);

    await loadFixture("segmented-index.html");
    const warm = await service.navigatePath(pathInput, false);
    expect(warm.result.cache).toEqual({ hit: true, revalidated: true, invalidated: false });
    expect(warm.result.resolved.every((level) => level.strategy === "cache-revalidated")).toBe(true);
    expect(driver.calls).toBeGreaterThanOrEqual(2);
  });

  it("executes form-edit, keyboard, extract and assert steps in one call", async () => {
    await loadFixture();
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);

    const result = await service.frameSequence({
      tabId: "tab-1",
      steps: [
        {
          action: "fill",
          framePath: ["MenuContent"],
          locator: { id: "query" },
          value: "consulta legacy",
        },
        {
          action: "select",
          framePath: ["MenuContent"],
          locator: { id: "category" },
          value: "recent",
        },
        {
          action: "press",
          framePath: ["MenuContent"],
          locator: { id: "query" },
          key: "ArrowRight",
        },
        {
          action: "extract",
          framePath: ["MenuContent"],
          locator: { id: "query" },
          format: "text",
        },
        {
          action: "assert",
          framePath: ["MenuContent"],
          locator: { id: "query" },
          condition: "textEquals",
          expected: "consulta legacy",
        },
      ],
    });

    expect(driver.calls).toBeGreaterThanOrEqual(1);
    expect(result.result.steps[3]?.value).toBe("consulta legacy");
    expect(await requireFrame("MenuContent").locator("#category").inputValue()).toBe("recent");
  });

  it("keeps preventDefault fetch submits in the same document instead of requiring replacement navigation", async () => {
    await loadFixture();
    const contentFrame = requireFrame("MenuContent");
    await contentFrame.evaluate(`(() => {
      window.ajaxSubmitCount = 0;
      const form = document.createElement("form");
      form.id = "ajax-form";
      const field = document.createElement("input");
      field.id = "ajax-field";
      field.name = "credential";
      const button = document.createElement("button");
      button.id = "ajax-submit";
      button.type = "submit";
      button.textContent = "Validar e autorizar";
      const output = document.createElement("output");
      output.id = "ajax-message";
      form.append(field, button, output);
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        window.ajaxSubmitCount += 1;
        const response = await fetch("content.html", { cache: "no-store" });
        output.textContent = response.ok ? "Credenciais inválidas." : "Falha inesperada.";
      });
      document.body.append(form);
    })()`);
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);

    const result = await service.frameSequence({
      tabId: "tab-1",
      timeoutMs: 5_000,
      steps: [
        {
          action: "fill",
          framePath: ["MenuContent"],
          locator: { id: "ajax-field" },
          value: "credential-value",
        },
        {
          action: "click",
          framePath: ["MenuContent"],
          locator: { id: "ajax-submit" },
        },
        {
          action: "waitFor",
          framePath: ["MenuContent"],
          locator: { id: "ajax-message" },
          state: "visible",
          timeoutMs: 2_000,
        },
        {
          action: "assert",
          framePath: ["MenuContent"],
          locator: { id: "ajax-message" },
          condition: "textEquals",
          expected: "Credenciais inválidas.",
        },
      ],
    }, new Set([1]));

    expect(result.result.steps.map((step) => step.index)).toEqual([0, 1, 2, 3]);
    expect(await contentFrame.evaluate<number>("window.ajaxSubmitCount")).toBe(1);
    expect(contentFrame.url()).toMatch(/content\.html$/u);
  });

  it("reindexes live interactive mutations while keeping arbitrary message text in extraction semantics", async () => {
    await loadFixture();
    const contentFrame = requireFrame("MenuContent");
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);

    const before = await service.domIndex({
      tabId: "tab-1",
      framePath: ["MenuContent"],
      query: "Dynamic action",
      visibleOnly: true,
    });
    expect(before.result.totalCount).toBe(0);

    await contentFrame.evaluate(`(() => {
      const button = document.createElement("button");
      button.id = "dynamic-action";
      button.textContent = "Dynamic action";
      const message = document.createElement("div");
      message.id = "dynamic-status";
      message.textContent = "Credenciais inválidas.";
      document.body.append(button, message);
    })()`);

    const after = await service.domIndex({
      tabId: "tab-1",
      framePath: ["MenuContent"],
      query: "Dynamic action",
      visibleOnly: true,
    });
    expect(after.result.items.some((item) => item.id === "dynamic-action")).toBe(true);

    const messageIndex = await service.domIndex({
      tabId: "tab-1",
      framePath: ["MenuContent"],
      rootSelector: "#dynamic-status",
      query: "Credenciais inválidas.",
      visibleOnly: true,
    });
    expect(messageIndex.result.totalCount).toBe(0);

    const extracted = await service.frameSequence({
      tabId: "tab-1",
      steps: [{
        action: "extract",
        framePath: ["MenuContent"],
        locator: { selector: "#dynamic-status" },
        format: "text",
      }],
    });
    expect(extracted.result.steps[0]?.value).toBe("Credenciais inválidas.");
  });
  it("stops a cancelled sequence before a later DOM mutation", async () => {
    await loadFixture();
    const contentFrame = requireFrame("MenuContent");
    await contentFrame.evaluate(`(() => {
      const button = document.createElement("button");
      button.id = "cancelled-action";
      button.type = "button";
      button.textContent = "Executar";
      const output = document.createElement("output");
      output.id = "cancelled-output";
      button.addEventListener("click", () => {
        output.textContent = "mutado";
      });
      document.body.append(button, output);
    })()`);
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);
    const controller = new AbortController();

    const pending = service.frameSequence({
      tabId: "tab-1",
      timeoutMs: 5_000,
      steps: [
        {
          action: "waitFor",
          framePath: ["MenuContent"],
          text: "estado que nunca aparece",
          timeoutMs: 5_000,
        },
        {
          action: "click",
          framePath: ["MenuContent"],
          locator: { id: "cancelled-action" },
        },
      ],
    }, new Set(), controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "OPERATION_CANCELLED" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await contentFrame.locator("#cancelled-output").textContent()).toBe("");
    expect(driver.calls).toBeGreaterThanOrEqual(1);
  });

  it("uses a real native key press when explicitly requested", async () => {
    await loadFixture();
    const contentFrame = requireFrame("MenuContent");
    await contentFrame.evaluate(`(() => {
      const button = document.createElement("button");
      button.id = "native-action";
      button.type = "button";
      button.textContent = "Abrir";
      const output = document.createElement("output");
      output.id = "native-output";
      button.addEventListener("click", () => {
        output.textContent = "acionado";
      });
      document.body.append(button, output);
    })()`);
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);

    const result = await service.frameSequence({
      tabId: "tab-1",
      steps: [{
        action: "press",
        framePath: ["MenuContent"],
        locator: { id: "native-action" },
        key: "Enter",
        mode: "native",
      }],
    });

    expect(driver.calls).toBeGreaterThanOrEqual(1);
    expect(result.result.steps[0]?.strategy).toBe("native-id");
    expect(await contentFrame.locator("#native-output").textContent()).toBe("acionado");
  });

  it("preflights submit confirmation before executing earlier sequence mutations", async () => {
    await loadFixture();
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);

    await expect(
      service.frameSequence({
        tabId: "tab-1",
        steps: [
          {
            action: "fill",
            framePath: ["MenuContent"],
            locator: { id: "query" },
            value: "must-not-run-before-confirmation",
          },
          {
            action: "click",
            framePath: ["MenuContent"],
            locator: { id: "analisar" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });

    expect(await requireFrame("MenuContent").locator("#query").inputValue()).toBe("");
    expect(requireFrame("MenuContent").url()).toMatch(/content\.html$/u);
  });

  it("profiles and indexes a cross-origin frame through native Playwright", async () => {
    await page.goto(fixtureUrl.href, { waitUntil: "load" });
    await page.setContent(
      '<!doctype html><html><body><iframe name="external" src="data:text/html,external"></iframe></body></html>',
      { waitUntil: "load" },
    );
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);

    const profile = await service.profilePage({ tabId: "tab-1" });
    expect(profile.result.frames).toHaveLength(1);
    expect(profile.result.frames[0]?.status).toBe("ready");

    await expect(
      service.domIndex({ tabId: "tab-1", framePath: ["external"] }),
    ).resolves.toMatchObject({
      result: { framePath: ["external"], items: expect.any(Array) },
    });
  });

  it("refuses an ambiguous visible match instead of clicking arbitrarily", async () => {
    await loadFixture();
    const menuFrame = requireFrame("Menu");
    await menuFrame.evaluate(`(() => {
      const duplicate = document.createElement("a");
      duplicate.textContent = "Financeiro";
      duplicate.href = "#";
      document.body.append(duplicate);
    })()`);
    const driver = new PlaywrightEvaluationDriver(page);
    const service = makeLegacyService(driver);

    await expect(
      service.frameSequence({
        tabId: "tab-1",
        steps: [
          {
            action: "click",
            framePath: ["Menu"],
            locator: { text: "Financeiro", exact: true },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "LOCATOR_AMBIGUOUS" });

    expect(await menuFrame.locator("#financeiro-submenu").getAttribute("class")).toBe("hidden");
  });
});

function makeLegacyService(driver: PlaywrightEvaluationDriver): BrowserLegacyAutomationService {
  return new BrowserLegacyAutomationService({ driver });
}

async function loadFixture(relativePath = "index.html"): Promise<void> {
  await page.goto(new URL(relativePath, fixtureUrl).href, { waitUntil: "load" });
  await page.waitForFunction("window.frames.length === 2");
  expect(page.frames().filter((frame) => frame !== page.mainFrame())).toHaveLength(2);
}

function requireFrame(name: string) {
  const frame = page.frame({ name });
  if (!frame) throw new Error(`Fixture frame not found: ${name}`);
  return frame;
}

class PlaywrightEvaluationDriver {
  calls = 0;

  constructor(private readonly page: Page) {}

  activePage(): Page {
    this.calls += 1;
    return this.page;
  }

  async resolveFrame(name: string): Promise<Frame> {
    this.calls += 1;
    const frame = this.page.frame({ name });
    if (!frame) throw new Error(`Fixture frame not found: ${name}`);
    return frame;
  }

  async resolveFramePath(framePath: readonly string[]): Promise<Frame> {
    this.calls += 1;
    let frame = this.page.mainFrame();
    for (const segment of framePath) {
      const child = frame.childFrames().find((candidate) => candidate.name() === segment);
      if (!child) throw new Error(`Fixture frame not found: ${segment}`);
      frame = child;
    }
    return frame;
  }

  async currentPageResponse(): Promise<BrowserDriverResponse> {
    return {
      page: {
        id: "fixture-page",
        url: this.page.url(),
        title: await this.page.title(),
      },
    };
  }

  async press(
    input: BrowserPressRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    this.calls += 1;
    await this.page.keyboard.press(input.key);
    return this.currentPageResponse();
  }
}

async function serveFixture(requestUrl: string, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(requestUrl, "http://127.0.0.1");
    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const absolutePath = path.resolve(fixtureDirectory, relativePath);
    const relative = path.relative(fixtureDirectory, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const content = await readFile(absolutePath);
    response.writeHead(200, {
      "content-type": contentType(absolutePath),
      "cache-control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404).end("Not found");
  }
}

function contentType(filePath: string): string {
  return path.extname(filePath).toLowerCase() === ".html"
    ? "text/html; charset=utf-8"
    : "application/octet-stream";
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
