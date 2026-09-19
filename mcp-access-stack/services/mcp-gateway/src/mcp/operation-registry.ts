import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  createOperationDeadline,
  createOperationLifecycle,
  type ToolOperationContextFactory,
  type ToolOperationContextLease,
} from "@vs-code-gpt/shared";
import type { AuthenticatedRequest } from "../http/mcp-middleware.js";

type McpRequestId = string | number;

interface ActiveOperation {
  token: string;
  controller: AbortController;
}

interface PendingOperation {
  cancelled: boolean;
  reason?: string;
}

export interface McpOperationRegistration {
  signal: AbortSignal;
  release(): void;
}

export interface McpPendingOperationRegistration {
  release(): void;
}

export class McpOperationRegistry {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly cancellationTargets = new Map<string, Map<string, AbortController>>();
  private readonly pending = new Map<string, Map<string, PendingOperation>>();

  get size(): number {
    return this.active.size;
  }

  registerPending(
    cancellationScopeKey: string,
    requestId: McpRequestId,
    requestLifecycleId: string,
  ): McpPendingOperationRegistration {
    const key = operationKey(cancellationScopeKey, requestId);
    let pendingRequests = this.pending.get(key);
    if (!pendingRequests) {
      pendingRequests = new Map<string, PendingOperation>();
      this.pending.set(key, pendingRequests);
    }

    const pending: PendingOperation = { cancelled: false };
    pendingRequests.set(requestLifecycleId, pending);

    return {
      release: () => {
        const currentPending = this.pending.get(key);
        if (currentPending?.get(requestLifecycleId) !== pending) return;
        currentPending.delete(requestLifecycleId);
        if (currentPending.size === 0) {
          this.pending.delete(key);
        }
      },
    };
  }

  begin(
    operationScopeKey: string,
    requestId: McpRequestId,
    cancellationScopeKey = operationScopeKey,
    requestLifecycleId?: string,
  ): McpOperationRegistration {
    const key = operationKey(operationScopeKey, requestId);
    if (this.active.has(key)) {
      throw new AppError(
        "RELAY_PROTOCOL_ERROR",
        "A request with the same MCP request id is already active for this operation scope.",
      );
    }

    const token = randomUUID();
    const controller = new AbortController();
    this.active.set(key, { token, controller });

    const cancellationKey = operationKey(cancellationScopeKey, requestId);
    let targets = this.cancellationTargets.get(cancellationKey);
    if (!targets) {
      targets = new Map<string, AbortController>();
      this.cancellationTargets.set(cancellationKey, targets);
    }
    targets.set(token, controller);

    if (requestLifecycleId !== undefined) {
      const pendingRequests = this.pending.get(cancellationKey);
      const pending = pendingRequests?.get(requestLifecycleId);
      if (pending) {
        pendingRequests!.delete(requestLifecycleId);
        if (pendingRequests!.size === 0) {
          this.pending.delete(cancellationKey);
        }
        if (pending.cancelled) {
          controller.abort(pending.reason);
        }
      }
    }

    return {
      signal: controller.signal,
      release: () => {
        const current = this.active.get(key);
        if (current?.token === token) {
          this.active.delete(key);
          const currentTargets = this.cancellationTargets.get(cancellationKey);
          currentTargets?.delete(token);
          if (currentTargets?.size === 0) {
            this.cancellationTargets.delete(cancellationKey);
          }
        }
      },
    };
  }

  cancel(
    cancellationScopeKey: string,
    requestId: McpRequestId,
    reason?: string,
  ): boolean {
    const key = operationKey(cancellationScopeKey, requestId);
    let matched = false;

    const targets = this.cancellationTargets.get(key);
    if (targets && targets.size > 0) {
      for (const controller of targets.values()) {
        if (!controller.signal.aborted) {
          controller.abort(reason);
        }
      }
      matched = true;
    }

    const pendingRequests = this.pending.get(key);
    if (pendingRequests && pendingRequests.size > 0) {
      for (const pending of pendingRequests.values()) {
        pending.cancelled = true;
        if (reason === undefined) {
          delete pending.reason;
        } else {
          pending.reason = reason;
        }
      }
      matched = true;
    }

    return matched;
  }

  clear(): void {
    for (const operation of this.active.values()) {
      operation.controller.abort("gateway shutdown");
    }
    this.active.clear();
    this.cancellationTargets.clear();
    this.pending.clear();
  }
}

export interface GatewayOperationContextFactoryOptions {
  registry: McpOperationRegistry;
  principalKey: string;
  operationScopeKey: string;
  cancellationScopeKey: string;
  requestLifecycleId?: string;
  requestSignal: AbortSignal;
}

