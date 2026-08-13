import type { BrowserExecutor } from "@vs-code-gpt/shared";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import compression from "compression";
import express, {
  type Express,
  type NextFunction,
  type RequestHandler,
  type Response,
} from "express";
import helmet from "helmet";
import type { Logger } from "pino";
import { AgentRelay } from "./relay/service.js";
import {
  JwtAccessTokenVerifier,
  type AccessTokenVerifier,
} from "./auth/jwt-verifier.js";
import type { GatewayConfig } from "./config.js";
import { BrowserWorkerClient } from "./browser/client.js";
import { createLogger } from "./logger.js";
import { createMcpServer, type McpServerAuthOptions } from "./mcp/server.js";
import { tryHandleLegacyBrowserFastPath } from "./mcp/browser-legacy-fast-path.js";
import {
  McpOperationRegistry,
  createGatewayOperationContextFactory,
  createMcpPrincipalKey,
  extractMcpCancellationNotifications,
} from "./mcp/operation-registry.js";
import {
  createOwnerAuthenticationMiddleware,
  mountOwnerOAuth,
} from "./auth/owner-mount.js";
import { mountGptActions } from "./actions/service.js";
import {
  createAuthenticationMiddleware,
  createChallenge,
  createIpRateLimiter,
  createMcpRequestLifecycleMiddleware,
  createOriginMiddleware,
  createSubjectRateLimiter,
  isToolCall,
  type AuthenticatedRequest,
} from "./http/mcp-middleware.js";

export interface GatewayApplication {
  app: Express;
  relay: AgentRelay;
  logger: Logger;
  resourceMetadataUrl?: URL | undefined;
}

export interface GatewayApplicationDependencies {
  logger?: Logger;
  tokenVerifier?: AccessTokenVerifier;
  browser?: BrowserExecutor;
}

