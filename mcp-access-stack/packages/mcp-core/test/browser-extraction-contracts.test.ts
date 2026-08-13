import { describe, expect, it } from "@jest/globals";
import {
  browserExtractInputSchema,
  browserExtractResultSchema,
  browserFrameExtractInputSchema,
  browserFrameExtractResultSchema,
} from "../src/browser-contracts.js";

describe("browser extraction contracts", () => {
  it("accepts bounded full-document and safe-pagination modes", () => {
    expect(browserExtractInputSchema.parse({
      tabId: "tab-1",
      format: "text",
      completion: "document",
    })).toMatchObject({ completion: "document" });

    expect(browserExtractInputSchema.parse({
      tabId: "tab-1",
      format: "text",
      completion: "document-and-safe-pagination",
    })).toMatchObject({ completion: "document-and-safe-pagination" });
  });

  it("exposes explicit complete and partial extraction metadata", () => {
    expect(browserExtractResultSchema.parse({
      tabId: "tab-1",
      format: "text",
      value: "content",
      completeness: {
        status: "partial",
        reason: "scroll-limit",
        mode: "document",
        pages: 1,
        scrolls: 24,
        bytes: 7,
      },
    })).toMatchObject({
      completeness: {
        status: "partial",
        reason: "scroll-limit",
      },
    });
  });

  it("allows bounded frame scrolling but rejects automatic frame pagination", () => {
    expect(browserFrameExtractInputSchema.parse({
      tabId: "tab-1",
      frame: "details",
      completion: "document",
    })).toMatchObject({ completion: "document" });

    expect(() => browserFrameExtractInputSchema.parse({
      tabId: "tab-1",
      frame: "details",
      completion: "document-and-safe-pagination",
    })).toThrow();

    expect(browserFrameExtractResultSchema.parse({
      tabId: "tab-1",
      frame: "details",
      format: "text",
      value: "content",
      completeness: {
        status: "complete",
        reason: "end-of-document",
        mode: "document",
        pages: 1,
        scrolls: 2,
        bytes: 7,
      },
    })).toMatchObject({
      completeness: { status: "complete" },
    });
  });
});
