import { randomUUID } from "node:crypto";
import {
  AppError,
  BACKGROUND_WAIT_COMPLETION_GRACE_MS,
  COMMAND_TERMINATION_GRACE_MS,
  createAgentUnavailableDetails,
  createOperationDeadline,
  createOperationLifecycle,
  MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
  relayResultSchemas,
  remainingOperationTimeMs,
  type OperationContext,
  type RelayCancellation,
  type RelayOperation,
  type RelayRequest,
  type RelayResponse,
} from "@vs-code-gpt/shared";
import type { Logger } from "pino";

export interface RelayRequestSender {
  send(payload: string, callback: (error?: Error) => void): void;
}

export interface AgentRelayRequestManagerOptions {
  requestTimeoutMs: number;
  maxConcurrency: number;
  maxPayloadBytes: number;
  generation: () => number;
}

interface PendingRequest {
  operation: RelayOperation;
  generation: number;
  startedAt: number;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
  resolve: (value: unknown) => void;
  reject: (reason: AppError) => void;
}

export class AgentRelayRequestManager {
  private readonly pending = new Map<string, PendingRequest>();

  constructor(
    private readonly options: AgentRelayRequestManagerOptions,
    private readonly logger: Logger,
  ) {}

  get size(): number {
    return this.pending.size;
  }

  call(
    sender: RelayRequestSender,
    operation: RelayOperation,
    input: unknown,
    context: OperationContext = {},
  ): Promise<unknown> {
    if (this.pending.size >= this.options.maxConcurrency) {
      throw new AppError("AGENT_BUSY", "The local agent reached its concurrency limit.");
    }

    const requestId = randomUUID();
    const generation = this.options.generation();
    const deadline = context.deadline
      ? createOperationDeadline(
          MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS,
          context.deadline,
        )
      : createOperationDeadline(this.options.requestTimeoutMs, undefined);
    const request: RelayRequest = {
      version: 1,
      type: "request",
      requestId,
      deadline,
      operation,
      input: input as never,
    };
    const payload = JSON.stringify(request);
    if (Buffer.byteLength(payload) > this.options.maxPayloadBytes) {
      throw new AppError("RELAY_PROTOCOL_ERROR", "Relay request exceeds the payload limit.");
    }

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const remainingMs = remainingOperationTimeMs(deadline, startedAt);
      if (remainingMs <= 0) {
        reject(
          new AppError("AGENT_TIMEOUT", "The relay request deadline has expired.", {
            lifecycle: createOperationLifecycle(deadline, startedAt, {
              layer: "gateway",
              reason: "upstream_timeout",
              diagnostic: "Gateway received an already expired operation deadline.",
            }),
          }),
        );
        return;
      }

      const watchdogMs = remainingMs + operationCompletionGraceMs(operation);
      const timeout = setTimeout(() => {
        this.cancelPending(
          sender,
          requestId,
          "upstream_timeout",
          new AppError("AGENT_TIMEOUT", "The local agent did not respond in time.", {
            lifecycle: createOperationLifecycle(deadline, startedAt, {
              layer: "gateway",
              reason: "upstream_timeout",
              diagnostic: "Gateway relay deadline expired while awaiting the Workspace Agent.",
            }),
          }),
        );
      }, watchdogMs);
      timeout.unref();

      const onAbort = (): void => {
        const interruption = relayInterruption(
          context.signal,
          deadline,
          startedAt,
        );
        this.cancelPending(
          sender,
          requestId,
          interruption.reason,
          interruption.error,
        );
      };

      this.pending.set(requestId, {
        operation,
        generation,
        startedAt,
        timeout,
        ...(context.signal === undefined
          ? {}
          : { signal: context.signal, onAbort }),
        resolve,
        reject,
      });
      context.signal?.addEventListener("abort", onAbort, { once: true });

      this.logger.debug({
        event: "relay_request_started",
        requestId,
        operation,
        requestedTimeoutMs: deadline.requestedTimeoutMs,
        effectiveTimeoutMs: deadline.effectiveTimeoutMs,
        deadlineAt: deadline.deadlineAt,
        pendingRequests: this.pending.size,
        generation,
      });

      if (context.signal?.aborted) {
        onAbort();
        return;
      }

      sender.send(payload, (error) => {
        if (!error) return;
        const pending = this.takePending(requestId);
        if (!pending) return;
        pending.reject(
          new AppError("AGENT_UNAVAILABLE", "Relay request could not be sent.", {
            lifecycle: createOperationLifecycle(deadline, startedAt, {
              layer: "websocket",
              reason: "client_disconnected",
              diagnostic: "The relay WebSocket failed before the request was delivered.",
            }),
            details: createAgentUnavailableDetails(
              operation,
              "relay_send_failed",
              "unknown",
              generation,
            ),
          }),
        );
        this.logCompletion(requestId, operation, startedAt, "send_error");
      });
    });
  }

  complete(response: RelayResponse): void {
    const pending = this.takePending(response.requestId);
    if (!pending) {
      this.logger.debug({ event: "late_relay_response", requestId: response.requestId });
      return;
    }
    if (!response.ok) {
      pending.reject(
        new AppError(response.error.code, response.error.message, {
          ...(response.error.lifecycle === undefined
            ? {}
            : { lifecycle: response.error.lifecycle }),
          ...(response.error.details === undefined
            ? {}
            : { details: response.error.details }),
        }),
      );
      this.logCompletion(response.requestId, pending.operation, pending.startedAt, "error");
      return;
    }

    const result = relayResultSchemas[pending.operation].safeParse(response.result);
    if (!result.success) {
      pending.reject(new AppError("RELAY_PROTOCOL_ERROR", "The agent returned an invalid result."));
      this.logCompletion(response.requestId, pending.operation, pending.startedAt, "invalid_result");
      return;
    }
    pending.resolve(result.data);
    this.logCompletion(response.requestId, pending.operation, pending.startedAt, "success");
  }

  rejectAll(
    code: "AGENT_UNAVAILABLE",
    message: string,
    reason: "agent_disconnected" | "gateway_shutdown" = "agent_disconnected",
  ): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.takePending(requestId);
      if (!pending) continue;
      pending.reject(
        new AppError(code, message, {
          details: createAgentUnavailableDetails(
            pending.operation,
            reason,
            "unknown",
            pending.generation,
          ),
        }),
      );
    }
  }

  rejectGeneration(
    generation: number,
    code: "AGENT_UNAVAILABLE",
    message: string,
    reason: "agent_disconnected" = "agent_disconnected",
  ): void {
    for (const [requestId, candidate] of [...this.pending.entries()]) {
      if (candidate.generation !== generation) continue;
      const pending = this.takePending(requestId);
      if (!pending) continue;
      pending.reject(
        new AppError(code, message, {
          details: createAgentUnavailableDetails(
            pending.operation,
            reason,
            "unknown",
            pending.generation,
          ),
        }),
      );
    }
  }

  private cancelPending(
    sender: RelayRequestSender,
    requestId: string,
    reason: RelayCancellation["reason"],
    error: AppError,
  ): void {
    const pending = this.takePending(requestId);
    if (!pending) return;
    const cancellation: RelayCancellation = {
      version: 1,
      type: "cancel",
      requestId,
      reason,
    };
    sender.send(JSON.stringify(cancellation), () => undefined);
    pending.reject(error);
    this.logCompletion(requestId, pending.operation, pending.startedAt, reason);
  }

  private takePending(requestId: string): PendingRequest | undefined {
    const pending = this.pending.get(requestId);
    if (!pending) return undefined;
    clearTimeout(pending.timeout);
    pending.signal?.removeEventListener("abort", pending.onAbort!);
    this.pending.delete(requestId);
    return pending;
  }

  private logCompletion(
    requestId: string,
    operation: RelayOperation,
    startedAt: number,
    status: string,
  ): void {
    this.logger.info({
      event: "relay_request_completed",
      requestId,
      operation,
      durationMs: Date.now() - startedAt,
      status,
      generation: this.options.generation(),
      pendingRequests: this.pending.size,
    });
  }
}

