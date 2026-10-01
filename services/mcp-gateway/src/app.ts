import type {
  BrowserExecutor,
  RepositoryExecutor,
  SourceControlExecutor,
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
import type { GatewayConfig } from "./config.js";
import { BrowserWorkerClient } from "./browser/client.js";
import { createLogger } from "./logger.js";
import { createMcpServer } from "./mcp/server.js";
import { tryHandleLegacyBrowserFastPath } from "./mcp/browser-legacy-fast-path.js";
import {  McpOperationRegistry,
  createGatewayOperationContextFactory,
  createMcpCancellationScopeKey,
  createMcpOperationScopeKey,
  createMcpPrincipalKey,
  extractMcpCancellationNotifications,
  extractMcpToolCallRequestIds,
} from "./mcp/operation-registry.js";
import type { CompanionRepositoryBinder } from "./companion/internal-repository-tools.js";
import {
  createEdgeTrustedAuthenticationMiddleware,
  type EdgeTrustConfig,
} from "./edge/internal-trust.js";
import {
  createIpRateLimiter,
  createMcpRequestLifecycleMiddleware,
  createOriginMiddleware,
  createSubjectRateLimiter,
  type AuthenticatedRequest,
} from "./http/mcp-middleware.js";

export interface GatewayApplication {
  app: Express;
  logger: Logger;
  close(): Promise<void>;
}

export interface GatewayApplicationDependencies {
  logger?: Logger;
  browser?: BrowserExecutor;
  browserLiveFrame?: (
    input: { taskId: string; tabId: string; afterSeq: number; signal?: AbortSignal },
    context: { ownerScope: string },
  ) => Promise<{
    seq: number;
    data: string;
    width: number;
    height: number;
    capturedAt: number;
  } | null>;
  workspaceExecutor?: WorkspaceExecutor;
  sourceControlExecutor?: SourceControlExecutor;
  repositoryExecutor?: RepositoryExecutor;
  companionRepositoryBinder?: CompanionRepositoryBinder;
  workspaceReady?: () => boolean;
  edgeTrust?: EdgeTrustConfig;
}

export function createGatewayApplication(
  config: GatewayConfig,
  dependencies: GatewayApplicationDependencies = {},
): GatewayApplication {
  const logger = dependencies.logger ?? createLogger(config.logLevel);
  const workspaceExecutor = dependencies.workspaceExecutor;
  const sourceControlExecutor = dependencies.sourceControlExecutor;
  if (!workspaceExecutor) {
    throw new Error("An in-process workspace executor is required.");
  }
  if (!sourceControlExecutor) {
    throw new Error("An in-process source-control executor is required.");
  }
  if (!dependencies.edgeTrust) {
    throw new Error("Edge-trusted authentication requires an internal Edge trust assertion.");
  }
  const workspaceReady = dependencies.workspaceReady ?? (() => true);
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
    response.status(workspaceReady() ? 200 : 503).json({
      status: workspaceReady() ? "ready" : "workspace_backend_unavailable",
    }),
  );

  const edgeTrustedAuthMiddleware =
    createEdgeTrustedAuthenticationMiddleware(dependencies.edgeTrust);
  const mcpMiddlewares: RequestHandler[] = [
    express.json({
      limit: config.maxPayloadBytes,
      type: ["application/json", "application/*+json"],
    }),
    edgeTrustedAuthMiddleware,
    createIpRateLimiter(config),
    createSubjectRateLimiter(config),
  ];

  if (edgeTrustedAuthMiddleware && dependencies.browserLiveFrame) {
    app.get(
      "/_viewer/frame",
      edgeTrustedAuthMiddleware,
      async (request: AuthenticatedRequest, response) => {
        const userId = request.auth?.extra?.userId;
        const taskId = typeof request.query.taskId === "string" ? request.query.taskId : "";
        const tabId = typeof request.query.tabId === "string" ? request.query.tabId : "";
        const afterSeqText = typeof request.query.afterSeq === "string"
          ? request.query.afterSeq
          : "0";
        if (typeof userId !== "string" || !userId ||
            !taskId || taskId.length > 128 || !tabId || tabId.length > 128 ||
            !/^\d{1,16}$/u.test(afterSeqText) ||
            !Number.isSafeInteger(Number(afterSeqText))) {
          response.status(400).json({ error: "invalid_viewer_frame_request" });
          return;
        }
        try {
          const frame = await dependencies.browserLiveFrame!(
            {
              taskId,
              tabId,
              afterSeq: Number(afterSeqText),
              signal: request.signal,
            },
            { ownerScope: `user:${userId}` },
          );
          if (!frame) {
            response.status(204).end();
            return;
          }
          response.json(frame);
        } catch {
          response.status(404).json({ error: "view_unavailable" });
        }
      },
    );
  }

  app.use(config.mcpPath, createMcpRequestLifecycleMiddleware(logger));
  app.use(config.mcpPath, ...mcpMiddlewares);

  app.post(config.mcpPath, async (request: AuthenticatedRequest, response, next) => {
    request.mcpTransportMode = "stateless";
    const principalKey = createMcpPrincipalKey(request);
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

    const requestAbort = bindMcpHttpRequestAbort(request, response);
    const authenticatedUserId = request.auth?.extra?.userId;
    const operationContextFactory = createGatewayOperationContextFactory({
      registry: operationRegistry,
      principalKey,
      operationScopeKey,
      cancellationScopeKey,
      ...(typeof authenticatedUserId === "string"
        ? { ownerScopeKey: `user:${authenticatedUserId}` }
        : {}),
      ...(requestLifecycleId === undefined ? {} : { requestLifecycleId }),
      requestSignal: requestAbort.signal,
    });
    try {
      const handledByFastPath = await tryHandleLegacyBrowserFastPath({
        request,
        response,
        browser,
        auth: undefined,
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
    const server = createMcpServer({
      workspaceExecutor,
      sourceControlExecutor,
      ...(dependencies.repositoryExecutor === undefined ? {} : { repositoryExecutor: dependencies.repositoryExecutor }),
      ...(dependencies.companionRepositoryBinder === undefined ? {} : { companionRepositoryBinder: dependencies.companionRepositoryBinder }),
      ...(browser === undefined ? {} : { browser }),
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
    logger,
    close: async () => undefined,
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

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
