import { describe, expect, it } from "@jest/globals";
import {
  browserOperationInputSchemas,
  browserOperationResultSchemas,
  browserOperationSchema,
} from "../src/browser-contracts.js";

describe("browser diagnostic contracts", () => {
  it("registers every public advanced operation", () => {
    for (const operation of [
      "console",
      "networkList",
      "networkInspect",
      "traceStart",
      "traceStop",
      "videoStart",
      "videoStop",
      "pdf",
      "diagnostics",
    ] as const) {
      expect(browserOperationSchema.parse(operation)).toBe(operation);
      expect(browserOperationInputSchemas[operation]).toBeDefined();
      expect(browserOperationResultSchemas[operation]).toBeDefined();
    }
  });

  it("rejects unsafe filters, filenames and incomplete video dimensions", () => {
    expect(() =>
      browserOperationInputSchemas.networkList.parse({
        tabId: "tab-1",
        filter: "[invalid",
      }),
    ).toThrow();

    expect(() =>
      browserOperationInputSchemas.pdf.parse({
        tabId: "tab-1",
        filename: "../outside.pdf",
      }),
    ).toThrow();

    expect(() =>
      browserOperationInputSchemas.videoStart.parse({
        tabId: "tab-1",
        width: 800,
      }),
    ).toThrow();
  });

  it("validates bounded public diagnostic results", () => {
    const collectedAt = "2026-07-02T14:30:00.000Z";
    expect(
      browserOperationResultSchemas.diagnostics.parse({
        tabId: "tab-1",
        console: { text: "console", truncated: false, collectedAt },
        network: { text: "network", truncated: false, collectedAt },
        traceActive: false,
        videoActive: false,
        collectedAt,
      }),
    ).toMatchObject({ tabId: "tab-1", traceActive: false });
  });
});
