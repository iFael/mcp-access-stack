import type { RelayOperation } from "./contracts.js";
import type { ErrorDetails } from "./errors.js";

export const RETRYABLE_RELAY_OPERATIONS = [
  "listWorkspaces",
  "listWorkspaceRoots",
  "listFiles",
  "readFile",
  "readBinaryFile",
  "runValidation",
  "searchFiles",
  "inspectGit",
  "getWorkspaceContext",
  "getBackgroundTask",
  "waitBackgroundTask",
  "listBackgroundTasks",
  "readBackgroundTaskLogs",
] as const satisfies readonly RelayOperation[];

const retryableRelayOperations = new Set<RelayOperation>(RETRYABLE_RELAY_OPERATIONS);

export type AgentAvailabilityReason =
  | "agent_not_connected"
  | "relay_send_failed"
  | "agent_disconnected"
  | "gateway_shutdown"
  | "reconnect_timeout";

export type AgentAvailabilityOutcome = "not_started" | "unknown";

export function isRetryableRelayOperation(operation: RelayOperation): boolean {
  return retryableRelayOperations.has(operation);
}

export function createAgentUnavailableDetails(
  operation: RelayOperation,
  reason: AgentAvailabilityReason,
  outcome: AgentAvailabilityOutcome,
  connectionGeneration: number,
  retryAttempted = false,
): ErrorDetails {
  return {
    operation,
    reason,
    retryable: isRetryableRelayOperation(operation),
    retryAttempted,
    outcome,
    connectionGeneration,
  };
}
