import {
  EdgeAuthenticationError,
  createBearerChallenge,
  parseScopes,
  readBearerToken,
  type OwnerOAuthStorage,
} from "@mcp-access-stack/mcp-owner-auth";

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const MICROSOFT_PENDING_TTL_MS = 10 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const INVITE_TTL_MS = 30 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_CLIENTS = 256;
const MAX_SCOPES = 64;

const USER_IDS_KEY = "update-control:identity:user-ids:v1";
const USER_PREFIX = "update-control:identity:user:";
const MICROSOFT_SUBJECT_PREFIX = "update-control:identity:microsoft-subject:";
const BOOTSTRAP_ACTIVE_KEY = "update-control:identity:bootstrap:active";
const BOOTSTRAP_OPERATION_PREFIX = "update-control:identity:bootstrap:operation:";
const INVITE_PREFIX = "update-control:identity:invite:";
export const UPDATE_CONTROL_OAUTH_STORAGE_PREFIX = "update-control:oauth:";
const ADMIN_SESSION_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "admin-session:";
const CLIENT_COUNT_KEY = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "client-count";
const CLIENT_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "client:";
const PENDING_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "microsoft-pending:";
const CODE_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "code:";
const REFRESH_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "refresh:";
const REVOKED_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "revoked:";
const SIGNING_KEY = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "signing:v1";

export type UpdateControlRole = "admin" | "operator" | "viewer";

export type UpdateControlUser = {
  version: 1;
  id: string;
  displayName: string;
  email?: string;
  role: UpdateControlRole;
  status: "active" | "revoked";
  provider: "microsoft";
  providerSubject: string;
  createdAt: string;
  updatedAt: string;
};

type OAuthClient = {
  client_id: string;
  client_id_issued_at: number;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: "none";
  grant_types: string[];
  response_types: string[];
};

type PendingMicrosoftAuthorization = {
  version: 1;
  state: string;
  kind: "mcp" | "admin" | "join";
  microsoftCodeVerifier: string;
  expiresAtMs: number;
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  scopes?: string[];
  resource?: string;
  clientState?: string;
  inviteHash?: string;
};

type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  resource: string;
  expiresAtMs: number;
  userId: string;
};

type RefreshTokenRecord = {
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
  signingVersion: string;
  userId: string;
};

type RevokedAccessRecord = { expiresAt: number };

type SigningMaterial = {
  key: string;
  version: string;
};

type BootstrapOperation = {
  version: 1;
  operationId: string;
  status: "ready" | "completed" | "expired";
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
};

type InvitationRecord = {
  version: 1;
  role: UpdateControlRole;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string;
};

type AdminSessionRecord = {
  version: 1;
  userId: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
};

type AccessClaims = {
  iss: string;
  aud: string;
  sub: string;
  scope: string;
  client_id: string;
  owner_scope: "owner";
  user_id: string;
  iat: number;
  exp: number;
  jti: string;
};

export interface UpdateControlIdentityOAuthConfig {
  publicBaseUrl: URL;
  microsoftClientId: string;
  microsoftTenant: string;
  bootstrapAdminEmail: string;
  scopes: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  resourceName: string;
}

export interface UpdateControlIdentityStorage extends OwnerOAuthStorage {
  listPrefix(prefix: string, limit: number): Promise<Map<string, unknown>>;
  deleteMany(keys: string[]): Promise<number>;
}

export type MicrosoftIdentityCompletion = {
  state: string;
  subject: string;
  displayName: string;
  email?: string;
};

export class UpdateControlIdentityOAuth {
  private readonly mcpUrl: URL;
  private readonly resourceMetadataUrl: URL;
  private readonly challenge: string;

