import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  AppError,
  BROWSER_OPERATION_TRACE_HEADER,
  createBrowserIdempotencyKey,
  createBrowserOperationTraceId,
  createBrowserOperationFingerprint,
  abortSignalError,
  createOperationDeadline,
  createOperationLifecycle,
  remainingOperationTimeMs,
  browserOperationResponseSchema,
  browserOperationResultSchemas,
  type BrowserClickInput,
  type BrowserCloseTabInput,
  type BrowserConnectInput,
  type BrowserConsoleInput,
  type BrowserDiagnosticsInput,
  type BrowserDownloadInput,
  type BrowserUploadInput,
  type BrowserExecutor,
  type BrowserExtractInput,
  type BrowserFillInput,
  type BrowserFinishTaskInput,
  type BrowserFrameClickInput,
  type BrowserFrameExtractInput,
  type BrowserFrameFillInput,
  type BrowserDomIndexInput,
  type BrowserFrameSequenceInput,
  type BrowserNavigatePathInput,
  type BrowserProfilePageInput,
  type BrowserNavigateInput,
  type BrowserNetworkInspectInput,
  type BrowserNetworkListInput,
  type BrowserOpenInput,
  type BrowserOpenAuthorizedSiteInput,
  type BrowserPdfInput,
  type BrowserOperation,
  type BrowserPressInput,
  type BrowserScreenshotInput,
  type BrowserSequenceInput,
  type BrowserSnapshotInput,
  type BrowserStatusInput,
  type BrowserTabActionInput,
  type BrowserTraceInput,
  type BrowserTabsInput,
  type BrowserVideoStartInput,
  type BrowserVideoStopInput,
  type BrowserWaitInput,
  type OperationContext,
} from "@vs-code-gpt/shared";

export interface BrowserWorkerClientOptions {
  url: URL;
  token: string;
  timeoutMs: number;
  maxPayloadBytes: number;
  logger?: Pick<Logger, "warn"> & Partial<Pick<Logger, "info">>;
}

export interface BrowserWorkerClientTiming {
  requestSerializeMs: number;
  fetchHeadersMs: number;
  responseReadMs: number;
  jsonParseMs: number;
  envelopeValidationMs: number;
  resultValidationMs: number;
  totalMs: number;
  requestBytes: number;
  responseBytes: number;
}

const browserWorkerClientTimingSymbol: unique symbol = Symbol(
  "browser-worker-client-timing",
);

export function readBrowserWorkerClientTiming(
  value: unknown,
): BrowserWorkerClientTiming | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  return (value as {
    [browserWorkerClientTimingSymbol]?: BrowserWorkerClientTiming;
  })[browserWorkerClientTimingSymbol];
}

/** Calls the isolated local browser worker over authenticated loopback HTTP. */
export class BrowserWorkerClient implements BrowserExecutor {
  private readonly operationsUrl: URL;

  constructor(private readonly options: BrowserWorkerClientOptions) {
    this.operationsUrl = new URL("/operations", options.url);
  }

  status(input: BrowserStatusInput, context?: OperationContext) {
    return this.call("status", input, context);
  }

  connect(input: BrowserConnectInput, context?: OperationContext) {
    return this.call("connect", input, context);
  }

  tabs(input: BrowserTabsInput, context?: OperationContext) {
    return this.call("tabs", input, context);
  }

  open(input: BrowserOpenInput, context?: OperationContext) {
    return this.call("open", input, context);
  }

  openAuthorizedSite(
    input: BrowserOpenAuthorizedSiteInput,
    context?: OperationContext,
  ) {
    return this.call("openAuthorizedSite", input, context);
  }

  navigate(input: BrowserNavigateInput, context?: OperationContext) {
    return this.call("navigate", input, context);
  }

  snapshot(input: BrowserSnapshotInput, context?: OperationContext) {
    return this.call("snapshot", input, context);
  }

  click(input: BrowserClickInput, context?: OperationContext) {
    return this.call("click", input, context);
  }

  fill(input: BrowserFillInput, context?: OperationContext) {
    return this.call("fill", input, context);
  }

