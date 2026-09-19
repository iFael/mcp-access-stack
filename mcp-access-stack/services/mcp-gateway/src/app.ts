import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type {
  BrowserExecutor,
  SourceControlExecutor,
  ToolOperationContextFactory,
  WorkspaceExecutor,
} from "@vs-code-gpt/shared";
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
import { RelayWorkspaceExecutor } from "./relay/workspace-executor.js";
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
  createMcpCancellationScopeKey,
  createMcpOperationScopeKey,
  createMcpPrincipalKey,
  extractMcpCancellationNotifications,
  extractMcpToolCallRequestIds,
} from "./mcp/operation-registry.js";
import {
  createOwnerAuthenticationMiddleware,
  mountOwnerOAuth,
} from "./auth/owner-mount.js";
import { mountGptActions } from "./actions/service.js";
import {
  createEdgeTrustedAuthenticationMiddleware,
  type EdgeTrustConfig,
} from "./edge/internal-trust.js";
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
  relay?: AgentRelay;
  logger: Logger;
  resourceMetadataUrl?: URL | undefined;
}

export interface GatewayApplicationDependencies {
  logger?: Logger;
  tokenVerifier?: AccessTokenVerifier;
  browser?: BrowserExecutor;
  workspaceExecutor?: WorkspaceExecutor;
  sourceControlExecutor?: SourceControlExecutor;
  workspaceReady?: () => boolean;
  edgeTrust?: EdgeTrustConfig;
}

