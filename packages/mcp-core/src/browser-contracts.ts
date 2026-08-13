import { z } from "zod";
import { errorCodes } from "./errors.js";
import { operationLifecycleSchema } from "./timeout-policy.js";
import {
  browserDomIndexInputSchema,
  browserDomIndexResultSchema,
  browserFrameSequenceInputSchema,
  browserFrameSequenceResultSchema,
  browserNavigatePathInputSchema,
  browserNavigatePathResultSchema,
  browserProfilePageInputSchema,
  browserProfilePageResultSchema,
} from "./legacy-browser-contracts.js";

export const browserOwnershipSchema = z.enum(["user", "mcp"]);
export type BrowserOwnership = z.infer<typeof browserOwnershipSchema>;

export const browserConnectionStateSchema = z.enum([
  "disconnected",
  "connecting",
  "connected",
]);
export type BrowserConnectionState = z.infer<typeof browserConnectionStateSchema>;

export const browserSnapshotKindSchema = z.enum([
  "full",
  "delta",
  "unchanged",
  "unavailable",
]);
export type BrowserSnapshotKind = z.infer<typeof browserSnapshotKindSchema>;

export const browserStateEventSchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    type: z.enum([
      "console",
      "pageerror",
      "request",
      "response",
      "requestfailed",
      "dialog",
      "download",
      "filechooser",
    ]),
    timestamp: z.string().datetime(),
    text: z.string().max(10_000).optional(),
    url: z.string().max(20_000).optional(),
    status: z.number().int().min(100).max(999).optional(),
  })
  .strict();
export type BrowserStateEvent = z.infer<typeof browserStateEventSchema>;

export const browserStateUpdateSchema = z
  .object({
    documentId: z.string().min(1).max(128),
    revision: z.number().int().nonnegative(),
    baseRevision: z.number().int().nonnegative().optional(),
    kind: browserSnapshotKindSchema,
    snapshot: z.string().max(2_000_000).optional(),
    events: z.array(browserStateEventSchema).max(500).optional(),
    refsValid: z.boolean(),
  })
  .strict();
export type BrowserStateUpdate = z.infer<typeof browserStateUpdateSchema>;

