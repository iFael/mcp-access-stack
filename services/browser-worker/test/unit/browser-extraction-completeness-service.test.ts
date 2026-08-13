import { describe, expect, it, jest } from "@jest/globals";
import {
  BrowserExtractionCompletenessService,
  type BrowserExtractionProbe,
} from "../../services/browser-extraction-completeness-service.js";

const defaultRequest = {
  format: "text" as const,
  mode: "document" as const,
  maxScrolls: 8,
  maxPages: 3,
  maxBytes: 1024,
  timeoutMs: 5_000,
  noProgressLimit: 2,
};

describe("BrowserExtractionCompletenessService", () => {
  it("scrolls incrementally until lazy content reaches the end of the document", async () => {
    const probes = queue<BrowserExtractionProbe>([
      probe({ scrollTop: 0, scrollSize: 200, contentBytes: 6, signature: "a" }),
      probe({ scrollTop: 85, scrollSize: 260, contentBytes: 13, signature: "b" }),
      probe({ scrollTop: 160, scrollSize: 260, contentBytes: 20, signature: "c" }),
    ]);
    const reads = queue<unknown>([
      "item-1",
      "item-1\nitem-2",
      "item-1\nitem-2\nitem-3",
    ]);
    const advanceScroll = jest.fn(async () => undefined);
    const stabilize = jest.fn(async () => undefined);
    const service = new BrowserExtractionCompletenessService({
      probe: async () => probes.next(),
      read: async () => reads.next(),
      advanceScroll,
      stabilize,
    });

    await expect(service.extract(defaultRequest)).resolves.toEqual({
      value: "item-1\nitem-2\nitem-3",
      completeness: {
        status: "complete",
        reason: "end-of-document",
        mode: "document",
        pages: 1,
        scrolls: 2,
        bytes: 20,
      },
    });
    expect(advanceScroll).toHaveBeenCalledTimes(2);
    expect(stabilize).toHaveBeenCalledTimes(3);
  });

  it("stops an infinite scroll at the configured scroll bound", async () => {
    const probes = queue<BrowserExtractionProbe>([
      probe({ scrollTop: 0, scrollSize: 1_000, signature: "a" }),
      probe({ scrollTop: 85, scrollSize: 1_100, signature: "b" }),
    ]);
    const reads = queue<unknown>(["first", "first\nsecond"]);
    const service = new BrowserExtractionCompletenessService({
      probe: async () => probes.next(),
      read: async () => reads.next(),
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
    });

    const result = await service.extract({ ...defaultRequest, maxScrolls: 1 });

    expect(result.completeness).toMatchObject({
      status: "partial",
      reason: "scroll-limit",
      scrolls: 1,
      pages: 1,
    });
    expect(result.value).toBe("first\nsecond");
  });

  it("stops when repeated scroll attempts make no observable progress", async () => {
    const stationary = probe({
      scrollTop: 0,
      scrollSize: 1_000,
      contentBytes: 5,
      signature: "same",
    });
    const probes = queue<BrowserExtractionProbe>([
      stationary,
      stationary,
      stationary,
    ]);
    const reads = queue<unknown>(["same", "same", "same"]);
    const service = new BrowserExtractionCompletenessService({
      probe: async () => probes.next(),
      read: async () => reads.next(),
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
    });

    const result = await service.extract(defaultRequest);

    expect(result.completeness).toMatchObject({
      status: "partial",
      reason: "no-progress",
      scrolls: 2,
    });
  });

  it("truncates output and reports the byte limit explicitly", async () => {
    const service = new BrowserExtractionCompletenessService({
      probe: async () => probe({ contentBytes: 20 }),
      read: async () => "12345678901234567890",
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
    });

    const result = await service.extract({ ...defaultRequest, maxBytes: 10 });

    expect(result.value).toBe("1234567890");
    expect(result.completeness).toMatchObject({
      status: "partial",
      reason: "byte-limit",
      bytes: 10,
    });
  });

  it("returns a partial result when the extraction time budget expires", async () => {
    let now = 0;
    const service = new BrowserExtractionCompletenessService({
      probe: async () => probe({ scrollTop: 0, scrollSize: 1_000 }),
      read: async () => "visible-so-far",
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
      now: () => {
        const current = now;
        now += 10;
        return current;
      },
    });

    const result = await service.extract({ ...defaultRequest, timeoutMs: 1 });

    expect(result).toMatchObject({
      value: "visible-so-far",
      completeness: {
        status: "partial",
        reason: "time-limit",
        pages: 1,
        scrolls: 0,
      },
    });
  });

  it("reports semantic pagination without navigating in document mode", async () => {
    const navigateNext = jest.fn(async () => true);
    const service = new BrowserExtractionCompletenessService({
      probe: async () => probe({ nextUrl: "https://example.test/page/2" }),
      read: async () => "page-1",
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
      navigateNext,
    });

    const result = await service.extract(defaultRequest);

    expect(result.completeness).toMatchObject({
      status: "partial",
      reason: "pagination-available",
      paginationAvailable: true,
    });
    expect(navigateNext).not.toHaveBeenCalled();
  });

  it("follows only the supplied safe pagination target and combines text pages", async () => {
    let page = 1;
    const navigateNext = jest.fn(async (url: string) => {
      expect(url).toBe("https://example.test/page/2");
      page = 2;
      return true;
    });
    const service = new BrowserExtractionCompletenessService({
      probe: async () => page === 1
        ? probe({ signature: "page-1", nextUrl: "https://example.test/page/2" })
        : probe({ signature: "page-2" }),
      read: async () => `page-${page}`,
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
      navigateNext,
    });

    const result = await service.extract({
      ...defaultRequest,
      mode: "document-and-safe-pagination",
    });

    expect(result).toEqual({
      value: "page-1\n\npage-2",
      completeness: {
        status: "complete",
        reason: "pagination-end",
        mode: "document-and-safe-pagination",
        pages: 2,
        scrolls: 0,
        bytes: 14,
      },
    });
    expect(navigateNext).toHaveBeenCalledTimes(1);
  });

  it("keeps the final combined pagination output inside the byte bound", async () => {
    let page = 1;
    const service = new BrowserExtractionCompletenessService({
      probe: async () => page === 1
        ? probe({ signature: "page-1", nextUrl: "https://example.test/page/2" })
        : probe({ signature: "page-2" }),
      read: async () => `page-${page}`,
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
      navigateNext: async () => {
        page = 2;
        return true;
      },
    });

    const result = await service.extract({
      ...defaultRequest,
      mode: "document-and-safe-pagination",
      maxBytes: 13,
    });

    expect(Buffer.byteLength(String(result.value), "utf8")).toBeLessThanOrEqual(13);
    expect(result.completeness).toMatchObject({
      status: "partial",
      reason: "byte-limit",
      bytes: 13,
    });
  });
  it("stops cyclic semantic pagination without repeating navigation", async () => {
    let page = 1;
    const navigateNext = jest.fn(async () => {
      page = 2;
      return true;
    });
    const service = new BrowserExtractionCompletenessService({
      probe: async () => page === 1
        ? probe({ signature: "page-1", nextUrl: "https://example.test/page/2" })
        : probe({ signature: "page-2", nextUrl: "https://example.test/page/2" }),
      read: async () => `page-${page}`,
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
      navigateNext,
    });

    const result = await service.extract({
      ...defaultRequest,
      mode: "document-and-safe-pagination",
    });

    expect(result.completeness).toMatchObject({
      status: "partial",
      reason: "cycle",
      pages: 2,
    });
    expect(navigateNext).toHaveBeenCalledTimes(1);
  });

  it("refuses to auto-paginate HTML because concatenation would be unsafe", async () => {
    const navigateNext = jest.fn(async () => true);
    const service = new BrowserExtractionCompletenessService({
      probe: async () => probe({ nextUrl: "https://example.test/page/2" }),
      read: async () => "<html><body>page</body></html>",
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
      navigateNext,
    });

    const result = await service.extract({
      ...defaultRequest,
      format: "html",
      mode: "document-and-safe-pagination",
    });

    expect(result.completeness).toMatchObject({
      status: "partial",
      reason: "unsafe-pagination",
    });
    expect(navigateNext).not.toHaveBeenCalled();
  });

  it("marks virtualized HTML partial instead of claiming lost off-screen DOM is complete", async () => {
    const probes = queue<BrowserExtractionProbe>([
      probe({
        scrollTop: 0,
        scrollSize: 200,
        contentBytes: 100,
        signature: "window-a",
      }),
      probe({
        scrollTop: 100,
        scrollSize: 200,
        contentBytes: 90,
        signature: "window-b",
      }),
    ]);
    const reads = queue<unknown>([
      "<html><body>window-a</body></html>",
      "<html><body>window-b</body></html>",
    ]);
    const service = new BrowserExtractionCompletenessService({
      probe: async () => probes.next(),
      read: async () => reads.next(),
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
    });

    const result = await service.extract({ ...defaultRequest, format: "html" });

    expect(result.completeness).toMatchObject({
      status: "partial",
      reason: "virtualized-content",
      pages: 1,
      scrolls: 1,
    });
  });

  it("propagates cancellation before performing browser work", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const read = jest.fn(async () => "unused");
    const service = new BrowserExtractionCompletenessService({
      probe: async () => probe(),
      read,
      advanceScroll: async () => undefined,
      stabilize: async () => undefined,
    });

    await expect(service.extract({
      ...defaultRequest,
      signal: controller.signal,
    })).rejects.toBeDefined();
    expect(read).not.toHaveBeenCalled();
  });
});

function probe(
  overrides: Partial<BrowserExtractionProbe> = {},
): BrowserExtractionProbe {
  return {
    scrollTop: 0,
    viewportSize: 100,
    scrollSize: 100,
    contentBytes: 6,
    signature: "page",
    ...overrides,
  };
}

function queue<T>(values: readonly T[]): { next(): T } {
  const remaining = [...values];
  return {
    next(): T {
      const next = remaining.shift();
      if (next === undefined) throw new Error("Fake queue exhausted.");
      return next;
    },
  };
}