  press(input: BrowserPressInput, context?: OperationContext) {
    return this.call("press", input, context);
  }

  wait(input: BrowserWaitInput, context?: OperationContext) {
    return this.call("wait", input, context);
  }

  extract(input: BrowserExtractInput, context?: OperationContext) {
    return this.call("extract", input, context);
  }

  sequence(input: BrowserSequenceInput, context?: OperationContext) {
    return this.call("sequence", input, context);
  }

  frameExtract(input: BrowserFrameExtractInput, context?: OperationContext) {
    return this.call("frameExtract", input, context);
  }

  frameClick(input: BrowserFrameClickInput, context?: OperationContext) {
    return this.call("frameClick", input, context);
  }

  frameFill(input: BrowserFrameFillInput, context?: OperationContext) {
    return this.call("frameFill", input, context);
  }

  profilePage(input: BrowserProfilePageInput, context?: OperationContext) {
    return this.call("profilePage", input, context);
  }

  domIndex(input: BrowserDomIndexInput, context?: OperationContext) {
    return this.call("domIndex", input, context);
  }

  frameSequence(input: BrowserFrameSequenceInput, context?: OperationContext) {
    return this.call("frameSequence", input, context);
  }

  navigatePath(input: BrowserNavigatePathInput, context?: OperationContext) {
    return this.call("navigatePath", input, context);
  }

  screenshot(input: BrowserScreenshotInput, context?: OperationContext) {
    return this.call("screenshot", input, context);
  }

  goBack(input: BrowserTabActionInput, context?: OperationContext) {
    return this.call("goBack", input, context);
  }

  goForward(input: BrowserTabActionInput, context?: OperationContext) {
    return this.call("goForward", input, context);
  }

  closeTab(input: BrowserCloseTabInput, context?: OperationContext) {
    return this.call("closeTab", input, context);
  }

  finishTask(input: BrowserFinishTaskInput, context?: OperationContext) {
    return this.call("finishTask", input, context);
  }

  download(input: BrowserDownloadInput, context?: OperationContext) {
    return this.call("download", input, context);
  }

  upload(input: BrowserUploadInput, context?: OperationContext) {
    return this.call("upload", input, context);
  }

  console(input: BrowserConsoleInput, context?: OperationContext) {
    return this.call("console", input, context);
  }

  networkList(input: BrowserNetworkListInput, context?: OperationContext) {
    return this.call("networkList", input, context);
  }

  networkInspect(input: BrowserNetworkInspectInput, context?: OperationContext) {
    return this.call("networkInspect", input, context);
  }

  traceStart(input: BrowserTraceInput, context?: OperationContext) {
    return this.call("traceStart", input, context);
  }

  traceStop(input: BrowserTraceInput, context?: OperationContext) {
    return this.call("traceStop", input, context);
  }

  videoStart(input: BrowserVideoStartInput, context?: OperationContext) {
    return this.call("videoStart", input, context);
  }

  videoStop(input: BrowserVideoStopInput, context?: OperationContext) {
    return this.call("videoStop", input, context);
  }

  pdf(input: BrowserPdfInput, context?: OperationContext) {
    return this.call("pdf", input, context);
  }

  diagnostics(input: BrowserDiagnosticsInput, context?: OperationContext) {
    return this.call("diagnostics", input, context);
  }

