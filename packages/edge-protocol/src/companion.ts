import type { AuthenticatedEdgePrincipal, EdgeHttpMethod } from "./index.js";

export const COMPANION_PROTOCOL_VERSION = 1 as const;
export const COMPANION_INTERNAL_TOOL_PREFIX = "__mcp_v3_internal_" as const;
export const COMPANION_INTERNAL_BIND_REPOSITORIES_TOOL = `${COMPANION_INTERNAL_TOOL_PREFIX}bind_repositories` as const;
export const COMPANION_INTERNAL_MATERIALIZE_REPOSITORY_TOOL = `${COMPANION_INTERNAL_TOOL_PREFIX}materialize_repository` as const;

export type CompanionPlatform = "windows" | "linux" | "macos" | "unknown";

export type CompanionWorkspace = {
  workspaceId: string;
  name: string;
  workspaceKind: "repository" | "aggregate";
  enabled: boolean;
  permissionProfile: string;
  confirmationMode: string;
  writesEnabled: boolean;
  shellsEnabled: boolean;
  allowedShells: string[];
};

export type CompanionMaterializationAnnouncement = {
  repositoryId: string;
  workspaceId: string;
  path: string;
};

export type CompanionRegistration = {
  deviceId?: string;
  displayName: string;
  platform: CompanionPlatform;
  capabilities: string[];
};

export type CompanionHelloMessage = {
  type: "companion-hello";
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
};

export type CompanionRegisteredMessage = {
  type: "companion-registered";
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  deviceId: string;
};

export type CompanionReadyMessage = {
  type: "companion-ready";
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  registration: CompanionRegistration;
  workspaces: CompanionWorkspace[];
  materializations: CompanionMaterializationAnnouncement[];
};

export type CompanionHttpRequestMessage = {
  type: "http-request";
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  requestId: string;
  method: EdgeHttpMethod;
  path: string;
  headers: Record<string, string>;
  body: string;
  principal: AuthenticatedEdgePrincipal;
};

export type CompanionHttpResponseMessage = {
  type: "http-response";
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  requestId: string;
  status: number;
  headers?: Record<string, string>;
  body: string;
};

export type CompanionHttpCancelMessage = {
  type: "http-cancel";
  protocolVersion: typeof COMPANION_PROTOCOL_VERSION;
  requestId: string;
  reason: "timeout" | "client_disconnected" | "connector_replaced";
};

export type EdgeToCompanionMessage =
  | CompanionHelloMessage
  | CompanionRegisteredMessage
  | CompanionHttpRequestMessage
  | CompanionHttpCancelMessage;

export type CompanionToEdgeMessage =
  | CompanionReadyMessage
  | CompanionHttpResponseMessage;

export function parseCompanionToEdgeMessage(value: string): CompanionToEdgeMessage | null {
  const parsed = parseRecord(value);
  if (!parsed || parsed.protocolVersion !== COMPANION_PROTOCOL_VERSION || typeof parsed.type !== "string") return null;
  if (parsed.type === "companion-ready") {
    const registration = parseRegistration(parsed.registration);
    const workspaces = parseWorkspaces(parsed.workspaces);
    const materializations = parseMaterializations(parsed.materializations);
    if (!registration || !workspaces || !materializations) return null;
    return {
      type: "companion-ready",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      registration,
      workspaces,
      materializations,
    };
  }
  if (parsed.type !== "http-response") return null;
  if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0 || parsed.requestId.length > 128) return null;
  if (typeof parsed.status !== "number" || !Number.isInteger(parsed.status) || parsed.status < 100 || parsed.status > 599) return null;
  if (typeof parsed.body !== "string") return null;
  if (parsed.headers !== undefined && !isStringRecord(parsed.headers)) return null;
  return {
    type: "http-response",
    protocolVersion: COMPANION_PROTOCOL_VERSION,
    requestId: parsed.requestId,
    status: parsed.status,
    body: parsed.body,
    ...(parsed.headers === undefined ? {} : { headers: parsed.headers }),
  };
}

export function parseEdgeToCompanionMessage(value: string): EdgeToCompanionMessage | null {
  const parsed = parseRecord(value);
  if (!parsed || parsed.protocolVersion !== COMPANION_PROTOCOL_VERSION || typeof parsed.type !== "string") return null;
  if (parsed.type === "companion-hello") return { type: "companion-hello", protocolVersion: COMPANION_PROTOCOL_VERSION };
  if (parsed.type === "companion-registered") {
    if (!isPrefixedUuid(parsed.deviceId, "dev")) return null;
    return { type: "companion-registered", protocolVersion: COMPANION_PROTOCOL_VERSION, deviceId: parsed.deviceId };
  }
  if (parsed.type === "http-cancel") {
    if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0 || parsed.requestId.length > 128) return null;
    if (parsed.reason !== "timeout" && parsed.reason !== "client_disconnected" && parsed.reason !== "connector_replaced") return null;
    return {
      type: "http-cancel",
      protocolVersion: COMPANION_PROTOCOL_VERSION,
      requestId: parsed.requestId,
      reason: parsed.reason,
    };
  }
  if (parsed.type !== "http-request") return null;
  if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0 || parsed.requestId.length > 128) return null;
  if (!isMethod(parsed.method) || typeof parsed.path !== "string" || !parsed.path.startsWith("/")) return null;
  if (!isStringRecord(parsed.headers) || typeof parsed.body !== "string") return null;
  const principal = parsePrincipal(parsed.principal);
  if (!principal) return null;
  return {
    type: "http-request",
    protocolVersion: COMPANION_PROTOCOL_VERSION,
    requestId: parsed.requestId,
    method: parsed.method,
    path: parsed.path,
    headers: parsed.headers,
    body: parsed.body,
    principal,
  };
}

