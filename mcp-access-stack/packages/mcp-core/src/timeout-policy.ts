import { z } from "zod";

export const QUICK_OPERATION_TIMEOUT_MS = 60_000;
export const MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS = 300_000;
export const MAX_BACKGROUND_OPERATION_TIMEOUT_MS = 86_400_000;
export const COMMAND_TERMINATION_GRACE_MS = 30_000;

export const operationTerminalReasonSchema = z.enum([
  "timeout",
  "cancelled",
  "client_disconnected",
  "upstream_timeout",
  "process_failed",
]);
export type OperationTerminalReason = z.infer<
  typeof operationTerminalReasonSchema
>;

export const operationTerminationLayerSchema = z.enum([
  "chatgpt_tool",
  "mcp_server",
  "gateway",
  "relay",
  "workspace_agent",
  "executor",
  "child_process",
  "http_client",
  "http_server",
  "websocket",
  "proxy",
  "background_task_manager",
  "external",
]);
export type OperationTerminationLayer = z.infer<
  typeof operationTerminationLayerSchema
>;

export const operationDeadlineSchema = z
  .object({
    requestedTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(MAX_BACKGROUND_OPERATION_TIMEOUT_MS),
    effectiveTimeoutMs: z.number().int().nonnegative(),
    deadlineAt: z.iso.datetime(),
  })
  .strict();
export type OperationDeadline = z.infer<typeof operationDeadlineSchema>;

export const operationLifecycleSchema = z
  .object({
    requestedTimeoutMs: operationDeadlineSchema.shape.requestedTimeoutMs,
    effectiveTimeoutMs: operationDeadlineSchema.shape.effectiveTimeoutMs,
    deadlineAt: operationDeadlineSchema.shape.deadlineAt,
    elapsedMs: z.number().int().nonnegative(),
    terminatedBy: operationTerminationLayerSchema.optional(),
    reason: operationTerminalReasonSchema.optional(),
    diagnostic: z.string().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.terminatedBy === undefined) !== (value.reason === undefined)) {
      context.addIssue({
        code: "custom",
        message: "terminatedBy and reason must be provided together.",
      });
    }
  });
export type OperationLifecycle = z.infer<typeof operationLifecycleSchema>;

export const synchronousTimeoutMsSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_SYNCHRONOUS_OPERATION_TIMEOUT_MS)
  .default(QUICK_OPERATION_TIMEOUT_MS);

export const routableCommandTimeoutMsSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_BACKGROUND_OPERATION_TIMEOUT_MS)
  .default(QUICK_OPERATION_TIMEOUT_MS);

export function createOperationDeadline(
  requestedTimeoutMs: number,
  upstream: OperationDeadline | undefined,
  now = Date.now(),
): OperationDeadline {
  const requested = Math.min(
    Math.max(1, Math.trunc(requestedTimeoutMs)),
    MAX_BACKGROUND_OPERATION_TIMEOUT_MS,
  );
  const requestedDeadline = now + requested;
  const upstreamDeadline = upstream
    ? Date.parse(upstream.deadlineAt)
    : Number.POSITIVE_INFINITY;
  const deadline = Math.min(
    requestedDeadline,
    Number.isFinite(upstreamDeadline) ? upstreamDeadline : requestedDeadline,
  );
  return operationDeadlineSchema.parse({
    requestedTimeoutMs: upstream?.requestedTimeoutMs ?? requested,
    effectiveTimeoutMs: Math.max(0, deadline - now),
    deadlineAt: new Date(deadline).toISOString(),
  });
}

export function remainingOperationTimeMs(
  deadline: OperationDeadline,
  now = Date.now(),
): number {
  const absoluteDeadline = Date.parse(deadline.deadlineAt);
  if (!Number.isFinite(absoluteDeadline)) return 0;
  return Math.max(0, absoluteDeadline - now);
}

export function createOperationLifecycle(
  deadline: OperationDeadline,
  startedAt: number,
  terminal?: {
    layer: OperationTerminationLayer;
    reason: OperationTerminalReason;
    diagnostic?: string;
  },
  now = Date.now(),
): OperationLifecycle {
  return operationLifecycleSchema.parse({
    ...deadline,
    elapsedMs: Math.max(0, now - startedAt),
    ...(terminal === undefined
      ? {}
      : {
          terminatedBy: terminal.layer,
          reason: terminal.reason,
          ...(terminal.diagnostic === undefined
            ? {}
            : {
                diagnostic: sanitizeOperationDiagnostic(
                  terminal.diagnostic,
                ),
              }),
        }),
  });
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(authorization\s*:\s*bearer\s+)[^\s]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key)(\s*[:=]\s*)[^\s,;]+/giu,
      "$1$2[REDACTED]",
    )
    .replace(
      /([?&](?:token|secret|password|api[_-]?key|access[_-]?key)=)[^&#\s]+/giu,
      "$1[REDACTED]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
      "[REDACTED_JWT]",
    )
    .replace(
      /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[^/\s?#]+(?:\.local|\.internal))(?::\d+)?(?:[/?#][^\s]*)?/giu,
      "[REDACTED_PRIVATE_URL]",
    )
    .replace(
      /https?:\/\/[^\s?#]+[?][^\s#]*/giu,
      (url) => `${url.split("?")[0] ?? "[REDACTED_URL]"}?[REDACTED_QUERY]`,
    )
    .replace(/\b[A-Za-z]:\\Users\\[^\\\s]+/gu, "%USERPROFILE%")
    .replace(/\/home\/[^/\s]+/gu, "%HOME%")
    .replace(/\S*\.runtime-private(?:[\\/]\S*)?/giu, "[REDACTED_PRIVATE_PATH]");
}

export function sanitizeOperationDiagnostic(value: string): string {
  return redactSensitiveText(value)
    .replace(/[\r\n\t]+/gu, " ")
    .trim()
    .slice(0, 500);
}