export const browserOperationTimingSchema = z
  .object({
    queueMs: z.number().nonnegative().optional(),
    actionMs: z.number().nonnegative(),
    snapshotMs: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserOperationTiming = z.infer<typeof browserOperationTimingSchema>;

const knownRevisionSchema = z.number().int().nonnegative().optional();
const taskIdSchema = z.string().min(1).max(128);
export const browserTabLifecycleSchema = z.enum([
  "task-scoped",
  "persistent",
  "external",
]);
export type BrowserTabLifecycle = z.infer<typeof browserTabLifecycleSchema>;

export const browserTabSchema = z
  .object({
    tabId: z.string().min(1).max(128),
    taskId: taskIdSchema.optional(),
    lifecycle: browserTabLifecycleSchema.optional(),
    ownership: browserOwnershipSchema,
    purpose: z.string().min(1).max(200),
    reusable: z.boolean(),
    protected: z.boolean(),
    sticky: z.boolean(),
    createdAt: z.string().min(1),
    lastUsedAt: z.string().min(1),
    url: z.url().optional(),
    requestedUrl: z.url().optional(),
    title: z.string().max(500).optional(),
    lockedUrl: z.url().optional(),
  })
  .strict();
export type BrowserTab = z.infer<typeof browserTabSchema>;

export const browserStatusInputSchema = z.object({}).strict();
export type BrowserStatusInput = z.infer<typeof browserStatusInputSchema>;

export const browserIdempotencyMetricsSchema = z
  .object({
    entries: z.number().int().nonnegative(),
    hits: z.number().int().nonnegative(),
    misses: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    evictions: z.number().int().nonnegative(),
    expirations: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserIdempotencyMetrics = z.infer<
  typeof browserIdempotencyMetricsSchema
>;

export const browserContextRecoveryMetricsSchema = z
  .object({
    zeroPageDetections: z.number().int().nonnegative(),
    contextRecoveriesAttempted: z.number().int().nonnegative(),
    contextRecoveriesSucceeded: z.number().int().nonnegative(),
    contextRecoveriesFailed: z.number().int().nonnegative(),
    pagesRecreated: z.number().int().nonnegative(),
    contextsRestarted: z.number().int().nonnegative(),
    staleBindingsRemoved: z.number().int().nonnegative(),
    staleReferencesRemoved: z.number().int().nonnegative(),
    recoveryContentionCount: z.number().int().nonnegative(),
    recoveryDurationMs: z.number().nonnegative(),
  })
  .strict();
export type BrowserContextRecoveryMetrics = z.infer<
  typeof browserContextRecoveryMetricsSchema
>;

export const browserStatusResultSchema = z
  .object({
    state: browserConnectionStateSchema,
    ready: z.boolean(),
    browser: z.literal("chrome"),
    profile: z.enum(["default", "dedicated-persistent"]),
    autoLaunch: z.literal(true),
    tabGroup: z.literal("MCP"),
    edgeFallback: z.literal("technical-necessity-only"),
    tabCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative().optional(),
    idempotency: browserIdempotencyMetricsSchema.optional(),
    recovery: browserContextRecoveryMetricsSchema.optional(),
    engine: z.literal("playwright-direct").optional(),
    engineVersion: z.string().min(1).max(100).optional(),
    protocolVersion: z.number().int().positive().optional(),
    playwrightVersion: z.string().min(1).max(100).optional(),
    browserChannel: z.enum(["chromium", "chrome"]).optional(),
    chromiumRevision: z.string().min(1).max(100).optional(),
    capabilities: z
      .object({
        semanticSnapshots: z.boolean(),
        incrementalSnapshots: z.boolean(),
        actionState: z.boolean(),
        perTabConcurrency: z.boolean(),
        zeroPageRecovery: z.boolean().optional(),
        taskLifecycle: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrowserStatusResult = z.infer<typeof browserStatusResultSchema>;

export const browserConnectInputSchema = z.object({}).strict();
export type BrowserConnectInput = z.infer<typeof browserConnectInputSchema>;
export const browserConnectResultSchema = browserStatusResultSchema;
export type BrowserConnectResult = BrowserStatusResult;

export const browserTabsInputSchema = z
  .object({ taskId: taskIdSchema.optional() })
  .strict();
export type BrowserTabsInput = z.infer<typeof browserTabsInputSchema>;
export const browserTabsResultSchema = z
  .object({ tabs: z.array(browserTabSchema).max(100) })
  .strict();
export type BrowserTabsResult = z.infer<typeof browserTabsResultSchema>;

export const browserOpenInputSchema = z
  .object({
    taskId: taskIdSchema.optional(),
    url: z.url().optional(),
    purpose: z.string().min(1).max(200).optional(),
    reusable: z.boolean().optional(),
    protected: z.boolean().optional(),
    sticky: z.boolean().optional(),
    knownRevision: knownRevisionSchema,
  })
  .strict();
export type BrowserOpenInput = z.infer<typeof browserOpenInputSchema>;

export const browserTabResultSchema = z
  .object({
    tab: browserTabSchema,
    restoredFromCache: z.boolean().optional(),
    cacheAgeMs: z.number().int().nonnegative().optional(),
    state: browserStateUpdateSchema.optional(),
    timing: browserOperationTimingSchema.optional(),
  })
  .strict();
export type BrowserTabResult = z.infer<typeof browserTabResultSchema>;

const tabIdSchema = z.string().min(1).max(128);
const confirmationIdSchema = z.string().min(1).max(128).optional();

export const browserOpenAuthorizedSiteInputSchema = z
  .object({
    siteId: z.string().min(1).max(128),
    purpose: z.string().min(1).max(200),
    taskId: taskIdSchema.optional(),
    confirmationId: z.string().min(1).max(128).optional(),
  })
  .strict();
export type BrowserOpenAuthorizedSiteInput = z.infer<
  typeof browserOpenAuthorizedSiteInputSchema
>;

export const browserOpenAuthorizedSiteConfirmationResultSchema = z
  .object({
    status: z.literal("confirmation_required"),
    taskId: taskIdSchema,
    siteId: z.string().min(1).max(128),
    confirmationId: z.string().min(1).max(128),
    expiresAt: z.iso.datetime(),
    reasons: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const browserAuthenticationStatusSchema = z.enum([
  "not-required",
  "session-reused",
  "performed",
  "interaction-required",
  "failed",
]);
export type BrowserAuthenticationStatus = z.infer<
  typeof browserAuthenticationStatusSchema
>;

export const browserAuthenticationReasonSchema = z.enum([
  "mfa-or-captcha",
  "credential-unavailable",
  "broker-unavailable",
  "broker-access-denied",
  "broker-protocol-mismatch",
  "credentials-invalid",
  "login-form-not-found",
  "submit-outcome-unknown",
  "postcondition-not-reached",
  "capability-unavailable",
  "diagnostic-active",
]);
export type BrowserAuthenticationReason = z.infer<
  typeof browserAuthenticationReasonSchema
>;

export const browserOpenAuthorizedSiteOpenedResultSchema = z
  .object({
    status: z.literal("opened"),
    taskId: taskIdSchema,
    tabId: tabIdSchema,
    authorization: z
      .object({
        status: z.literal("granted"),
        expiresAt: z.iso.datetime(),
      })
      .strict(),
    authentication: z
      .object({
        status: browserAuthenticationStatusSchema,
        reason: browserAuthenticationReasonSchema.optional(),
      })
      .strict(),
    site: z
      .object({
        siteId: z.string().min(1).max(128),
        accessMode: z.literal("business-read-only"),
      })
      .strict(),
    state: browserStateUpdateSchema.optional(),
    timing: browserOperationTimingSchema.optional(),
  })
  .strict();

export const browserOpenAuthorizedSiteResultSchema = z.discriminatedUnion(
  "status",
  [
    browserOpenAuthorizedSiteConfirmationResultSchema,
    browserOpenAuthorizedSiteOpenedResultSchema,
  ],
);
export type BrowserOpenAuthorizedSiteResult = z.infer<
  typeof browserOpenAuthorizedSiteResultSchema
>;

/**
 * Object-shaped representation published through MCP tools/list. Runtime
 * validation still delegates to the canonical discriminated union above.
 */
export const browserOpenAuthorizedSiteToolResultSchema = z
  .object({
    status: z.enum(["confirmation_required", "opened"]),
    taskId: taskIdSchema,
    siteId: z.string().min(1).max(128),
    confirmationId: z.string().min(1).max(128).optional(),
    expiresAt: z.iso.datetime().optional(),
    reasons: z.array(z.string().min(1)).min(1).optional(),
    tabId: tabIdSchema.optional(),
    authorization:
      browserOpenAuthorizedSiteOpenedResultSchema.shape.authorization.optional(),
    authentication:
      browserOpenAuthorizedSiteOpenedResultSchema.shape.authentication.optional(),
    site: browserOpenAuthorizedSiteOpenedResultSchema.shape.site.optional(),
    state: browserStateUpdateSchema.optional(),
    timing: browserOperationTimingSchema.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    if (browserOpenAuthorizedSiteResultSchema.safeParse(result).success) return;
    context.addIssue({
      code: "custom",
      message: "Authorized-site output must match confirmation_required or opened.",
    });
  });

export const browserNavigateInputSchema = z
  .object({
    tabId: tabIdSchema,
    url: z.url(),
    waitUntil: z.enum(["commit", "domcontentloaded", "load"]).optional(),
    confirmationId: confirmationIdSchema,
    knownRevision: knownRevisionSchema,
  })
  .strict();
export type BrowserNavigateInput = z.infer<typeof browserNavigateInputSchema>;

export const browserSnapshotInputSchema = z
  .object({
    tabId: tabIdSchema,
    knownRevision: knownRevisionSchema,
    forceFull: z.boolean().optional(),
  })
  .strict();
export type BrowserSnapshotInput = z.infer<typeof browserSnapshotInputSchema>;
export const browserSnapshotResultSchema = z
  .object({
    tabId: tabIdSchema,
    url: z.url(),
    title: z.string().max(500).optional(),
    content: z.string().max(2_000_000),
    refs: z
      .array(
        z
          .object({
            ref: z.string().min(1).max(128),
            role: z.string().min(1).max(100),
            name: z.string().max(500),
          })
          .strict(),
      )
      .max(10_000),
    state: browserStateUpdateSchema.optional(),
    timing: browserOperationTimingSchema.optional(),
  })
  .strict();
export type BrowserSnapshotResult = z.infer<typeof browserSnapshotResultSchema>;

export const browserClickInputSchema = z
  .object({
    tabId: tabIdSchema,
    ref: z.string().min(1).max(128),
    confirmationId: confirmationIdSchema,
    knownRevision: knownRevisionSchema,
  })
  .strict();
export type BrowserClickInput = z.infer<typeof browserClickInputSchema>;

export const browserFillInputSchema = z
  .object({
    tabId: tabIdSchema,
    ref: z.string().min(1).max(128),
    value: z.string().max(200_000),
    confirmationId: confirmationIdSchema,
    knownRevision: knownRevisionSchema,
  })
  .strict();
export type BrowserFillInput = z.infer<typeof browserFillInputSchema>;

export const browserPressInputSchema = z
  .object({
    tabId: tabIdSchema,
    key: z.string().min(1).max(100),
    confirmationId: confirmationIdSchema,
    knownRevision: knownRevisionSchema,
  })
  .strict();
export type BrowserPressInput = z.infer<typeof browserPressInputSchema>;

export const browserWaitInputSchema = z
  .object({
    tabId: tabIdSchema,
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    text: z.string().min(1).max(10_000).optional(),
    ref: z.string().min(1).max(128).optional(),
    knownRevision: knownRevisionSchema,
  })
  .strict()
  .refine((input) => input.text !== undefined || input.ref !== undefined || input.timeoutMs !== undefined, {
    message: "Provide timeoutMs, text, or ref.",
  });
export type BrowserWaitInput = z.infer<typeof browserWaitInputSchema>;

export const browserExtractionCompletionModeSchema = z.enum([
  "visible",
  "document",
  "document-and-safe-pagination",
]);
export type BrowserExtractionCompletionMode = z.infer<
  typeof browserExtractionCompletionModeSchema
>;

export const browserExtractionCompletenessSchema = z
  .object({
    status: z.enum(["complete", "partial"]),
    reason: z.enum([
      "targeted",
      "visible-only",
      "end-of-document",
      "pagination-end",
      "pagination-available",
      "scroll-limit",
      "page-limit",
      "byte-limit",
      "time-limit",
      "no-progress",
      "cycle",
      "unsafe-pagination",
      "virtualized-content",
    ]),
    mode: browserExtractionCompletionModeSchema,
    pages: z.number().int().min(1).max(100),
    scrolls: z.number().int().nonnegative().max(10_000),
    bytes: z.number().int().nonnegative(),
    paginationAvailable: z.boolean().optional(),
  })
  .strict();
export type BrowserExtractionCompleteness = z.infer<
  typeof browserExtractionCompletenessSchema
>;

export const browserExtractInputSchema = z
  .object({
    tabId: tabIdSchema,
    ref: z.string().min(1).max(128).optional(),
    selector: z.string().min(1).max(2_000).optional(),
    format: z.enum(["text", "html", "json"]).optional(),
    completion: browserExtractionCompletionModeSchema.optional(),
  })
  .strict();
export type BrowserExtractInput = z.infer<typeof browserExtractInputSchema>;
export const browserExtractResultSchema = z
  .object({
    tabId: tabIdSchema,
    format: z.enum(["text", "html", "json"]),
    value: z.unknown(),
    completeness: browserExtractionCompletenessSchema.optional(),
  })
  .strict();
export type BrowserExtractResult = z.infer<typeof browserExtractResultSchema>;

const browserSequenceStepSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("navigate"),
    url: z.url(),
    waitUntil: z.enum(["commit", "domcontentloaded", "load"]).optional(),
  }).strict(),
  z.object({
    action: z.literal("click"),
    ref: z.string().min(1).max(128),
    confirmationId: confirmationIdSchema,
  }).strict(),
  z.object({
    action: z.literal("fill"),
    ref: z.string().min(1).max(128),
    value: z.string().max(100_000),
  }).strict(),
  z.object({
    action: z.literal("press"),
    key: z.string().min(1).max(100),
    confirmationId: confirmationIdSchema,
  }).strict(),
  z.object({
    action: z.literal("wait"),
    timeoutMs: z.number().int().positive().max(120_000).optional(),
    text: z.string().min(1).max(10_000).optional(),
    ref: z.string().min(1).max(128).optional(),
  }).strict(),
  z.object({
    action: z.literal("extract"),
    ref: z.string().min(1).max(128).optional(),
    selector: z.string().min(1).max(2_000).optional(),
    format: z.enum(["text", "html", "json"]).optional(),
    completion: browserExtractionCompletionModeSchema.optional(),
  }).strict(),
]);
export const browserSequenceInputSchema = z
  .object({
    tabId: tabIdSchema,
    steps: z.array(browserSequenceStepSchema).min(1).max(20),
    finalSnapshot: z.boolean().optional(),
    knownRevision: knownRevisionSchema,
  })
  .strict()
  .superRefine((input, context) => {
    input.steps.forEach((step, index) => {
      if (
        step.action === "wait" &&
        step.timeoutMs === undefined &&
        step.text === undefined &&
        step.ref === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["steps", index],
          message: "A wait step requires timeoutMs, text, or ref.",
        });
      }
    });
  });
export type BrowserSequenceInput = z.infer<typeof browserSequenceInputSchema>;
export type BrowserSequenceStep = BrowserSequenceInput["steps"][number];
export const browserSequenceStepResultSchema = z
  .object({
    index: z.number().int().nonnegative(),
    action: z.enum(["navigate", "click", "fill", "press", "wait", "extract"]),
    completed: z.literal(true),
    value: z.unknown().optional(),
    completeness: browserExtractionCompletenessSchema.optional(),
  })
  .strict();
export const browserSequenceResultSchema = z
  .object({
    tabId: tabIdSchema,
    completed: z.literal(true),
    steps: z.array(browserSequenceStepResultSchema).max(20),
    snapshot: browserSnapshotResultSchema.optional(),
    state: browserStateUpdateSchema.optional(),
    timing: browserOperationTimingSchema.optional(),
  })
  .strict();
export type BrowserSequenceResult = z.infer<typeof browserSequenceResultSchema>;

const browserFrameNameSchema = z.string().min(1).max(200);
const browserFrameSelectorSchema = z.string().min(1).max(2_000);

export const browserFrameExtractInputSchema = z
  .object({
    tabId: tabIdSchema,
    frame: browserFrameNameSchema,
    selector: browserFrameSelectorSchema.optional(),
    format: z.enum(["text", "html", "json"]).optional(),
    completion: z.enum(["visible", "document"]).optional(),
  })
  .strict();
export type BrowserFrameExtractInput = z.infer<typeof browserFrameExtractInputSchema>;

export const browserFrameExtractResultSchema = z
  .object({
    tabId: tabIdSchema,
    frame: browserFrameNameSchema,
    format: z.enum(["text", "html", "json"]),
    value: z.unknown(),
    completeness: browserExtractionCompletenessSchema.optional(),
  })
  .strict();
export type BrowserFrameExtractResult = z.infer<typeof browserFrameExtractResultSchema>;

export const browserFrameClickInputSchema = z
  .object({
    tabId: tabIdSchema,
    frame: browserFrameNameSchema,
    selector: browserFrameSelectorSchema.optional(),
    text: z.string().min(1).max(500).optional(),
    match: z.enum(["exact", "contains"]).optional(),
    index: z.number().int().nonnegative().optional(),
    confirmationId: confirmationIdSchema,
    knownRevision: knownRevisionSchema,
  })
  .strict()
  .refine((input) => input.selector !== undefined || input.text !== undefined, {
    message: "Provide selector or text.",
  });
export type BrowserFrameClickInput = z.infer<typeof browserFrameClickInputSchema>;

export const browserFrameFillInputSchema = z
  .object({
    tabId: tabIdSchema,
    frame: browserFrameNameSchema,
    selector: browserFrameSelectorSchema,
    value: z.string().max(200_000),
    confirmationId: confirmationIdSchema,
    knownRevision: knownRevisionSchema,
  })
  .strict();
export type BrowserFrameFillInput = z.infer<typeof browserFrameFillInputSchema>;

export const browserScreenshotInputSchema = z
  .object({
    tabId: tabIdSchema,
    fullPage: z.boolean().optional(),
  })
  .strict();
export type BrowserScreenshotInput = z.infer<typeof browserScreenshotInputSchema>;
export const browserScreenshotResultSchema = z
  .object({
    tabId: tabIdSchema,
    path: z.string().min(1).max(4_096),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserScreenshotResult = z.infer<typeof browserScreenshotResultSchema>;

export const browserTabActionInputSchema = z.object({ tabId: tabIdSchema }).strict();
export type BrowserTabActionInput = z.infer<typeof browserTabActionInputSchema>;

export const browserCloseTabInputSchema = z
  .object({
    tabId: tabIdSchema,
    confirmationId: confirmationIdSchema,
  })
  .strict();
export type BrowserCloseTabInput = z.infer<typeof browserCloseTabInputSchema>;

export const browserFinishTaskInputSchema = z
  .object({ taskId: taskIdSchema.optional() })
  .strict();
export type BrowserFinishTaskInput = z.infer<typeof browserFinishTaskInputSchema>;
export const browserFinishTaskResultSchema = z
  .object({
    completed: z.literal(true),
    taskId: taskIdSchema.optional(),
    closedTabs: z.number().int().nonnegative(),
    browserClosed: z.boolean(),
  })
  .strict();
export type BrowserFinishTaskResult = z.infer<typeof browserFinishTaskResultSchema>;

export const browserDownloadInputSchema = z
  .object({
    tabId: tabIdSchema,
    ref: z.string().min(1).max(128).optional(),
    url: z.url().optional(),
    confirmationId: confirmationIdSchema,
  })
  .strict()
  .refine((input) => input.ref !== undefined || input.url !== undefined, {
    message: "Provide ref or url.",
  });
export type BrowserDownloadInput = z.infer<typeof browserDownloadInputSchema>;
export const browserDownloadResultSchema = z
  .object({
    tabId: tabIdSchema,
    path: z.string().min(1).max(4_096),
    suggestedFilename: z.string().min(1).max(500).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type BrowserDownloadResult = z.infer<typeof browserDownloadResultSchema>;

export const browserUploadFileSchema = z
  .object({
    name: z.string().trim().min(1).max(255).regex(/^[^/\\\x00]+$/u),
    contentBase64: z.string().max(8 * 1024 * 1024),
    mimeType: z.string().trim().min(1).max(255).optional(),
  })
  .strict();
export type BrowserUploadFile = z.infer<typeof browserUploadFileSchema>;

export const browserUploadInputSchema = z
  .object({
    tabId: tabIdSchema,
    files: z.array(browserUploadFileSchema).min(1).max(10),
    triggerRef: z.string().min(1).max(128).optional(),
    inputRef: z.string().min(1).max(128).optional(),
    selector: z.string().min(1).max(2_000).optional(),
    confirmationId: confirmationIdSchema,
  })
  .strict()
  .superRefine((input, context) => {
    const names = new Set<string>();
    for (const [index, file] of input.files.entries()) {
      const normalized = file.name.toLocaleLowerCase("en-US");
      if (names.has(normalized)) {
        context.addIssue({
          code: "custom",
          path: ["files", index, "name"],
          message: "Upload file names must be unique.",
        });
      }
      names.add(normalized);
    }
  });
export type BrowserUploadInput = z.infer<typeof browserUploadInputSchema>;

export const browserUploadResultSchema = z
  .object({
    tabId: tabIdSchema,
    completed: z.literal(true),
    fileCount: z.number().int().positive(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type BrowserUploadResult = z.infer<typeof browserUploadResultSchema>;

export const browserActionResultSchema = z
  .object({
    tabId: tabIdSchema,
    completed: z.literal(true),
    state: browserStateUpdateSchema.optional(),
    timing: browserOperationTimingSchema.optional(),
  })
  .strict();
export type BrowserActionResult = z.infer<typeof browserActionResultSchema>;

export const browserConsoleLevelSchema = z.enum([
  "error",
  "warning",
  "info",
  "debug",
]);
export type BrowserConsoleLevel = z.infer<typeof browserConsoleLevelSchema>;

export const browserNetworkDetailSchema = z.enum([
  "request",
  "request-headers",
  "request-body",
  "response-headers",
  "response-body",
]);
export type BrowserNetworkDetail = z.infer<typeof browserNetworkDetailSchema>;

export const browserArtifactKindSchema = z.enum(["trace", "video", "pdf"]);
export type BrowserArtifactKind = z.infer<typeof browserArtifactKindSchema>;

export const browserDiagnosticTextSchema = z
  .object({
    text: z.string().max(4 * 1024 * 1024),
    truncated: z.boolean(),
    collectedAt: z.string().datetime(),
  })
  .strict();
export type BrowserDiagnosticText = z.infer<typeof browserDiagnosticTextSchema>;
export type BrowserDiagnosticTextResult = BrowserDiagnosticText;

export const browserArtifactSchema = z
  .object({
    kind: browserArtifactKindSchema,
    path: z.string().min(1).max(4_096),
    sizeBytes: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type BrowserArtifact = z.infer<typeof browserArtifactSchema>;

export const browserArtifactCollectionSchema = z
  .object({
    kind: browserArtifactKindSchema,
    files: z.array(browserArtifactSchema).max(5_000),
    totalBytes: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type BrowserArtifactCollection = z.infer<
  typeof browserArtifactCollectionSchema
>;

const browserNetworkFilterSchema = z
  .string()
  .max(500)
  .refine((value) => !/[\r\n\0]/.test(value), {
    message: "Browser network filter contains forbidden control characters.",
  })
  .refine((value) => {
    try {
      void new RegExp(value);
      return true;
    } catch {
      return false;
    }
  }, { message: "Browser network filter must be a valid regular expression." });

const browserArtifactFilenameSchema = z
  .string()
  .min(1)
  .max(180)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      !value.includes("..") &&
      !/[\r\n\0]/.test(value),
    { message: "Browser artifact filename must be a simple filename." },
  );

export const browserConsoleInputSchema = z
  .object({
    tabId: tabIdSchema,
    level: browserConsoleLevelSchema.optional(),
    clear: z.boolean().optional(),
  })
  .strict();
export type BrowserConsoleInput = z.infer<typeof browserConsoleInputSchema>;

export const browserConsoleResultSchema = browserDiagnosticTextSchema
  .extend({ tabId: tabIdSchema })
  .strict();
export type BrowserConsoleResult = z.infer<typeof browserConsoleResultSchema>;

export const browserNetworkListInputSchema = z
  .object({
    tabId: tabIdSchema,
    includeStatic: z.boolean().optional(),
    filter: browserNetworkFilterSchema.optional(),
    clear: z.boolean().optional(),
  })
  .strict();
export type BrowserNetworkListInput = z.infer<
  typeof browserNetworkListInputSchema
>;

export const browserNetworkInspectInputSchema = z
  .object({
    tabId: tabIdSchema,
    index: z.number().int().positive(),
    detail: browserNetworkDetailSchema.optional(),
  })
  .strict();
export type BrowserNetworkInspectInput = z.infer<
  typeof browserNetworkInspectInputSchema
>;

export const browserNetworkResultSchema = browserDiagnosticTextSchema
  .extend({ tabId: tabIdSchema })
  .strict();
export type BrowserNetworkResult = z.infer<typeof browserNetworkResultSchema>;

export const browserTraceInputSchema = z.object({ tabId: tabIdSchema }).strict();
export type BrowserTraceInput = z.infer<typeof browserTraceInputSchema>;

export const browserTraceStartResultSchema = z
  .object({
    tabId: tabIdSchema,
    active: z.literal(true),
  })
  .strict();
export type BrowserTraceStartResult = z.infer<
  typeof browserTraceStartResultSchema
>;

export const browserTraceStopResultSchema = browserArtifactCollectionSchema
  .extend({
    tabId: tabIdSchema,
    kind: z.literal("trace"),
  })
  .strict();
export type BrowserTraceStopResult = z.infer<
  typeof browserTraceStopResultSchema
>;

export const browserVideoStartInputSchema = z
  .object({
    tabId: tabIdSchema,
    filename: browserArtifactFilenameSchema.optional(),
    width: z.number().int().min(64).max(3_840).optional(),
    height: z.number().int().min(64).max(2_160).optional(),
  })
  .strict()
  .refine(
    (input) =>
      (input.width === undefined && input.height === undefined) ||
      (input.width !== undefined && input.height !== undefined),
    { message: "Browser video width and height must be provided together." },
  );
export type BrowserVideoStartInput = z.infer<
  typeof browserVideoStartInputSchema
>;

export const browserVideoStartResultSchema = z
  .object({
    tabId: tabIdSchema,
    path: z.string().min(1).max(4_096),
    active: z.literal(true),
  })
  .strict();
export type BrowserVideoStartResult = z.infer<
  typeof browserVideoStartResultSchema
>;

export const browserVideoStopInputSchema = browserTraceInputSchema;
export type BrowserVideoStopInput = BrowserTraceInput;

export const browserVideoStopResultSchema = browserArtifactSchema
  .extend({
    tabId: tabIdSchema,
    kind: z.literal("video"),
  })
  .strict();
export type BrowserVideoStopResult = z.infer<
  typeof browserVideoStopResultSchema
>;

export const browserPdfInputSchema = z
  .object({
    tabId: tabIdSchema,
    filename: browserArtifactFilenameSchema.optional(),
  })
  .strict();
export type BrowserPdfInput = z.infer<typeof browserPdfInputSchema>;

export const browserPdfResultSchema = browserArtifactSchema
  .extend({
    tabId: tabIdSchema,
    kind: z.literal("pdf"),
  })
  .strict();
export type BrowserPdfResult = z.infer<typeof browserPdfResultSchema>;

export const browserDiagnosticsInputSchema = z
  .object({
    tabId: tabIdSchema,
    consoleLevel: browserConsoleLevelSchema.optional(),
    includeStaticRequests: z.boolean().optional(),
    requestFilter: browserNetworkFilterSchema.optional(),
    clearAfterRead: z.boolean().optional(),
  })
  .strict();
export type BrowserDiagnosticsInput = z.infer<
  typeof browserDiagnosticsInputSchema
>;

export const browserDiagnosticsResultSchema = z
  .object({
    tabId: tabIdSchema,
    console: browserDiagnosticTextSchema,
    network: browserDiagnosticTextSchema,
    traceActive: z.boolean(),
    videoActive: z.boolean(),
    collectedAt: z.string().datetime(),
  })
  .strict();
export type BrowserDiagnosticsResult = z.infer<
  typeof browserDiagnosticsResultSchema
>;

export const browserOperationSchema = z.enum([
  "status",
  "connect",
  "tabs",
  "open",
  "openAuthorizedSite",
  "navigate",
  "snapshot",
  "click",
  "fill",
  "press",
  "wait",
  "extract",
  "sequence",
  "frameExtract",
  "frameClick",
  "frameFill",
  "profilePage",
  "domIndex",
  "frameSequence",
  "navigatePath",
  "screenshot",
  "goBack",
  "goForward",
  "closeTab",
  "finishTask",
  "download",
  "upload",
  "console",
  "networkList",
  "networkInspect",
  "traceStart",
  "traceStop",
  "videoStart",
  "videoStop",
  "pdf",
  "diagnostics",
]);
export type BrowserOperation = z.infer<typeof browserOperationSchema>;

export const browserOperationRequestSchema = z
  .object({
    operation: browserOperationSchema,
    input: z.unknown(),
  })
  .strict();
export type BrowserOperationRequest = z.infer<typeof browserOperationRequestSchema>;

export const browserOperationResponseSchema = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      result: z.unknown(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z
        .object({
          code: z.enum(errorCodes),
          message: z.string().min(1).max(2_000),
          lifecycle: operationLifecycleSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type BrowserOperationResponse = z.infer<typeof browserOperationResponseSchema>;

export const browserOperationInputSchemas = {
  status: browserStatusInputSchema,
  connect: browserConnectInputSchema,
  tabs: browserTabsInputSchema,
  open: browserOpenInputSchema,
  openAuthorizedSite: browserOpenAuthorizedSiteInputSchema,
  navigate: browserNavigateInputSchema,
  snapshot: browserSnapshotInputSchema,
  click: browserClickInputSchema,
  fill: browserFillInputSchema,
  press: browserPressInputSchema,
  wait: browserWaitInputSchema,
  extract: browserExtractInputSchema,
  sequence: browserSequenceInputSchema,
  frameExtract: browserFrameExtractInputSchema,
  frameClick: browserFrameClickInputSchema,
  frameFill: browserFrameFillInputSchema,
  profilePage: browserProfilePageInputSchema,
  domIndex: browserDomIndexInputSchema,
  frameSequence: browserFrameSequenceInputSchema,
  navigatePath: browserNavigatePathInputSchema,
  screenshot: browserScreenshotInputSchema,
  goBack: browserTabActionInputSchema,
  goForward: browserTabActionInputSchema,
  closeTab: browserCloseTabInputSchema,
  finishTask: browserFinishTaskInputSchema,
  download: browserDownloadInputSchema,
  upload: browserUploadInputSchema,
  console: browserConsoleInputSchema,
  networkList: browserNetworkListInputSchema,
  networkInspect: browserNetworkInspectInputSchema,
  traceStart: browserTraceInputSchema,
  traceStop: browserTraceInputSchema,
  videoStart: browserVideoStartInputSchema,
  videoStop: browserVideoStopInputSchema,
  pdf: browserPdfInputSchema,
  diagnostics: browserDiagnosticsInputSchema,
} as const;

export const browserOperationResultSchemas = {
  status: browserStatusResultSchema,
  connect: browserConnectResultSchema,
  tabs: browserTabsResultSchema,
  open: browserTabResultSchema,
  openAuthorizedSite: browserOpenAuthorizedSiteResultSchema,
  navigate: browserTabResultSchema,
  snapshot: browserSnapshotResultSchema,
  click: browserActionResultSchema,
  fill: browserActionResultSchema,
  press: browserActionResultSchema,
  wait: browserActionResultSchema,
  extract: browserExtractResultSchema,
  sequence: browserSequenceResultSchema,
  frameExtract: browserFrameExtractResultSchema,
  frameClick: browserActionResultSchema,
  frameFill: browserActionResultSchema,
  profilePage: browserProfilePageResultSchema,
  domIndex: browserDomIndexResultSchema,
  frameSequence: browserFrameSequenceResultSchema,
  navigatePath: browserNavigatePathResultSchema,
  screenshot: browserScreenshotResultSchema,
  goBack: browserTabResultSchema,
  goForward: browserTabResultSchema,
  closeTab: browserActionResultSchema,
  finishTask: browserFinishTaskResultSchema,
  download: browserDownloadResultSchema,
  upload: browserUploadResultSchema,
  console: browserConsoleResultSchema,
  networkList: browserNetworkResultSchema,
  networkInspect: browserNetworkResultSchema,
  traceStart: browserTraceStartResultSchema,
  traceStop: browserTraceStopResultSchema,
  videoStart: browserVideoStartResultSchema,
  videoStop: browserVideoStopResultSchema,
  pdf: browserPdfResultSchema,
  diagnostics: browserDiagnosticsResultSchema,
} as const;