  private async call<T extends BrowserOperation>(
    operation: T,
    input: unknown,
    context?: OperationContext,
  ): Promise<ReturnType<(typeof browserOperationResultSchemas)[T]["parse"]>> {
    const startedAt = Date.now();
    const invocationId = context?.invocationId ?? randomUUID();
    const fingerprint = createBrowserOperationFingerprint(operation, input);
    const callId = context?.idempotencyKey
      ?? createBrowserIdempotencyKey(invocationId, fingerprint);
    const traceId = createBrowserOperationTraceId(invocationId, fingerprint);
    const deadline = context?.deadline
      ? createOperationDeadline(this.options.timeoutMs, context.deadline, startedAt)
      : createOperationDeadline(this.options.timeoutMs, undefined, startedAt);
    const controller = new AbortController();
    const timeoutError = new AppError(
      "BROWSER_WORKER_TIMEOUT",
      "The browser worker did not respond in time.",
      {
        lifecycle: createOperationLifecycle(deadline, startedAt, {
          layer: "http_client",
          reason: "upstream_timeout",
          diagnostic: "Gateway HTTP client exhausted the Browser Worker response deadline.",
        }),
      },
    );
    const remainingMs = remainingOperationTimeMs(deadline, startedAt);
    const timeout = setTimeout(
      () => controller.abort(timeoutError),
      Math.max(1, remainingMs),
    );
    timeout.unref();
    const onAbort = (): void => {
      controller.abort(context?.signal?.reason);
    };
    context?.signal?.addEventListener("abort", onAbort, { once: true });
    if (context?.signal?.aborted) onAbort();

    let requestSerializeMs = 0;
    let fetchHeadersMs = 0;
    let responseReadMs = 0;
    let jsonParseMs = 0;
    let envelopeValidationMs = 0;
    let resultValidationMs = 0;
    let requestBytes = 0;
    let responseBytes = 0;
    const timingStartedAt = performance.now();

    const currentTiming = (): BrowserWorkerClientTiming => ({
      requestSerializeMs: roundTiming(requestSerializeMs),
      fetchHeadersMs: roundTiming(fetchHeadersMs),
      responseReadMs: roundTiming(responseReadMs),
      jsonParseMs: roundTiming(jsonParseMs),
      envelopeValidationMs: roundTiming(envelopeValidationMs),
      resultValidationMs: roundTiming(resultValidationMs),
      totalMs: roundTiming(performance.now() - timingStartedAt),
      requestBytes,
      responseBytes,
    });

    this.options.logger?.info?.({
      event: "browser_worker_call_started",
      operation,
      traceId,
    });

    try {
      const requestSerializeStartedAt = performance.now();
      const requestBody = JSON.stringify({ operation, input });
      requestSerializeMs = performance.now() - requestSerializeStartedAt;
      requestBytes = Buffer.byteLength(requestBody, "utf8");
      if (requestBytes > this.options.maxPayloadBytes) {
        throw new AppError("LIMIT_EXCEEDED", "Browser worker request exceeds the payload limit.");
      }

      let response: Response;
      try {
        const fetchStartedAt = performance.now();
        response = await fetch(this.operationsUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.options.token}`,
            "content-type": "application/json",
            "x-browser-engine-protocol": "3",
            "x-mcp-call-id": callId,
            [BROWSER_OPERATION_TRACE_HEADER]: traceId,
            ...(context?.ownerScope === undefined
              ? {}
              : { "x-mcp-owner-scope": context.ownerScope }),
          },
          body: requestBody,
          signal: controller.signal,
        });
        fetchHeadersMs += performance.now() - fetchStartedAt;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          if (controller.signal.reason instanceof AppError) {
            throw controller.signal.reason;
          }
          if (context?.signal?.aborted) {
            throw abortSignalError(
              context.signal,
              "The browser operation was cancelled.",
            );
          }
          throw timeoutError;
        }
        throw new AppError("BROWSER_WORKER_UNAVAILABLE", "The browser worker is unavailable.", {
          cause: error,
        });
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > this.options.maxPayloadBytes) {
        throw new AppError("LIMIT_EXCEEDED", "Browser worker response exceeds the payload limit.");
      }
      const responseReadStartedAt = performance.now();
      const bytes = Buffer.from(await response.arrayBuffer());
      responseReadMs += performance.now() - responseReadStartedAt;
      responseBytes += bytes.byteLength;
      if (bytes.byteLength > this.options.maxPayloadBytes) {
        throw new AppError("LIMIT_EXCEEDED", "Browser worker response exceeds the payload limit.");
      }

      let body: unknown;
      try {
        const jsonParseStartedAt = performance.now();
        body = JSON.parse(bytes.toString("utf8"));
        jsonParseMs += performance.now() - jsonParseStartedAt;
      } catch (error) {
        throw new AppError("RELAY_PROTOCOL_ERROR", "The browser worker returned invalid JSON.", {
          cause: error,
        });
      }

      const envelopeValidationStartedAt = performance.now();
      const envelope = browserOperationResponseSchema.safeParse(body);
      envelopeValidationMs += performance.now() - envelopeValidationStartedAt;
      if (!envelope.success) {
        if (response.status === 401 || response.status === 403) {
          throw new AppError("AUTHENTICATION_FAILED", "Browser worker authentication failed.");
        }
        throw new AppError("RELAY_PROTOCOL_ERROR", "The browser worker returned an invalid response.");
      }
      if (!envelope.data.ok) {
        const appError = new AppError(
          envelope.data.error.code,
          envelope.data.error.message,
          {
            ...(envelope.data.error.lifecycle === undefined
              ? {}
              : { lifecycle: envelope.data.error.lifecycle }),
          },
        );
        throw attachBrowserWorkerClientTiming(appError, currentTiming());
      }
      const resultValidationStartedAt = performance.now();
      const result = browserOperationResultSchemas[operation].parse(
        envelope.data.result,
      ) as ReturnType<(typeof browserOperationResultSchemas)[T]["parse"]>;
      resultValidationMs += performance.now() - resultValidationStartedAt;
      const timing = currentTiming();
      this.options.logger?.info?.({
        event: "browser_worker_call_completed",
        operation,
        traceId,
        status: "success",
        durationMs: timing.totalMs,
      });
      return attachBrowserWorkerClientTiming(result, timing);
    } catch (error) {
      const timing = readBrowserWorkerClientTiming(error) ?? currentTiming();
      this.options.logger?.warn({
        event: "browser_worker_call_failed",
        operation,
        traceId,
        status: "error",
        failureLayer: classifyGatewayBrowserFailure(error),
        errorCode: browserErrorCode(error),
        durationMs: timing.totalMs,
      });
      if (readBrowserWorkerClientTiming(error)) throw error;
      throw attachBrowserWorkerClientTiming(error, timing);
    } finally {
      clearTimeout(timeout);
      context?.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function attachBrowserWorkerClientTiming<T>(
  value: T,
  timing: BrowserWorkerClientTiming,
): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return value;
  }
  Object.defineProperty(value, browserWorkerClientTimingSymbol, {
    value: timing,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return value;
}

type GatewayBrowserFailureLayer =
  | "gateway"
  | "transport_http"
  | "worker_executor"
  | "browser_context"
  | "policy"
  | "idempotency"
  | "worker_protocol";

function browserErrorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "INTERNAL_ERROR";
}

function classifyGatewayBrowserFailure(error: unknown): GatewayBrowserFailureLayer {
  if (!(error instanceof AppError)) return "gateway";
  if (error.code === "IDEMPOTENCY_KEY_CONFLICT") return "idempotency";
  if (error.code === "BROWSER_WORKER_UNAVAILABLE") return "transport_http";
  if (error.code === "RELAY_PROTOCOL_ERROR") return "worker_protocol";
  if ([
    "BROWSER_DISCONNECTED",
    "BROWSER_CONTEXT_RECOVERY_FAILED",
    "STALE_TAB_ID",
    "TAB_NOT_FOUND",
    "TAB_NOT_OWNED",
  ].includes(error.code)) {
    return "browser_context";
  }
  if ([
    "TASK_SCOPE_REQUIRED",
    "TASK_OWNERSHIP_MISMATCH",
    "TASK_SUSPENDED",
    "TASK_EXPIRED",
    "SITE_ACCESS_AUTHORIZATION_REQUIRED",
    "SITE_ACCESS_GRANT_EXPIRED",
    "SITE_NAVIGATION_BLOCKED",
    "SITE_PRODUCTION_BLOCKED",
    "NAVIGATION_BLOCKED",
    "TAB_PROTECTED",
    "ACTION_REQUIRES_CONFIRMATION",
    "ACTION_BLOCKED_BY_POLICY",
    "AUTHENTICATION_FAILED",
  ].includes(error.code)) {
    return "policy";
  }
  if (error.lifecycle?.terminatedBy === "http_client" || error.code === "OPERATION_CANCELLED") {
    return "gateway";
  }
  return "worker_executor";
}

function roundTiming(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
