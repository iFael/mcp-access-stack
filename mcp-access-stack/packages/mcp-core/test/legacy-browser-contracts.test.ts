import { describe, expect, it } from "@jest/globals";
import {
  browserDomIndexInputSchema,
  browserFrameSequenceInputSchema,
  browserNavigatePathInputSchema,
  browserOperationInputSchemas,
  browserOperationResultSchemas,
  browserOperationSchema,
  browserProfilePageResultSchema,
  errorCodes,
  legacyLocatorSchema,
} from "../src/index.js";

describe("legacy browser contracts", () => {
  it("registers all four operations in the shared operation envelope", () => {
    for (const operation of ["profilePage", "domIndex", "frameSequence", "navigatePath"] as const) {
      expect(browserOperationSchema.parse(operation)).toBe(operation);
      expect(browserOperationInputSchemas[operation]).toBeDefined();
      expect(browserOperationResultSchemas[operation]).toBeDefined();
    }
  });

  it("requires a deterministic locator field and rejects unknown properties", () => {
    expect(legacyLocatorSchema.safeParse({ exact: true }).success).toBe(false);
    expect(legacyLocatorSchema.safeParse({ id: "menu", extra: true }).success).toBe(false);
    expect(legacyLocatorSchema.parse({ text: "Financeiro" })).toEqual({ text: "Financeiro" });
  });

  it("enforces typed sequence steps and bounded payloads", () => {
    expect(
      browserFrameSequenceInputSchema.parse({
        tabId: "tab-1",
        steps: [
          { action: "index", framePath: ["Menu"], limit: 100 },
          { action: "click", framePath: ["Menu"], locator: { id: "financeiro" } },
          { action: "waitFor", framePath: ["Menu"], locator: { id: "cpx-finance" }, state: "visible" },
          { action: "assert", framePath: ["Menu"], locator: { id: "cpx-finance" }, condition: "visible" },
        ],
      }).steps,
    ).toHaveLength(4);
    expect(
      browserFrameSequenceInputSchema.safeParse({
        tabId: "tab-1",
        steps: [{ action: "waitFor" }],
      }).success,
    ).toBe(false);
    expect(
      browserFrameSequenceInputSchema.parse({
        tabId: "tab-1",
        steps: [{ action: "press", key: "Enter", mode: "native", locator: { id: "open" } }],
      }).steps[0],
    ).toMatchObject({ action: "press", mode: "native" });
    expect(
      browserFrameSequenceInputSchema.safeParse({
        tabId: "tab-1",
        steps: [{ action: "press", key: "Enter", mode: "unknown" }],
      }).success,
    ).toBe(false);
  });

  it("keeps profile and index operations read-only by contract shape", () => {
    const indexInput = browserDomIndexInputSchema.parse({
      tabId: "tab-1",
      framePath: ["Menu"],
      rootSelector: "#main-menu",
      query: "CPX-Finance",
      offset: 2_000,
      limit: 500,
      visibleOnly: true,
    });
    expect(indexInput).not.toHaveProperty("value");
    expect(indexInput).not.toHaveProperty("script");

    const profile = browserProfilePageResultSchema.parse({
      tabId: "tab-1",
      profile: "legacy-frames",
      signals: {
        frames: 2,
        nestedFrames: 0,
        layoutTables: 1,
        inlineHandlers: 1,
        hashLinks: 1,
        targetedNavigation: 1,
        postForms: 0,
      },
      pageSignature: "page-signature",
      frameGraphSignature: "frame-signature",
      frames: [],
      telemetry: { totalMs: 1 },
    });
    expect(profile.profile).toBe("legacy-frames");
  });

  it("accepts hierarchical paths but no arbitrary JavaScript", () => {
    const parsed = browserNavigatePathInputSchema.parse({
      tabId: "tab-1",
      path: ["Financeiro", "CPX-Finance"],
      sourceFramePath: ["Menu"],
      targetFramePath: ["MenuContent"],
    });
    expect(parsed.path).toEqual(["Financeiro", "CPX-Finance"]);
    expect(parsed).not.toHaveProperty("function");
    expect(parsed).not.toHaveProperty("javascript");
  });

  it("allows only non-mutating final navigation checkpoints", () => {
    const parsed = browserNavigatePathInputSchema.parse({
      tabId: "tab-1",
      path: ["Financeiro", "CPX-Finance"],
      sourceFramePath: ["Menu"],
      targetFramePath: ["MenuContent"],
      checkpoint: {
        action: "extract",
        framePath: ["MenuContent"],
        locator: { selector: "h1" },
        format: "text",
      },
    });
    expect(parsed.checkpoint).toMatchObject({ action: "extract" });
    expect(
      browserNavigatePathInputSchema.safeParse({
        tabId: "tab-1",
        path: ["Financeiro"],
        checkpoint: {
          action: "click",
          framePath: ["Menu"],
          locator: { id: "financeiro" },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts frame-segmented paths while preserving the flattened path contract", () => {
    const parsed = browserNavigatePathInputSchema.parse({
      tabId: "tab-1",
      path: ["Financeiro", "CPX-Finance", "Histórico", "Conferências"],
      segments: [
        {
          framePath: ["Menu"],
          path: ["Financeiro", "CPX-Finance"],
          targetFramePath: ["MenuContent"],
        },
        {
          framePath: ["MenuContent"],
          path: ["Histórico", "Conferências"],
          waitFor: {
            locator: { selector: ".tab.is-active[data-view=\"conferencias\"]" },
            state: "visible",
          },
        },
      ],
    });
    expect(parsed.segments).toHaveLength(2);
    expect(
      browserNavigatePathInputSchema.safeParse({
        tabId: "tab-1",
        path: ["Financeiro", "CPX-Finance"],
        segments: [{ framePath: ["Menu"], path: ["Financeiro"] }],
      }).success,
    ).toBe(false);
  });

  it("publishes the required typed error codes", () => {
    expect(errorCodes).toEqual(expect.arrayContaining([
      "FRAME_NOT_FOUND",
      "FRAME_NOT_READY",
      "FRAME_CROSS_ORIGIN",
      "LOCATOR_NOT_FOUND",
      "LOCATOR_AMBIGUOUS",
      "LOCATOR_LOW_CONFIDENCE",
      "NAVIGATION_TIMEOUT",
      "STATE_NOT_REACHED",
      "ACTION_BLOCKED_BY_POLICY",
      "CAPABILITY_UNSUPPORTED",
    ]));
  });
});
