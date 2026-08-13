import { z } from "zod";

const tabIdSchema = z.string().min(1).max(128);
const framePathSchema = z.array(z.string().min(1).max(200)).max(16);
const confirmationIdSchema = z.string().min(1).max(128).optional();

export const legacyPageProfileSchema = z.enum([
  "modern",
  "legacy-frames",
  "legacy-table-layout",
  "legacy-form-post",
  "legacy-script-navigation",
  "hybrid",
]);
export type LegacyPageProfile = z.infer<typeof legacyPageProfileSchema>;

export const legacyFrameStatusSchema = z.enum([
  "ready",
  "not-ready",
  "cross-origin",
  "inaccessible",
]);
export type LegacyFrameStatus = z.infer<typeof legacyFrameStatusSchema>;

export const legacyFrameNodeSchema: z.ZodType<LegacyFrameNode> = z.lazy(() =>
  z
    .object({
      path: framePathSchema,
      name: z.string().max(200).optional(),
      id: z.string().max(200).optional(),
      index: z.number().int().nonnegative(),
      src: z.string().max(2_000).optional(),
      status: legacyFrameStatusSchema,
      readyState: z.string().max(50).optional(),
      signature: z.string().min(1).max(128),
      children: z.array(legacyFrameNodeSchema).max(100),
    })
    .strict(),
);
export interface LegacyFrameNode {
  path: string[];
  name?: string | undefined;
  id?: string | undefined;
  index: number;
  src?: string | undefined;
  status: LegacyFrameStatus;
  readyState?: string | undefined;
  signature: string;
  children: LegacyFrameNode[];
}

export const legacyTelemetrySchema = z
  .object({
    totalMs: z.number().nonnegative(),
    frameResolutionMs: z.number().nonnegative().optional(),
    indexMs: z.number().nonnegative().optional(),
    locatorMs: z.number().nonnegative().optional(),
    interactionMs: z.number().nonnegative().optional(),
    navigationMs: z.number().nonnegative().optional(),
    candidateCount: z.number().int().nonnegative().optional(),
    cacheHit: z.boolean().optional(),
    cacheInvalidated: z.boolean().optional(),
    strategy: z.string().max(100).optional(),
    retries: z.number().int().nonnegative().optional(),
  })
  .strict();
export type LegacyTelemetry = z.infer<typeof legacyTelemetrySchema>;

