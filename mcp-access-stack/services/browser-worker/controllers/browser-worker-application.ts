import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError } from "zod";
import {
  abortSignalError,
  AppError,
  BROWSER_OPERATION_TRACE_HEADER,
  isBrowserOperationTraceId,
  asAppError,
  createBrowserOperationFingerprint,
  createOperationDeadline,
  createOperationLifecycle,
  browserOperationInputSchemas,
  browserOperationRequestSchema,
  browserOperationResultSchemas,
  type BrowserIdempotencyMetrics,
  type BrowserOperation,
  type OperationContext,
} from "@vs-code-gpt/shared";
import { BrowserAuditLogger } from "../infrastructure/browser-audit-log.js";
import {
  BrowserOperationTelemetry,
  type BrowserOperationalEvent,
  type BrowserOperationalFailureLayer,
} from "../infrastructure/browser-operation-telemetry.js";
import { BrowserOperationQueue } from "../services/browser-operation-queue.js";
import { BrowserIdempotencyRegistry } from "../services/browser-idempotency-registry.js";
import type { BrowserWorkerConfig } from "../config/browser-worker-config.js";
import { isBrowserAdvancedOperation } from "../policies/browser-operation-policy.js";
import type { BrowserRuntime } from "../services/browser-runtime.js";

export class BrowserWorkerApplication {
  private readonly audit: BrowserAuditLogger;
  private readonly operations: BrowserOperationQueue;
  private readonly idempotency: BrowserIdempotencyRegistry;
  private readonly telemetry: BrowserOperationTelemetry;

  constructor(
    private readonly config: BrowserWorkerConfig,
    private readonly runtime: BrowserRuntime,
    telemetry?: BrowserOperationTelemetry,
  ) {
    this.audit = new BrowserAuditLogger(config.runtimeDirectory);
    this.telemetry = telemetry ?? new BrowserOperationTelemetry(config.runtimeDirectory);
    this.operations = new BrowserOperationQueue(config.maxConcurrentTabs ?? 4);
    this.idempotency = new BrowserIdempotencyRegistry({
      ...(config.idempotencyTtlMs === undefined
        ? {}
        : { ttlMs: config.idempotencyTtlMs }),
      ...(config.idempotencyMaxEntries === undefined
        ? {}
        : { maxEntries: config.idempotencyMaxEntries }),
      onDisposition: (idempotencyDisposition) => {
        this.telemetry.record({
          event: "browser_idempotency_disposition",
          idempotencyDisposition,
        });
      },
    });
  }

  handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    response.setHeader("x-browser-engine-protocol", "3");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/health/live") {
      return json(response, 200, { status: "live" });
    }
    if (request.method === "GET" && url.pathname === "/health/ready") {
      const readiness = await this.runtime.readiness();
      return json(response, readiness.ready ? 200 : 503, readiness);
    }
    if (request.method !== "POST" || url.pathname !== "/operations") {
      return json(response, 404, { error: "not_found" });
    }
    if (!authenticate(request, this.config.token)) {
      response.setHeader("WWW-Authenticate", 'Bearer realm="browser-worker"');
      return json(response, 401, { error: "unauthorized" });
    }

    const startedAt = performance.now();
    const controller = new AbortController();
    const abortDisconnected = (): void => {
      if (!controller.signal.aborted) {
        controller.abort(new AppError(
          "OPERATION_CANCELLED",
          "Browser operation was cancelled because the HTTP client disconnected.",
        ));
      }
    };
    const abortClosedResponse = (): void => {
      if (!response.writableEnded) abortDisconnected();
    };
    request.once("aborted", abortDisconnected);
    response.once("close", abortClosedResponse);
    let operation: BrowserOperation | undefined;
    let tabId: string | undefined;
    let traceId: string | undefined;
    let executionStarted = false;
    let queueWaitOnFailureMs: number | undefined;
    let operationUnits = 1;
    try {
      const body = await readJson(request, this.config.maxPayloadBytes);
      const { operation: activeOperation, input: parsedInput } = parseOperation(body);
      operation = activeOperation;
      traceId = browserOperationTraceId(request);
      tabId = typeof parsedInput.tabId === "string" ? parsedInput.tabId : undefined;
      operationUnits = countOperationUnits(activeOperation, parsedInput);
      this.telemetry.record({
        event: "browser_operation_started",
        ...(traceId === undefined ? {} : { traceId }),
        operation: activeOperation,
        status: "started",
        operationUnits,
        queueDepth: this.operations.queuedCount,
        ...observableScope(this.telemetry, parsedInput),
      });
      const callId = browserCallId(request);
      const ownerScope = browserOwnerScope(request);
      const idempotencyKey = isMutatingOperation(activeOperation)
        ? scopedBrowserCallId(ownerScope, callId)
        : undefined;
      const fingerprint = createBrowserOperationFingerprint(activeOperation, parsedInput);
      const timeoutMs = isBrowserAdvancedOperation(activeOperation)
        ? this.config.diagnosticTimeoutMs
        : this.config.operationTimeoutMs;
      const deadline = createOperationDeadline(timeoutMs, undefined);
      const context: OperationContext = {
        deadline,
        signal: controller.signal,
        ...(ownerScope === undefined ? {} : { ownerScope }),
      };
      const queueEnteredAt = performance.now();
      const queued = await this.telemetry.run(
        { ...(traceId === undefined ? {} : { traceId }), operation: activeOperation },
        () => withOperationTimeout(
          this.idempotency.run(
            idempotencyKey,
            fingerprint,
            () => this.operations.run(
              async () => {
                executionStarted = true;
                queueWaitOnFailureMs = Math.max(0, performance.now() - queueEnteredAt);
                const lease = typeof this.runtime.acquireOperationLease === "function"
                  ? this.runtime.acquireOperationLease(
                      activeOperation,
                      parsedInput,
                      context,
                    )
                  : { release: () => undefined };
                try {
                  return await execute(this.runtime, activeOperation, parsedInput, context);
                } finally {
                  lease.release();
                }
              },
              timeoutMs,
              controller.signal,
              operationQueueKey(activeOperation, parsedInput),
            ),
          ),
          deadline,
          controller,
        ),
      );
      const resultWithMetrics = attachIdempotencyMetrics(
        activeOperation,
        queued.value,
        this.idempotency.snapshot(),
      );
      const parsedResult = browserOperationResultSchemas[activeOperation].parse(
        attachQueueTiming(resultWithMetrics, queued.queueWaitMs),
      );
      const responseBody = { ok: true as const, result: parsedResult };
      assertJsonWithinLimit(
        responseBody,
        this.config.maxPayloadBytes,
        "Browser worker response exceeds the configured payload limit.",
      );
      const durationMs = elapsed(startedAt);
      this.telemetry.record({
        event: "browser_operation_completed",
        ...(traceId === undefined ? {} : { traceId }),
        operation: activeOperation,
        status: "allowed",
        durationMs,
        queueWaitMs: queued.queueWaitMs,
        operationUnits,
        ...observableScope(this.telemetry, parsedInput, parsedResult),
      });
      await this.audit.write({
        timestamp: new Date().toISOString(),
        operation: activeOperation,
        ...(tabId === undefined ? {} : { tabId }),
        status: "allowed",
        durationMs,
        queueWaitMs: queued.queueWaitMs,
        operationUnits,
      });
      await this.telemetry.flush();
      return json(response, 200, responseBody);
    } catch (error) {
      const abortReason = controller.signal.reason;
      const appError = abortReason instanceof AppError && abortReason.code === "BROWSER_WORKER_TIMEOUT"
        ? abortReason
        : error instanceof AppError
          ? error
          : controller.signal.aborted
            ? abortSignalError(controller.signal, "Browser operation was cancelled.")
            : asAppError(error);
      const durationMs = elapsed(startedAt);
      const status = isDenied(appError) ? "denied" : "error";
      if (operation !== undefined) {
        this.telemetry.record({
          event: "browser_operation_failed",
          ...(traceId === undefined ? {} : { traceId }),
          operation,
          status,
          reason: appError.code,
          failureLayer: classifyOperationalFailure(appError, executionStarted),
          durationMs,
          ...(queueWaitOnFailureMs === undefined
            ? {}
            : { queueWaitMs: queueWaitOnFailureMs }),
          operationUnits,
        });
      }
      await this.audit
        .write({
          timestamp: new Date().toISOString(),
          operation: operation ?? "unknown",
          ...(tabId === undefined ? {} : { tabId }),
          status,
          reason: appError.code,
          durationMs,
          operationUnits,
        })
        .catch(() => undefined);
      await this.telemetry.flush();
      if (!response.destroyed && !response.writableEnded) {
        return json(response, statusFor(appError), { ok: false, error: appError.toJSON() });
      }
    } finally {
      request.removeListener("aborted", abortDisconnected);
      response.removeListener("close", abortClosedResponse);
    }
  };
}