  constructor(
    private readonly storage: UpdateControlIdentityStorage,
    private readonly config: UpdateControlIdentityOAuthConfig,
  ) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(config.microsoftClientId)) {
      throw new Error("MICROSOFT_CLIENT_ID must be a GUID.");
    }
    if (!isMicrosoftTenant(config.microsoftTenant)) {
      throw new Error("MICROSOFT_TENANT must be common, organizations, consumers, or a tenant GUID.");
    }
    if (!isBootstrapAdminEmail(config.bootstrapAdminEmail)) {
      throw new Error("UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL is invalid.");
    }
    if (config.scopes.length === 0 || config.scopes.length > MAX_SCOPES) {
      throw new Error("Update Control OAuth scopes are invalid.");
    }
    this.mcpUrl = new URL("/mcp", config.publicBaseUrl);
    this.resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.publicBaseUrl);
    this.challenge = createBearerChallenge(this.resourceMetadataUrl, config.scopes[0] ?? "update:read");
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
    if (url.pathname === "/authorize" && (request.method === "GET" || request.method === "POST")) {
      return this.authorize(request);
    }
    if (url.pathname === "/token" && request.method === "POST") return this.token(request);
    if (url.pathname === "/revoke" && request.method === "POST") return this.revoke(request);
    return null;
  }

  async authenticate(request: Request): Promise<{
    subject: string;
    scopes: string[];
    ownerScope: "owner";
    userId: string;
  }> {
    const token = readBearerToken(request.headers.get("authorization"));
    if (!token) throw new EdgeAuthenticationError(401, "invalid_token", this.challenge);
    const claims = await this.verifyAccessToken(token).catch(() => null);
    if (!claims || claims.exp <= nowSeconds()) {
      throw new EdgeAuthenticationError(401, "invalid_token", this.challenge);
    }
    const revoked = await this.storage.get<RevokedAccessRecord>(REVOKED_PREFIX + claims.jti);
    if (revoked?.expiresAt && revoked.expiresAt > nowSeconds()) {
      throw new EdgeAuthenticationError(401, "invalid_token", this.challenge);
    }
    const user = await this.getUser(claims.user_id);
    if (!user || user.status !== "active") {
      throw new EdgeAuthenticationError(401, "invalid_token", this.challenge);
    }
    const scopes = parseScopes(claims.scope);
    const requiredScope = this.config.scopes[0] ?? "update:read";
    if (!scopes.includes(requiredScope)) {
      throw new EdgeAuthenticationError(403, "insufficient_scope", this.challenge);
    }
    return {
      subject: `user:${user.id}`,
      scopes,
      ownerScope: "owner",
      userId: user.id,
    };
  }

  async beginBootstrap(operationId: string): Promise<Response> {
    const operationKey = BOOTSTRAP_OPERATION_PREFIX + operationId;
    const existing = await this.storage.get<BootstrapOperation>(operationKey);
    if (isBootstrapOperation(existing)) {
      if (existing.status === "ready" && Date.parse(existing.expiresAt) <= Date.now()) {
        const expired = { ...existing, status: "expired" as const };
        await this.storage.put(operationKey, expired);
        const active = await this.storage.get<BootstrapOperation>(BOOTSTRAP_ACTIVE_KEY);
        if (active?.operationId === operationId) await this.storage.delete(BOOTSTRAP_ACTIVE_KEY);
        return jsonResponse({ operationId, status: "expired" }, 409);
      }
      return jsonResponse({ operationId, status: existing.status });
    }
    const userIds = await this.userIds();
    if (userIds.length > 0) {
      return jsonResponse({ operationId, status: "not_executed", error: "bootstrap_not_required" }, 409);
    }
    const active = await this.storage.get<BootstrapOperation>(BOOTSTRAP_ACTIVE_KEY);
    if (isBootstrapOperation(active) && active.status === "ready" && Date.parse(active.expiresAt) > Date.now()) {
      return jsonResponse({ operationId, status: "not_executed", error: "another_bootstrap_active" }, 409);
    }
    const createdAt = new Date().toISOString();
    const operation: BootstrapOperation = {
      version: 1,
      operationId,
      status: "ready",
      createdAt,
      expiresAt: new Date(Date.now() + BOOTSTRAP_TTL_MS).toISOString(),
    };
    await this.storage.put(operationKey, operation);
    await this.storage.put(BOOTSTRAP_ACTIVE_KEY, operation);
    return jsonResponse({ operationId, status: "ready" });
  }

  async readBootstrap(operationId: string): Promise<Response> {
    const operation = await this.storage.get<BootstrapOperation>(BOOTSTRAP_OPERATION_PREFIX + operationId);
    if (!isBootstrapOperation(operation)) {
      return jsonResponse({ operationId, status: "not_executed" });
    }
    if (operation.status === "ready" && Date.parse(operation.expiresAt) <= Date.now()) {
      const expired = { ...operation, status: "expired" as const };
      await this.storage.put(BOOTSTRAP_OPERATION_PREFIX + operationId, expired);
      const active = await this.storage.get<BootstrapOperation>(BOOTSTRAP_ACTIVE_KEY);
      if (active?.operationId === operationId) await this.storage.delete(BOOTSTRAP_ACTIVE_KEY);
      return jsonResponse({ operationId, status: "expired" });
    }
    return jsonResponse({ operationId, status: operation.status });
  }

  async beginAdminLogin(): Promise<Response> {
    return this.beginMicrosoftFlow({ kind: "admin" });
  }

  async beginInviteJoin(inviteToken: string): Promise<Response> {
    if (!isOpaqueToken(inviteToken)) return jsonResponse({ error: "invalid_invite" }, 400);
    const inviteHash = await sha256Base64Url(inviteToken);
    const invitation = await this.storage.get<InvitationRecord>(INVITE_PREFIX + inviteHash);
    if (!isInvitationRecord(invitation) || Date.parse(invitation.expiresAt) <= Date.now()) {
      return jsonResponse({ error: "invalid_invite" }, 400);
    }
    return this.beginMicrosoftFlow({ kind: "join", inviteHash });
  }

  async renderAdmin(request: Request): Promise<Response> {
    const context = await this.readAdminSession(request);
    if (!context) {
      return new Response(null, {
        status: 302,
        headers: { location: new URL("/admin/login", this.config.publicBaseUrl).href, "cache-control": "no-store" },
      });
    }
    const users = await this.listUsers();
    return htmlResponse(adminPage(users, context.session.csrfToken));
  }

  async createInvite(request: Request): Promise<Response> {
    const context = await this.requireAdminPost(request);
    if (context instanceof Response) return context;
    const fields = context.fields;
    const role = fields.get("role");
    if (!isRole(role)) return jsonResponse({ error: "invalid_role" }, 400);
    const token = randomToken();
    const now = new Date().toISOString();
    const invitation: InvitationRecord = {
      version: 1,
      role,
      createdByUserId: context.user.id,
      createdAt: now,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
    };
    await this.storage.put(INVITE_PREFIX + await sha256Base64Url(token), invitation);
    const join = new URL("/join", this.config.publicBaseUrl);
    join.searchParams.set("invite", token);
    return htmlResponse(`<!doctype html><html><body><main><h1>Invitation created</h1><p><a href="${htmlEscape(join.href)}">${htmlEscape(join.href)}</a></p><p>This link expires in 30 minutes and can be used once.</p><p><a href="/admin">Back</a></p></main></body></html>`);
  }

  async changeUserRole(request: Request, userId: string): Promise<Response> {
    const context = await this.requireAdminPost(request);
    if (context instanceof Response) return context;
    const role = context.fields.get("role");
    if (!isRole(role)) return jsonResponse({ error: "invalid_role" }, 400);
    const target = await this.getUser(userId);
    if (!target || target.status !== "active") return jsonResponse({ error: "user_not_found" }, 404);
    if (target.role === "admin" && role !== "admin" && await this.activeAdminCount() <= 1) {
      return jsonResponse({ error: "last_admin_required" }, 409);
    }
    const updated = { ...target, role, updatedAt: new Date().toISOString() } satisfies UpdateControlUser;
    await this.storage.put(USER_PREFIX + target.id, updated);
    return new Response(null, { status: 303, headers: { location: "/admin", "cache-control": "no-store" } });
  }

  async revokeUser(request: Request, userId: string): Promise<Response> {
    const context = await this.requireAdminPost(request);
    if (context instanceof Response) return context;
    const target = await this.getUser(userId);
    if (!target || target.status !== "active") return jsonResponse({ error: "user_not_found" }, 404);
    if (target.role === "admin" && await this.activeAdminCount() <= 1) {
      return jsonResponse({ error: "last_admin_required" }, 409);
    }
    await this.storage.put(USER_PREFIX + target.id, {
      ...target,
      status: "revoked",
      updatedAt: new Date().toISOString(),
    } satisfies UpdateControlUser);
    return new Response(null, { status: 303, headers: { location: "/admin", "cache-control": "no-store" } });
  }

  async logoutAdmin(request: Request): Promise<Response> {
    const context = await this.requireAdminPost(request);
    if (context instanceof Response) return context;
    const token = readCookie(request.headers.get("cookie"), "update_control_admin_session");
    if (token && isOpaqueToken(token)) {
      await this.storage.delete(ADMIN_SESSION_PREFIX + await sha256Base64Url(token));
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/admin",
        "set-cookie": "update_control_admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        "cache-control": "no-store",
      },
    });
  }

  async getPendingMicrosoft(state: string): Promise<Response> {
    if (!isOpaqueToken(state)) return jsonResponse({ error: "invalid_state" }, 400);
    const pending = await this.storage.get<PendingMicrosoftAuthorization>(PENDING_PREFIX + state);
    if (!isPendingAuthorization(pending) || pending.expiresAtMs <= Date.now()) {
      return jsonResponse({ error: "authorization_expired" }, 400);
    }
    return jsonResponse({ state, codeVerifier: pending.microsoftCodeVerifier });
  }

  async completeMicrosoftIdentity(input: MicrosoftIdentityCompletion): Promise<Response> {
    if (
      !isOpaqueToken(input.state) ||
      !validBoundedText(input.subject, 1, 512) ||
      !validBoundedText(input.displayName, 1, 200) ||
      (input.email !== undefined && !validBoundedText(input.email, 3, 320))
    ) {
      return jsonResponse({ error: "invalid_identity" }, 400);
    }
    const pendingKey = PENDING_PREFIX + input.state;
    const pending = await this.storage.get<PendingMicrosoftAuthorization>(pendingKey);
    if (!isPendingAuthorization(pending) || pending.expiresAtMs <= Date.now()) {
      return jsonResponse({ error: "authorization_expired" }, 400);
    }

    let user = await this.findMicrosoftUser(input.subject);
    if (!user) {
      if (pending.kind === "join") {
        if (!pending.inviteHash) {
          await this.storage.delete(pendingKey);
          return jsonResponse({ error: "invalid_invite" }, 400);
        }
        const invitation = await this.storage.get<InvitationRecord>(INVITE_PREFIX + pending.inviteHash);
        if (!isInvitationRecord(invitation) || Date.parse(invitation.expiresAt) <= Date.now()) {
          await this.storage.delete(pendingKey);
          return jsonResponse({ error: "invalid_invite" }, 400);
        }
        user = await this.createMicrosoftUser(input, invitation.role);
        await this.storage.delete(INVITE_PREFIX + pending.inviteHash);
      } else {
        const userIds = await this.userIds();
        const bootstrap = await this.storage.get<BootstrapOperation>(BOOTSTRAP_ACTIVE_KEY);
        if (
          userIds.length !== 0 ||
          !isBootstrapOperation(bootstrap) ||
          bootstrap.status !== "ready" ||
          Date.parse(bootstrap.expiresAt) <= Date.now()
        ) {
          await this.storage.delete(pendingKey);
          return jsonResponse({ error: "identity_not_enrolled" }, 403);
        }
        if (!input.email || normalizeEmail(input.email) !== normalizeEmail(this.config.bootstrapAdminEmail)) {
          await this.storage.delete(pendingKey);
          return jsonResponse({ error: "bootstrap_identity_mismatch" }, 403);
        }
        user = await this.createMicrosoftUser(input, "admin");
        const completedAt = new Date().toISOString();
        const completed: BootstrapOperation = {
          ...bootstrap,
          status: "completed",
          completedAt,
        };
        await this.storage.put(BOOTSTRAP_OPERATION_PREFIX + bootstrap.operationId, completed);
        await this.storage.delete(BOOTSTRAP_ACTIVE_KEY);
      }
    } else if (pending.kind === "join") {
      await this.storage.delete(pendingKey);
      return jsonResponse({ error: "identity_already_enrolled" }, 409);
    }

    if (user.status !== "active") {
      await this.storage.delete(pendingKey);
      return jsonResponse({ error: "identity_disabled" }, 403);
    }

    if (pending.kind === "admin") {
      await this.storage.delete(pendingKey);
      if (user.role !== "admin") return jsonResponse({ error: "admin_required" }, 403);
      return this.createAdminSession(user);
    }

    if (pending.kind === "join") {
      await this.storage.delete(pendingKey);
      return htmlResponse(`<!doctype html><html><body><main><h1>Access enabled</h1><p>${htmlEscape(user.displayName)} is enrolled as ${htmlEscape(user.role)}.</p><p>You can now connect MCP V3 Update Center in ChatGPT.</p></main></body></html>`);
    }

    if (!pending.clientId || !pending.redirectUri || !pending.codeChallenge ||
        !pending.scopes || !pending.resource) {
      await this.storage.delete(pendingKey);
      return jsonResponse({ error: "authorization_unavailable" }, 503);
    }
    const code = "code-" + randomToken();
    await this.storage.put(CODE_PREFIX + await sha256Base64Url(code), {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: [...pending.scopes],
      resource: pending.resource,
      expiresAtMs: Date.now() + AUTHORIZATION_CODE_TTL_MS,
      userId: user.id,
    } satisfies AuthorizationCodeRecord);
    await this.storage.delete(pendingKey);

    const target = new URL(pending.redirectUri);
    target.searchParams.set("code", code);
    if (pending.clientState) target.searchParams.set("state", pending.clientState);
    return new Response(null, {
      status: 302,
      headers: {
        location: target.href,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  async deleteOAuthState(limit = 4096): Promise<{ deleted: number; complete: boolean }> {
    let deleted = 0;
    while (deleted < limit) {
      const batch = await this.storage.listPrefix(UPDATE_CONTROL_OAUTH_STORAGE_PREFIX, Math.min(256, limit - deleted));
      const keys = [...batch.keys()];
      if (keys.length === 0) return { deleted, complete: true };
      deleted += await this.storage.deleteMany(keys);
    }
    const remaining = await this.storage.listPrefix(UPDATE_CONTROL_OAUTH_STORAGE_PREFIX, 1);
    return { deleted, complete: remaining.size === 0 };
  }

  async listUsers(): Promise<UpdateControlUser[]> {
    const users: UpdateControlUser[] = [];
    for (const id of await this.userIds()) {
      const user = await this.getUser(id);
      if (user) users.push(user);
    }
    return users;
  }

  private async beginMicrosoftFlow(
    input: { kind: "admin" } | { kind: "join"; inviteHash: string },
  ): Promise<Response> {
    const state = randomToken();
    const microsoftCodeVerifier = randomToken();
    const pending: PendingMicrosoftAuthorization = {
      version: 1,
      state,
      kind: input.kind,
      microsoftCodeVerifier,
      expiresAtMs: Date.now() + MICROSOFT_PENDING_TTL_MS,
      ...(input.kind === "join" ? { inviteHash: input.inviteHash } : {}),
    };
    await this.storage.put(PENDING_PREFIX + state, pending);
    const target = microsoftAuthorizeUrl(
      this.config.microsoftTenant,
      this.config.microsoftClientId,
      new URL("/auth/microsoft/callback", this.config.publicBaseUrl).href,
      state,
      await sha256Base64Url(microsoftCodeVerifier),
    );
    return new Response(null, {
      status: 302,
      headers: {
        location: target.href,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  private async createAdminSession(user: UpdateControlUser): Promise<Response> {
    const token = randomToken();
    const now = new Date().toISOString();
    const session: AdminSessionRecord = {
      version: 1,
      userId: user.id,
      csrfToken: randomToken(),
      createdAt: now,
      expiresAt: new Date(Date.now() + ADMIN_SESSION_TTL_MS).toISOString(),
    };
    await this.storage.put(ADMIN_SESSION_PREFIX + await sha256Base64Url(token), session);
    return new Response(null, {
      status: 302,
      headers: {
        location: new URL("/admin", this.config.publicBaseUrl).href,
        "set-cookie": `update_control_admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
        "cache-control": "no-store",
      },
    });
  }

  private async readAdminSession(
    request: Request,
  ): Promise<{ user: UpdateControlUser; session: AdminSessionRecord } | null> {
    const token = readCookie(request.headers.get("cookie"), "update_control_admin_session");
    if (!token || !isOpaqueToken(token)) return null;
    const key = ADMIN_SESSION_PREFIX + await sha256Base64Url(token);
    const session = await this.storage.get<AdminSessionRecord>(key);
    if (!isAdminSessionRecord(session) || Date.parse(session.expiresAt) <= Date.now()) {
      await this.storage.delete(key);
      return null;
    }
    const user = await this.getUser(session.userId);
    if (!user || user.status !== "active" || user.role !== "admin") return null;
    return { user, session };
  }

  private async requireAdminPost(
    request: Request,
  ): Promise<Response | {
    user: UpdateControlUser;
    session: AdminSessionRecord;
    fields: URLSearchParams;
  }> {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    const context = await this.readAdminSession(request);
    if (!context) return jsonResponse({ error: "admin_auth_required" }, 401);
    const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/x-www-form-urlencoded") {
      return jsonResponse({ error: "invalid_content_type" }, 415);
    }
    let fields: URLSearchParams;
    try {
      fields = new URLSearchParams(await readBoundedText(request, 16 * 1024));
    } catch {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    const csrf = fields.get("csrf") ?? "";
    if (!isOpaqueToken(csrf) || !await constantTimeTextEquals(csrf, context.session.csrfToken)) {
      return jsonResponse({ error: "csrf_rejected" }, 403);
    }
    return { ...context, fields };
  }

  private async activeAdminCount(): Promise<number> {
    let count = 0;
    for (const user of await this.listUsers()) {
      if (user.status === "active" && user.role === "admin") count += 1;
    }
    return count;
  }

  private async register(request: Request): Promise<Response> {
    let input: unknown;
    try {
      input = await request.json();
    } catch {
      return oauthError("invalid_client_metadata", 400);
    }
    if (!isRecord(input) || !Array.isArray(input.redirect_uris)) {
      return oauthError("invalid_client_metadata", 400);
    }
    const redirects = input.redirect_uris;
    if (
      redirects.length === 0 ||
      redirects.length > 16 ||
      !redirects.every((value) => typeof value === "string" && this.redirectAllowed(value)) ||
      (input.token_endpoint_auth_method !== undefined && input.token_endpoint_auth_method !== "none")
    ) {
      return oauthError("invalid_client_metadata", 400);
    }
    const existingCount = (await this.storage.get<number>(CLIENT_COUNT_KEY)) ?? 0;
    if (existingCount >= MAX_CLIENTS) return oauthError("invalid_client_metadata", 400);
    const now = nowSeconds();
    const client: OAuthClient = {
      client_id: "mcp-" + crypto.randomUUID(),
      client_id_issued_at: now,
      redirect_uris: [...redirects] as string[],
      ...(typeof input.client_name === "string" && input.client_name.length > 0
        ? { client_name: input.client_name.slice(0, 200) }
        : {}),
      token_endpoint_auth_method: "none",
      grant_types: readStringArray(input.grant_types, ["authorization_code", "refresh_token"]),
      response_types: readStringArray(input.response_types, ["code"]),
    };
    if (
      !client.grant_types.every((value) => value === "authorization_code" || value === "refresh_token") ||
      !client.response_types.every((value) => value === "code")
    ) {
      return oauthError("invalid_client_metadata", 400);
    }
    await this.storage.put(CLIENT_PREFIX + client.client_id, client);
    await this.storage.put(CLIENT_COUNT_KEY, existingCount + 1);
    return jsonResponse(client, 201);
  }

  private async authorize(request: Request): Promise<Response> {
    const fields = request.method === "GET"
      ? new URL(request.url).searchParams
      : new URLSearchParams(await request.text());
    const clientId = fields.get("client_id") ?? "";
    const client = await this.storage.get<OAuthClient>(CLIENT_PREFIX + clientId);
    if (!isOAuthClient(client)) return oauthError("invalid_request", 400);

    const redirectUri = fields.get("redirect_uri") ?? "";
    const codeChallenge = fields.get("code_challenge") ?? "";
    const resource = fields.get("resource") ?? "";
    const scopes = parseScopes(fields.get("scope") ?? this.config.scopes.join(" "));
    if (
      fields.get("response_type") !== "code" ||
      fields.get("code_challenge_method") !== "S256" ||
      !/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge) ||
      !client.redirect_uris.includes(redirectUri) ||
      resource !== this.mcpUrl.href ||
      scopes.length === 0 ||
      !scopes.every((scope) => this.config.scopes.includes(scope))
    ) {
      return oauthError("invalid_request", 400);
    }

    const state = randomToken();
    const microsoftCodeVerifier = randomToken();
    const pending: PendingMicrosoftAuthorization = {
      version: 1,
      state,
      kind: "mcp",
      clientId,
      redirectUri,
      codeChallenge,
      scopes,
      resource,
      ...(fields.get("state") ? { clientState: fields.get("state")! } : {}),
      microsoftCodeVerifier,
      expiresAtMs: Date.now() + MICROSOFT_PENDING_TTL_MS,
    };
    await this.storage.put(PENDING_PREFIX + state, pending);

    const target = microsoftAuthorizeUrl(
      this.config.microsoftTenant,
      this.config.microsoftClientId,
      new URL("/auth/microsoft/callback", this.config.publicBaseUrl).href,
      state,
      await sha256Base64Url(microsoftCodeVerifier),
    );
    return new Response(null, {
      status: 302,
      headers: {
        location: target.href,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  private async token(request: Request): Promise<Response> {
    const fields = new URLSearchParams(await request.text());
    const grantType = fields.get("grant_type");
    const clientId = fields.get("client_id") ?? "";
    const client = await this.storage.get<OAuthClient>(CLIENT_PREFIX + clientId);
    if (!isOAuthClient(client)) return oauthError("invalid_client", 400);

    if (grantType === "authorization_code") {
      const rawCode = fields.get("code") ?? "";
      const key = CODE_PREFIX + await sha256Base64Url(rawCode);
      const record = await this.storage.get<AuthorizationCodeRecord>(key);
      if (!isAuthorizationCodeRecord(record) || record.clientId !== clientId || record.expiresAtMs < Date.now()) {
        return oauthError("invalid_grant", 400);
      }
      if (
        fields.get("redirect_uri") !== record.redirectUri ||
        fields.get("resource") !== record.resource ||
        await sha256Base64Url(fields.get("code_verifier") ?? "") !== record.codeChallenge
      ) {
        return oauthError("invalid_grant", 400);
      }
      const user = await this.getUser(record.userId);
      if (!user || user.status !== "active") return oauthError("invalid_grant", 400);
      await this.storage.delete(key);
      return jsonResponse(await this.issueTokens(clientId, record.scopes, record.resource, user.id));
    }

    if (grantType === "refresh_token") {
      const rawRefresh = fields.get("refresh_token") ?? "";
      const key = REFRESH_PREFIX + await sha256Base64Url(rawRefresh);
      const record = await this.storage.get<RefreshTokenRecord>(key);
      if (!isRefreshTokenRecord(record) || record.clientId !== clientId || record.expiresAt <= nowSeconds()) {
        return oauthError("invalid_grant", 400);
      }
      const signing = await this.getSigningMaterial(false);
      if (!signing || signing.version !== record.signingVersion) return oauthError("invalid_grant", 400);
      const user = await this.getUser(record.userId);
      if (!user || user.status !== "active") return oauthError("invalid_grant", 400);
      const resource = fields.get("resource") ?? record.resource;
      if (resource !== record.resource) return oauthError("invalid_grant", 400);
      const requested = parseScopes(fields.get("scope") ?? record.scopes.join(" "));
      if (!requested.every((scope) => record.scopes.includes(scope))) return oauthError("invalid_scope", 400);
      await this.storage.delete(key);
      return jsonResponse(await this.issueTokens(clientId, requested, record.resource, user.id));
    }

    return oauthError("unsupported_grant_type", 400);
  }

  private async revoke(request: Request): Promise<Response> {
    const fields = new URLSearchParams(await request.text());
    const token = fields.get("token") ?? "";
    if (!token) return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
    const claims = await this.verifyAccessToken(token).catch(() => null);
    if (claims) {
      await this.storage.put(REVOKED_PREFIX + claims.jti, { expiresAt: claims.exp } satisfies RevokedAccessRecord);
    } else {
      await this.storage.delete(REFRESH_PREFIX + await sha256Base64Url(token));
    }
    return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const now = nowSeconds();
    const signing = await this.getSigningMaterial(true);
    if (!signing) throw new Error("OAuth signing material is unavailable.");
    const claims: AccessClaims = {
      iss: this.config.publicBaseUrl.href,
      aud: resource,
      sub: "user:" + userId,
      scope: scopes.join(" "),
      client_id: clientId,
      owner_scope: "owner",
      user_id: userId,
      iat: now,
      exp: now + this.config.accessTokenTtlSeconds,
      jti: crypto.randomUUID(),
    };
    const accessToken = await this.signAccessToken(claims, signing);
    const refreshToken = "refresh-" + randomToken();
    await this.storage.put(REFRESH_PREFIX + await sha256Base64Url(refreshToken), {
      clientId,
      scopes: [...scopes],
      resource,
      expiresAt: now + this.config.refreshTokenTtlSeconds,
      signingVersion: signing.version,
      userId,
    } satisfies RefreshTokenRecord);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.config.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private async signAccessToken(claims: AccessClaims, signing: SigningMaterial): Promise<string> {
    const header = base64UrlText(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = base64UrlText(JSON.stringify(claims));
    const input = header + "." + payload;
    const key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(decodeBase64UrlBytes(signing.key)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input)));
    return input + "." + base64UrlBytes(signature);
  }

  private async verifyAccessToken(token: string): Promise<AccessClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
    const header = JSON.parse(decodeBase64UrlText(encodedHeader)) as unknown;
    const payload = JSON.parse(decodeBase64UrlText(encodedPayload)) as unknown;
    if (!isRecord(header) || header.alg !== "HS256" || header.typ !== "JWT" || !isAccessClaims(payload)) {
      throw new Error("invalid token");
    }
    const signing = await this.getSigningMaterial(false);
    if (!signing) throw new Error("invalid token");
    const key = await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(decodeBase64UrlBytes(signing.key)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      toArrayBuffer(decodeBase64UrlBytes(encodedSignature)),
      new TextEncoder().encode(encodedHeader + "." + encodedPayload),
    );
    if (
      !valid ||
      payload.iss !== this.config.publicBaseUrl.href ||
      payload.aud !== this.mcpUrl.href ||
      payload.owner_scope !== "owner"
    ) {
      throw new Error("invalid token");
    }
    return payload;
  }

  private async getSigningMaterial(create: boolean): Promise<SigningMaterial | undefined> {
    const existing = await this.storage.get<SigningMaterial>(SIGNING_KEY);
    if (isSigningMaterial(existing)) return existing;
    if (!create) return undefined;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const created: SigningMaterial = {
      key: base64UrlBytes(bytes),
      version: crypto.randomUUID(),
    };
    await this.storage.put(SIGNING_KEY, created);
    return created;
  }

  private async findMicrosoftUser(subject: string): Promise<UpdateControlUser | null> {
    const userId = await this.storage.get<string>(MICROSOFT_SUBJECT_PREFIX + await sha256Base64Url(subject));
    return userId ? this.getUser(userId) : null;
  }

  private async createMicrosoftUser(
    identity: MicrosoftIdentityCompletion,
    role: UpdateControlRole,
  ): Promise<UpdateControlUser> {
    const now = new Date().toISOString();
    const user: UpdateControlUser = {
      version: 1,
      id: "usr_" + crypto.randomUUID(),
      displayName: identity.displayName.trim(),
      ...(identity.email ? { email: identity.email.trim() } : {}),
      role,
      status: "active",
      provider: "microsoft",
      providerSubject: identity.subject,
      createdAt: now,
      updatedAt: now,
    };
    const ids = await this.userIds();
    await this.storage.put(USER_PREFIX + user.id, user);
    await this.storage.put(MICROSOFT_SUBJECT_PREFIX + await sha256Base64Url(identity.subject), user.id);
    await this.storage.put(USER_IDS_KEY, [...ids, user.id]);
    return user;
  }

  private async userIds(): Promise<string[]> {
    const value = await this.storage.get<unknown>(USER_IDS_KEY);
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : [];
  }

  private async getUser(userId: string): Promise<UpdateControlUser | null> {
    const value = await this.storage.get<unknown>(USER_PREFIX + userId);
    return isUpdateControlUser(value) ? value : null;
  }

  private redirectAllowed(value: string): boolean {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true;
    if (url.protocol === "https:" && url.hostname === "chatgpt.com") {
      const segments = url.pathname.split("/").filter(Boolean);
      return !url.username && !url.password && !url.search && !url.hash &&
        segments.length === 3 && segments[0] === "connector" && segments[1] === "oauth" && Boolean(segments[2]);
    }
    return url.protocol === "https:" &&
      url.hostname === this.config.publicBaseUrl.hostname &&
      !url.username &&
      !url.password;
  }
}

function microsoftAuthorizeUrl(
  tenant: string,
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
): URL {
  const url = new URL("https://login.microsoftonline.com/" + tenant + "/oauth2/v2.0/authorize");
  url.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: "openid profile email",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

function isMicrosoftTenant(value: string): boolean {
  return value === "common" ||
    value === "organizations" ||
    value === "consumers" ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isBootstrapAdminEmail(value: string): boolean {
  return value.length >= 3 &&
    value.length <= 320 &&
    !/[\u0000-\u0020\u007f]/u.test(value) &&
    /^[^@]+@[^@]+$/u.test(value);
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isOAuthClient(value: unknown): value is OAuthClient {
  return isRecord(value) &&
    typeof value.client_id === "string" &&
    Number.isFinite(value.client_id_issued_at) &&
    Array.isArray(value.redirect_uris) &&
    value.redirect_uris.every((entry) => typeof entry === "string") &&
    value.token_endpoint_auth_method === "none" &&
    Array.isArray(value.grant_types) &&
    value.grant_types.every((entry) => typeof entry === "string") &&
    Array.isArray(value.response_types) &&
    value.response_types.every((entry) => typeof entry === "string");
}

function isPendingAuthorization(value: unknown): value is PendingMicrosoftAuthorization {
  if (!isRecord(value) ||
      value.version !== 1 ||
      typeof value.state !== "string" ||
      (value.kind !== "mcp" && value.kind !== "admin" && value.kind !== "join") ||
      typeof value.microsoftCodeVerifier !== "string" ||
      !Number.isFinite(value.expiresAtMs)) {
    return false;
  }
  if (value.kind === "mcp") {
    return typeof value.clientId === "string" &&
      typeof value.redirectUri === "string" &&
      typeof value.codeChallenge === "string" &&
      Array.isArray(value.scopes) &&
      value.scopes.every((entry) => typeof entry === "string") &&
      typeof value.resource === "string" &&
      (value.clientState === undefined || typeof value.clientState === "string");
  }
  if (value.kind === "join") return typeof value.inviteHash === "string";
  return true;
}

function isAuthorizationCodeRecord(value: unknown): value is AuthorizationCodeRecord {
  return isRecord(value) &&
    typeof value.clientId === "string" &&
    typeof value.redirectUri === "string" &&
    typeof value.codeChallenge === "string" &&
    Array.isArray(value.scopes) &&
    value.scopes.every((entry) => typeof entry === "string") &&
    typeof value.resource === "string" &&
    Number.isFinite(value.expiresAtMs) &&
    typeof value.userId === "string";
}

function isRefreshTokenRecord(value: unknown): value is RefreshTokenRecord {
  return isRecord(value) &&
    typeof value.clientId === "string" &&
    Array.isArray(value.scopes) &&
    value.scopes.every((entry) => typeof entry === "string") &&
    typeof value.resource === "string" &&
    Number.isFinite(value.expiresAt) &&
    typeof value.signingVersion === "string" &&
    typeof value.userId === "string";
}

function isSigningMaterial(value: unknown): value is SigningMaterial {
  return isRecord(value) &&
    typeof value.key === "string" &&
    /^[A-Za-z0-9_-]{43}$/u.test(value.key) &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
    value.version.length <= 64;
}

function isBootstrapOperation(value: unknown): value is BootstrapOperation {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.operationId === "string" &&
    (value.status === "ready" || value.status === "completed" || value.status === "expired") &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    (value.completedAt === undefined ||
      (typeof value.completedAt === "string" && Number.isFinite(Date.parse(value.completedAt))));
}

function isUpdateControlUser(value: unknown): value is UpdateControlUser {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    /^usr_[0-9a-f-]{36}$/iu.test(value.id) &&
    typeof value.displayName === "string" &&
    (value.email === undefined || typeof value.email === "string") &&
    (value.role === "admin" || value.role === "operator" || value.role === "viewer") &&
    (value.status === "active" || value.status === "revoked") &&
    value.provider === "microsoft" &&
    typeof value.providerSubject === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

function isAccessClaims(value: unknown): value is AccessClaims {
  return isRecord(value) &&
    typeof value.iss === "string" &&
    typeof value.aud === "string" &&
    typeof value.sub === "string" &&
    typeof value.scope === "string" &&
    typeof value.client_id === "string" &&
    value.owner_scope === "owner" &&
    typeof value.user_id === "string" &&
    /^usr_[0-9a-f-]{36}$/iu.test(value.user_id) &&
    typeof value.iat === "number" &&
    typeof value.exp === "number" &&
    typeof value.jti === "string";
}

function isInvitationRecord(value: unknown): value is InvitationRecord {
  return isRecord(value) &&
    value.version === 1 &&
    isRole(value.role) &&
    typeof value.createdByUserId === "string" &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt));
}

function isAdminSessionRecord(value: unknown): value is AdminSessionRecord {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.userId === "string" &&
    typeof value.csrfToken === "string" &&
    isOpaqueToken(value.csrfToken) &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt));
}

function isRole(value: unknown): value is UpdateControlRole {
  return value === "admin" || value === "operator" || value === "viewer";
}

function adminPage(users: UpdateControlUser[], csrfToken: string): string {
  const rows = users.map((user) => {
    const roleOptions = ["admin", "operator", "viewer"].map((role) =>
      `<option value="${role}"${user.role === role ? " selected" : ""}>${role}</option>`).join("");
    const controls = user.status === "active"
      ? `<form method="post" action="/admin/users/${encodeURIComponent(user.id)}/role"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><select name="role">${roleOptions}</select><button type="submit">Change role</button></form><form method="post" action="/admin/users/${encodeURIComponent(user.id)}/revoke"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><button type="submit">Revoke</button></form>`
      : "";
    return `<tr><td>${htmlEscape(user.displayName)}</td><td>${htmlEscape(user.email ?? "")}</td><td>${htmlEscape(user.role)}</td><td>${htmlEscape(user.status)}</td><td>${controls}</td></tr>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP V3 Update Center admin</title></head><body><main><h1>MCP V3 Update Center</h1><h2>Users</h2><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table><h2>Invite user</h2><form method="post" action="/admin/invites"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><select name="role"><option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option></select><button type="submit">Create invite</button></form><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><button type="submit">Sign out</button></form></main></body></html>`;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    if (key !== name) continue;
    return pair.slice(index + 1).trim();
  }
  return null;
}

async function readBoundedText(request: Request, maximumBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await request.body?.cancel();
    throw new Error("request too large");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("request too large");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function constantTimeTextEquals(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aDigest, bDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const a = new Uint8Array(aDigest);
  const b = new Uint8Array(bDigest);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index]! ^ b[index]!;
  return difference === 0;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function readStringArray(value: unknown, fallback: string[]): string[] {
  return value === undefined
    ? fallback
    : Array.isArray(value) && value.every((entry) => typeof entry === "string")
      ? [...value]
      : [];
}

function validBoundedText(value: string, min: number, max: number): boolean {
  return value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isOpaqueToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlBytes(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  return base64UrlBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function base64UrlText(value: string): string {
  return base64UrlBytes(new TextEncoder().encode(value));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64UrlText(value: string): string {
  return new TextDecoder().decode(decodeBase64UrlBytes(value));
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function oauthError(error: string, status: number): Response {
  return jsonResponse({ error }, status);
}
