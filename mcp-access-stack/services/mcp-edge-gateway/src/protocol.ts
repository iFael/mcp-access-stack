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

const REQUEST_HEADER_ALLOWLIST = new Set([
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

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}