export function createGatewayApplication(
  config: GatewayConfig,
  dependencies: GatewayApplicationDependencies = {},
): GatewayApplication {
  const logger = dependencies.logger ?? createLogger(config.logLevel);
  const relay = new AgentRelay(
    {
      agentId: config.agent.id,
      tokenSha256: config.agent.tokenSha256,
      requestTimeoutMs: config.agent.requestTimeoutMs,
      heartbeatMs: config.agent.heartbeatMs,
      maxConcurrency: config.agent.maxConcurrency,
      maxPayloadBytes: config.agent.maxPayloadBytes,
      allowedOrigins: config.allowedOrigins,
    },
    logger,
  );
  const browser = dependencies.browser ?? (config.browserWorker
    ? new BrowserWorkerClient({
        url: config.browserWorker.url,
        token: config.browserWorker.token,
        timeoutMs: config.browserWorker.timeoutMs,
        maxPayloadBytes: config.browserWorker.maxPayloadBytes,
        logger,
      })
    : undefined);
  const operationRegistry = new McpOperationRegistry();
  const app = express();

  app.disable("x-powered-by");
  app.disable("etag");
  app.set("trust proxy", config.trustProxy === 0 ? false : config.trustProxy);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(compression({
    threshold: 16 * 1_024,
  }));
  app.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(createOriginMiddleware(config.allowedOrigins));

  app.get("/health/live", (_request, response) => response.json({ status: "live" }));
  app.get("/health/ready", (_request, response) =>
    response.status(relay.isConnected ? 200 : 503).json({
      status: relay.isConnected ? "ready" : "agent_disconnected",
    }),
  );

  if (config.authMode === "owner") {
    app.use(express.urlencoded({ extended: false }));
  }

  let resourceMetadataUrl: URL | undefined;
  let challenge: string | undefined;
  let mcpAuth: McpServerAuthOptions | undefined;
  let ownerChallenge: string | undefined;
  let ownerAuthMiddleware: RequestHandler | undefined;

  const mcpMiddlewares: RequestHandler[] = [
    express.json({
      limit: config.agent.maxPayloadBytes,
      type: ["application/json", "application/*+json"],
    }),
  ];

  if (config.authMode === "oauth") {
    const oauth = config.oauth;
    if (!oauth) {
      throw new Error("OAuth configuration is required when authMode is oauth.");
    }
    const mcpUrl = new URL(config.mcpPath, config.publicBaseUrl);
    resourceMetadataUrl = new URL(
      `/.well-known/oauth-protected-resource${config.mcpPath}`,
      config.publicBaseUrl,
    );
    challenge = createChallenge(resourceMetadataUrl, oauth.requiredScope);
    mcpAuth = {
      requiredScope: oauth.requiredScope,
      resourceMetadataUrl,
    };
    const tokenVerifier =
      dependencies.tokenVerifier ?? new JwtAccessTokenVerifier(oauth);
    const protectedResourceMetadata = {
      resource: mcpUrl.href,
      authorization_servers: [oauth.issuer],
      scopes_supported: [oauth.requiredScope],
      resource_name: "VS Code - GPT",
    };
    app.get(
      [
        "/.well-known/oauth-protected-resource",
        `/.well-known/oauth-protected-resource${config.mcpPath}`,
      ],
      (_request, response) => response.json(protectedResourceMetadata),
    );
    mcpMiddlewares.push(createAuthenticationMiddleware(tokenVerifier, challenge));
  }

  if (config.authMode === "owner") {
    const ownerMount = mountOwnerOAuth(app, config);
    mcpAuth = {
      requiredScope: ownerMount.requiredScope,
      resourceMetadataUrl: ownerMount.resourceMetadataUrl,
    };
    ownerChallenge = ownerMount.challenge;
    resourceMetadataUrl = ownerMount.resourceMetadataUrl;
    ownerAuthMiddleware = createOwnerAuthenticationMiddleware(
      ownerMount.provider,
      ownerMount.challenge,
    );
    mcpMiddlewares.push(ownerAuthMiddleware);
  }

  mcpMiddlewares.push(createIpRateLimiter(config));
  if (config.authMode === "oauth") {
    mcpMiddlewares.push(createSubjectRateLimiter(config));
  }

  mountGptActions(app, config, relay, logger, browser);

  app.use(config.mcpPath, createMcpRequestLifecycleMiddleware(logger));
  app.use(config.mcpPath, ...mcpMiddlewares);

  app.post(config.mcpPath, async (request: AuthenticatedRequest, response, next) => {
    if ((challenge || ownerChallenge) && !request.auth && isToolCall(request.body)) {
      response.setHeader("WWW-Authenticate", challenge ?? ownerChallenge ?? "");
    }

    const principalKey = createMcpPrincipalKey(request);
    for (const cancellation of extractMcpCancellationNotifications(request.body)) {
      const matched = operationRegistry.cancel(
        principalKey,
        cancellation.requestId,
        cancellation.reason,
      );
      logger.info({
        event: "mcp_operation_cancellation_received",
        requestId: request.mcpRequestId ?? null,
        targetRequestIdType: typeof cancellation.requestId,
        matched,
      });
    }

    const requestAbort = bindMcpHttpRequestAbort(request, response);
    const operationContextFactory = createGatewayOperationContextFactory({
      registry: operationRegistry,
      principalKey,
      requestSignal: requestAbort.signal,
    });
    try {
      const handledByFastPath = await tryHandleLegacyBrowserFastPath({
        request,
        response,
        browser,
        auth: mcpAuth,
        operationContextFactory,
        requestSignal: requestAbort.signal,
      });
      if (handledByFastPath) {
        requestAbort.release();
        return;
      }
    } catch (error) {
      requestAbort.release();
      next(error);
      return;
    }
    const server = createMcpServer({
      relay,
      ...(browser === undefined ? {} : { browser }),
      auth: mcpAuth,
      operationContextFactory,
    });
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport as Transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      next(error);
    } finally {
      requestAbort.release();
      await server.close().catch(() => undefined);
    }
  });
  app.get(config.mcpPath, (_request, response) => response.status(405).json({ error: "method_not_allowed" }));
  app.delete(config.mcpPath, (_request, response) => response.status(405).json({ error: "method_not_allowed" }));

  app.use((error: unknown, request: AuthenticatedRequest, response: Response, _next: NextFunction) => {
    logger.error({
      event: "http_request_failed",
      requestId: request.mcpRequestId ?? null,
      reason: errorName(error),
    });
    if (response.headersSent) {
      response.end();
      return;
    }
    response.status(500).json({ error: "internal_error" });
  });

  return { app, relay, logger, resourceMetadataUrl };
}

function bindMcpHttpRequestAbort(
  request: AuthenticatedRequest,
  response: Response,
): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  let completed = false;
  const abort = (): void => {
    if (!completed && !controller.signal.aborted) {
      controller.abort("http client disconnected");
    }
  };
  const onFinish = (): void => {
    completed = true;
  };
  const onClose = (): void => {
    if (!response.writableEnded) abort();
  };

  request.once("aborted", abort);
  response.once("finish", onFinish);
  response.once("close", onClose);

  return {
    signal: controller.signal,
    release: () => {
      request.removeListener("aborted", abort);
      response.removeListener("finish", onFinish);
      response.removeListener("close", onClose);
    },
  };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
