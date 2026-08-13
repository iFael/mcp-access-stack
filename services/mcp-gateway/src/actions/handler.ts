import {
  abortSignalError,
  AppError,
  asAppError,
  createOperationDeadline,
  createOperationLifecycle,
  MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
  QUICK_OPERATION_TIMEOUT_MS,
  type OperationContext,
} from "@vs-code-gpt/shared";
import type { RequestHandler } from "express";
import type { Logger } from "pino";
import type { ZodType } from "zod";
import type { GatewayActionsConfig } from "../config.js";
import type { GptActionConsole } from "./console/service.js";
import { sendActionError, type ActionRequest } from "./http.js";

type JsonObject = Record<string, unknown>;

interface ActionConsoleTracking {
  console: GptActionConsole;
  operation: string;
}

interface HttpOperationControl {
  context: OperationContext;
  dispose(): void;
}

export function trackConsole(
  consoleRegistry: GptActionConsole,
  operation: string,
): ActionConsoleTracking {
  return { console: consoleRegistry, operation };
}

export function createWorkspacePostHandler<
  TBody extends JsonObject & { workspaceId: string },
  TInput extends { workspaceId: string },
>(
  bodySchema: ZodType<TBody>,
  inputSchema: ZodType<TInput>,
  actions: GatewayActionsConfig,
  logger: Logger,
  execute: (input: TInput, context: OperationContext) => Promise<unknown>,
  tracking?: ActionConsoleTracking,
): RequestHandler {
  return createActionHandler(
    bodySchema,
    logger,
    async (body, context) => {
      assertWorkspaceAllowed(actions, body.workspaceId);
      return execute(inputSchema.parse(withoutConsoleRunId(body)), context);
    },
    tracking,
  );
}

export function createActionHandler<TInput>(
  schema: ZodType<TInput>,
  logger: Logger,
  execute: (input: TInput, context: OperationContext) => Promise<unknown>,
  tracking?: ActionConsoleTracking,
): RequestHandler {
  return async (request: ActionRequest, response) => {
    let runId: string | undefined;
    let operationSequence: number | undefined;
    let operationControl: HttpOperationControl | undefined;
    try {
      const input = schema.parse(request.body);
      operationControl = createHttpOperationControl(input, request, response);
      const reference = consoleReference(input);
      runId = reference.runId;
      operationSequence = tracking?.console.startOperation(
        runId,
        tracking.operation,
        reference.workspaceId,
      );
      const result = await withAbort(
        execute(input, operationControl.context),
        operationControl.context.signal,
      );
      if (tracking !== undefined) {
        try {
          tracking.console.completeOperation(
            runId,
            operationSequence,
            tracking.operation,
            result,
          );
        } catch (consoleError) {
          logConsoleTrackingFailure(logger, request, consoleError);
        }
      }
      response.json(result);
    } catch (error) {
      if (tracking !== undefined) {
        try {
          tracking.console.failOperation(
            runId,
            operationSequence,
            tracking.operation,
            error,
          );
        } catch (consoleError) {
          logConsoleTrackingFailure(logger, request, consoleError);
        }
      }
      sendActionError(request, response, logger, error);
    } finally {
      operationControl?.dispose();
    }
  };
}

export function withoutConsoleRunId(value: unknown): JsonObject {
  const record = value as JsonObject;
  const { runId: _runId, ...operationInput } = record;
  return operationInput;
}

export function assertWorkspaceAllowed(
  actions: GatewayActionsConfig,
  workspaceId: string,
): void {
  if (!actions.workspaceIds.some((allowedId) => allowedId === workspaceId)) {
    throw new AppError(
      "PERMISSION_DENIED",
      "Workspace is not available to this GPT Action.",
    );
  }
}

function createHttpOperationControl(
  input: unknown,
  request: ActionRequest,
  response: Parameters<RequestHandler>[1],
): HttpOperationControl {
  const startedAt = Date.now();
  const deadline = createOperationDeadline(
    requestedTimeoutMs(input),
    undefined,
    startedAt,
  );
  const controller = new AbortController();

  const abort = (error: AppError): void => {
    if (!controller.signal.aborted) controller.abort(error);
  };
  const onDisconnected = (): void => {
    abort(
      new AppError(
        "OPERATION_CANCELLED",
        "The GPT Actions HTTP client disconnected before completion.",
        {
          lifecycle: createOperationLifecycle(deadline, startedAt, {
            layer: "http_server",
            reason: "client_disconnected",
            diagnostic:
              "The inbound GPT Actions HTTP connection closed while the operation was active.",
          }),
        },
      ),
    );
  };
  const onResponseClose = (): void => {
    if (!response.writableEnded) onDisconnected();
  };
  request.once("aborted", onDisconnected);
  response.once("close", onResponseClose);

  const timer = setTimeout(() => {
    abort(
      new AppError("AGENT_TIMEOUT", "The GPT Actions request deadline expired.", {
        lifecycle: createOperationLifecycle(deadline, startedAt, {
          layer: "http_server",
          reason: "timeout",
          diagnostic:
            "The inbound GPT Actions request exceeded its effective synchronous deadline.",
        }),
      }),
    );
  }, deadline.effectiveTimeoutMs);
  timer.unref();

  return {
    context: {
      ...(request.actionRequestId === undefined
        ? {}
        : { correlationId: request.actionRequestId }),
      deadline,
      signal: controller.signal,
    },
    dispose: () => {
      clearTimeout(timer);
      request.removeListener("aborted", onDisconnected);
      response.removeListener("close", onResponseClose);
    },
  };
}

function requestedTimeoutMs(input: unknown): number {
  if (
    typeof input === "object" &&
    input !== null &&
    "timeoutMs" in input &&
    typeof input.timeoutMs === "number" &&
    Number.isFinite(input.timeoutMs)
  ) {
    return Math.min(
      Math.max(1, Math.trunc(input.timeoutMs)),
      MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
    );
  }
  return QUICK_OPERATION_TIMEOUT_MS;
}

function withAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  if (signal.aborted) {
    return Promise.reject(abortSignalError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortSignalError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function consoleReference(value: unknown): {
  runId?: string | undefined;
  workspaceId?: string | undefined;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as JsonObject;
  return {
    ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
    ...(typeof record.workspaceId === "string"
      ? { workspaceId: record.workspaceId }
      : {}),
  };
}

function logConsoleTrackingFailure(
  logger: Logger,
  request: ActionRequest,
  error: unknown,
): void {
  logger.warn({
    event: "gpt_action_console_tracking_failed",
    requestId: request.actionRequestId ?? null,
    code: asAppError(error).code,
  });
}