export function createGatewayOperationContextFactory(
  options: GatewayOperationContextFactoryOptions,
): ToolOperationContextFactory {
  return (extra, requestedTimeoutMs): ToolOperationContextLease => {
    const startedAt = Date.now();
    const deadline = createOperationDeadline(
      requestedTimeoutMs,
      undefined,
      startedAt,
    );
    const registration = options.registry.begin(
      options.operationScopeKey,
      extra.requestId,
      options.cancellationScopeKey,
      options.requestLifecycleId,
    );
    const controller = new AbortController();
    const subscriptions: Array<{
      signal: AbortSignal;
      listener: () => void;
    }> = [];

    const abort = (
      signal: AbortSignal,
      reason: "cancelled" | "client_disconnected",
      diagnostic: string,
    ): void => {
      if (controller.signal.aborted) return;
      if (signal.reason instanceof AppError) {
        controller.abort(signal.reason);
        return;
      }
      controller.abort(
        new AppError(
          "OPERATION_CANCELLED",
          reason === "cancelled"
            ? "The MCP request was cancelled by the client."
            : "The HTTP client disconnected before the MCP operation completed.",
          {
            lifecycle: createOperationLifecycle(deadline, startedAt, {
              layer: "mcp_server",
              reason,
              diagnostic,
            }),
          },
        ),
      );
    };

    const subscribe = (
      signal: AbortSignal,
      reason: "cancelled" | "client_disconnected",
      diagnostic: string,
    ): void => {
      const listener = (): void => abort(signal, reason, diagnostic);
      subscriptions.push({ signal, listener });
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    };

    subscribe(
      extra.signal,
      "cancelled",
      "The MCP SDK cancelled the active tool request.",
    );
    subscribe(
      registration.signal,
      "cancelled",
      "An MCP cancellation notification matched the active operation scope and request id.",
    );
    subscribe(
      options.requestSignal,
      "client_disconnected",
      "The inbound HTTP request ended before the tool operation completed.",
    );

    return {
      context: {
        signal: controller.signal,
        correlationId: String(extra.requestId),
        invocationId: randomUUID(),
        ownerScope: options.cancellationScopeKey,
        deadline,
      },
      release: () => {
        for (const subscription of subscriptions) {
          subscription.signal.removeEventListener(
            "abort",
            subscription.listener,
          );
        }
        registration.release();
      },
    };
  };
}

export function createMcpPrincipalKey(
  request: AuthenticatedRequest,
  options: { ignoreMcpSessionId?: boolean } = {},
): string {
  const subject = request.auth?.extra?.subject;
  const clientId = request.auth?.clientId;
  if (typeof subject === "string" || clientId) {
    return `identity:${sha256(`${String(subject ?? "")}:${clientId ?? ""}`)}`;
  }
  const token = request.auth?.token;
  if (token) {
    return `auth:${sha256(token)}`;
  }

  const openAiSubject = readOpaquePrincipalHeader(request, "x-openai-subject");
  const openAiSession = readOpaquePrincipalHeader(request, "x-openai-session");
  if (openAiSubject && openAiSession) {
    return `openai:${sha256(JSON.stringify([openAiSubject, openAiSession]))}`;
  }

  if (!options.ignoreMcpSessionId) {
    const mcpSessionId = readOpaquePrincipalHeader(request, "mcp-session-id");
    if (mcpSessionId) {
      return `session:${sha256(mcpSessionId)}`;
    }
  }

  const address = request.ip ?? request.socket.remoteAddress ?? "unknown";
  const userAgent = request.header("user-agent") ?? "unknown";
  return `anonymous:${sha256(`${address}:${userAgent}`)}`;
}

export function createMcpOperationScopeKey(
  request: AuthenticatedRequest,
  principalKey = createMcpPrincipalKey(request),
): string {
  const mcpSessionId = readOpaquePrincipalHeader(request, "mcp-session-id");
  if (mcpSessionId) {
    return `mcp-session:${sha256(JSON.stringify([principalKey, mcpSessionId]))}`;
  }

  const requestId = request.mcpRequestId;
  if (!requestId) {
    throw new AppError(
      "INTERNAL_ERROR",
      "The MCP request lifecycle id is unavailable.",
    );
  }
  return `request:${sha256(JSON.stringify([principalKey, requestId]))}`;
}

export function createMcpCancellationScopeKey(
  request: AuthenticatedRequest,
  principalKey = createMcpPrincipalKey(request),
): string {
  return createMcpSessionScopeKey(request, principalKey) ?? principalKey;
}

function createMcpSessionScopeKey(
  request: AuthenticatedRequest,
  principalKey: string,
): string | undefined {
  const mcpSessionId = readOpaquePrincipalHeader(request, "mcp-session-id");
  if (mcpSessionId) {
    return `mcp-session:${sha256(JSON.stringify([principalKey, mcpSessionId]))}`;
  }

  const openAiSubject = readOpaquePrincipalHeader(request, "x-openai-subject");
  const openAiSession = readOpaquePrincipalHeader(request, "x-openai-session");
  if (openAiSubject && openAiSession) {
    return `openai-session:${sha256(
      JSON.stringify([principalKey, openAiSubject, openAiSession]),
    )}`;
  }
  return undefined;
}

function readOpaquePrincipalHeader(
  request: AuthenticatedRequest,
  name: string,
): string | undefined {
  const value = request.header(name)?.trim();
  if (!value || value.length > 512) return undefined;
  for (const character of value) {
    const codePoint = character.charCodeAt(0);
    if (codePoint < 0x21 || codePoint > 0x7e || character === ",") {
      return undefined;
    }
  }
  return value;
}

export interface McpCancellationNotification {
  requestId: McpRequestId;
  reason?: string;
}

export function extractMcpCancellationNotifications(
  body: unknown,
): McpCancellationNotification[] {
  const messages = Array.isArray(body) ? body : [body];
  const notifications: McpCancellationNotification[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.method !== "notifications/cancelled") {
      continue;
    }
    const params = message.params;
    if (!isRecord(params)) continue;
    const requestId = params.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      continue;
    }
    notifications.push({
      requestId,
      ...(typeof params.reason === "string"
        ? { reason: params.reason.slice(0, 256) }
        : {}),
    });
  }
  return notifications;
}

export function extractMcpToolCallRequestIds(body: unknown): McpRequestId[] {
  const messages = Array.isArray(body) ? body : [body];
  const requestIds: McpRequestId[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (!isRecord(message) || message.method !== "tools/call") continue;
    const requestId = message.id;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      continue;
    }
    const key = `${typeof requestId}:${String(requestId)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    requestIds.push(requestId);
  }

  return requestIds;
}

function operationKey(principalKey: string, requestId: McpRequestId): string {
  return `${principalKey}:${sha256(`${typeof requestId}:${String(requestId)}`)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
