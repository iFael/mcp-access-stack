import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol/source";
import {
  EdgeAuthenticationError,
  createBearerChallenge,
  parseScopes,
  readBearerToken,
} from "./auth.js";

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 256;
const MAX_SCOPES = 64;

export interface OwnerOAuthStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface EdgeOwnerOAuthConfig {
  ownerSecret: string;
  publicBaseUrl: URL;
  mcpPath: string;
  scopes: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  resourceName: string;
}

type OwnerClient = {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
};

type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAtMs: number;
};

type RefreshTokenRecord = {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
};

type RevokedAccessRecord = { expiresAt: number };

type OwnerAccessClaims = {
  iss: string;
  aud: string;
  sub: string;
  scope: string;
  client_id: string;
  owner_scope: "owner";
  iat: number;
  exp: number;
  jti: string;
};

export class EdgeOwnerOAuth {
  private readonly mcpUrl: URL;
  private readonly resourceMetadataUrl: URL;
  private readonly requiredScope: string;
  private readonly challenge: string;
  private hmacKeyPromise: Promise<CryptoKey> | undefined;

  constructor(
    private readonly storage: OwnerOAuthStorage,
    private readonly config: EdgeOwnerOAuthConfig,
  ) {
    if (config.ownerSecret.length < 16) throw new Error("Owner secret must contain at least 16 characters.");
    if (config.scopes.length === 0 || config.scopes.length > MAX_SCOPES) throw new Error("Owner OAuth scopes are invalid.");
    this.mcpUrl = new URL(config.mcpPath, config.publicBaseUrl);
    this.resourceMetadataUrl = new URL(`/.well-known/oauth-protected-resource${config.mcpPath}`, config.publicBaseUrl);
    this.requiredScope = config.scopes[0] ?? "mcp:tools";
    this.challenge = createBearerChallenge(this.resourceMetadataUrl, this.requiredScope);
  }