export const legacyLocatorSchema = z
  .object({
    ref: z.string().min(1).max(256).optional(),
    id: z.string().min(1).max(256).optional(),
    name: z.string().min(1).max(256).optional(),
    selector: z.string().min(1).max(2_000).optional(),
    tag: z.string().min(1).max(100).optional(),
    type: z.string().min(1).max(100).optional(),
    role: z.string().min(1).max(100).optional(),
    href: z.string().min(1).max(2_000).optional(),
    target: z.string().min(1).max(256).optional(),
    onclickSignature: z.string().min(1).max(128).optional(),
    text: z.string().min(1).max(500).optional(),
    exact: z.boolean().optional(),
    ancestorText: z.string().min(1).max(500).optional(),
    index: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (locator) =>
      Object.entries(locator).some(
        ([key, value]) => key !== "exact" && value !== undefined,
      ),
    { message: "A legacy locator requires at least one identifying field." },
  );
export type LegacyLocator = z.infer<typeof legacyLocatorSchema>;

export const legacyDomIndexItemSchema = z
  .object({
    ref: z.string().min(1).max(256),
    tag: z.string().min(1).max(100),
    id: z.string().max(256).optional(),
    name: z.string().max(256).optional(),
    type: z.string().max(100).optional(),
    role: z.string().max(100).optional(),
    text: z.string().max(500),
    href: z.string().max(2_000).optional(),
    target: z.string().max(256).optional(),
    onclickSignature: z.string().max(128).optional(),
    ariaLabel: z.string().max(500).optional(),
    title: z.string().max(500).optional(),
    alt: z.string().max(500).optional(),
    visible: z.boolean(),
    enabled: z.boolean(),
    selector: z.string().min(1).max(2_000),
    framePath: framePathSchema,
    ancestors: z.array(z.string().max(300)).max(6),
  })
  .strict();
export type LegacyDomIndexItem = z.infer<typeof legacyDomIndexItemSchema>;

export const browserProfilePageInputSchema = z
  .object({
    tabId: tabIdSchema,
    maxDepth: z.number().int().min(0).max(16).optional(),
  })
  .strict();
export type BrowserProfilePageInput = z.infer<typeof browserProfilePageInputSchema>;

export const browserProfilePageResultSchema = z
  .object({
    tabId: tabIdSchema,
    profile: legacyPageProfileSchema,
    signals: z
      .object({
        frames: z.number().int().nonnegative(),
        nestedFrames: z.number().int().nonnegative(),
        layoutTables: z.number().int().nonnegative(),
        inlineHandlers: z.number().int().nonnegative(),
        hashLinks: z.number().int().nonnegative(),
        targetedNavigation: z.number().int().nonnegative(),
        postForms: z.number().int().nonnegative(),
      })
      .strict(),
    pageSignature: z.string().min(1).max(128),
    frameGraphSignature: z.string().min(1).max(128),
    frames: z.array(legacyFrameNodeSchema).max(100),
    telemetry: legacyTelemetrySchema,
  })
  .strict();
export type BrowserProfilePageResult = z.infer<typeof browserProfilePageResultSchema>;

export const browserDomIndexInputSchema = z
  .object({
    tabId: tabIdSchema,
    framePath: framePathSchema.optional(),
    rootSelector: z.string().min(1).max(2_000).optional(),
    query: z.string().min(1).max(500).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(2_000).optional(),
    visibleOnly: z.boolean().optional(),
  })
  .strict();
export type BrowserDomIndexInput = z.infer<typeof browserDomIndexInputSchema>;

export const browserDomIndexResultSchema = z
  .object({
    tabId: tabIdSchema,
    framePath: framePathSchema,
    pageSignature: z.string().min(1).max(128),
    frameGraphSignature: z.string().min(1).max(128),
    items: z.array(legacyDomIndexItemSchema).max(2_000),
    truncated: z.boolean(),
    offset: z.number().int().nonnegative().optional(),
    totalCount: z.number().int().nonnegative().optional(),
    nextOffset: z.number().int().nonnegative().optional(),
    telemetry: legacyTelemetrySchema,
  })
  .strict();
export type BrowserDomIndexResult = z.infer<typeof browserDomIndexResultSchema>;

const legacyFrameStepBase = {
  framePath: framePathSchema.optional(),
};

export const legacyFrameSequenceStepSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("index"),
    ...legacyFrameStepBase,
    rootSelector: z.string().min(1).max(2_000).optional(),
    query: z.string().min(1).max(500).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(2_000).optional(),
    visibleOnly: z.boolean().optional(),
  }).strict(),
  z.object({ action: z.literal("click"), ...legacyFrameStepBase, locator: legacyLocatorSchema, confirmationId: confirmationIdSchema }).strict(),
  z.object({ action: z.literal("fill"), ...legacyFrameStepBase, locator: legacyLocatorSchema, value: z.string().max(100_000) }).strict(),
  z.object({ action: z.literal("select"), ...legacyFrameStepBase, locator: legacyLocatorSchema, value: z.string().max(10_000) }).strict(),
  z.object({ action: z.literal("press"), ...legacyFrameStepBase, locator: legacyLocatorSchema.optional(), key: z.string().min(1).max(100), mode: z.enum(["dom", "native"]).optional(), confirmationId: confirmationIdSchema }).strict(),
  z
    .object({
      action: z.literal("waitFor"),
      ...legacyFrameStepBase,
      locator: legacyLocatorSchema.optional(),
      text: z.string().min(1).max(10_000).optional(),
      state: z.enum(["ready", "exists", "visible", "hidden"]).optional(),
      timeoutMs: z.number().int().positive().max(120_000).optional(),
    })
    .strict()
    .refine((step) => step.locator !== undefined || step.text !== undefined || step.state === "ready", {
      message: "waitFor requires locator, text, or state=ready.",
    }),
  z.object({ action: z.literal("extract"), ...legacyFrameStepBase, locator: legacyLocatorSchema.optional(), format: z.enum(["text", "html", "json"]).optional() }).strict(),
  z
    .object({
      action: z.literal("assert"),
      ...legacyFrameStepBase,
      locator: legacyLocatorSchema.optional(),
      condition: z.enum(["exists", "visible", "enabled", "textEquals", "textContains", "frameReady"]),
      expected: z.string().max(10_000).optional(),
    })
    .strict()
    .superRefine((step, context) => {
      if (step.condition !== "frameReady" && step.locator === undefined) {
        context.addIssue({ code: "custom", path: ["locator"], message: "This assertion requires a locator." });
      }
      if (["textEquals", "textContains"].includes(step.condition) && step.expected === undefined) {
        context.addIssue({ code: "custom", path: ["expected"], message: "Text assertions require expected." });
      }
    }),
]);
export type LegacyFrameSequenceStep = z.infer<typeof legacyFrameSequenceStepSchema>;