function operationCompletionGraceMs(operation: RelayOperation): number {
  if (operation === "runCommand" || operation === "runPowerShell") {
    return COMMAND_TERMINATION_GRACE_MS;
  }
  return operation === "waitBackgroundTask"
    ? BACKGROUND_WAIT_COMPLETION_GRACE_MS
    : 0;
}

function relayInterruption(
  signal: AbortSignal | undefined,
  deadline: RelayRequest["deadline"],
  startedAt: number,
): { reason: RelayCancellation["reason"]; error: AppError } {
  const error = signal?.reason;
  if (error instanceof AppError) {
    const terminalReason = error.lifecycle?.reason;
    if (terminalReason === "timeout" || terminalReason === "upstream_timeout") {
      return { reason: "upstream_timeout", error };
    }
    if (terminalReason === "cancelled") {
      return { reason: "cancelled", error };
    }
    if (terminalReason === "client_disconnected") {
      return { reason: "client_disconnected", error };
    }
    return {
      reason: error.code === "AGENT_TIMEOUT" ? "upstream_timeout" : "cancelled",
      error,
    };
  }
  return {
    reason: "client_disconnected",
    error: new AppError(
      "OPERATION_CANCELLED",
      "The MCP or HTTP client disconnected before the operation completed.",
      {
        lifecycle: createOperationLifecycle(deadline, startedAt, {
          layer: "mcp_server",
          reason: "client_disconnected",
          diagnostic:
            "The upstream request ended before the relay operation completed.",
        }),
      },
    ),
  };
}