  async authenticate(request: Request): Promise<AuthenticatedEdgePrincipal> {
    const token = readBearerToken(request.headers.get("authorization"));
    if (!token) throw new EdgeAuthenticationError(401, "invalid_token", this.challenge);

    const claims = await this.verifyAccessToken(token).catch(() => null);
    if (!claims || claims.exp <= nowSeconds()) {
      throw new EdgeAuthenticationError(401, "invalid_token", this.challenge);
    }
    const revoked = await this.storage.get<RevokedAccessRecord>(revokedAccessKey(claims.jti));
    if (revoked) {
      if (revoked.expiresAt > nowSeconds()) {
        throw new EdgeAuthenticationError(401, "invalid_token", this.challenge);
      }
      await this.storage.delete(revokedAccessKey(claims.jti));
    }
    const scopes = parseScopes(claims.scope);
    if (!scopes.includes(this.requiredScope)) {
      throw new EdgeAuthenticationError(403, "insufficient_scope", this.challenge);
    }
    return { subject: claims.sub, scopes, ownerScope: "owner" };
  }

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer: this.config.publicBaseUrl.href,
        authorization_endpoint: new URL("/authorize", this.config.publicBaseUrl).href,
        token_endpoint: new URL("/token", this.config.publicBaseUrl).href,
        registration_endpoint: new URL("/register", this.config.publicBaseUrl).href,
        revocation_endpoint: new URL("/revoke", this.config.publicBaseUrl).href,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: this.config.scopes,
      });
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === this.resourceMetadataUrl.pathname)
    ) {
      return jsonResponse({
        resource: this.mcpUrl.href,
        authorization_servers: [this.config.publicBaseUrl.href],
        scopes_supported: this.config.scopes,
        resource_name: this.config.resourceName,
      });
    }
    if (url.pathname === "/register" && request.method === "POST") return this.register(request);
    if (url.pathname === "/authorize" && (request.method === "GET" || request.method === "POST")) return this.authorize(request);
    if (url.pathname === "/token" && request.method === "POST") return this.token(request);
    if (url.pathname === "/revoke" && request.method === "POST") return this.revoke(request);
    return null;
  }

  private async register(request: Request): Promise<Response> {
    let input: unknown;
    try { input = await request.json(); } catch { return oauthError("invalid_client_metadata", 400); }
    if (!isRecord(input) || !Array.isArray(input.redirect_uris)) return oauthError("invalid_client_metadata", 400);
    const redirects = input.redirect_uris;
    if (
      redirects.length === 0 || redirects.length > 16 ||
      !redirects.every((value) => typeof value === "string" && this.redirectAllowed(value)) ||
      (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none")
    ) return oauthError("invalid_client_metadata", 400);

    const existingCount = (await this.storage.get<number>("owner:client-count")) ?? 0;
    if (existingCount >= MAX_CLIENTS) return oauthError("invalid_client_metadata", 400);
    const now = nowSeconds();
    const client: OwnerClient = {
      client_id: `mcp-${crypto.randomUUID()}`,
      client_id_issued_at: now,
      redirect_uris: [...redirects] as string[],
      ...(typeof input.client_name === "string" && input.client_name.length > 0 ? { client_name: input.client_name.slice(0, 200) } : {}),
      token_endpoint_auth_method: "none",
      grant_types: readStringArray(input.grant_types, ["authorization_code", "refresh_token"]),
      response_types: readStringArray(input.response_types, ["code"]),
    };
    if (!client.grant_types.every((value) => value === "authorization_code" || value === "refresh_token") ||
        !client.response_types.every((value) => value === "code")) return oauthError("invalid_client_metadata", 400);

    await this.storage.put(clientKey(client.client_id), client);
    await this.storage.put("owner:client-count", existingCount + 1);
    return jsonResponse(client, 201);
  }

  private async authorize(request: Request): Promise<Response> {
    const fields = request.method === "GET"
      ? new URL(request.url).searchParams
      : new URLSearchParams(await request.text());
    const clientId = fields.get("client_id") ?? "";
    const client = await this.storage.get<OwnerClient>(clientKey(clientId));
    if (!client) return oauthError("invalid_request", 400);
    const redirectUri = fields.get("redirect_uri") ?? "";
    const codeChallenge = fields.get("code_challenge") ?? "";
    const resource = fields.get("resource") ?? "";
    const scopes = parseScopes(fields.get("scope") ?? this.config.scopes.join(" "));
    if (
      fields.get("response_type") !== "code" ||
      fields.get("code_challenge_method") !== "S256" ||
      codeChallenge.length < 32 ||
      !client.redirect_uris.includes(redirectUri) ||
      resource !== this.mcpUrl.href ||
      scopes.length === 0 || !scopes.every((scope) => this.config.scopes.includes(scope))
    ) return oauthError("invalid_request", 400);

    if (request.method === "GET") {
      return htmlResponse(this.authorizationPage(client, fields));
    }
    const supplied = fields.get("owner_token") ?? "";
    if (!(await constantTimeEquals(supplied, this.config.ownerSecret))) {
      return htmlResponse(this.authorizationPage(client, fields, "Owner credential was not accepted."), 401);
    }

    const code = `code-${randomToken()}`;
    await this.storage.put(codeKey(await sha256Base64Url(code)), {
      clientId,
      redirectUri,
      codeChallenge,
      scopes,
      resource,
      expiresAtMs: Date.now() + AUTHORIZATION_CODE_TTL_MS,
    } satisfies AuthorizationCodeRecord);
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    const state = fields.get("state");
    if (state) target.searchParams.set("state", state);
    return new Response(null, { status: 302, headers: { location: target.href, "cache-control": "no-store" } });
  }

  private async token(request: Request): Promise<Response> {
    const fields = new URLSearchParams(await request.text());
    const grantType = fields.get("grant_type");
    const clientId = fields.get("client_id") ?? "";
    const client = await this.storage.get<OwnerClient>(clientKey(clientId));
    if (!client) return oauthError("invalid_client", 400);

    if (grantType === "authorization_code") {
      const rawCode = fields.get("code") ?? "";
      const key = codeKey(await sha256Base64Url(rawCode));
      const record = await this.storage.get<AuthorizationCodeRecord>(key);
      if (!record || record.clientId !== clientId || record.expiresAtMs < Date.now()) return oauthError("invalid_grant", 400);
      if (fields.get("redirect_uri") !== record.redirectUri || fields.get("resource") !== record.resource) return oauthError("invalid_grant", 400);
      const verifier = fields.get("code_verifier") ?? "";
      if ((await sha256Base64Url(verifier)) !== record.codeChallenge) return oauthError("invalid_grant", 400);
      await this.storage.delete(key);
      return jsonResponse(await this.issueTokens(clientId, record.scopes, record.resource));
    }

    if (grantType === "refresh_token") {
      const refresh = fields.get("refresh_token") ?? "";
      const hash = await sha256Base64Url(refresh);
      const key = refreshKey(hash);
      const record = await this.storage.get<RefreshTokenRecord>(key);
      if (!record || record.clientId !== clientId || record.expiresAt <= nowSeconds()) return oauthError("invalid_grant", 400);
      const resource = fields.get("resource") ?? record.resource;
      if (resource !== record.resource) return oauthError("invalid_grant", 400);
      const requested = parseScopes(fields.get("scope") ?? record.scopes.join(" "));
      if (!requested.every((scope) => record.scopes.includes(scope))) return oauthError("invalid_scope", 400);
      await this.storage.delete(key);
      return jsonResponse(await this.issueTokens(clientId, requested, record.resource));
    }

    return oauthError("unsupported_grant_type", 400);
  }

  private async revoke(request: Request): Promise<Response> {
    const fields = new URLSearchParams(await request.text());
    const token = fields.get("token") ?? "";
    if (!token) return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });

    const claims = await this.verifyAccessToken(token).catch(() => null);
    if (claims) {
      await this.storage.put(revokedAccessKey(claims.jti), { expiresAt: claims.exp } satisfies RevokedAccessRecord);
    } else {
      await this.storage.delete(refreshKey(await sha256Base64Url(token)));
    }
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }

  private async issueTokens(clientId: string, scopes: string[], resource: string): Promise<Record<string, unknown>> {
    const now = nowSeconds();
    const claims: OwnerAccessClaims = {
      iss: this.config.publicBaseUrl.href,
      aud: resource,
      sub: `owner:${clientId}`,
      scope: scopes.join(" "),
      client_id: clientId,
      owner_scope: "owner",
      iat: now,
      exp: now + this.config.accessTokenTtlSeconds,
      jti: crypto.randomUUID(),
    };
    const accessToken = await this.signAccessToken(claims);
    const refreshToken = `refresh-${randomToken()}`;
    await this.storage.put(refreshKey(await sha256Base64Url(refreshToken)), {
      clientId,
      scopes: [...scopes],
      resource,
      expiresAt: now + this.config.refreshTokenTtlSeconds,
    } satisfies RefreshTokenRecord);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private async signAccessToken(claims: OwnerAccessClaims): Promise<string> {
    const header = base64UrlText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64UrlText(JSON.stringify(claims));
    const signingInput = `${header}.${payload}`;
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await this.hmacKey(), new TextEncoder().encode(signingInput)));
    return `${signingInput}.${base64UrlBytes(signature)}`;
  }

  private async verifyAccessToken(token: string): Promise<OwnerAccessClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = JSON.parse(decodeBase64UrlText(encodedHeader)) as unknown;
    const payload = JSON.parse(decodeBase64UrlText(encodedPayload)) as unknown;
    if (!isRecord(header) || header.alg !== "HS256" || header.typ !== "JWT" || !isOwnerClaims(payload)) throw new Error("invalid token");
    const valid = await crypto.subtle.verify(
      "HMAC",
      await this.hmacKey(),
      toArrayBuffer(decodeBase64UrlBytes(encodedSignature)),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!valid || payload.iss !== this.config.publicBaseUrl.href || payload.aud !== this.mcpUrl.href || payload.owner_scope !== "owner") {
      throw new Error("invalid token");
    }
    return payload;
  }

  private hmacKey(): Promise<CryptoKey> {
    this.hmacKeyPromise ??= crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(this.config.ownerSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    return this.hmacKeyPromise;
  }

  private redirectAllowed(value: string): boolean {
    let url: URL;
    try { url = new URL(value); } catch { return false; }
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true;
    if (url.protocol === "https:" && url.hostname === "chatgpt.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      return !url.username && !url.password && !url.search && !url.hash && segments.length === 3 && segments[0] === "connector" && segments[1] === "oauth" && Boolean(segments[2]);
    }
    return url.protocol === "https:" && url.hostname === this.config.publicBaseUrl.hostname && !url.username && !url.password;
  }

  private authorizationPage(client: OwnerClient, fields: URLSearchParams, error?: string): string {
    const hidden = [...fields.entries()]
      .filter(([name]) => name !== "owner_token")
      .map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`)
      .join("\n");
    return `<!doctype html><html><body><main><h1>${htmlEscape(this.config.resourceName)}</h1><p>${htmlEscape(client.client_name ?? client.client_id)}</p>${error ? `<p>${htmlEscape(error)}</p>` : ""}<form method="post">${hidden}<label>Owner<input name="owner_token" type="password" required></label><button type="submit">Authorize</button></form></main></body></html>`;
  }
}

function clientKey(clientId: string): string { return `owner:client:${clientId}`; }
function codeKey(hash: string): string { return `owner:code:${hash}`; }
function refreshKey(hash: string): string { return `owner:refresh:${hash}`; }
function revokedAccessKey(jti: string): string { return `owner:revoked:${jti}`; }
function nowSeconds(): number { return Math.floor(Date.now() / 1000); }
function randomToken(): string { const bytes = new Uint8Array(32); crypto.getRandomValues(bytes); return base64UrlBytes(bytes); }

async function constantTimeEquals(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}
async function sha256Bytes(value: string): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
async function sha256Base64Url(value: string): Promise<string> { return base64UrlBytes(await sha256Bytes(value)); }
function base64UrlText(value: string): string { return base64UrlBytes(new TextEncoder().encode(value)); }
function base64UrlBytes(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""); }
function decodeBase64UrlText(value: string): string { return new TextDecoder().decode(decodeBase64UrlBytes(value)); }
function decodeBase64UrlBytes(value: string): Uint8Array { const normalized = value.replaceAll("-", "+").replaceAll("_", "/"); const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4); const binary = atob(padded); return Uint8Array.from(binary, (char) => char.charCodeAt(0)); }
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}function readStringArray(value: unknown, fallback: string[]): string[] { return value === undefined ? fallback : Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : []; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isOwnerClaims(value: unknown): value is OwnerAccessClaims { return isRecord(value) && typeof value.iss === "string" && typeof value.aud === "string" && typeof value.sub === "string" && typeof value.scope === "string" && typeof value.client_id === "string" && value.owner_scope === "owner" && typeof value.iat === "number" && typeof value.exp === "number" && typeof value.jti === "string"; }
function htmlEscape(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
function jsonResponse(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function htmlResponse(body: string, status = 200): Response { return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }); }
function oauthError(error: string, status: number): Response { return jsonResponse({ error }, status); }