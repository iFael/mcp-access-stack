import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  asAppError,
  type OperationLifecycle,
} from "@vs-code-gpt/shared";
import type { Request, RequestHandler, Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { Logger } from "pino";
import { ZodError } from "zod";
import type { GatewayActionsConfig, GatewayConfig } from "../config.js";

export type ActionRequest = Request & { actionRequestId?: string };

interface ActionErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    lifecycle?: OperationLifecycle;
  };
}

export function createActionLifecycleMiddleware(logger: Logger): RequestHandler {
  return (request: ActionRequest, response, next) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    let finalized = false;
    request.actionRequestId = requestId;
    response.setHeader("x-action-request-id", requestId);

    logger.info({
      event: "gpt_action_request_started",
      requestId,
      method: request.method,
      path: request.path,
    });

    const finalize = (status: string): void => {
      if (finalized) return;
      finalized = true;
      logger.info({
        event: "gpt_action_request_completed",
        requestId,
        method: request.method,
        path: request.path,
        status,
        statusCode: response.statusCode,
        durationMs: Date.now() - startedAt,
      });
    };

    request.once("aborted", () => finalize("aborted"));
    response.once("finish", () => finalize("completed"));
    response.once("close", () => {
      if (!response.writableEnded) finalize("closed");
    });
    next();
  };
}

export function createActionAuthenticationMiddleware(
  actions: GatewayActionsConfig,
): RequestHandler {
  const expectedHash = Buffer.from(actions.tokenSha256, "hex");
  return (request: ActionRequest, response, next) => {
    const authorization = request.header("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      sendAuthenticationError(request, response);
      return;
    }
    const token = authorization.slice("Bearer ".length);
    const actualHash = createHash("sha256").update(token, "utf8").digest();
    if (
      actualHash.byteLength !== expectedHash.byteLength ||
      !timingSafeEqual(actualHash, expectedHash)
    ) {
      sendAuthenticationError(request, response);
      return;
    }
    next();
  };
}

export function createActionRateLimiter(config: GatewayConfig): RequestHandler {
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (request) =>
      ipKeyGenerator(request.ip ?? request.socket.remoteAddress ?? "unknown"),
    handler: (request: ActionRequest, response: Response<ActionErrorBody>) => {
      response.status(429).json({
        error: {
          code: "LIMIT_EXCEEDED",
          message: "GPT Actions rate limit exceeded.",
          requestId: request.actionRequestId ?? "unknown",
        },
      });
    },
  });
}

export function sendActionError(
  request: ActionRequest,
  response: Response<ActionErrorBody>,
  logger: Logger,
  error: unknown,
): void {
  if (response.headersSent || response.destroyed) {
    logger.warn({
      event: "gpt_action_error_response_skipped",
      requestId: request.actionRequestId ?? null,
      reason: "client_disconnected",
    });
    return;
  }
  if (error instanceof ZodError) {
    logger.warn({
      event: "gpt_action_request_rejected",
      requestId: request.actionRequestId ?? null,
      code: "INVALID_ARGUMENT",
    });
    response.status(400).json({
      error: {
        code: "INVALID_ARGUMENT",
        message: error.issues.map((issue) => issue.message).join("; "),
        requestId: request.actionRequestId ?? "unknown",
      },
    });
    return;
  }

  const appError = asAppError(error);
  logger.warn({
    event: "gpt_action_request_rejected",
    requestId: request.actionRequestId ?? null,
    code: appError.code,
    reason: appError.lifecycle?.reason ?? null,
    terminatedBy: appError.lifecycle?.terminatedBy ?? null,
  });
  response.status(statusForActionError(appError.code)).json({
    error: {
      code: appError.code,
      message: appError.message,
      requestId: request.actionRequestId ?? "unknown",
      ...(appError.lifecycle === undefined
        ? {}
        : { lifecycle: appError.lifecycle }),
    },
  });
}

export function statusForActionError(code: string): number {
  if (["AUTHENTICATION_FAILED", "AUTHENTICATION_REQUIRED"].includes(code)) return 401;
  if (
    [
      "PERMISSION_DENIED",
      "WRITE_NOT_ALLOWED",
      "SHELL_NOT_ALLOWED",
      "BLOCKED_PATH",
      "PATH_OUTSIDE_WORKSPACE",
      "PATH_OUTSIDE_ALLOWED_ROOTS",
    ].includes(code)
  ) {
    return 403;
  }
  if (["WORKSPACE_NOT_FOUND", "FILE_NOT_FOUND", "EXECUTION_NOT_FOUND"].includes(code)) {
    return 404;
  }
  if (
    [
      "COMMAND_CONFIRMATION_INVALID",
      "ACTION_REQUIRES_CONFIRMATION",
      "EXECUTION_STATE_INVALID",
    ].includes(code)
  ) {
    return 409;
  }
  if (["FILE_TOO_LARGE", "LIMIT_EXCEEDED"].includes(code)) return 413;
  if (code === "AGENT_BUSY") return 429;
  if (code === "OPERATION_CANCELLED") return 499;
  if (code === "AGENT_TIMEOUT") return 504;
  if (code === "AGENT_UNAVAILABLE") return 503;
  if (
    [
      "INVALID_ARGUMENT",
      "INVALID_PATH",
      "NOT_A_FILE",
      "NOT_A_DIRECTORY",
      "BINARY_FILE",
      "INVALID_UTF8",
      "NOT_GIT_REPOSITORY",
    ].includes(code)
  ) {
    return 400;
  }
  return 500;
}

function sendAuthenticationError(
  request: ActionRequest,
  response: Response<ActionErrorBody>,
): void {
  response.setHeader("WWW-Authenticate", 'Bearer realm="gpt-actions"');
  response.status(401).json({
    error: {
      code: "AUTHENTICATION_FAILED",
      message: "A valid GPT Actions API key is required.",
      requestId: request.actionRequestId ?? "unknown",
    },
  });
}
