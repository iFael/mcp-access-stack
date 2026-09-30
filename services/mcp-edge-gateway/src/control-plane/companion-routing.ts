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

export function retireReplacedCompanion<T extends { ready: boolean }>(
  attachment: T,
): T {
  return { ...attachment, ready: false };
}

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

function stableWorkspaceKeyHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function selectAvailableRuntimeWorkspaceId(
  requestedWorkspaceId: string,
  stableKey: string,
  reservedWorkspaceIds: ReadonlySet<string>,
  scope: "local" | "remote",
): string {
  const requested = requestedWorkspaceId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(requested)) {
    throw new Error("Runtime workspace id is invalid.");
  }
  if (!reservedWorkspaceIds.has(requested)) return requested;

  const hash = stableWorkspaceKeyHash(stableKey);
  for (let attempt = 0; attempt < 4096; attempt += 1) {
    const suffix = attempt === 0
      ? `-${scope}-${hash}`
      : `-${scope}-${hash}-${attempt + 1}`;
    const prefixLength = Math.max(1, 200 - suffix.length);
    const prefix = requested
      .slice(0, prefixLength)
      .replace(/[._-]+$/u, "") || "repository";
    const candidate = `${prefix}${suffix}`;
    if (!reservedWorkspaceIds.has(candidate)) return candidate;
  }
  throw new Error("Runtime workspace id namespace is exhausted.");
}

export function selectAvailableCompanionWorkspaceId(
  requestedWorkspaceId: string,
  stableKey: string,
  reservedWorkspaceIds: ReadonlySet<string>,
): string {
  return selectAvailableRuntimeWorkspaceId(
    requestedWorkspaceId,
    stableKey,
    reservedWorkspaceIds,
    "local",
  );
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
