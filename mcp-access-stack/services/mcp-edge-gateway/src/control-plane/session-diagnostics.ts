export type SessionDiagnosticEvent = {
  version: 1;
  atMs: number;
  route: string;
  httpMethod: string;
  status: number;
  mcpMethod?: string;
  protocolVersion?: string;
  oauthGrantType?: string;
  oauthError?: string;
  clientFingerprint?: string;
  credentialFingerprint?: string;
  issuedAccessFingerprint?: string;
  issuedCredentialFingerprint?: string;
};

export interface SessionDiagnosticStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

type DiagnosticRequest = {
  url: string;
  method: string;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
};

type DiagnosticResponse = {
  status: number;
  json(): Promise<unknown>;
};
const SESSION_DIAGNOSTICS_KEY = "diagnostics:session-routing:v1";
const MAX_EVENTS = 128;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const FINGERPRINT_HEX_LENGTH = 16;

export async function classifySessionDiagnostic(
  request: DiagnosticRequest,
  response: DiagnosticResponse,
  atMs = Date.now(),
): Promise<SessionDiagnosticEvent> {
  const url = new URL(request.url);
  const event: SessionDiagnosticEvent = {
    version: 1,
    atMs,
    route: url.pathname,
    httpMethod: request.method,
    status: response.status,
  };

  if (url.pathname === "/mcp") {
    const bearer = readBearer(request.headers.get("authorization"));
    if (bearer) event.credentialFingerprint = await fingerprint(bearer);
    if (request.method === "POST") {
      const body = await readJsonRecord(request);
      if (typeof body?.method === "string") event.mcpMethod = body.method;
      if (body?.method === "initialize") {
        const params = isRecord(body.params) ? body.params : undefined;
        if (typeof params?.protocolVersion === "string") event.protocolVersion = params.protocolVersion.slice(0, 64);
      }
    }
    return event;
  }

  if (url.pathname === "/token" && request.method === "POST") {
    const fields = new URLSearchParams(await request.text());
    const grantType = fields.get("grant_type");
    if (grantType) event.oauthGrantType = grantType.slice(0, 64);
    const clientId = fields.get("client_id");
    if (clientId) event.clientFingerprint = await fingerprint(clientId);
    if (grantType === "refresh_token") {
      const refreshToken = fields.get("refresh_token");
      if (refreshToken) event.credentialFingerprint = await fingerprint(refreshToken);
    }
    const tokenResult = await readTokenResult(response);
    if (tokenResult.error) event.oauthError = tokenResult.error;
    if (tokenResult.accessToken) event.issuedAccessFingerprint = await fingerprint(tokenResult.accessToken);
    if (tokenResult.refreshToken) event.issuedCredentialFingerprint = await fingerprint(tokenResult.refreshToken);
    return event;
  }

  if ((url.pathname === "/authorize" || url.pathname === "/revoke") && (request.method === "GET" || request.method === "POST")) {
    const fields = request.method === "GET" ? url.searchParams : new URLSearchParams(await request.text());
    const clientId = fields.get("client_id");
    if (clientId) event.clientFingerprint = await fingerprint(clientId);
  }

  return event;
}

export function shouldPersistSessionDiagnostic(event: SessionDiagnosticEvent): boolean {
  if (event.route === "/token" || event.route === "/authorize" || event.route === "/register" || event.route === "/revoke" || event.route.startsWith("/.well-known/oauth-")) {
    return true;
  }
  if (event.route !== "/mcp") return event.status >= 400;
  if (event.status >= 400 || event.httpMethod !== "POST") return true;
  return event.mcpMethod === "initialize" || event.mcpMethod === "tools/list" || event.mcpMethod === "notifications/initialized" || event.mcpMethod === "ping";
}
export async function appendSessionDiagnostic(
  storage: SessionDiagnosticStorage,
  event: SessionDiagnosticEvent,
  nowMs = event.atMs,
): Promise<void> {
  const current = await storage.get<SessionDiagnosticEvent[]>(SESSION_DIAGNOSTICS_KEY);
  const events = Array.isArray(current)
    ? current.filter((entry) => isDiagnosticEvent(entry) && entry.atMs >= nowMs - MAX_AGE_MS)
    : [];
  events.push(event);
  await storage.put(SESSION_DIAGNOSTICS_KEY, events.slice(-MAX_EVENTS));
}

export async function readSessionDiagnostics(
  storage: SessionDiagnosticStorage,
  nowMs = Date.now(),
): Promise<SessionDiagnosticEvent[]> {
  const current = await storage.get<SessionDiagnosticEvent[]>(SESSION_DIAGNOSTICS_KEY);
  if (!Array.isArray(current)) return [];
  return current
    .filter((entry) => isDiagnosticEvent(entry) && entry.atMs >= nowMs - MAX_AGE_MS)
    .slice(-MAX_EVENTS);
}

async function readJsonRecord(request: DiagnosticRequest): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json();
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readTokenResult(response: DiagnosticResponse): Promise<{
  error?: string;
  accessToken?: string;
  refreshToken?: string;
}> {
  try {
    const value = await response.json();
    if (!isRecord(value)) return {};
    return {
      ...(typeof value.error === "string" ? { error: value.error.slice(0, 64) } : {}),
      ...(response.status < 400 && typeof value.access_token === "string" ? { accessToken: value.access_token } : {}),
      ...(response.status < 400 && typeof value.refresh_token === "string" ? { refreshToken: value.refresh_token } : {}),
    };
  } catch {
    return {};
  }
}

function readBearer(value: string | null): string | undefined {
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(value.trim());
  return match?.[1];
}

async function fingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, FINGERPRINT_HEX_LENGTH);
}

function isDiagnosticEvent(value: unknown): value is SessionDiagnosticEvent {
  return isRecord(value) && value.version === 1 && typeof value.atMs === "number" && Number.isFinite(value.atMs) &&
    typeof value.route === "string" && typeof value.httpMethod === "string" && typeof value.status === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}