import { describe, expect, it } from "@jest/globals";
import type { Frame, Page } from "playwright";
import type {
  BrowserDriverCallOptions,
  BrowserDriverResponse,
  BrowserPressRequest,
} from "../../drivers/browser-driver.js";
import { BrowserLegacyAutomationService } from "../../services/browser-legacy-automation-service.js";

describe("BrowserLegacyAutomationService direct engine", () => {
  it("profiles a page through native Frame evaluation", async () => {
    const driver = new FakeLegacyDriver([
      {
        layoutTables: 1,
        inlineHandlers: 1,
        hashLinks: 1,
        targetedNavigation: 0,
        postForms: 0,
        origin: "https://example.test",
        pathname: "/legacy",
        title: "Legacy",
        childElementCount: 5,
      },
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    await expect(
      service.profilePage({ tabId: "tab-1", maxDepth: 4 }),
    ).resolves.toMatchObject({
      result: {
        profile: "hybrid",
        signals: {
          frames: 0,
          layoutTables: 1,
          inlineHandlers: 1,
          hashLinks: 1,
        },
      },
    });

    expect(driver.evaluations).toHaveLength(1);
    expect(typeof driver.evaluations[0]).toBe("string");
  });

  it("builds a compact DOM index without textual transport", async () => {
    const driver = new FakeLegacyDriver([
      envelope({
        framePath: [],
        pageSignature: "page-1",
        frameGraphSignature: "frames-1",
        items: [],
        offset: 2_000,
        totalCount: 2_000,
        truncated: false,
        telemetry: { totalMs: 1, indexMs: 1, retries: 0 },
      }),
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    await service.domIndex({
      tabId: "tab-1",
      framePath: ["Menu"],
      rootSelector: "#main-menu",
      query: "CPX-Finance",
      offset: 2_000,
      limit: 50,
      visibleOnly: true,
    });

    const script = evaluationScript(driver.evaluations[0]);
    expect(script).toContain('"operation":"domIndex"');
    expect(script).toContain("onclickSignature");
    expect(script).toContain('"rootSelector":"#main-menu"');
    expect(script).toContain('"query":"CPX-Finance"');
    expect(script).toContain('"offset":2000');
    expect(script).toContain('"visibleOnly":true');
    expect(script).toContain("type === 'password'");
    expect(script).not.toContain("outerHTML : doc.documentElement.outerHTML");
  });

  it("executes a typed frame step with authorization embedded", async () => {
    const driver = new FakeLegacyDriver([
      envelope({
        completed: true,
        steps: [{
          index: 0,
          action: "extract",
          completed: true,
          value: "Histórico",
        }],
        telemetry: { totalMs: 1, locatorMs: 1, retries: 0 },
      }),
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    const execution = await service.frameSequence(
      {
        tabId: "tab-1",
        steps: [{
          action: "extract",
          framePath: ["MenuContent"],
          locator: { selector: "h1" },
          format: "text",
        }],
      },
      new Set(),
    );

    expect(execution.result.steps[0]).toMatchObject({
      action: "extract",
      value: "Histórico",
    });
    const script = evaluationScript(driver.evaluations[0]);
    expect(script).toContain('"operation":"frameSequence"');
    expect(script).toContain('"authorized":false');
  });

  it("batches contiguous same-frame steps into one direct evaluation", async () => {
    const driver = new FakeLegacyDriver([
      envelope({
        completed: true,
        steps: [
          { index: 0, action: "fill", completed: true },
          { index: 1, action: "select", completed: true },
          { index: 2, action: "press", completed: true },
          { index: 3, action: "extract", completed: true, value: "consulta legacy" },
          { index: 4, action: "extract", completed: true, value: "recent" },
          { index: 5, action: "assert", completed: true },
        ],
        telemetry: { totalMs: 2, locatorMs: 1, retries: 0 },
      }),
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    const execution = await service.frameSequence({
      tabId: "tab-1",
      steps: [
        { action: "fill", framePath: ["MenuContent"], locator: { id: "query" }, value: "consulta legacy" },
        { action: "select", framePath: ["MenuContent"], locator: { id: "category" }, value: "recent" },
        { action: "press", framePath: ["MenuContent"], locator: { id: "query" }, key: "ArrowRight" },
        { action: "extract", framePath: ["MenuContent"], locator: { id: "query" }, format: "text" },
        { action: "extract", framePath: ["MenuContent"], locator: { id: "category" }, format: "text" },
        { action: "assert", framePath: ["MenuContent"], locator: { id: "query" }, condition: "textEquals", expected: "consulta legacy" },
      ],
    });

    expect(driver.evaluations).toHaveLength(1);
    expect(driver.responseReads).toBe(1);
    expect(execution.result.steps.map((step) => step.index)).toEqual([0, 1, 2, 3, 4, 5]);
    const script = evaluationScript(driver.evaluations[0]);
    expect(script).toContain('"action":"fill"');
    expect(script).toContain('"action":"assert"');
  });

  it("separates direct sequence batches when the frame path changes", async () => {
    const driver = new FakeLegacyDriver([
      envelope({
        completed: true,
        steps: [{ index: 0, action: "extract", completed: true, value: "Menu" }],
        telemetry: { totalMs: 1, retries: 0 },
      }),
      envelope({
        completed: true,
        steps: [
          { index: 0, action: "extract", completed: true, value: "Content" },
          { index: 1, action: "assert", completed: true },
        ],
        telemetry: { totalMs: 1, retries: 0 },
      }),
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    const execution = await service.frameSequence({
      tabId: "tab-1",
      steps: [
        { action: "extract", framePath: ["Menu"], locator: { selector: "h1" }, format: "text" },
        { action: "extract", framePath: ["MenuContent"], locator: { selector: "h1" }, format: "text" },
        { action: "assert", framePath: ["MenuContent"], locator: { selector: "h1" }, condition: "exists" },
      ],
    });

    expect(driver.evaluations).toHaveLength(2);
    expect(driver.responseReads).toBe(2);
    expect(execution.result.steps.map((step) => step.index)).toEqual([0, 1, 2]);
  });

  it("retries one read-only batch after a transient frame replacement", async () => {
    const driver = new FakeLegacyDriver([
      new Error("Execution context was destroyed, most likely because of a navigation"),
      envelope({
        completed: true,
        steps: [{ index: 0, action: "extract", completed: true, value: "ready" }],
        telemetry: { totalMs: 1, retries: 0 },
      }),
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    const execution = await service.frameSequence({
      tabId: "tab-1",
      steps: [{
        action: "extract",
        framePath: ["MenuContent"],
        locator: { selector: "h1" },
        format: "text",
      }],
    });

    expect(driver.evaluations).toHaveLength(2);
    expect(driver.responseReads).toBe(1);
    expect(execution.result.steps[0]?.value).toBe("ready");
    expect(execution.result.telemetry.retries).toBe(1);
  });

  it("isolates navigation-like steps and batches the post-navigation tail", async () => {
    const driver = new FakeLegacyDriver([
      envelope({ navigationLikely: true }),
      envelope({
        completed: true,
        steps: [{ index: 0, action: "click", completed: true }],
        telemetry: { totalMs: 1, interactionMs: 1, retries: 0 },
      }),
      envelope({
        completed: true,
        steps: [
          { index: 0, action: "waitFor", completed: true },
          { index: 1, action: "extract", completed: true, value: "1" },
        ],
        telemetry: { totalMs: 1, navigationMs: 1, retries: 0 },
      }),
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    const execution = await service.frameSequence({
      tabId: "tab-1",
      steps: [
        { action: "click", framePath: ["MenuContent"], locator: { id: "confirm-post" } },
        { action: "waitFor", framePath: ["MenuContent"], locator: { id: "postback-heading" }, state: "visible" },
        { action: "extract", framePath: ["MenuContent"], locator: { id: "post-count" }, format: "text" },
      ],
    });

    expect(driver.evaluations).toHaveLength(3);
    expect(evaluationScript(driver.evaluations[0])).toContain('"operation":"preflightFrameStep"');
    expect(evaluationScript(driver.evaluations[1])).toContain('"deferNavigation":true');
    const tail = evaluationScript(driver.evaluations[2]);
    expect(tail).toContain('"action":"waitFor"');
    expect(tail).toContain('"action":"extract"');
    expect(execution.result.steps.map((step) => step.index)).toEqual([0, 1, 2]);
  });

  it("preflights every dangerous target before executing an earlier safe step", async () => {
    const driver = new FakeLegacyDriver([
      { ok: false, error: { code: "ACTION_BLOCKED_BY_POLICY", message: "Confirmation required." } },
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    await expect(service.frameSequence({
      tabId: "tab-1",
      steps: [
        { action: "fill", framePath: ["MenuContent"], locator: { id: "query" }, value: "must-not-run" },
        { action: "click", framePath: ["MenuContent"], locator: { id: "submit" } },
      ],
    })).rejects.toMatchObject({ code: "ACTION_BLOCKED_BY_POLICY" });

    expect(driver.evaluations).toHaveLength(1);
    expect(evaluationScript(driver.evaluations[0])).toContain('"operation":"preflightFrameStep"');
  });

  it("reports completed action steps when a later observation fails", async () => {
    const driver = new FakeLegacyDriver([
      envelope({ navigationLikely: false }),
      envelope({
        completed: true,
        steps: [{ index: 0, action: "click", completed: true }],
        telemetry: { totalMs: 1, interactionMs: 1, retries: 0 },
      }),
      { ok: false, error: { code: "STATE_NOT_REACHED", message: "Expected status was not observed." } },
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    await expect(service.frameSequence({
      tabId: "tab-1",
      steps: [
        { action: "click", framePath: ["MenuContent"], locator: { id: "open" } },
        { action: "waitFor", framePath: ["MenuContent"], text: "ready", timeoutMs: 100 },
      ],
      timeoutMs: 1_000,
    })).rejects.toMatchObject({
      code: "STATE_NOT_REACHED",
      message: expect.stringContaining(
        "failed while observing step indexes [1] after completed step indexes [0]",
      ),
    });
  });
  it("reports that action dispatch reached post-action observation when committed navigation fails to settle", async () => {
    const driver = new FakeLegacyDriver([
      envelope({ navigationLikely: true }),
      envelope({
        completed: true,
        steps: [{ index: 0, action: "click", completed: true }],
        telemetry: { totalMs: 1, interactionMs: 1, retries: 0 },
      }),
    ], {
      loadStateError: new Error("fixture load-state failure"),
    });
    const service = new BrowserLegacyAutomationService({ driver });

    await expect(service.frameSequence({
      tabId: "tab-1",
      steps: [
        { action: "click", framePath: ["MenuContent"], locator: { id: "open" } },
      ],
      timeoutMs: 1_000,
    })).rejects.toMatchObject({
      code: "STATE_NOT_REACHED",
      message: expect.stringContaining(
        "Legacy frame sequence reached post-action observation after step indexes [0].",
      ),
    });
  });
  it("reuses only a signature-bound navigation cache entry", async () => {
    const cacheEntry = {
      pageSignature: "page-1",
      frameGraphSignature: "frames-1",
      selectors: ["#financeiro", "#cpx-finance"],
    };
    const result = {
      completed: true,
      path: ["Financeiro", "CPX-Finance"],
      resolved: [],
      destinationReady: true,
      cache: { hit: false, revalidated: false, invalidated: false },
      telemetry: { totalMs: 3, retries: 0 },
      cacheEntry,
    };
    const driver = new FakeLegacyDriver([
      envelope(result),
      envelope(result),
    ]);
    const service = new BrowserLegacyAutomationService({ driver });
    const input = {
      tabId: "tab-1",
      path: ["Financeiro", "CPX-Finance"],
      sourceFramePath: ["Menu"],
    };

    await service.navigatePath(input, false);
    await service.navigatePath(input, false);

    expect(driver.evaluations).toHaveLength(2);
    const second = evaluationScript(driver.evaluations[1]);
    expect(second).toContain('"pageSignature":"page-1"');
    expect(second).toContain('"selectors":["#financeiro","#cpx-finance"]');
    expect(second).toContain("cacheEntryMatches");
  });

  it("returns a final read-only checkpoint in the same service operation", async () => {
    const driver = new FakeLegacyDriver([
      envelope({
        completed: true,
        path: ["Financeiro", "CPX-Finance"],
        resolved: [],
        destinationReady: true,
        cache: { hit: false, revalidated: false, invalidated: false },
        telemetry: { totalMs: 3, navigationMs: 2, retries: 0 },
      }),
      envelope({
        completed: true,
        steps: [{
          index: 0,
          action: "extract",
          completed: true,
          value: "Histórico",
        }],
        telemetry: { totalMs: 1, locatorMs: 1, retries: 0 },
      }),
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    const execution = await service.navigatePath({
      tabId: "tab-1",
      path: ["Financeiro", "CPX-Finance"],
      sourceFramePath: ["Menu"],
      checkpoint: {
        action: "extract",
        framePath: ["MenuContent"],
        locator: { selector: "h1" },
        format: "text",
      },
    }, false);

    expect(driver.evaluations).toHaveLength(2);
    expect(execution.result.checkpoint?.step).toMatchObject({
      action: "extract",
      value: "Histórico",
    });
    expect(evaluationScript(driver.evaluations[1])).toContain(
      '"operation":"frameSequence"',
    );
  });

  it("uses the native keyboard only for an isolated native press", async () => {
    const driver = new FakeLegacyDriver([
      envelope({
        ref: "lref_button",
        strategy: "id",
        telemetry: {
          totalMs: 1,
          frameResolutionMs: 0,
          locatorMs: 1,
          interactionMs: 0,
          candidateCount: 1,
          retries: 0,
        },
      }),
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    const execution = await service.frameSequence({
      tabId: "tab-1",
      steps: [{
        action: "press",
        framePath: ["MenuContent"],
        locator: { id: "open" },
        key: "Enter",
        mode: "native",
      }],
    });

    expect(driver.presses).toEqual(["Enter"]);
    expect(evaluationScript(driver.evaluations[0])).toContain(
      '"operation":"focusForNativePress"',
    );
    expect(execution.result.steps[0]).toMatchObject({
      action: "press",
      strategy: "native-id",
      ref: "lref_button",
    });
  });

  it("refuses to mix a native press with other sequence steps", async () => {
    const driver = new FakeLegacyDriver([]);
    const service = new BrowserLegacyAutomationService({ driver });

    await expect(service.frameSequence({
      tabId: "tab-1",
      steps: [
        { action: "index" },
        { action: "press", key: "Tab", mode: "native" },
      ],
    })).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
    expect(driver.evaluations).toHaveLength(0);
  });

  it("rejects an already aborted operation before evaluating the page", async () => {
    const driver = new FakeLegacyDriver([]);
    const service = new BrowserLegacyAutomationService({ driver });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(service.frameSequence({
      tabId: "tab-1",
      steps: [{ action: "index" }],
    }, new Set(), controller.signal)).rejects.toMatchObject({
      code: "OPERATION_CANCELLED",
    });
    expect(driver.evaluations).toHaveLength(0);
  });

  it("preserves typed legacy failures", async () => {
    const driver = new FakeLegacyDriver([
      { ok: false, error: { code: "LOCATOR_AMBIGUOUS", message: "Multiple equivalent candidates." } },
    ]);
    const service = new BrowserLegacyAutomationService({ driver });

    await expect(
      service.frameSequence({
        tabId: "tab-1",
        steps: [{ action: "extract", locator: { text: "Histórico" } }],
      }),
    ).rejects.toMatchObject({
      code: "LOCATOR_AMBIGUOUS",
      message: "Multiple equivalent candidates.",
    });
  });
});

class FakeLegacyDriver {
  readonly evaluations: unknown[] = [];
  readonly presses: string[] = [];
  responseReads = 0;
  private readonly frame: Frame;
  private readonly page: Page;

  constructor(
    private readonly values: unknown[],
    private readonly navigation: {
      commitError?: Error;
      loadStateError?: Error;
    } = {},
  ) {
    const frame = {
      evaluate: async (expression: unknown, argument?: unknown) => {
        this.evaluations.push(argument ?? expression);
        const value = this.values.shift();
        if (value === undefined) throw new Error("Missing fake frame evaluation.");
        if (value instanceof Error) throw value;
        return value;
      },
      childFrames: () => [],
      parentFrame: () => null,
      url: () => "https://example.test/legacy",
      isDetached: () => false,
      waitForNavigation: async () => {
        if (this.navigation.commitError) throw this.navigation.commitError;
        return undefined;
      },
      waitForLoadState: async () => {
        if (this.navigation.loadStateError) throw this.navigation.loadStateError;
      },
    } as unknown as Frame;
    this.frame = frame;
    this.page = { mainFrame: () => frame } as unknown as Page;
  }

  activePage(): Page {
    return this.page;
  }

  async resolveFramePath(_framePath: readonly string[]): Promise<Frame> {
    return this.frame;
  }

  async currentPageResponse(): Promise<BrowserDriverResponse> {
    this.responseReads += 1;
    return {
      page: {
        id: "page-1",
        url: "https://example.test/legacy",
        title: "Legacy",
      },
    };
  }

  async press(
    input: BrowserPressRequest,
    _options?: BrowserDriverCallOptions,
  ): Promise<BrowserDriverResponse> {
    this.presses.push(input.key);
    return this.currentPageResponse();
  }
}

function evaluationScript(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "function") return value.toString();
  throw new Error("Expected a frame evaluation function.");
}

function envelope(result: unknown): unknown {
  return { ok: true, result };
}
