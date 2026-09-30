import type { ConnectorRuntimeIdentity } from "@mcp-access-stack/edge-protocol";

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
    if (candidateId === currentId) {
      const candidateGeneration = candidate?.connectionGeneration ?? 0;
      const currentGeneration = current?.connectionGeneration ?? 0;
      return candidateGeneration > currentGeneration;
    }
    return candidateId.localeCompare(currentId) > 0;
  }
  return Number.isFinite(candidateStartedAt) && !Number.isFinite(currentStartedAt);
}
