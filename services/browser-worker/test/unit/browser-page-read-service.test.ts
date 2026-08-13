import { describe, expect, it, jest } from "@jest/globals";
import type { BrowserTab } from "@vs-code-gpt/shared";
import type { BrowserDriverResponse } from "../../drivers/browser-driver.js";
import {
  BrowserPageReadService,
  type BrowserPageReadServiceOptions,
} from "../../services/browser-page-read-service.js";

const baseTab: BrowserTab = {
  tabId: "tab-1",
  ownership: "mcp",
  purpose: "page-read-test",
  reusable: true,
  protected: false,
  sticky: false,
  createdAt: "2026-07-23T00:00:00.000Z",
  lastUsedAt: "2026-07-23T00:00:00.000Z",
  url: "https://example.test/",
  title: "Example",
};

describe("BrowserPageReadService", () => {
  it("captures a typed snapshot, updates the tab and stores references", async () => {
    const driver = new FakePageDriver([
      response({
        snapshot: '- button "Save" [ref=button-save]\n- textbox Name [ref=input-name]',
      }),
    ]);
    const captureReferences = jest.fn<
      BrowserPageReadServiceOptions["interactionContext"]["captureReferences"]
    >(() => [
      { ref: "button-save", role: "button", name: "Save" },
    ]);
    const updateSelectedTab = jest.fn<
      BrowserPageReadServiceOptions["updateSelectedTab"]
    >(() => ({ ...baseTab, title: "Updated" }));
    const service = makeService({ driver, captureReferences, updateSelectedTab });

    const snapshot = await service.captureSnapshot(baseTab.tabId);

    expect(driver.calls).toEqual([{ name: "snapshot", input: undefined }]);
    expect(updateSelectedTab).toHaveBeenCalledWith(
      baseTab.tabId,
      expect.objectContaining({ snapshot: expect.stringContaining("button-save") }),
    );
    expect(captureReferences).toHaveBeenCalledWith(
      baseTab.tabId,
      expect.stringContaining("button-save"),
    );
    expect(snapshot).toMatchObject({
      tab: { title: "Updated" },
      content: expect.stringContaining("button-save"),
      refs: [{ ref: "button-save" }],
    });
  });

  it("rejects CAPTCHA content before storing references", async () => {
    const captureReferences = jest.fn(() => []);
    const service = makeService({
      driver: new FakePageDriver([
        response({ snapshot: "Complete the reCAPTCHA challenge" }),
      ]),
      captureReferences,
    });

    await expect(service.captureSnapshot(baseTab.tabId)).rejects.toMatchObject({
      code: "CAPTCHA_DETECTED",
    });
    expect(captureReferences).not.toHaveBeenCalled();
  });

  it("polls snapshots until the requested reference appears", async () => {
    let now = 0;
    const driver = new FakePageDriver([
      response({ snapshot: '- button "Other" [ref=other]' }),
      response({ snapshot: '- button "Target" [ref=target]' }),
    ]);
    const service = makeService({
      driver,
      captureReferences: (_tabId, content) =>
        content.includes("target")
          ? [{ ref: "target", role: "button", name: "Target" }]
          : [{ ref: "other", role: "button", name: "Other" }],
      now: () => now,
      delay: async (ms) => {
        now += ms;
      },
      pollIntervalMs: 100,
    });

    await expect(
      service.wait(baseTab.tabId, { ref: "target", timeoutMs: 500 }),
    ).resolves.toBeUndefined();
    expect(driver.calls).toHaveLength(2);
  });

  it("throws a timeout when a reference never appears", async () => {
    let now = 0;
    const service = makeService({
      driver: new FakePageDriver([
        response({ snapshot: '- button "Other" [ref=other]' }),
        response({ snapshot: '- button "Other" [ref=other]' }),
      ]),
      captureReferences: () => [
        { ref: "other", role: "button", name: "Other" },
      ],
      now: () => now,
      delay: async (ms) => {
        now += ms;
      },
      pollIntervalMs: 100,
    });

    await expect(
      service.wait(baseTab.tabId, { ref: "target", timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "BROWSER_WORKER_TIMEOUT" });
  });

  it("delegates textual waits and updates the selected tab", async () => {
    const driver = new FakePageDriver([response()]);
    const updateSelectedTab = jest.fn(() => baseTab);
    const service = makeService({ driver, updateSelectedTab });

    await service.wait(baseTab.tabId, {
      text: "Completed",
      timeoutMs: 2_500,
    });

    expect(driver.calls).toEqual([
      { name: "wait", input: { text: "Completed", time: 2.5 } },
    ]);
    expect(updateSelectedTab).toHaveBeenCalledTimes(1);
  });

  it("returns typed extraction values without textual parsing", async () => {
    const driver = new FakePageDriver([
      response({ result: "hello" }),
      response({ result: "<main>content</main>" }),
      response({ result: { ok: true } }),
    ]);
    const service = makeService({ driver });

    await expect(service.extract({ selector: "main", format: "text" })).resolves.toBe(
      "hello",
    );
    await expect(service.extract({ format: "html" })).resolves.toBe(
      "<main>content</main>",
    );
    await expect(service.extract({ ref: "target", format: "json" })).resolves.toEqual({
      ok: true,
    });

    expect(driver.calls[0]).toMatchObject({
      name: "evaluate",
      input: { target: "main", element: "main" },
    });
    expect(driver.calls[1]).toMatchObject({
      name: "evaluate",
      input: { function: expect.stringContaining("document.documentElement") },
    });
    expect(driver.calls[2]).toMatchObject({
      name: "evaluate",
      input: { target: "target", element: "target" },
    });
  });
});

interface MakeServiceOptions {
  driver?: FakePageDriver;
  captureReferences?: BrowserPageReadServiceOptions["interactionContext"]["captureReferences"];
  updateSelectedTab?: BrowserPageReadServiceOptions["updateSelectedTab"];
  actionTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

function makeService(options: MakeServiceOptions = {}): BrowserPageReadService {
  return new BrowserPageReadService({
    driver: options.driver ?? new FakePageDriver([]),
    interactionContext: {
      captureReferences: options.captureReferences ?? (() => []),
    },
    updateSelectedTab: options.updateSelectedTab ?? (() => baseTab),
    actionTimeoutMs: options.actionTimeoutMs ?? 1_000,
    ...(options.pollIntervalMs === undefined
      ? {}
      : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.delay === undefined ? {} : { delay: options.delay }),
  });
}

class FakePageDriver {
  readonly calls: Array<{ name: string; input: unknown }> = [];

  constructor(private readonly responses: BrowserDriverResponse[]) {}

  snapshot(): Promise<BrowserDriverResponse> {
    return this.next("snapshot", undefined);
  }

  wait(input: { text?: string; time?: number }): Promise<BrowserDriverResponse> {
    return this.next("wait", input);
  }

  evaluate(input: {
    function: string;
    target?: string;
    element?: string;
  }): Promise<BrowserDriverResponse> {
    return this.next("evaluate", input);
  }

  private async next(name: string, input: unknown): Promise<BrowserDriverResponse> {
    this.calls.push({ name, input });
    const next = this.responses.shift();
    if (!next) throw new Error(`Missing fake response for ${name}.`);
    return next;
  }
}

function response(
  overrides: Partial<BrowserDriverResponse> = {},
): BrowserDriverResponse {
  return {
    page: {
      id: "page-1",
      url: "https://example.test/",
      title: "Example",
    },
    ...overrides,
  };
}
