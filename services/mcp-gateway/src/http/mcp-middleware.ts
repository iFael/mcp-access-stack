import { createHash, randomUUID } from "node:crypto";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { Logger } from "pino";
import {
  AuthenticationError,
  type AccessTokenVerifier,
} from "../auth/jwt-verifier.js";
import type { GatewayConfig } from "../config.js";

export type AuthenticatedRequest = Request & {
  auth?: AuthInfo;
  mcpRequestId?: string;
  mcpRequestStartedAt?: number;
  mcpBenchmarkTiming?: boolean;
};

export function createMcpRequestLifecycleMiddleware(logger: Logger): RequestHandler {
  return (request: AuthenticatedRequest, response, next) => {
    const requestId = randomUUID();
    const startedAt = performance.now();
    let finalized = false;
    request.mcpRequestId = requestId;
    request.mcpRequestStartedAt = startedAt;
    request.mcpBenchmarkTiming =
      request.header("x-mcp-benchmark-timing") === "1";
    response.setHeader("x-mcp-request-id", requestId);

    const base = {
      requestId,
      method: request.method,
      path: request.path,
      transportMode: "stateless-json",
      hasMcpSessionId: Boolean(request.header("mcp-session-id")),
      hasLastEventId: Boolean(request.header("last-event-id")),
    };
    logger.info({ event: "mcp_http_request_started", ...base });

    const finalize = (event: string, status: string): void => {
      if (finalized) return;
      finalized = true;
      logger.info({
        event,
        ...base,
        status,
        statusCode: response.statusCode,
        durationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
        headersSent: response.headersSent,
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

export function createAuthenticationMiddleware(
  verifier: AccessTokenVerifier,
  challenge: string,
): (request: AuthenticatedRequest, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    const header = request.header("authorization");
    if (!header) {
      next();
      return;
    }
    if (!header.startsWith("Bearer ") || header.length === "Bearer ".length) {
      response.setHeader("WWW-Authenticate", `${challenge}, error="invalid_token"`);
      response.status(401).json({ error: "invalid_token" });
      return;
    }
    void verifier.verify(header.slice("Bearer ".length)).then(
      (authInfo) => {
        request.auth = authInfo;
        next();
      },
      (error: unknown) => {
        const authenticationError =
          error instanceof AuthenticationError
            ? error
            : new AuthenticationError(401, "invalid_token");
        response.setHeader(
          "WWW-Authenticate",
          `${challenge}, error="${authenticationError.oauthError}"`,
        );
        response.status(authenticationError.status).json({
          error: authenticationError.oauthError,
        });
      },
    );
  };
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

export function createChallenge(resourceMetadataUrl: URL, scope: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl.href}", scope="${scope}"`;
}

export function isToolCall(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "method" in body &&
    body.method === "tools/call"
  );
}

function subjectFromRequest(request: AuthenticatedRequest): string | undefined {
  const subject = request.auth?.extra?.subject;
  return typeof subject === "string" ? subject : undefined;
}