function parseOperation(body: unknown): {
  operation: BrowserOperation;
  input: Record<string, unknown>;
} {
  try {
    const envelope = browserOperationRequestSchema.parse(body);
    return {
      operation: envelope.operation,
      input: browserOperationInputSchemas[envelope.operation].parse(
        envelope.input,
      ) as Record<string, unknown>,
    };
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(
        "INVALID_ARGUMENT",
        "Browser operation request is invalid.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function execute(
  runtime: BrowserRuntime,
  operation: BrowserOperation,
  input: Record<string, unknown>,
  context: OperationContext,
): Promise<unknown> {
  switch (operation) {
    case "status": return runtime.status(input as never);
    case "connect": return runtime.connect(input as never, context);
    case "tabs": return runtime.tabs(input as never, context);
    case "open": return runtime.open(input as never, context);
    case "openAuthorizedSite": return runtime.openAuthorizedSite(input as never, context);
    case "navigate": return runtime.navigate(input as never, context);
    case "snapshot": return runtime.snapshot(input as never, context);
    case "click": return runtime.click(input as never, context);
    case "fill": return runtime.fill(input as never, context);
    case "press": return runtime.press(input as never, context);
    case "wait": return runtime.wait(input as never, context);
    case "extract": return runtime.extract(input as never, context);
    case "sequence": return runtime.sequence(input as never, context);
    case "frameExtract": return runtime.frameExtract(input as never, context);
    case "frameClick": return runtime.frameClick(input as never, context);
    case "frameFill": return runtime.frameFill(input as never, context);
    case "profilePage": return runtime.profilePage(input as never, context);
    case "domIndex": return runtime.domIndex(input as never, context);
    case "frameSequence": return runtime.frameSequence(input as never, context);
    case "navigatePath": return runtime.navigatePath(input as never, context);
    case "screenshot": return runtime.screenshot(input as never);
    case "goBack": return runtime.goBack(input as never);
    case "goForward": return runtime.goForward(input as never);
    case "closeTab": return runtime.closeTab(input as never);
    case "finishTask": return runtime.finishTask(input as never, context);
    case "download": return runtime.download(input as never);
    case "upload": return runtime.upload(input as never);
    case "console": return runtime.console(input as never);
    case "networkList": return runtime.networkList(input as never);
    case "networkInspect": return runtime.networkInspect(input as never);
    case "traceStart": return runtime.traceStart(input as never);
    case "traceStop": return runtime.traceStop(input as never);
    case "videoStart": return runtime.videoStart(input as never);
    case "videoStop": return runtime.videoStop(input as never);
    case "pdf": return runtime.pdf(input as never);
    case "diagnostics": return runtime.diagnostics(input as never);
  }
}

function countOperationUnits(
  operation: BrowserOperation,
  input: Record<string, unknown>,
): number {
  if (!["sequence", "frameSequence"].includes(operation) || !Array.isArray(input.steps)) {
    return operation === "navigatePath" && Array.isArray(input.path)
      ? Math.max(1, input.path.length)
      : 1;
  }
  const finalSnapshot = input.finalSnapshot === true ? 1 : 0;
  return Math.max(1, input.steps.length + finalSnapshot);
}

function operationQueueKey(
  operation: BrowserOperation,
  input: Record<string, unknown>,
): string {
  const tabId = typeof input.tabId === "string" ? input.tabId : undefined;
  if (tabId) return `tab:${tabId}`;
  const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
  if (taskId) return `task:${taskId}`;
  return ["status", "tabs"].includes(operation)
    ? `read:${operation}`
    : "context";
}

function browserOwnerScope(request: IncomingMessage): string | undefined {
  const raw = request.headers["x-mcp-owner-scope"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && /^[A-Za-z0-9._:-]{1,256}$/.test(value)
    ? value
    : undefined;
}

function browserCallId(request: IncomingMessage): string | undefined {
  const raw = request.headers["x-mcp-call-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : undefined;
}

function browserOperationTraceId(request: IncomingMessage): string | undefined {
  const raw = request.headers[BROWSER_OPERATION_TRACE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && isBrowserOperationTraceId(value) ? value : undefined;
}

function observableScope(
  telemetry: BrowserOperationTelemetry,
  input: Record<string, unknown>,
  result?: unknown,
): Pick<
  BrowserOperationalEvent,
  "taskRef" | "tabRef" | "taskState" | "tabLifecycle" | "reusable" | "protected" | "sticky"
> {
  const resultRecord = isRecord(result) ? result : undefined;
  const tab = resultRecord && isRecord(resultRecord.tab) ? resultRecord.tab : undefined;
  const taskId = typeof input.taskId === "string"
    ? input.taskId
    : typeof tab?.taskId === "string"
      ? tab.taskId
      : typeof resultRecord?.taskId === "string"
        ? resultRecord.taskId
        : undefined;
  const tabId = typeof input.tabId === "string"
    ? input.tabId
    : typeof tab?.tabId === "string"
      ? tab.tabId
      : typeof resultRecord?.tabId === "string"
        ? resultRecord.tabId
        : undefined;
  return {
    ...(taskId === undefined ? {} : { taskRef: telemetry.reference("task", taskId) }),
    ...(tabId === undefined ? {} : { tabRef: telemetry.reference("tab", tabId) }),
    ...(taskId !== undefined && typeof resultRecord?.state === "string"
      ? { taskState: resultRecord.state }
      : {}),
    ...(typeof tab?.lifecycle === "string" ? { tabLifecycle: tab.lifecycle } : {}),
    ...(typeof tab?.reusable === "boolean" ? { reusable: tab.reusable } : {}),
    ...(typeof tab?.protected === "boolean" ? { protected: tab.protected } : {}),
    ...(typeof tab?.sticky === "boolean" ? { sticky: tab.sticky } : {}),
  };
}

function classifyOperationalFailure(
  error: AppError,
  executionStarted: boolean,
): BrowserOperationalFailureLayer {
  if (error.code === "IDEMPOTENCY_KEY_CONFLICT") return "idempotency";
  if (isDenied(error) || [
    "TASK_SCOPE_REQUIRED",
    "TASK_OWNERSHIP_MISMATCH",
    "TASK_SUSPENDED",
    "TASK_EXPIRED",
    "SITE_ACCESS_AUTHORIZATION_REQUIRED",
    "SITE_ACCESS_GRANT_EXPIRED",
  ].includes(error.code)) return "policy";
  if ([
    "BROWSER_DISCONNECTED",
    "BROWSER_CONTEXT_RECOVERY_FAILED",
    "STALE_TAB_ID",
    "TAB_NOT_OWNED",
  ].includes(error.code)) {
    return "browser_context";
  }
  if (!executionStarted && ["BROWSER_WORKER_TIMEOUT", "OPERATION_CANCELLED"].includes(error.code)) {
    return "queue";
  }
  return executionStarted ? "executor" : "http_server";
}

function scopedBrowserCallId(
  ownerScope: string | undefined,
  callId: string | undefined,
): string | undefined {
  if (!callId) return undefined;
  return createHash("sha256")
    .update(`${ownerScope ?? "local"}\0${callId}`, "utf8")
    .digest("hex");
}

function attachIdempotencyMetrics(
  operation: BrowserOperation,
  result: unknown,
  metrics: BrowserIdempotencyMetrics,
): unknown {
  if (operation !== "status" && operation !== "connect") return result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return result;
  }
  return { ...result, idempotency: metrics };
}

function isMutatingOperation(operation: BrowserOperation): boolean {
  return ![
    "status",
    "tabs",
    "snapshot",
    "wait",
    "extract",
    "frameExtract",
    "profilePage",
    "domIndex",
    "console",
    "networkList",
    "networkInspect",
    "diagnostics",
  ].includes(operation);
}

function authenticate(request: IncomingMessage, expectedToken: string): boolean {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(value.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readJson(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new AppError("LIMIT_EXCEEDED", "Request body exceeds the browser worker limit.");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new AppError("INVALID_ARGUMENT", "Request body must be valid JSON.", { cause: error });
  }
}

async function withOperationTimeout<T>(
  task: Promise<T>,
  deadline: NonNullable<OperationContext["deadline"]>,
  controller: AbortController,
): Promise<T> {
  const startedAt = Date.now();
  const timeoutMs = Math.max(1, Date.parse(deadline.deadlineAt) - startedAt);
  let timer: NodeJS.Timeout | undefined;
  let removeAbortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(abortSignalError(controller.signal, "Browser operation was cancelled."));
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    timer = setTimeout(() => {
      const timeoutError = new AppError(
        "BROWSER_WORKER_TIMEOUT",
        "Browser worker operation exceeded the configured timeout.",
        {
          lifecycle: createOperationLifecycle(deadline, startedAt, {
            layer: "executor",
            reason: "timeout",
            diagnostic: "Browser Worker operation exceeded its configured execution timeout.",
          }),
        },
      );
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([task, interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

function assertJsonWithinLimit(
  body: unknown,
  maxBytes: number,
  message: string,
): void {
  const value = JSON.stringify(body);
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new AppError("LIMIT_EXCEEDED", message);
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function statusFor(error: AppError): number {
  if (error.code === "INVALID_ARGUMENT") return 400;
  if (["TASK_NOT_FOUND", "SITE_POLICY_NOT_FOUND"].includes(error.code)) return 404;
  if (error.code === "SITE_PRODUCTION_BLOCKED") return 403;
  if (error.code === "LIMIT_EXCEEDED") return 413;
  if (error.code === "OPERATION_CANCELLED") return 499;
  if ([
    "IDEMPOTENCY_KEY_CONFLICT",
    "TASK_SCOPE_REQUIRED",
    "TASK_OWNERSHIP_MISMATCH",
    "TASK_SUSPENDED",
    "TASK_EXPIRED",
    "SITE_ACCESS_AUTHORIZATION_REQUIRED",
    "SITE_ACCESS_GRANT_EXPIRED",
    "SITE_NAVIGATION_BLOCKED",
    "LOGIN_CREDENTIAL_UNAVAILABLE",
    "LOGIN_CREDENTIALS_INVALID",
    "LOGIN_INTERACTION_REQUIRED",
    "TAB_NOT_OWNED",
    "STALE_TAB_ID",
    "TAB_PROTECTED",
    "NAVIGATION_BLOCKED",
    "ACTION_REQUIRES_CONFIRMATION",
    "BROWSER_CAPABILITY_UNSUPPORTED",
    "BROWSER_OPERATION_MODE_UNSUPPORTED",
    "FRAME_NOT_FOUND",
    "FRAME_NOT_READY",
    "FRAME_CROSS_ORIGIN",
    "LOCATOR_NOT_FOUND",
    "LOCATOR_AMBIGUOUS",
    "LOCATOR_LOW_CONFIDENCE",
    "STATE_NOT_REACHED",
    "ACTION_BLOCKED_BY_POLICY",
    "CAPABILITY_UNSUPPORTED",
  ].includes(error.code)) return 409;
  if ([
    "BROWSER_DISCONNECTED",
    "BROWSER_CONTEXT_RECOVERY_FAILED",
    "BROWSER_WORKER_UNAVAILABLE",
  ].includes(error.code)) return 503;
  if (["BROWSER_WORKER_TIMEOUT", "NAVIGATION_TIMEOUT"].includes(error.code)) return 504;
  return 500;
}

function isDenied(error: AppError): boolean {
  return [
    "TAB_NOT_OWNED",
    "SITE_PRODUCTION_BLOCKED",
    "SITE_NAVIGATION_BLOCKED",
    "TAB_PROTECTED",
    "NAVIGATION_BLOCKED",
    "ACTION_REQUIRES_CONFIRMATION",
    "ACTION_BLOCKED_BY_POLICY",
    "BROWSER_CAPABILITY_UNSUPPORTED",
    "BROWSER_OPERATION_MODE_UNSUPPORTED",
  ].includes(error.code);
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round((performance.now() - startedAt) * 1000) / 1000);
}

function attachQueueTiming(value: unknown, queueMs: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  const timing = result.timing;
  if (!timing || typeof timing !== "object" || Array.isArray(timing)) {
    return value;
  }
  return {
    ...result,
    timing: {
      ...(timing as Record<string, unknown>),
      queueMs,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
