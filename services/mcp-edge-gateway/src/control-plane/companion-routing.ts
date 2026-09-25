export type CompanionRouteCandidate<T> = {
  target: T;
  deviceId: string;
  workspaceIds: readonly string[];
};

export type CompanionEligibility = {
  online: boolean;
  ready: boolean;
  userId: string;
  deviceId?: string;
};

export function isCompanionEligibleForUser(
  candidate: CompanionEligibility,
  userId: string,
  requestedDeviceId?: string,
): boolean {
  return candidate.online &&
    candidate.ready &&
    candidate.userId === userId &&
    Boolean(candidate.deviceId) &&
    (requestedDeviceId === undefined || candidate.deviceId === requestedDeviceId);
}

export type DeviceRouteSelection<T> =
  | { kind: "selected"; candidate: CompanionRouteCandidate<T> }
  | { kind: "none" }
  | { kind: "ambiguous" };

export type WorkspaceRouteSelection<T> =
  | { kind: "companion"; candidate: CompanionRouteCandidate<T> }
  | { kind: "primary" }
  | { kind: "none" }
  | { kind: "collision" };

export function selectCompanionDevice<T>(
  candidates: readonly CompanionRouteCandidate<T>[],
  requestedDeviceId?: string,
): DeviceRouteSelection<T> {
  const eligible = requestedDeviceId === undefined
    ? candidates
    : candidates.filter((candidate) => candidate.deviceId === requestedDeviceId);
  if (eligible.length === 0) return { kind: "none" };
  if (eligible.length > 1) return { kind: "ambiguous" };
  return { kind: "selected", candidate: eligible[0]! };
}

export function selectWorkspaceRuntime<T>(
  candidates: readonly CompanionRouteCandidate<T>[],
  workspaceId: string,
  primaryWorkspaceIds: ReadonlySet<string>,
): WorkspaceRouteSelection<T> {
  const matching = candidates.filter((candidate) =>
    candidate.workspaceIds.includes(workspaceId),
  );
  if (matching.length > 1) return { kind: "collision" };
  if (matching.length === 1) {
    return primaryWorkspaceIds.has(workspaceId)
      ? { kind: "collision" }
      : { kind: "companion", candidate: matching[0]! };
  }
  return primaryWorkspaceIds.has(workspaceId)
    ? { kind: "primary" }
    : { kind: "none" };
}
