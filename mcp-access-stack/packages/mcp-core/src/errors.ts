import {
  operationLifecycleSchema,
  type OperationLifecycle,
} from "./timeout-policy.js";

export const errorCodes = [
  "POLICY_INVALID",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_DISABLED",
  "PERMISSION_DENIED",
  "WRITE_NOT_ALLOWED",
  "SHELL_NOT_ALLOWED",
  "SHELL_FAILED",
  "SHELL_UNAVAILABLE",
  "COMMAND_CONFIRMATION_INVALID",
  "INVALID_PATH",
  "PATH_OUTSIDE_WORKSPACE",
  "PATH_OUTSIDE_ALLOWED_ROOTS",
  "BLOCKED_PATH",
  "FILE_NOT_FOUND",
  "NOT_A_FILE",
  "NOT_A_DIRECTORY",
  "FILE_TOO_LARGE",
  "INVALID_UTF8",
  "BINARY_FILE",
  "LIMIT_EXCEEDED",
  "NOT_GIT_REPOSITORY",
  "GIT_ERROR",
  "AUDIT_FAILED",
  "AGENT_UNAVAILABLE",
  "AGENT_BUSY",
  "AGENT_TIMEOUT",
  "OPERATION_CANCELLED",
  "RELAY_PROTOCOL_ERROR",
  "IDEMPOTENCY_KEY_CONFLICT",
  "EXECUTION_NOT_FOUND",
  "EXECUTION_STATE_INVALID",
  "EXECUTION_OUTCOME_UNKNOWN",
  "AUTHENTICATION_FAILED",
  "BROWSER_WORKER_UNAVAILABLE",
  "BROWSER_WORKER_TIMEOUT",
  "BROWSER_DISCONNECTED",
  "BROWSER_CONTEXT_RECOVERY_FAILED",
  "TASK_SCOPE_REQUIRED",
  "TASK_NOT_FOUND",
  "TASK_OWNERSHIP_MISMATCH",
  "TASK_SUSPENDED",
  "TASK_EXPIRED",
  "SITE_ACCESS_AUTHORIZATION_REQUIRED",
  "SITE_ACCESS_GRANT_EXPIRED",
  "SITE_NAVIGATION_BLOCKED",
  "SITE_POLICY_NOT_FOUND",
  "SITE_PRODUCTION_BLOCKED",
  "LOGIN_CREDENTIAL_UNAVAILABLE",
  "LOGIN_CREDENTIALS_INVALID",
  "LOGIN_INTERACTION_REQUIRED",
  "CREDENTIAL_BROKER_UNAVAILABLE",
  "CREDENTIAL_BROKER_PROTOCOL_MISMATCH",
  "CREDENTIAL_BROKER_ACCESS_DENIED",
  "BROWSER_CAPABILITY_UNSUPPORTED",
  "BROWSER_OPERATION_MODE_UNSUPPORTED",
  "FRAME_NOT_FOUND",
  "FRAME_NOT_READY",
  "FRAME_CROSS_ORIGIN",
  "LOCATOR_NOT_FOUND",
  "LOCATOR_AMBIGUOUS",
  "LOCATOR_LOW_CONFIDENCE",
  "NAVIGATION_TIMEOUT",
  "STATE_NOT_REACHED",
  "ACTION_BLOCKED_BY_POLICY",
  "CAPABILITY_UNSUPPORTED",
  "TAB_NOT_FOUND",
  "STALE_TAB_ID",
  "TAB_NOT_OWNED",
  "TAB_PROTECTED",
  "NAVIGATION_BLOCKED",
  "AUTHENTICATION_REQUIRED",
  "CAPTCHA_DETECTED",
  "ACTION_REQUIRES_CONFIRMATION",
  "BROWSER_CONFIRMATION_INVALID",
  "INVALID_ARGUMENT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export interface ErrorDetails {
  path?: string;
  policyRule?: string;
  operation?: string;
  reason?: string;
  safeAlternative?: string;
}

export interface SerializedError {
  code: ErrorCode;
  message: string;
  lifecycle?: OperationLifecycle;
  details?: ErrorDetails;
}

export interface AppErrorOptions extends ErrorOptions {
  lifecycle?: OperationLifecycle;
  details?: ErrorDetails;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly lifecycle: OperationLifecycle | undefined;
  readonly details: ErrorDetails | undefined;

  constructor(code: ErrorCode, message: string, options?: AppErrorOptions) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AppError";
    this.code = code;
    this.lifecycle = options?.lifecycle;
    this.details = options?.details;
  }

  toJSON(): SerializedError {
    return {
      code: this.code,
      message: this.message,
      ...(this.lifecycle === undefined
        ? {}
        : { lifecycle: operationLifecycleSchema.parse(this.lifecycle) }),
      ...(this.details === undefined ? {} : { details: { ...this.details } }),
    };
  }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError("INTERNAL_ERROR", "Unexpected internal error.", {
    cause: error,
  });
}

export function abortSignalError(
  signal: AbortSignal | undefined,
  fallbackMessage = "Operation was cancelled.",
): AppError {
  if (signal?.reason instanceof AppError) return signal.reason;
  return new AppError("OPERATION_CANCELLED", fallbackMessage);
}
