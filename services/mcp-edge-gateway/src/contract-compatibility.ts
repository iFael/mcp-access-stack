import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol";
import { EDGE_MCP_CATALOG_METADATA } from "./generated/mcp-tool-manifest.js";

export const EXPECTED_MCP_CONTRACT_REVISION = EDGE_MCP_CATALOG_METADATA.contractRevision;
export const MCP_CONTRACT_ROLLOUT_STORAGE_KEY = "edge:mcp-contract-rollout:v1";

export type McpContractRolloutStateV1 = {
  version: 1;
  activeContractRevision: string;
  candidateContractRevision?: string;
  previousContractRevision?: string;
  preparedAt?: string;
  promotedAt?: string;
};

type PromotionResult =
  | { ok: true; state: McpContractRolloutStateV1; alreadyPromoted: boolean }
  | { ok: false; code: "build_contract_mismatch" | "active_contract_mismatch" | "candidate_contract_mismatch" | "candidate_not_ready" };

type RollbackResult =
  | { ok: true; state: McpContractRolloutStateV1; alreadyRolledBack: boolean }
  | { ok: false; code: "build_contract_mismatch" | "active_contract_mismatch" | "previous_contract_mismatch" | "previous_not_ready" };

const CONTRACT_REVISION_PATTERN = /^[0-9a-f]{64}$/u;

export function isMcpContractRevision(value: unknown): value is string {
  return typeof value === "string" && CONTRACT_REVISION_PATTERN.test(value);
}

export function isMcpContractRolloutState(value: unknown): value is McpContractRolloutStateV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<McpContractRolloutStateV1>;
  if (state.version !== 1 || !isMcpContractRevision(state.activeContractRevision)) return false;
  if (state.candidateContractRevision !== undefined &&
      (!isMcpContractRevision(state.candidateContractRevision) ||
       state.candidateContractRevision === state.activeContractRevision)) return false;
  if (state.previousContractRevision !== undefined &&
      (!isMcpContractRevision(state.previousContractRevision) ||
       state.previousContractRevision === state.activeContractRevision)) return false;
  return true;
}

export function reconcileMcpContractRolloutState(
  current: unknown,
  observedRuntimeRevision: string | undefined,
  now: string,
): { state: McpContractRolloutStateV1; changed: boolean } {
  if (isMcpContractRolloutState(current)) {
    if (current.candidateContractRevision !== undefined ||
        current.activeContractRevision === EXPECTED_MCP_CONTRACT_REVISION) {
      return { state: current, changed: false };
    }
    return {
      state: {
        ...current,
        candidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
        preparedAt: now,
      },
      changed: true,
    };
  }

  if (isMcpContractRevision(observedRuntimeRevision) &&
      observedRuntimeRevision !== EXPECTED_MCP_CONTRACT_REVISION) {
    return {
      state: {
        version: 1,
        activeContractRevision: observedRuntimeRevision,
        candidateContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
        preparedAt: now,
      },
      changed: true,
    };
  }

  return {
    state: {
      version: 1,
      activeContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
    },
    changed: true,
  };
}

export function isExpectedContractPrepared(state: McpContractRolloutStateV1): boolean {
  return state.activeContractRevision === EXPECTED_MCP_CONTRACT_REVISION ||
    state.candidateContractRevision === EXPECTED_MCP_CONTRACT_REVISION;
}

export function isConnectorContractCompatible(
  runtime: Pick<ConnectorRuntimeIdentity, "catalogContractRevision"> | undefined,
  state: McpContractRolloutStateV1 = {
    version: 1,
    activeContractRevision: EXPECTED_MCP_CONTRACT_REVISION,
  },
): boolean {
  const revision = runtime?.catalogContractRevision;
  if (!isMcpContractRevision(revision)) return false;
  return revision === state.activeContractRevision || revision === state.candidateContractRevision;
}

export function promoteMcpContractRolloutState(
  state: McpContractRolloutStateV1,
  expectedActiveContractRevision: string,
  expectedCandidateContractRevision: string,
  candidateReadyRevision: string | undefined,
  now: string,
): PromotionResult {
  if (expectedCandidateContractRevision !== EXPECTED_MCP_CONTRACT_REVISION) {
    return { ok: false, code: "build_contract_mismatch" };
  }
  if (state.activeContractRevision === expectedCandidateContractRevision &&
      state.candidateContractRevision === undefined) {
    return { ok: true, state, alreadyPromoted: true };
  }
  if (state.activeContractRevision !== expectedActiveContractRevision) {
    return { ok: false, code: "active_contract_mismatch" };
  }
  if (state.candidateContractRevision !== expectedCandidateContractRevision) {
    return { ok: false, code: "candidate_contract_mismatch" };
  }
  if (candidateReadyRevision !== expectedCandidateContractRevision) {
    return { ok: false, code: "candidate_not_ready" };
  }
  return {
    ok: true,
    alreadyPromoted: false,
    state: {
      version: 1,
      activeContractRevision: expectedCandidateContractRevision,
      previousContractRevision: state.activeContractRevision,
      promotedAt: now,
    },
  };
}

export function rollbackMcpContractRolloutState(
  state: McpContractRolloutStateV1,
  expectedActiveContractRevision: string,
  expectedPreviousContractRevision: string,
  previousReadyRevision: string | undefined,
  now: string,
): RollbackResult {
  if (expectedActiveContractRevision !== EXPECTED_MCP_CONTRACT_REVISION) {
    return { ok: false, code: "build_contract_mismatch" };
  }
  if (state.activeContractRevision === expectedPreviousContractRevision &&
      state.candidateContractRevision === expectedActiveContractRevision) {
    return { ok: true, state, alreadyRolledBack: true };
  }
  if (state.activeContractRevision !== expectedActiveContractRevision) {
    return { ok: false, code: "active_contract_mismatch" };
  }
  if (state.previousContractRevision !== expectedPreviousContractRevision) {
    return { ok: false, code: "previous_contract_mismatch" };
  }
  if (previousReadyRevision !== expectedPreviousContractRevision) {
    return { ok: false, code: "previous_not_ready" };
  }
  return {
    ok: true,
    alreadyRolledBack: false,
    state: {
      version: 1,
      activeContractRevision: expectedPreviousContractRevision,
      candidateContractRevision: expectedActiveContractRevision,
      preparedAt: now,
    },
  };
}