export const browserFrameSequenceInputSchema = z
  .object({
    tabId: tabIdSchema,
    steps: z.array(legacyFrameSequenceStepSchema).min(1).max(20),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict();
export type BrowserFrameSequenceInput = z.infer<typeof browserFrameSequenceInputSchema>;

export const browserFrameSequenceStepResultSchema = z
  .object({
    index: z.number().int().nonnegative(),
    action: z.enum(["index", "click", "fill", "select", "press", "waitFor", "extract", "assert"]),
    completed: z.literal(true),
    value: z.unknown().optional(),
    strategy: z.string().max(100).optional(),
    ref: z.string().max(256).optional(),
  })
  .strict();

export const browserFrameSequenceResultSchema = z
  .object({
    tabId: tabIdSchema,
    completed: z.literal(true),
    steps: z.array(browserFrameSequenceStepResultSchema).max(20),
    telemetry: legacyTelemetrySchema,
  })
  .strict();
export type BrowserFrameSequenceResult = z.infer<typeof browserFrameSequenceResultSchema>;

const legacyPathSchema = z.array(z.string().min(1).max(500)).min(1).max(10);

export const legacyNavigationWaitSchema = z
  .object({
    framePath: framePathSchema.optional(),
    locator: legacyLocatorSchema.optional(),
    text: z.string().min(1).max(10_000).optional(),
    state: z.enum(["ready", "exists", "visible", "hidden"]).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  })
  .strict()
  .refine(
    (wait) => wait.locator !== undefined || wait.text !== undefined || wait.state === "ready",
    { message: "A navigation segment wait requires locator, text, or state=ready." },
  );
export type LegacyNavigationWait = z.infer<typeof legacyNavigationWaitSchema>;

export const legacyNavigationCheckpointSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("waitFor"),
    framePath: framePathSchema.optional(),
    locator: legacyLocatorSchema.optional(),
    text: z.string().min(1).max(10_000).optional(),
    state: z.enum(["ready", "exists", "visible", "hidden"]).optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
  }).strict().refine(
    (step) => step.locator !== undefined || step.text !== undefined || step.state === "ready",
    { message: "A navigation checkpoint wait requires locator, text, or state=ready." },
  ),
  z.object({
    action: z.literal("extract"),
    framePath: framePathSchema.optional(),
    locator: legacyLocatorSchema.optional(),
    format: z.enum(["text", "html", "json"]).optional(),
  }).strict(),
  z.object({
    action: z.literal("assert"),
    framePath: framePathSchema.optional(),
    locator: legacyLocatorSchema.optional(),
    condition: z.enum(["exists", "visible", "enabled", "textEquals", "textContains", "frameReady"]),
    expected: z.string().max(10_000).optional(),
  }).strict().superRefine((step, context) => {
    if (step.condition !== "frameReady" && step.locator === undefined) {
      context.addIssue({ code: "custom", path: ["locator"], message: "This navigation checkpoint assertion requires a locator." });
    }
    if (["textEquals", "textContains"].includes(step.condition) && step.expected === undefined) {
      context.addIssue({ code: "custom", path: ["expected"], message: "Navigation checkpoint text assertions require expected." });
    }
  }),
]);
export type LegacyNavigationCheckpoint = z.infer<typeof legacyNavigationCheckpointSchema>;
export const legacyNavigationSegmentSchema = z
  .object({
    framePath: framePathSchema,
    path: legacyPathSchema,
    rootSelector: z.string().min(1).max(2_000).optional(),
    targetFramePath: framePathSchema.optional(),
    waitFor: legacyNavigationWaitSchema.optional(),
  })
  .strict();
export type LegacyNavigationSegment = z.infer<typeof legacyNavigationSegmentSchema>;

export const browserNavigatePathInputSchema = z
  .object({
    tabId: tabIdSchema,
    path: legacyPathSchema,
    sourceFramePath: framePathSchema.optional(),
    targetFramePath: framePathSchema.optional(),
    segments: z.array(legacyNavigationSegmentSchema).min(1).max(10).optional(),
    checkpoint: legacyNavigationCheckpointSchema.optional(),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    confirmationId: confirmationIdSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.segments) return;
    const flattened = input.segments.flatMap((segment) => segment.path);
    if (flattened.length !== input.path.length || flattened.some((label, index) => label !== input.path[index])) {
      context.addIssue({
        code: "custom",
        path: ["segments"],
        message: "Segment paths must flatten to the legacy path in the same order.",
      });
    }
  });
export type BrowserNavigatePathInput = z.infer<typeof browserNavigatePathInputSchema>;

export const browserNavigatePathResultSchema = z
  .object({
    tabId: tabIdSchema,
    completed: z.literal(true),
    path: z.array(z.string().min(1).max(500)).min(1).max(10),
    resolved: z
      .array(
        z
          .object({
            level: z.number().int().nonnegative(),
            label: z.string().min(1).max(500),
            ref: z.string().min(1).max(256),
            selector: z.string().min(1).max(2_000),
            strategy: z.string().min(1).max(100),
            segment: z.number().int().nonnegative().optional(),
            framePath: framePathSchema.optional(),
          })
          .strict(),
      )
      .max(10),
    destinationReady: z.boolean(),
    segments: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            framePath: framePathSchema,
            path: legacyPathSchema,
            targetFramePath: framePathSchema.optional(),
            destinationReady: z.boolean(),
            telemetry: legacyTelemetrySchema,
          })
          .strict(),
      )
      .max(10)
      .optional(),
    cache: z
      .object({ hit: z.boolean(), revalidated: z.boolean(), invalidated: z.boolean() })
      .strict(),
    checkpoint: z
      .object({
        step: browserFrameSequenceStepResultSchema,
        telemetry: legacyTelemetrySchema,
      })
      .strict()
      .optional(),
    telemetry: legacyTelemetrySchema,
  })
  .strict();
export type BrowserNavigatePathResult = z.infer<typeof browserNavigatePathResultSchema>;
