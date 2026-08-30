import {
  EDGE_PROTOCOL_VERSION,
  EDGE_RELAY_TIMEOUT_MS,
  EDGE_SESSION_NAME,
  MAX_EDGE_REQUEST_BODY_BYTES,
  MAX_EDGE_RESPONSE_BODY_BYTES,
  isAllowedEdgeRequest,
  parseConnectorToEdgeMessage,
  utf8ByteLength,
  type ConnectorReadyMessage,
  type EdgeHelloMessage,
  type EdgeHttpCancelMessage,
  type EdgeHttpRequestMessage,
  type EdgeHttpResponseMessage,
} from "@mcp-access-stack/edge-protocol/source";

export {
  EDGE_PROTOCOL_VERSION,
  EDGE_RELAY_TIMEOUT_MS,
  EDGE_SESSION_NAME,
  MAX_EDGE_REQUEST_BODY_BYTES,
  MAX_EDGE_RESPONSE_BODY_BYTES,
  isAllowedEdgeRequest,
  parseConnectorToEdgeMessage,
  utf8ByteLength,
  type ConnectorReadyMessage,
  type EdgeHelloMessage,
  type EdgeHttpCancelMessage,
  type EdgeHttpRequestMessage,
  type EdgeHttpResponseMessage,
};

export const LEGACY_EDGE_PROTOCOL_VERSION = 2 as const;

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
]);

const LEGACY_REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  "allow",
  "cache-control",
  "content-type",
  "location",
  "mcp-protocol-version",
  "mcp-session-id",
  "origin",
  "retry-after",
  "www-authenticate",
]);

export function collectAllowedRequestHeaders(headers: Headers): Record<string, string> {
  return collectAllowedHeaders(headers, REQUEST_HEADER_ALLOWLIST);
}

export function collectLegacyAllowedRequestHeaders(headers: Headers): Record<string, string> {
  return collectAllowedHeaders(headers, LEGACY_REQUEST_HEADER_ALLOWLIST);
}

export function resolveConnectorProtocol(url: URL, cutoverComplete: boolean): 2 | 3 | null {
  if (url.pathname !== "/connector" || url.hash) return null;
  const requested = url.searchParams.get("protocol");
  if (requested === String(EDGE_PROTOCOL_VERSION) && [...url.searchParams.keys()].length === 1) return EDGE_PROTOCOL_VERSION;
  if (requested !== null) return null;
  return cutoverComplete ? null : LEGACY_EDGE_PROTOCOL_VERSION;
}

export type LegacyConnectorToEdgeMessage =
  | { type: "connector-ready"; protocolVersion: 2 }
  | { type: "http-response"; protocolVersion: 2; requestId: string; status: number; headers?: Record<string, string>; body: string };

export function parseLegacyConnectorToEdgeMessage(value: string): LegacyConnectorToEdgeMessage | null {
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { return null; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.protocolVersion !== LEGACY_EDGE_PROTOCOL_VERSION || typeof record.type !== "string") return null;
  if (record.type === "connector-ready") {
    const keys = Object.keys(record).sort();
    if (keys.length !== 2 || keys[0] !== "protocolVersion" || keys[1] !== "type") return null;
    return { type: "connector-ready", protocolVersion: LEGACY_EDGE_PROTOCOL_VERSION };
  }
  if (record.type !== "http-response") return null;
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return null;
  if (typeof record.status !== "number" || !Number.isInteger(record.status) || record.status < 100 || record.status > 599) return null;
  if (typeof record.body !== "string") return null;
  if (record.headers !== undefined && !isStringRecord(record.headers)) return null;
  const keys = Object.keys(record).sort();
  const allowed = record.headers === undefined
    ? ["body", "protocolVersion", "requestId", "status", "type"]
    : ["body", "headers", "protocolVersion", "requestId", "status", "type"];
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) return null;
  return {
    type: "http-response",
    protocolVersion: LEGACY_EDGE_PROTOCOL_VERSION,
    requestId: record.requestId,
    status: record.status,
    body: record.body,
    ...(record.headers === undefined ? {} : { headers: record.headers as Record<string, string> }),
  };
}

export function collectAllowedResponseHeaders(
  headers: Record<string, string> | undefined,
): Headers {
  const result = new Headers();
  if (!headers) return result;

  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (RESPONSE_HEADER_ALLOWLIST.has(normalized)) {
      result.set(normalized, value);
    }
  }
  return result;
}

export async function connectorTokenMatches(
  authorizationHeader: string | null,
  expectedToken: string,
): Promise<boolean> {
  const prefix = "Bearer ";
  if (!authorizationHeader?.startsWith(prefix)) return false;

  const suppliedToken = authorizationHeader.slice(prefix.length);
  if (suppliedToken.length === 0) return false;

  const [suppliedHash, expectedHash] = await Promise.all([
    sha256(suppliedToken),
    sha256(expectedToken),
  ]);

  let difference = 0;
  for (let index = 0; index < suppliedHash.length; index += 1) {
    difference |= suppliedHash[index]! ^ expectedHash[index]!;
  }
  return difference === 0;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function collectAllowedHeaders(headers: Headers, allowlist: Set<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const normalized = name.toLowerCase();
    if (allowlist.has(normalized)) {
      result[normalized] = value;
    }
  }
  return result;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}
