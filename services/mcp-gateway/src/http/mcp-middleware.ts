import { BROWSER_LATENCY_ID_HEADER, BROWSER_LATENCY_RELAY_HEADER, BROWSER_LATENCY_CAPTURE_LIMIT, browserLatencyOperation, isBrowserLatencyOperation, latencyId } from "@mcp-access-stack/edge-protocol";
import { createHash, randomUUID } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { Logger } from "pino";
import type { GatewayConfig } from "../config.js";

export type AuthenticatedRequest = Request & {
  auth?: AuthInfo;
  mcpRequestId?: string;
  mcpLatency?: { requestId?: string; relayRequestId?: string; gatewayRequestId?: string; gatewayStartedAt?: number };
  mcpRequestStartedAt?: number;
  mcpBenchmarkTiming?: boolean;
  mcpTransportMode?: "stateless";
};

export function createMcpRequestLifecycleMiddleware(
  logger: Logger,
): RequestHandler {
  let admitted = 0;
  return (request: AuthenticatedRequest, response, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const receivedAt = Date.now();
    let finalized = false;
    const hasMcpSessionId = Boolean(request.header("mcp-session-id"));
    request.mcpRequestId = requestId;
    const rootId = latencyId(request.header(BROWSER_LATENCY_ID_HEADER));
    const relayId = latencyId(request.header(BROWSER_LATENCY_RELAY_HEADER));
    request.mcpLatency = { requestId: rootId ?? requestId, ...(relayId ? { relayRequestId: relayId } : {}), gatewayRequestId: requestId, gatewayStartedAt: startedAt };
    request.mcpRequestStartedAt = startedAt;
    request.mcpBenchmarkTiming =
      request.header("x-mcp-benchmark-timing") === "1";
    request.mcpTransportMode = "stateless";
    response.setHeader("x-mcp-request-id", requestId);

    const base = {
      requestId,
      method: request.method,
      path: request.path,
      hasMcpSessionId,
      hasLastEventId: Boolean(request.header("last-event-id")),
    };
    logger.info({ event: "mcp_http_request_started", ...base });

    const finalize = (event: string, status: string): void => {
      if (finalized) return;
      finalized = true;
      // The JSON parser runs after arrival logging. Admit once, using its parsed body;
      // the original arrival clocks and normal HTTP lifecycle logging stay intact.
      const operation = browserLatencyOperation(request.body);
      const captured = isBrowserLatencyOperation(operation) && admitted < BROWSER_LATENCY_CAPTURE_LIMIT;
      if (captured) admitted += 1;
      logger.info({
        event,
        ...base,
        ...(captured ? {
          operation,
          ...(rootId ? { latencyRequestId: rootId } : {}),
          ...(relayId ? { relayRequestId: relayId } : {}),
          receivedAt,
          latencyCaptureIndex: admitted,
          latencyCaptureLimit: BROWSER_LATENCY_CAPTURE_LIMIT,
        } : {}),
        mcpTransportMode: request.mcpTransportMode,
        status,
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
        headersSent: response.headersSent,
        ...(!captured || safeBytes(request.header("content-length")) === undefined ? {} : { requestBytes: safeBytes(request.header("content-length")) }),
        ...(!captured || safeBytes(String(response.getHeader?.("content-length") ?? "")) === undefined ? {} : { responseBytes: safeBytes(String(response.getHeader?.("content-length") ?? "")) }),
      });
    };

    request.once("aborted", () => finalize("mcp_http_request_aborted", "aborted"));
    response.once("finish", () => finalize("mcp_http_request_completed", "completed"));
    response.once("close", () => {
      if (!response.writableEnded) {
        finalize("mcp_http_connection_closed", "closed");
      }
    });
    next();
  };
}

function safeBytes(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,10}$/u.test(value)) return undefined;
  const bytes = Number(value); return Number.isSafeInteger(bytes) ? bytes : undefined;
}

export function createOriginMiddleware(
  allowedOrigins: ReadonlySet<string>,
): (request: Request, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    const origin = request.header("origin");
    if (allowedOrigins.size === 0 || !origin || allowedOrigins.has(origin)) {
      next();
      return;
    }
    response.status(403).json({ error: "origin_not_allowed" });
  };
}

export function createIpRateLimiter(config: GatewayConfig): RequestHandler {
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (request) =>
      ipKeyGenerator(request.ip ?? request.socket.remoteAddress ?? "unknown"),
    handler: (_request, response) =>
      response.status(429).json({ error: "rate_limit_exceeded" }),
  });
}

export function createSubjectRateLimiter(config: GatewayConfig): RequestHandler {
  return rateLimit({
    windowMs: config.rateLimit.windowMs,
    limit: config.rateLimit.max,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: (request) => !subjectFromRequest(request as AuthenticatedRequest),
    keyGenerator: (request) => {
      const subject = subjectFromRequest(request as AuthenticatedRequest) ?? "anonymous";
      return createHash("sha256").update(subject, "utf8").digest("hex");
    },
    handler: (_request, response) =>
      response.status(429).json({ error: "rate_limit_exceeded" }),
  });
}

function subjectFromRequest(request: AuthenticatedRequest): string | undefined {
  const subject = request.auth?.extra?.subject;
  return typeof subject === "string" ? subject : undefined;
}
