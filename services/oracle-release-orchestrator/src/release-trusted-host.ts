import type { ReleaseOrchestrator } from "./engine/release-orchestrator.js";
import type { ReleaseExecutionResult } from "./release-workflow-executor.js";
import type { ReleaseCapabilityRegistry } from "./release-capability-registry.js";
import type { ReleaseRunSnapshot } from "./types.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const PRINCIPAL = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

/** Provided exclusively by the authenticated MCP V3 host, not derived from a
 * user-controlled HTTP body or the Oracle read-channel bearer token. */
export interface TrustedReleasePrincipal {
  readonly workspaceId: string;
  readonly authenticatedActorId: string;
  readonly ownerScope: string;
}

export interface TrustedReleaseAdvanceInput {
  readonly runId: string;
  readonly expectedSourceSha: string;
  readonly expectedLastSeq: number;
  /** Signed caller operation identity, available to the host policy/audit. */
  readonly requestOperationId?: string;
}

export interface TrustedOracleReleaseHostOptions {
  readonly workspaceId: string;
  readonly capabilities: ReleaseCapabilityRegistry;
  /** Mandatory host policy. This callback must verify the authenticated
   * source-control/release gate independently of this ledger and its bearer. */
  readonly authorize: (
    principal: TrustedReleasePrincipal,
    input: TrustedReleaseAdvanceInput,
    snapshot: ReleaseRunSnapshot,
  ) => Promise<boolean>;
}

/**
 * In-process control of the EXISTING SQLite Oracle One-writer.
 *
 * No HTTP route, new token, extra database, arbitrary command execution,
 * scheduler or duplicate release executor is introduced. Only a trusted
 * caller holding this object and passing the external MCP V3 policy may
 * advance the canonical run. The GET-only Update Control surface stays GET.
 */
export function createTrustedOracleReleaseHost(
  orchestrator: ReleaseOrchestrator,
  options: TrustedOracleReleaseHostOptions,
): {
  advance(input: TrustedReleaseAdvanceInput, principal: TrustedReleasePrincipal): Promise<ReleaseExecutionResult>;
} {
  if (!options.workspaceId || typeof options.authorize !== "function") {
    throw new Error("ORACLE_TRUSTED_HOST_CONFIG_INVALID");
  }
  const activeRuns = new Set<string>();
  const executor = options.capabilities.ready
    ? options.capabilities.createExecutor(orchestrator) : null;

  function assertInput(input: TrustedReleaseAdvanceInput, principal: TrustedReleasePrincipal): void {
    if (!input || !UUID.test(input.runId) || !SHA.test(input.expectedSourceSha) ||
      !Number.isSafeInteger(input.expectedLastSeq) || input.expectedLastSeq < 0 ||
      (input.requestOperationId!==undefined && !UUID.test(input.requestOperationId)) ||
      !principal || principal.workspaceId !== options.workspaceId ||
      !PRINCIPAL.test(principal.authenticatedActorId) ||
      typeof principal.ownerScope !== "string" || !principal.ownerScope.trim() ||
      principal.ownerScope.length > 256) {
      throw new Error("ORACLE_TRUSTED_HOST_ARGUMENT_INVALID");
    }
  }
  function assertSnapshot(
    snapshot: ReleaseRunSnapshot, input: TrustedReleaseAdvanceInput,
  ): void {
    if (snapshot.runId !== input.runId ||
      snapshot.sourceCommitSha !== input.expectedSourceSha ||
      snapshot.lastSeq !== input.expectedLastSeq) {
      throw new Error("ORACLE_TRUSTED_HOST_EXPECTED_STATE_MISMATCH");
    }
  }

  return {
    async advance(input, principal) {
      assertInput(input, principal);
      if (!executor) throw new Error("RELEASE_CAPABILITY_INCOMPLETE");
      if (activeRuns.has(input.runId)) throw new Error("ORACLE_RELEASE_OPERATION_IN_PROGRESS");
      activeRuns.add(input.runId);
      try {
        const snapshot = orchestrator.getRun(input.runId);
        assertSnapshot(snapshot, input);
        // Denied authorization must not even start a planned release.
        if (!await options.authorize(principal, input, snapshot)) {
          throw new Error("ORACLE_TRUSTED_HOST_PERMISSION_DENIED");
        }
        // Compare-and-check again after asynchronous authorization: an
        // intervening caller must not inherit stale permission or state.
        assertSnapshot(orchestrator.getRun(input.runId), input);
        return await executor.advance(input.runId, principal.authenticatedActorId);
      } finally {
        activeRuns.delete(input.runId);
      }
    },
  };
}
