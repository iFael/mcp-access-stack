export const EDGE_PROTOCOL_VERSION = 2 as const;
export const EDGE_SESSION_NAME = "primary";
export const EDGE_RELAY_TIMEOUT_MS = 330_000;
export const MAX_EDGE_REQUEST_BODY_BYTES = 4 * 1024 * 1024;
export const MAX_EDGE_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;

export type EdgeHttpMethod = "GET" | "POST" | "DELETE";

export type EdgeHelloMessage = {
  type: "edge-hello";
  protocolVersion: typeof EDGE_PROTOCOL_VERSION;
};

export type ConnectorReadyMessage = {
  type: "connector-ready";
  protocolVersion: typeof EDGE_PROTOCOL_VERSION;
};

export type EdgeHttpRequestMessage = {
  type: "http-request";
  protocolVersion: typeof EDGE_PROTOCOL_VERSION;
  requestId: string;
  method: EdgeHttpMethod;
  path: string;
  headers: Record<string, string>;
  body: string;
};

export type EdgeHttpResponseMessage = {
  type: "http-response";
  protocolVersion: typeof EDGE_PROTOCOL_VERSION;
  requestId: string;
  status: number;
  headers?: Record<string, string>;
  body: string;
};

export type EdgeHttpCancelMessage = {
  type: "http-cancel";
  protocolVersion: typeof EDGE_PROTOCOL_VERSION;
  requestId: string;
  reason: "timeout" | "client_disconnected" | "connector_replaced";
};

export type EdgeToConnectorMessage =
  | EdgeHelloMessage
  | EdgeHttpRequestMessage
  | EdgeHttpCancelMessage;

export type ConnectorToEdgeMessage = ConnectorReadyMessage | EdgeHttpResponseMessage;

const MCP_PATH = "/mcp";
const OAUTH_POST_PATHS = new Set(["/token", "/register", "/revoke"]);

export function isAllowedEdgeRequest(method: string, path: string): method is EdgeHttpMethod {
  const normalizedMethod = method.toUpperCase();
  if (!isEdgeHttpMethod(normalizedMethod)) return false;

  const pathname = pathnameFromEdgePath(path);
  if (pathname === null) return false;

  if (pathname === MCP_PATH) {
    return normalizedMethod === "POST" || normalizedMethod === "GET" || normalizedMethod === "DELETE";
  }
  if (pathname === "/authorize") {
    return normalizedMethod === "GET" || normalizedMethod === "POST";
  }
  if (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-protected-resource/mcp"
  ) {
    return normalizedMethod === "GET";
  }
  if (OAUTH_POST_PATHS.has(pathname)) {
    return normalizedMethod === "POST";
  }
  return false;
}

export function parseEdgeToConnectorMessage(value: string): EdgeToConnectorMessage | null {
  const parsed = parseRecord(value);
  if (!parsed || parsed.protocolVersion !== EDGE_PROTOCOL_VERSION || typeof parsed.type !== "string") return null;

  if (parsed.type === "edge-hello") {
    return { type: "edge-hello", protocolVersion: EDGE_PROTOCOL_VERSION };
  }
  if (parsed.type === "http-cancel") {
    if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0) return null;
    if (!isCancelReason(parsed.reason)) return null;
    return {
      type: "http-cancel",
      protocolVersion: EDGE_PROTOCOL_VERSION,
      requestId: parsed.requestId,
      reason: parsed.reason,
    };
  }
  if (parsed.type !== "http-request") return null;
  if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0) return null;
  if (typeof parsed.method !== "string" || typeof parsed.path !== "string") return null;
  if (!isAllowedEdgeRequest(parsed.method, parsed.path)) return null;
  if (!isStringRecord(parsed.headers) || typeof parsed.body !== "string") return null;

  return {
    type: "http-request",
    protocolVersion: EDGE_PROTOCOL_VERSION,
    requestId: parsed.requestId,
    method: parsed.method.toUpperCase() as EdgeHttpMethod,
    path: parsed.path,
    headers: parsed.headers,
    body: parsed.body,
  };
}

export function parseConnectorToEdgeMessage(value: string): ConnectorToEdgeMessage | null {
  const parsed = parseRecord(value);
  if (!parsed || parsed.protocolVersion !== EDGE_PROTOCOL_VERSION || typeof parsed.type !== "string") return null;

  if (parsed.type === "connector-ready") {
    return { type: "connector-ready", protocolVersion: EDGE_PROTOCOL_VERSION };
  }
  if (parsed.type !== "http-response") return null;
  if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0) return null;
  if (typeof parsed.status !== "number" || !Number.isInteger(parsed.status) || parsed.status < 100 || parsed.status > 599) return null;
  if (typeof parsed.body !== "string") return null;
  if (parsed.headers !== undefined && !isStringRecord(parsed.headers)) return null;

  return {
    type: "http-response",
    protocolVersion: EDGE_PROTOCOL_VERSION,
    requestId: parsed.requestId,
    status: parsed.status,
    body: parsed.body,
    ...(parsed.headers === undefined ? {} : { headers: parsed.headers }),
  };
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function pathnameFromEdgePath(path: string): string | null {
  if (!path.startsWith("/") || path.startsWith("//")) return null;
  try {
    return new URL(path, "https://edge.invalid").pathname;
  } catch {
    return null;
  }
}

function isEdgeHttpMethod(value: string): value is EdgeHttpMethod {
  return value === "GET" || value === "POST" || value === "DELETE";
}

function isCancelReason(value: unknown): value is EdgeHttpCancelMessage["reason"] {
  return value === "timeout" || value === "client_disconnected" || value === "connector_replaced";
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}
