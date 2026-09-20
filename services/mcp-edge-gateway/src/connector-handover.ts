import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol";
import { EDGE_PROTOCOL_VERSION, LEGACY_EDGE_PROTOCOL_VERSION } from "./protocol.js";

export function isPreferredConnectorRuntime(
  candidate: ConnectorRuntimeIdentity | undefined,
  current: ConnectorRuntimeIdentity | undefined,
): boolean {
  const candidateStartedAt = Date.parse(candidate?.processStartedAt ?? "");
  const currentStartedAt = Date.parse(current?.processStartedAt ?? "");
  if (Number.isFinite(candidateStartedAt) && Number.isFinite(currentStartedAt)) {
    if (candidateStartedAt !== currentStartedAt) return candidateStartedAt > currentStartedAt;
    const candidateId = candidate?.connectorInstanceId ?? "";
    const currentId = current?.connectorInstanceId ?? "";
    return candidateId.localeCompare(currentId) > 0;
  }
  return Number.isFinite(candidateStartedAt) && !Number.isFinite(currentStartedAt);
}

export function selectPreferredConnectorProtocol(
  v3Ready: boolean,
  legacyReady: boolean,
): typeof EDGE_PROTOCOL_VERSION | typeof LEGACY_EDGE_PROTOCOL_VERSION | null {
  if (v3Ready) return EDGE_PROTOCOL_VERSION;
  if (legacyReady) return LEGACY_EDGE_PROTOCOL_VERSION;
  return null;
}