function parseRegistration(value: unknown): CompanionRegistration | null {
  if (!isRecord(value)) return null;
  if (value.deviceId !== undefined && !isPrefixedUuid(value.deviceId, "dev")) return null;
  if (typeof value.displayName !== "string" || value.displayName.trim().length === 0 || value.displayName.length > 200) return null;
  if (!isPlatform(value.platform)) return null;
  if (!Array.isArray(value.capabilities) || value.capabilities.length > 64 ||
      !value.capabilities.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 100) ||
      new Set(value.capabilities).size !== value.capabilities.length) return null;
  return {
    ...(value.deviceId === undefined ? {} : { deviceId: value.deviceId }),
    displayName: value.displayName.trim(),
    platform: value.platform,
    capabilities: [...value.capabilities] as string[],
  };
}

function parseWorkspaces(value: unknown): CompanionWorkspace[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const result: CompanionWorkspace[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.workspaceId !== "string" || !entry.workspaceId ||
        typeof entry.name !== "string" || !entry.name ||
        (entry.workspaceKind !== "repository" && entry.workspaceKind !== "aggregate") ||
        typeof entry.enabled !== "boolean" || typeof entry.permissionProfile !== "string" ||
        typeof entry.confirmationMode !== "string" || typeof entry.writesEnabled !== "boolean" ||
        typeof entry.shellsEnabled !== "boolean" || !Array.isArray(entry.allowedShells) ||
        !entry.allowedShells.every((shell) => typeof shell === "string" && shell.length > 0 && shell.length <= 64)) return null;
    if (ids.has(entry.workspaceId)) return null;
    ids.add(entry.workspaceId);
    result.push({
      workspaceId: entry.workspaceId,
      name: entry.name,
      workspaceKind: entry.workspaceKind,
      enabled: entry.enabled,
      permissionProfile: entry.permissionProfile,
      confirmationMode: entry.confirmationMode,
      writesEnabled: entry.writesEnabled,
      shellsEnabled: entry.shellsEnabled,
      allowedShells: [...entry.allowedShells] as string[],
    });
  }
  return result;
}

function parseMaterializations(value: unknown): CompanionMaterializationAnnouncement[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const result: CompanionMaterializationAnnouncement[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isPrefixedUuid(entry.repositoryId, "repo") ||
        typeof entry.workspaceId !== "string" || !entry.workspaceId ||
        typeof entry.path !== "string" || !entry.path || entry.path.length > 4096) return null;
    result.push({ repositoryId: entry.repositoryId, workspaceId: entry.workspaceId, path: entry.path });
  }
  return result;
}

function parsePrincipal(value: unknown): AuthenticatedEdgePrincipal | null {
  if (!isRecord(value) || typeof value.subject !== "string" || !value.subject ||
      !Array.isArray(value.scopes) || !value.scopes.every((scope) => typeof scope === "string" && scope.length > 0)) return null;
  if (value.ownerScope !== undefined && typeof value.ownerScope !== "string") return null;
  if (value.userId !== undefined && !isPrefixedUuid(value.userId, "usr")) return null;
  return {
    subject: value.subject,
    scopes: [...value.scopes] as string[],
    ...(value.ownerScope === undefined ? {} : { ownerScope: value.ownerScope }),
    ...(value.userId === undefined ? {} : { userId: value.userId }),
  };
}

function isPrefixedUuid(value: unknown, prefix: "usr" | "repo" | "dev"): value is string {
  return typeof value === "string" &&
    new RegExp(`^${prefix}_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, "iu").test(value);
}
function isMethod(value: unknown): value is EdgeHttpMethod { return value === "GET" || value === "POST" || value === "DELETE"; }
function isPlatform(value: unknown): value is CompanionPlatform { return value === "windows" || value === "linux" || value === "macos" || value === "unknown"; }
function parseRecord(value: string): Record<string, unknown> | null { try { const parsed: unknown = JSON.parse(value); return isRecord(parsed) ? parsed : null; } catch { return null; } }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isStringRecord(value: unknown): value is Record<string, string> { return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string"); }