export function createGatewayApplication(
  config: GatewayConfig,
  dependencies: GatewayApplicationDependencies = {},
): GatewayApplication {
  const logger = dependencies.logger ?? createLogger(config.logLevel);
  const relay = config.workspaceBackend.kind === "relay"
    ? new AgentRelay(
        {
          agentId: config.agent.id!,
          tokenSha256: config.agent.tokenSha256!,
          requestTimeoutMs: config.agent.requestTimeoutMs,
          heartbeatMs: config.agent.heartbeatMs,
          maxConcurrency: config.agent.maxConcurrency,
          maxPayloadBytes: config.agent.maxPayloadBytes,
          allowedOrigins: config.allowedOrigins,
        },
        logger,
      )
    : undefined;
  const relayExecutor = relay ? new RelayWorkspaceExecutor(relay) : undefined;
  const workspaceExecutor = dependencies.workspaceExecutor ?? relayExecutor;
  const sourceControlExecutor = dependencies.sourceControlExecutor ?? relayExecutor;
  if (!workspaceExecutor) {
    throw new Error("A workspace executor is required when the relay backend is disabled.");
  }
  if (!sourceControlExecutor) {
    throw new Error("A source-control executor is required when the relay backend is disabled.");
  }
  const workspaceReady = dependencies.workspaceReady ?? (() => relay?.isConnected ?? false);
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
  const statefulRequestContext =
    new AsyncLocalStorage<ToolOperationContextFactory>();
  type ExperimentalMcpSession = {
    principalKey: string;
    server: ReturnType<typeof createMcpServer>;
    transport: StreamableHTTPServerTransport;
  };
  const statefulSessions = new Map<string, ExperimentalMcpSession>();
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
    response.status(workspaceReady() ? 200 : 503).json({
      status: workspaceReady() ? "ready" : "workspace_backend_unavailable",
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

  if (config.authMode === "edge-trusted") {
    if (!dependencies.edgeTrust) {
      throw new Error("edge-trusted authentication requires an internal Edge trust assertion.");
    }
    mcpMiddlewares.push(createEdgeTrustedAuthenticationMiddleware(dependencies.edgeTrust));
  }

  mcpMiddlewares.push(createIpRateLimiter(config));
  if (config.authMode === "oauth" || config.authMode === "edge-trusted") {
    mcpMiddlewares.push(createSubjectRateLimiter(config));
  }

  const statefulOperationContextFactory: ToolOperationContextFactory = (
    extra,
    requestedTimeoutMs,
  ) => {
    const factory = statefulRequestContext.getStore();
    if (!factory) {
      throw new Error(
        "Stateful MCP operation context is unavailable for the current HTTP request.",
      );
    }
    return factory(extra, requestedTimeoutMs);
  };

  const createExperimentalMcpSession = async (
    principalKey: string,
  ): Promise<ExperimentalMcpSession> => {
    let session!: ExperimentalMcpSession;
    const server = createMcpServer({
      workspaceExecutor,
      sourceControlExecutor,
      ...(browser === undefined ? {} : { browser }),
      auth: mcpAuth,
      operationContextFactory: statefulOperationContextFactory,
    });
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        statefulSessions.set(sessionId, session);
      },
      onsessionclosed: (sessionId) => {
        statefulSessions.delete(sessionId);
      },
    });
    session = { principalKey, server, transport };
    await server.connect(transport as Transport);
    return session;
  };

  mountGptActions(app, config, workspaceExecutor, logger, browser);

  app.use(config.mcpPath, createMcpRequestLifecycleMiddleware(logger));
  app.use(config.mcpPath, ...mcpMiddlewares);

  app.post(config.mcpPath, async (request: AuthenticatedRequest, response, next) => {
    if ((challenge || ownerChallenge) && !request.auth && isToolCall(request.body)) {
      response.setHeader("WWW-Authenticate", challenge ?? ownerChallenge ?? "");
    }

    const requestedSessionId =
      config.mcpSessionMode === "stateful-experiment"
        ? readMcpSessionId(request)
        : undefined;
    const requestedSession =
      requestedSessionId === undefined
        ? undefined
        : statefulSessions.get(requestedSessionId);
    const principalKey =
      config.mcpSessionMode === "stateful-experiment"
        ? createMcpPrincipalKey(request, { ignoreMcpSessionId: true })
        : createMcpPrincipalKey(request);

    if (
      requestedSessionId !== undefined &&
      (requestedSession === undefined ||
        requestedSession.principalKey !== principalKey)
    ) {
      response.status(404).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "MCP session not found." },
      });
      return;
    }

    const operationScopeKey = createMcpOperationScopeKey(request, principalKey);
    const cancellationScopeKey = createMcpCancellationScopeKey(request, principalKey);
    const requestLifecycleId = request.mcpRequestId;
    const pendingRegistrations = requestLifecycleId === undefined
      ? []
      : extractMcpToolCallRequestIds(request.body).map((requestId) =>
          operationRegistry.registerPending(
            cancellationScopeKey,
            requestId,
            requestLifecycleId,
          ),
        );
    const releasePendingRegistrations = (): void => {
      for (const registration of pendingRegistrations) {
        registration.release();
      }
    };

    for (const cancellation of extractMcpCancellationNotifications(request.body)) {
      const matched = operationRegistry.cancel(
        cancellationScopeKey,
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

    if (
      config.mcpSessionMode === "stateful-experiment" &&
      requestedSessionId !== undefined &&
      requestedSession !== undefined &&
      isCancellationOnlyMcpBody(request.body)
    ) {
      releasePendingRegistrations();
      response.status(202).end();
      return;
    }

    const requestAbort = bindMcpHttpRequestAbort(request, response);
    const operationContextFactory = createGatewayOperationContextFactory({
      registry: operationRegistry,
      principalKey,
      operationScopeKey,
      cancellationScopeKey,
      ...(requestLifecycleId === undefined ? {} : { requestLifecycleId }),
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
        releasePendingRegistrations();
        requestAbort.release();
        return;
      }
    } catch (error) {
      releasePendingRegistrations();
      requestAbort.release();
      next(error);
      return;
    }
    if (config.mcpSessionMode === "stateful-experiment") {
      let session = requestedSession;
      let createdForRequest = false;
      try {
        if (!session) {
          session = await createExperimentalMcpSession(principalKey);
          createdForRequest = true;
        }
        await statefulRequestContext.run(operationContextFactory, () =>
          session!.transport.handleRequest(request, response, request.body),
        );
      } catch (error) {
        next(error);
      } finally {
        releasePendingRegistrations();
        requestAbort.release();
        if (createdForRequest && session?.transport.sessionId === undefined) {
          await session?.server.close().catch(() => undefined);
        }
      }
      return;
    }

    const server = createMcpServer({
      workspaceExecutor,
      sourceControlExecutor,
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
      releasePendingRegistrations();
      requestAbort.release();
      await server.close().catch(() => undefined);
    }
  });
  const handleExperimentalSessionRequest = async (
    request: AuthenticatedRequest,
    response: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (config.mcpSessionMode !== "stateful-experiment") {
      response.status(405).json({ error: "method_not_allowed" });
      return;
    }

    const sessionId = readMcpSessionId(request);
    if (!sessionId) {
      response.status(400).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: "Mcp-Session-Id is required." },
      });
      return;
    }
    const session = statefulSessions.get(sessionId);
    const principalKey = createMcpPrincipalKey(request, {
      ignoreMcpSessionId: true,
    });
    if (!session || session.principalKey !== principalKey) {
      response.status(404).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "MCP session not found." },
      });
      return;
    }

    try {
      await session.transport.handleRequest(request, response);
    } catch (error) {
      next(error);
    } finally {
      if (request.method === "DELETE") {
        statefulSessions.delete(sessionId);
        await session.server.close().catch(() => undefined);
      }
    }
  };

  app.get(config.mcpPath, handleExperimentalSessionRequest);
  app.delete(config.mcpPath, handleExperimentalSessionRequest);

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

  return {
    app,
    ...(relay === undefined ? {} : { relay }),
    logger,
    resourceMetadataUrl,
  };
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

function isCancellationOnlyMcpBody(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return (
    messages.length > 0 &&
    messages.every(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        (message as { method?: unknown }).method === "notifications/cancelled",
    )
  );
}

function readMcpSessionId(request: AuthenticatedRequest): string | undefined {
  const value = request.header("mcp-session-id")?.trim();
  return value ? value : undefined;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
