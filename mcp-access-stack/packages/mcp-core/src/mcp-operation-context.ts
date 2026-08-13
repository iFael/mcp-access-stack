import { randomUUID } from "node:crypto";
import type { OperationContext } from "./contracts.js";
import { createOperationDeadline, QUICK_OPERATION_TIMEOUT_MS } from "./timeout-policy.js";

export interface McpToolRequestExtra {
  signal: AbortSignal;
  requestId: string | number;
}

export interface ToolOperationContextLease {
  context: OperationContext;
  release(): void;
}

export type ToolOperationContextFactory = (
  extra: McpToolRequestExtra,
  requestedTimeoutMs: number,
) => ToolOperationContextLease;

export function createToolOperationContextLease(
  factory: ToolOperationContextFactory | undefined,
  extra: McpToolRequestExtra,
  requestedTimeoutMs = QUICK_OPERATION_TIMEOUT_MS,
): ToolOperationContextLease {
  if (factory) {
    return factory(extra, requestedTimeoutMs);
  }
  return {
    context: {
      signal: extra.signal,
      ...(extra.requestId === undefined
        ? {}
        : { correlationId: String(extra.requestId) }),
      invocationId: randomUUID(),
      deadline: createOperationDeadline(requestedTimeoutMs, undefined),
    },
    release: () => undefined,
  };
}

export async function withToolOperationContext<T>(
  factory: ToolOperationContextFactory | undefined,
  extra: McpToolRequestExtra,
  requestedTimeoutMs: number,
  operation: (context: OperationContext) => Promise<T>,
): Promise<T> {
  const lease = createToolOperationContextLease(
    factory,
    extra,
    requestedTimeoutMs,
  );
  try {
    return await operation(lease.context);
  } finally {
    lease.release();
  }
}
