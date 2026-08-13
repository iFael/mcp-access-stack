import {
  AppError,
  asAppError,
  COMMAND_TERMINATION_GRACE_MS,
  createOperationLifecycle,
  remainingOperationTimeMs,
  type OperationDeadline,
  type RelayCancellation,
  type RelayOperation,
  type RelayRequest,
  type RelayResponse,
} from "@vs-code-gpt/shared";
import type { LocalAgent } from "../local-agent.js";
import { dispatchRelayRequest } from "./request-dispatcher.js";
import {
  SynchronousShellConcurrency,
  type SynchronousShellLease,
} from "./synchronous-shell-concurrency.js";

export interface RequestExecutionLog {
  event: "agent_request_started" | "agent_request_completed";
  generation: number;
  requestId: string;
  operation: RelayOperation;
  durationMs?: number;
  status?: string;
  activeRequests: number;
  rssBytes: number;
  heapUsedBytes: number;
}

interface ActiveRequest {
  controller: AbortController;
  deadline: OperationDeadline;
  startedAt: number;
}

export interface AgentRequestExecutorOptions {
  maxConcurrentSynchronousShells?: number;
}

export class AgentRequestExecutor {
  private readonly activeRequests = new Map<string, ActiveRequest>();
  private readonly synchronousShells: SynchronousShellConcurrency;

  constructor(
    private readonly agent: LocalAgent,
    private readonly log?: (entry: RequestExecutionLog) => void,
    options: AgentRequestExecutorOptions = {},
  ) {
    this.synchronousShells = new SynchronousShellConcurrency(
      options.maxConcurrentSynchronousShells,
    );
  }

  get activeRequestCount(): number {
    return this.activeRequests.size;
  }

  async execute(
    request: RelayRequest,
    generation: number,
  ): Promise<RelayResponse> {
    const startedAt = Date.now();
    const remainingMs = remainingOperationTimeMs(request.deadline, startedAt);
    if (remainingMs <= 0) {
      return errorResponse(
        request.requestId,
        new AppError("AGENT_TIMEOUT", "Relay request deadline has expired.", {
          lifecycle: createOperationLifecycle(request.deadline, startedAt, {
            layer: "workspace_agent",
            reason: "timeout",
            diagnostic: "Workspace Agent received an expired relay deadline.",
          }),
        }),
      );
    }

    let shellLease: SynchronousShellLease | undefined;
    if (isSynchronousShellOperation(request.operation)) {
      try {
        const workspaceKey = this.agent.resolveWorkspaceConcurrencyKey(
          request.input.workspaceId,
        );
        shellLease = this.synchronousShells.acquire(
          workspaceKey,
          request.requestId,
        );
      } catch (error) {
        return errorResponse(request.requestId, asAppError(error));
      }
    }

    const controller = new AbortController();
    const watchdogMs = remainingMs + commandTerminationGraceMs(request.operation);
    const timeout = setTimeout(() => {
      controller.abort(
        new AppError("AGENT_TIMEOUT", "Relay request deadline has expired.", {
          lifecycle: createOperationLifecycle(request.deadline, startedAt, {
            layer: "workspace_agent",
            reason: "timeout",
            diagnostic: "Workspace Agent exhausted the remaining relay deadline.",
          }),
        }),
      );
    }, watchdogMs);
    timeout.unref();
    this.activeRequests.set(request.requestId, {
      controller,
      deadline: request.deadline,
      startedAt,
    });
    this.log?.({
      event: "agent_request_started",
      generation,
      requestId: request.requestId,
      operation: request.operation,
      ...runtimeMetrics(this.activeRequests.size),
    });

    try {
      const result = await dispatchRelayRequest(this.agent, request, {
        correlationId: request.requestId,
        deadline: request.deadline,
        signal: controller.signal,
      });
      this.log?.({
        event: "agent_request_completed",
        generation,
        requestId: request.requestId,
        operation: request.operation,
        durationMs: Date.now() - startedAt,
        status: "success",
        ...runtimeMetrics(this.activeRequests.size),
      });
      return {
        version: 1,
        type: "response",
        requestId: request.requestId,
        ok: true,
        result,
      };
    } catch (error) {
      const appError = asAppError(error);
      this.log?.({
        event: "agent_request_completed",
        generation,
        requestId: request.requestId,
        operation: request.operation,
        durationMs: Date.now() - startedAt,
        status: appError.code,
        ...runtimeMetrics(this.activeRequests.size),
      });
      return errorResponse(request.requestId, appError);
    } finally {
      clearTimeout(timeout);
      this.activeRequests.delete(request.requestId);
      shellLease?.release();
    }
  }

  cancel(cancellation: RelayCancellation): void {
    const active = this.activeRequests.get(cancellation.requestId);
    if (!active || active.controller.signal.aborted) return;
    const terminal = cancellationTerminal(cancellation.reason);
    active.controller.abort(
      new AppError(terminal.code, terminal.message, {
        lifecycle: createOperationLifecycle(
          active.deadline,
          active.startedAt,
          {
            layer: terminal.layer,
            reason: cancellation.reason,
            diagnostic: terminal.diagnostic,
          },
        ),
      }),
    );
  }

  abortAll(reason: string): void {
    for (const active of this.activeRequests.values()) {
      if (!active.controller.signal.aborted) {
        active.controller.abort(
          new AppError("AGENT_UNAVAILABLE", "The Agent relay connection was closed.", {
            lifecycle: createOperationLifecycle(
              active.deadline,
              active.startedAt,
              {
                layer: "websocket",
                reason: "client_disconnected",
                diagnostic: reason,
              },
            ),
          }),
        );
      }
    }
  }
}

function isSynchronousShellOperation(operation: RelayOperation): boolean {
  return operation === "runCommand" || operation === "runPowerShell";
}

function commandTerminationGraceMs(operation: RelayOperation): number {
  return operation === "runCommand" || operation === "runPowerShell"
    ? COMMAND_TERMINATION_GRACE_MS
    : 0;
}

function cancellationTerminal(
  reason: RelayCancellation["reason"],
): {
  code: "AGENT_TIMEOUT" | "OPERATION_CANCELLED";
  message: string;
  layer: "gateway" | "mcp_server" | "workspace_agent";
  diagnostic: string;
} {
  switch (reason) {
    case "upstream_timeout":
      return {
        code: "AGENT_TIMEOUT",
        message: "The upstream Gateway deadline expired.",
        layer: "gateway",
        diagnostic: "Gateway cancelled the active Agent request after its relay deadline expired.",
      };
    case "client_disconnected":
      return {
        code: "OPERATION_CANCELLED",
        message: "The MCP client disconnected before the operation completed.",
        layer: "mcp_server",
        diagnostic: "The upstream MCP request was disconnected while the Agent operation was active.",
      };
    case "cancelled":
      return {
        code: "OPERATION_CANCELLED",
        message: "The operation was cancelled before completion.",
        layer: "workspace_agent",
        diagnostic: "The active Agent request received an explicit cancellation.",
      };
  }
}

function errorResponse(requestId: string, error: AppError): RelayResponse {
  return {
    version: 1,
    type: "response",
    requestId,
    ok: false,
    error: error.toJSON(),
  };
}

function runtimeMetrics(activeRequests: number): Pick<
  RequestExecutionLog,
  "activeRequests" | "rssBytes" | "heapUsedBytes"
> {
  const memory = process.memoryUsage();
  return {
    activeRequests,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  };
}
