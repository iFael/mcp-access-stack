export const EDGE_PROTOCOL_VERSION = 1 as const;
export const MCP_SESSION_NAME = "primary";
export const MCP_RELAY_TIMEOUT_MS = 55_000;
export const MAX_MCP_REQUEST_BODY_BYTES = 1_048_576;
export const MAX_MCP_RESPONSE_BODY_BYTES = 4_194_304;

export type ConnectorAttachment = {
  role: "connector";
  ready: boolean;
  protocolVersion: number;
};

export type EdgeHelloMessage = {
  type: "edge-hello";
  protocolVersion: typeof EDGE_PROTOCOL_VERSION;
};

export type ConnectorReadyMessage = {
  type: "connector-ready";
  protocolVersion: typeof EDGE_PROTOCOL_VERSION;
};

export type McpRequestMessage = {
  type: "mcp-request";
  protocolVersion: typeof EDGE_PROTOCOL_VERSION;
  requestId: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
};

export type McpResponseMessage = {
  type: "mcp-response";
  protocolVersion: typeof EDGE_PROTOCOL_VERSION;
  requestId: string;
  status: number;
  headers?: Record<string, string>;
  body: string;
};

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
]);

const RESPONSE_HEADER_ALLOWLIST = new Set([
  "cache-control",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "retry-after",
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

export function parseConnectorMessage(value: string): ConnectorReadyMessage | McpResponseMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;

  if (parsed.type === "connector-ready") {
    return parsed.protocolVersion === EDGE_PROTOCOL_VERSION
      ? {
          type: "connector-ready",
          protocolVersion: EDGE_PROTOCOL_VERSION,
        }
      : null;
  }

  if (parsed.type !== "mcp-response") return null;
  if (parsed.protocolVersion !== EDGE_PROTOCOL_VERSION) return null;
  if (typeof parsed.requestId !== "string" || parsed.requestId.length === 0) return null;
  const status = parsed.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) return null;
  if (typeof parsed.body !== "string") return null;
  if (parsed.headers !== undefined && !isStringRecord(parsed.headers)) return null;

  return {
    type: "mcp-response",
    protocolVersion: EDGE_PROTOCOL_VERSION,
    requestId: parsed.requestId,
    status,
    body: parsed.body,
    ...(parsed.headers === undefined ? {} : { headers: parsed.headers }),
  };
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

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

async function sha256(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}
