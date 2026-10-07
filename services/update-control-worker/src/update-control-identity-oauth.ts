import {
  EdgeAuthenticationError,
  createBearerChallenge,
  parseScopes,
  readBearerToken,
  type OwnerOAuthStorage,
} from "@mcp-access-stack/mcp-owner-auth";
import {
  isTotpEncryptionKey,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  UPDATE_CONTROL_TOTP_ISSUER,
} from "./local-totp.js";

const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const LOGIN_PENDING_TTL_MS = 10 * 60 * 1000;
const ENROLLMENT_PENDING_TTL_MS = 10 * 60 * 1000;
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const INVITE_TTL_MS = 30 * 60 * 1000;
const HUMAN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_STATE_TTL_SECONDS = Math.floor(LOGIN_PENDING_TTL_MS / 1000);
const HUMAN_SESSION_COOKIE = "update_control_session";
const LOGIN_STATE_COOKIE = "update_control_login";
const LEGACY_ADMIN_SESSION_COOKIE = "update_control_admin_session";
const TOTP_MAX_FAILURES = 5;
const TOTP_LOCK_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 256;
const MAX_SCOPES = 64;

const USER_IDS_KEY = "update-control:identity:user-ids:v1";
const USER_PREFIX = "update-control:identity:user:";
const EMAIL_PREFIX = "update-control:identity:email:";
const CREDENTIAL_PREFIX = "update-control:identity:totp:";
const BOOTSTRAP_ACTIVE_KEY = "update-control:identity:bootstrap:active";
const BOOTSTRAP_OPERATION_PREFIX = "update-control:identity:bootstrap:operation:";
const INVITE_PREFIX = "update-control:identity:invite:";
const ENROLLMENT_PREFIX = "update-control:identity:enrollment:";
export const UPDATE_CONTROL_OAUTH_STORAGE_PREFIX = "update-control:oauth:";
const ADMIN_SESSION_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "admin-session:";
const HUMAN_SESSION_PREFIX = "update-control:identity:session:";
const CLIENT_COUNT_KEY = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "client-count";
const CLIENT_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "client:";
const LOGIN_PENDING_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "login-pending:";
const CODE_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "code:";
const REFRESH_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "refresh:";
const REVOKED_PREFIX = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "revoked:";
const SIGNING_KEY = UPDATE_CONTROL_OAUTH_STORAGE_PREFIX + "signing:v1";

export type UpdateControlRole = "admin" | "user";
type StoredUpdateControlRole = UpdateControlRole | "operator" | "viewer";

export type UpdateControlUser = {
  version: 1;
  id: string;
  displayName: string;
  email: string;
  role: UpdateControlRole;
  status: "active" | "revoked";
  provider: "local-totp";
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

type PendingLogin = {
  version: 1;
  state: string;
  kind: "mcp" | "oauth" | "admin" | "user";
  expiresAtMs: number;
  clientId?: string;
  redirectUri?: string;
  codeChallenge?: string;
  scopes?: string[];
  resource?: string;
  clientState?: string;
};

type PendingEnrollment = {
  version: 1;
  state: string;
  kind: "bootstrap" | "join";
  role: StoredUpdateControlRole;
  encryptedSecret: EncryptedSecret;
  expiresAtMs: number;
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
  role: StoredUpdateControlRole;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string;
};

type HumanSessionRecord = {
  version: 1;
  userId: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
};

type HumanSessionContext = {
  user: UpdateControlUser;
  session: HumanSessionRecord;
  key: string;
  cookieName: string;
};

type EncryptedSecret = {
  version: 1;
  iv: string;
  ciphertext: string;
};

type TotpCredential = {
  version: 1;
  userId: string;
  encryptedSecret: EncryptedSecret;
  lastAcceptedCounter?: number;
  recoveryCodeHashes: string[];
  failedAttempts: number;
  lockedUntilMs?: number;
  createdAt: string;
  updatedAt: string;
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
  bootstrapAdminEmail: string;
  totpEncryptionKey: string;
  scopes: string[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  resourceName: string;
}

export interface UpdateControlIdentityStorage extends OwnerOAuthStorage {
  listPrefix(prefix: string, limit: number): Promise<Map<string, unknown>>;
  deleteMany(keys: string[]): Promise<number>;
}

export class UpdateControlIdentityOAuth {
  private readonly mcpUrl: URL;
  private readonly resourceMetadataUrl: URL;
  private readonly challenge: string;
  private readonly encryptionKeyBytes: Uint8Array;

  constructor(
    private readonly storage: UpdateControlIdentityStorage,
    private readonly config: UpdateControlIdentityOAuthConfig,
  ) {
    if (!isBootstrapAdminEmail(config.bootstrapAdminEmail)) {
      throw new Error("UPDATE_CONTROL_BOOTSTRAP_ADMIN_EMAIL is invalid.");
    }
    if (!isTotpEncryptionKey(config.totpEncryptionKey)) {
      throw new Error("UPDATE_CONTROL_TOTP_ENCRYPTION_KEY must be 64 lowercase hex characters.");
    }
    if (config.scopes.length === 0 || config.scopes.length > MAX_SCOPES) {
      throw new Error("Update Control OAuth scopes are invalid.");
    }
    this.encryptionKeyBytes = decodeHex(config.totpEncryptionKey);
    this.mcpUrl = new URL("/mcp", config.publicBaseUrl);
    this.resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.publicBaseUrl);
    this.challenge = createBearerChallenge(this.resourceMetadataUrl, config.scopes[0] ?? "update:read");
  }

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
      return jsonResponse({
        issuer: this.config.publicBaseUrl.href,
        authorization_endpoint: new URL("/oauth", this.config.publicBaseUrl).href,
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
    if (url.pathname === "/user") {
      if (request.method === "GET") return this.beginUserLogin(request);
      if (request.method === "POST") return this.completeUserLogin(request);
      return jsonResponse({ error: "method_not_allowed" }, 405);
    }
    if (url.pathname === "/user/logout") return this.logoutUser(request);
    if (url.pathname === "/register" && request.method === "POST") return this.register(request);
    if (url.pathname === "/oauth" || url.pathname === "/authorize") {
      if (request.method === "GET" || request.method === "POST") return this.handleAuthorization(request);
      return jsonResponse({ error: "method_not_allowed" }, 405);
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
    if ((await this.userIds()).length > 0) {
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
    if (!isBootstrapOperation(operation)) return jsonResponse({ operationId, status: "not_executed" });
    if (operation.status === "ready" && Date.parse(operation.expiresAt) <= Date.now()) {
      const expired = { ...operation, status: "expired" as const };
      await this.storage.put(BOOTSTRAP_OPERATION_PREFIX + operationId, expired);
      const active = await this.storage.get<BootstrapOperation>(BOOTSTRAP_ACTIVE_KEY);
      if (active?.operationId === operationId) await this.storage.delete(BOOTSTRAP_ACTIVE_KEY);
      return jsonResponse({ operationId, status: "expired" });
    }
    return jsonResponse({ operationId, status: operation.status });
  }

  async beginBootstrapEnrollment(): Promise<Response> {
    if ((await this.userIds()).length !== 0) return jsonResponse({ error: "bootstrap_not_required" }, 409);
    const bootstrap = await this.storage.get<BootstrapOperation>(BOOTSTRAP_ACTIVE_KEY);
    if (!isBootstrapOperation(bootstrap) || bootstrap.status !== "ready" ||
        Date.parse(bootstrap.expiresAt) <= Date.now()) {
      return jsonResponse({ error: "bootstrap_not_ready" }, 403);
    }
    return this.beginEnrollment({ kind: "bootstrap", role: "admin" });
  }

  async completeEnrollment(request: Request): Promise<Response> {
    const fields = new URLSearchParams(await readBoundedText(request, 16 * 1024));
    const state = fields.get("state") ?? "";
    const email = normalizeEmail(fields.get("email") ?? "");
    const displayName = (fields.get("display_name") ?? "").trim();
    const code = normalizeVerificationCode(fields.get("code") ?? "");
    if (!isOpaqueToken(state) || !isBootstrapAdminEmail(email) ||
        !validBoundedText(displayName, 1, 200) || !code) {
      return jsonResponse({ error: "invalid_enrollment" }, 400);
    }
    const key = ENROLLMENT_PREFIX + state;
    const pending = await this.storage.get<PendingEnrollment>(key);
    if (!isPendingEnrollment(pending) || pending.expiresAtMs <= Date.now()) {
      await this.storage.delete(key);
      return jsonResponse({ error: "enrollment_expired" }, 400);
    }
    const role = normalizeRole(pending.role);
    if (!role) return jsonResponse({ error: "invalid_enrollment" }, 400);
    if (await this.findUserByEmail(email)) return jsonResponse({ error: "identity_already_enrolled" }, 409);

    if (pending.kind === "bootstrap") {
      const bootstrap = await this.storage.get<BootstrapOperation>(BOOTSTRAP_ACTIVE_KEY);
      if (!isBootstrapOperation(bootstrap) || bootstrap.status !== "ready" ||
          Date.parse(bootstrap.expiresAt) <= Date.now() ||
          (await this.userIds()).length !== 0) {
        return jsonResponse({ error: "bootstrap_not_ready" }, 403);
      }
      if (email !== normalizeEmail(this.config.bootstrapAdminEmail)) {
        return jsonResponse({ error: "bootstrap_identity_mismatch" }, 403);
      }
    } else {
      if (!pending.inviteHash) return jsonResponse({ error: "invalid_invite" }, 400);
      const invitation = await this.storage.get<InvitationRecord>(INVITE_PREFIX + pending.inviteHash);
      if (!isInvitationRecord(invitation) || Date.parse(invitation.expiresAt) <= Date.now() ||
          normalizeRole(invitation.role) !== role) {
        return jsonResponse({ error: "invalid_invite" }, 400);
      }
    }

    let secret: Uint8Array;
    try {
      secret = await this.decryptSecret(pending.encryptedSecret, "enrollment:" + state);
    } catch {
      return jsonResponse({ error: "enrollment_unavailable" }, 503);
    }
    const acceptedCounter = await verifyTotp(secret, code, undefined);
    if (acceptedCounter === null) return jsonResponse({ error: "invalid_credentials" }, 401);

    const user = await this.createLocalUser(email, displayName, role);
    const recoveryCodes = generateRecoveryCodes();
    const credential: TotpCredential = {
      version: 1,
      userId: user.id,
      encryptedSecret: await this.encryptSecret(secret, "user:" + user.id),
      lastAcceptedCounter: acceptedCounter,
      recoveryCodeHashes: await Promise.all(recoveryCodes.map((value) => sha256Base64Url(normalizeRecoveryCode(value)))),
      failedAttempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await this.storage.put(CREDENTIAL_PREFIX + user.id, credential);
    await this.storage.delete(key);

    if (pending.kind === "join" && pending.inviteHash) {
      await this.storage.delete(INVITE_PREFIX + pending.inviteHash);
    }
    if (pending.kind === "bootstrap") {
      const bootstrap = await this.storage.get<BootstrapOperation>(BOOTSTRAP_ACTIVE_KEY);
      if (isBootstrapOperation(bootstrap)) {
        const completedAt = new Date().toISOString();
        await this.storage.put(BOOTSTRAP_OPERATION_PREFIX + bootstrap.operationId, {
          ...bootstrap,
          status: "completed",
          completedAt,
        } satisfies BootstrapOperation);
        await this.storage.delete(BOOTSTRAP_ACTIVE_KEY);
      }
    }

    return htmlResponse(enrollmentCompletedPage(user, recoveryCodes));
  }

  async beginAdminLogin(request: Request): Promise<Response> {
    return this.beginUserLogin(request);
  }

  async completeAdminLogin(request: Request): Promise<Response> {
    return this.completeUserLogin(request);
  }

  async beginUserLogin(request: Request): Promise<Response> {
    const human = await this.readHumanSession(request);
    const state = readCookie(request.headers.get("cookie"), LOGIN_STATE_COOKIE);
    if (human) {
      if (state && isOpaqueToken(state)) {
        const pending = await this.storage.get<unknown>(LOGIN_PENDING_PREFIX + state);
        if (isPendingLogin(pending) && pending.expiresAtMs > Date.now() &&
            (pending.kind === "oauth" || pending.kind === "mcp")) {
          const response = await this.completeAuthorization(state, pending, human.user);
          response.headers.append("set-cookie", expiredCookie(LOGIN_STATE_COOKIE));
          return response;
        }
      }
      return htmlResponse(userPage(human.user, human.session.csrfToken));
    }

    if (state && isOpaqueToken(state)) {
      const pending = await this.storage.get<unknown>(LOGIN_PENDING_PREFIX + state);
      if (isPendingLogin(pending) && pending.expiresAtMs > Date.now()) {
        return htmlResponse(loginPage(state, "/user", "Sign in"));
      }
      await this.storage.delete(LOGIN_PENDING_PREFIX + state);
    }

    const nextState = randomToken();
    const pending: PendingLogin = {
      version: 1,
      state: nextState,
      kind: "user",
      expiresAtMs: Date.now() + LOGIN_PENDING_TTL_MS,
    };
    await this.storage.put(LOGIN_PENDING_PREFIX + nextState, pending);
    const response = htmlResponse(loginPage(nextState, "/user", "Sign in"));
    response.headers.set("set-cookie", cookieHeader(LOGIN_STATE_COOKIE, nextState, LOGIN_STATE_TTL_SECONDS));
    return response;
  }

  async beginInviteJoin(inviteToken: string): Promise<Response> {
    if (!isOpaqueToken(inviteToken)) return jsonResponse({ error: "invalid_invite" }, 400);
    const inviteHash = await sha256Base64Url(inviteToken);
    const invitation = await this.storage.get<InvitationRecord>(INVITE_PREFIX + inviteHash);
    if (!isInvitationRecord(invitation) || Date.parse(invitation.expiresAt) <= Date.now()) {
      return jsonResponse({ error: "invalid_invite" }, 400);
    }
    const role = normalizeRole(invitation.role);
    if (!role) return jsonResponse({ error: "invalid_invite" }, 400);
    if (role !== invitation.role) {
      await this.storage.put(INVITE_PREFIX + inviteHash, { ...invitation, role });
    }
    return this.beginEnrollment({ kind: "join", role, inviteHash });
  }

  async renderAdmin(request: Request): Promise<Response> {
    const context = await this.readHumanSession(request);
    if (!context) {
      return new Response(null, {
        status: 302,
        headers: { location: new URL("/user", this.config.publicBaseUrl).href, "cache-control": "no-store" },
      });
    }
    if (context.user.role !== "admin") return jsonResponse({ error: "admin_required" }, 403);
    return htmlResponse(adminPage(await this.listUsers(), context.session.csrfToken));
  }

  async createInvite(request: Request): Promise<Response> {
    const context = await this.requireAdminPost(request);
    if (context instanceof Response) return context;
    const requestedRole = context.fields.get("role");
    if (requestedRole !== null && requestedRole !== "user") {
      return jsonResponse({ error: "invalid_role" }, 400);
    }
    const role: UpdateControlRole = "user";
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
    await this.storage.put(USER_PREFIX + target.id, {
      ...target,
      role,
      updatedAt: new Date().toISOString(),
    } satisfies UpdateControlUser);
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
    return this.logoutUser(request);
  }

  async logoutUser(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
    const context = await this.readHumanSession(request);
    if (!context) return jsonResponse({ error: "session_required" }, 401);
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
    await this.storage.delete(context.key);
    const response = new Response(null, {
      status: 303,
      headers: { location: "/user", "cache-control": "no-store" },
    });
    response.headers.append("set-cookie", expiredCookie(HUMAN_SESSION_COOKIE));
    response.headers.append("set-cookie", expiredCookie(LEGACY_ADMIN_SESSION_COOKIE));
    response.headers.append("set-cookie", expiredCookie(LOGIN_STATE_COOKIE));
    return response;
  }

  async deleteOAuthState(limit = 4096): Promise<{ deleted: number; complete: boolean }> {
    let deleted = 0;
    while (deleted < limit) {
      const batch = await this.storage.listPrefix(
        UPDATE_CONTROL_OAUTH_STORAGE_PREFIX,
        Math.min(256, limit - deleted),
      );
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

  private async beginEnrollment(
    input: { kind: "bootstrap"; role: "admin" } | { kind: "join"; role: UpdateControlRole; inviteHash: string },
  ): Promise<Response> {
    const state = randomToken();
    const secret = new Uint8Array(20);
    crypto.getRandomValues(secret);
    const pending: PendingEnrollment = {
      version: 1,
      state,
      kind: input.kind,
      role: input.role,
      encryptedSecret: await this.encryptSecret(secret, "enrollment:" + state),
      expiresAtMs: Date.now() + ENROLLMENT_PENDING_TTL_MS,
      ...(input.kind === "join" ? { inviteHash: input.inviteHash } : {}),
    };
    await this.storage.put(ENROLLMENT_PREFIX + state, pending);
    const provisioningUri = createProvisioningUri(encodeBase32(secret));
    return htmlResponse(enrollmentPage(
      state,
      provisioningUri,
      input.kind === "bootstrap" ? normalizeEmail(this.config.bootstrapAdminEmail) : "",
      input.kind === "bootstrap",
    ));
  }



  private async completeUserLogin(request: Request): Promise<Response> {
    if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405);
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
    const state = fields.get("state") ?? "";
    const loginState = readCookie(request.headers.get("cookie"), LOGIN_STATE_COOKIE);
    if (!isOpaqueToken(state) || loginState !== state) {
      return jsonResponse({ error: "csrf_rejected" }, 403);
    }
    const pendingKey = LOGIN_PENDING_PREFIX + state;
    const pendingValue = await this.storage.get<unknown>(pendingKey);
    if (!isPendingLogin(pendingValue) || pendingValue.state !== state ||
        pendingValue.expiresAtMs <= Date.now()) {
      await this.storage.delete(pendingKey);
      return jsonResponse({ error: "authorization_expired" }, 400);
    }

    const email = normalizeEmail(fields.get("email") ?? "");
    const code = normalizeVerificationCode(fields.get("code") ?? "");
    if (!isBootstrapAdminEmail(email) || !code) {
      return jsonResponse({ error: "invalid_credentials" }, 401);
    }
    const user = await this.authenticateLocalUser(email, code);
    if (!user || user.status !== "active") return jsonResponse({ error: "invalid_credentials" }, 401);

    if (pendingValue.kind === "admin" && user.role !== "admin") {
      await this.storage.delete(pendingKey);
      return jsonResponse({ error: "admin_required" }, 403);
    }

    let response: Response;
    if (pendingValue.kind === "oauth" || pendingValue.kind === "mcp") {
      response = await this.completeAuthorization(state, pendingValue, user);
    } else {
      await this.storage.delete(pendingKey);
      response = new Response(null, {
        status: 303,
        headers: {
          location: pendingValue.kind === "admin" ? "/admin" : "/user",
          "cache-control": "no-store",
        },
      });
    }
    return this.createHumanSession(user, response);
  }

  private async handleAuthorization(request: Request): Promise<Response> {
    let fields: URLSearchParams;
    if (request.method === "GET") {
      fields = new URL(request.url).searchParams;
    } else {
      const mediaType = (request.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
      if (mediaType !== "application/x-www-form-urlencoded") {
        return jsonResponse({ error: "invalid_content_type" }, 415);
      }
      try {
        fields = new URLSearchParams(await readBoundedText(request, 16 * 1024));
      } catch {
        return jsonResponse({ error: "invalid_request" }, 400);
      }
    }
    const validated = await this.validateAuthorizationRequest(fields);
    if (validated instanceof Response) return validated;

    const state = randomToken();
    const pending: PendingLogin = {
      version: 1,
      state,
      kind: "oauth",
      clientId: validated.clientId,
      redirectUri: validated.redirectUri,
      codeChallenge: validated.codeChallenge,
      scopes: validated.scopes,
      resource: validated.resource,
      ...(validated.clientState ? { clientState: validated.clientState } : {}),
      expiresAtMs: Date.now() + LOGIN_PENDING_TTL_MS,
    };
    await this.storage.put(LOGIN_PENDING_PREFIX + state, pending);

    const human = await this.readHumanSession(request);
    if (human) return this.completeAuthorization(state, pending, human.user);

    return new Response(null, {
      status: 302,
      headers: {
        location: new URL("/user", this.config.publicBaseUrl).href,
        "set-cookie": cookieHeader(LOGIN_STATE_COOKIE, state, LOGIN_STATE_TTL_SECONDS),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  private async completeAuthorization(
    state: string,
    pendingValue: PendingLogin,
    user: UpdateControlUser,
  ): Promise<Response> {
    const pendingKey = LOGIN_PENDING_PREFIX + state;
    const pending = await this.storage.get<unknown>(pendingKey);
    if (!isPendingLogin(pending) || pending.state !== state ||
        pending.expiresAtMs <= Date.now() ||
        (pending.kind !== "oauth" && pending.kind !== "mcp")) {
      await this.storage.delete(pendingKey);
      return jsonResponse({ error: "authorization_expired" }, 400);
    }
    if (!pending.clientId || !pending.redirectUri || !pending.codeChallenge ||
        !pending.scopes || !pending.resource) {
      await this.storage.delete(pendingKey);
      return jsonResponse({ error: "authorization_unavailable" }, 503);
    }
    const codeToken = "code-" + randomToken();
    await this.storage.put(CODE_PREFIX + await sha256Base64Url(codeToken), {
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
    target.searchParams.set("code", codeToken);
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

  private async validateAuthorizationRequest(fields: URLSearchParams): Promise<
    Response | {
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      scopes: string[];
      resource: string;
      clientState?: string;
    }
  > {
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
    return {
      clientId,
      redirectUri,
      codeChallenge,
      scopes,
      resource,
      ...(fields.get("state") ? { clientState: fields.get("state")! } : {}),
    };
  }

  private async authenticateLocalUser(email: string, code: string): Promise<UpdateControlUser | null> {
    const user = await this.findUserByEmail(email);
    if (!user || user.status !== "active") return null;
    const key = CREDENTIAL_PREFIX + user.id;
    const credential = await this.storage.get<TotpCredential>(key);
    if (!isTotpCredential(credential) || credential.userId !== user.id) return null;
    if (credential.lockedUntilMs && credential.lockedUntilMs > Date.now()) return null;

    let success = false;
    let acceptedCounter: number | undefined;
    let recoveryIndex = -1;
    if (/^\d{6}$/u.test(code)) {
      try {
        const secret = await this.decryptSecret(credential.encryptedSecret, "user:" + user.id);
        const counter = await verifyTotp(secret, code, credential.lastAcceptedCounter);
        if (counter !== null) {
          success = true;
          acceptedCounter = counter;
        }
      } catch {
        return null;
      }
    } else if (isRecoveryCode(code)) {
      const targetHash = await sha256Base64Url(normalizeRecoveryCode(code));
      for (let index = 0; index < credential.recoveryCodeHashes.length; index += 1) {
        if (await constantTimeTextEquals(targetHash, credential.recoveryCodeHashes[index] ?? "")) {
          recoveryIndex = index;
          success = true;
          break;
        }
      }
    }

    if (!success) {
      const failures = credential.failedAttempts + 1;
      await this.storage.put(key, {
        ...credential,
        failedAttempts: failures >= TOTP_MAX_FAILURES ? 0 : failures,
        ...(failures >= TOTP_MAX_FAILURES ? { lockedUntilMs: Date.now() + TOTP_LOCK_MS } : {}),
        updatedAt: new Date().toISOString(),
      } satisfies TotpCredential);
      return null;
    }

    const hashes = [...credential.recoveryCodeHashes];
    if (recoveryIndex >= 0) hashes.splice(recoveryIndex, 1);
    const updatedCredential: TotpCredential = {
      ...credential,
      ...(acceptedCounter === undefined ? {} : { lastAcceptedCounter: acceptedCounter }),
      recoveryCodeHashes: hashes,
      failedAttempts: 0,
      updatedAt: new Date().toISOString(),
    };
    delete updatedCredential.lockedUntilMs;
    await this.storage.put(key, updatedCredential);
    return user;
  }

  private async createHumanSession(
    user: UpdateControlUser,
    response = new Response(null, {
      status: 303,
      headers: { location: "/user", "cache-control": "no-store" },
    }),
  ): Promise<Response> {
    const token = randomToken();
    const now = new Date().toISOString();
    const session: HumanSessionRecord = {
      version: 1,
      userId: user.id,
      csrfToken: randomToken(),
      createdAt: now,
      expiresAt: new Date(Date.now() + HUMAN_SESSION_TTL_MS).toISOString(),
    };
    await this.storage.put(HUMAN_SESSION_PREFIX + await sha256Base64Url(token), session);
    response.headers.append(
      "set-cookie",
      cookieHeader(HUMAN_SESSION_COOKIE, token, Math.floor(HUMAN_SESSION_TTL_MS / 1000)),
    );
    response.headers.append("set-cookie", expiredCookie(LOGIN_STATE_COOKIE));
    return response;
  }

  private async readHumanSession(request: Request): Promise<HumanSessionContext | null> {
    const requestCookie = request.headers.get("cookie");
    const currentToken = readCookie(requestCookie, HUMAN_SESSION_COOKIE);
    const legacyToken = currentToken ? null : readCookie(requestCookie, LEGACY_ADMIN_SESSION_COOKIE);
    const token = currentToken ?? legacyToken;
    if (!token || !isOpaqueToken(token)) return null;

    const key = currentToken
      ? HUMAN_SESSION_PREFIX + await sha256Base64Url(token)
      : ADMIN_SESSION_PREFIX + await sha256Base64Url(token);
    const session = await this.storage.get<unknown>(key);
    if (!isHumanSessionRecord(session) || Date.parse(session.expiresAt) <= Date.now()) {
      await this.storage.delete(key);
      return null;
    }
    const user = await this.getUser(session.userId);
    if (!user || user.status !== "active" || (legacyToken && user.role !== "admin")) {
      await this.storage.delete(key);
      return null;
    }
    return {
      user,
      session,
      key,
      cookieName: currentToken ? HUMAN_SESSION_COOKIE : LEGACY_ADMIN_SESSION_COOKIE,
    };
  }

  private async readAdminSession(request: Request): Promise<HumanSessionContext | null> {
    const context = await this.readHumanSession(request);
    return context?.user.role === "admin" ? context : null;
  }

  private async requireAdminPost(
    request: Request,
  ): Promise<Response | {
    user: UpdateControlUser;
    session: HumanSessionRecord;
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

  private async createLocalUser(
    email: string,
    displayName: string,
    role: UpdateControlRole,
  ): Promise<UpdateControlUser> {
    const now = new Date().toISOString();
    const user: UpdateControlUser = {
      version: 1,
      id: "usr_" + crypto.randomUUID(),
      displayName,
      email,
      role,
      status: "active",
      provider: "local-totp",
      createdAt: now,
      updatedAt: now,
    };
    const ids = await this.userIds();
    await this.storage.put(USER_PREFIX + user.id, user);
    await this.storage.put(EMAIL_PREFIX + await sha256Base64Url(email), user.id);
    await this.storage.put(USER_IDS_KEY, [...ids, user.id]);
    return user;
  }

  private async findUserByEmail(email: string): Promise<UpdateControlUser | null> {
    const userId = await this.storage.get<string>(EMAIL_PREFIX + await sha256Base64Url(normalizeEmail(email)));
    return userId ? this.getUser(userId) : null;
  }

  private async userIds(): Promise<string[]> {
    const value = await this.storage.get<unknown>(USER_IDS_KEY);
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? [...value] : [];
  }

  private async getUser(userId: string): Promise<UpdateControlUser | null> {
    const value = await this.storage.get<unknown>(USER_PREFIX + userId);
    if (!isStoredUpdateControlUser(value)) return null;
    const role = normalizeRole(value.role);
    if (!role) return null;
    const user = { ...value, role } as UpdateControlUser;
    if (value.role !== role) {
      const migrated = { ...user, updatedAt: new Date().toISOString() };
      await this.storage.put(USER_PREFIX + userId, migrated);
      return migrated;
    }
    return user;
  }

  private async encryptionKey(): Promise<CryptoKey> {
    return crypto.subtle.importKey(
      "raw",
      toArrayBuffer(this.encryptionKeyBytes),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }

  private async encryptSecret(secret: Uint8Array, context: string): Promise<EncryptedSecret> {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(new TextEncoder().encode(context)),
      },
      await this.encryptionKey(),
      toArrayBuffer(secret),
    ));
    return { version: 1, iv: base64UrlBytes(iv), ciphertext: base64UrlBytes(ciphertext) };
  }

  private async decryptSecret(encrypted: EncryptedSecret, context: string): Promise<Uint8Array> {
    if (!isEncryptedSecret(encrypted)) throw new Error("invalid encrypted secret");
    return new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(decodeBase64UrlBytes(encrypted.iv)),
        additionalData: toArrayBuffer(new TextEncoder().encode(context)),
      },
      await this.encryptionKey(),
      toArrayBuffer(decodeBase64UrlBytes(encrypted.ciphertext)),
    ));
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
      !url.username && !url.password;
  }
}

function createProvisioningUri(secret: string): string {
  const issuer = UPDATE_CONTROL_TOTP_ISSUER;
  const url = new URL("otpauth://totp/" + encodeURIComponent(issuer));
  url.searchParams.set("secret", secret);
  url.searchParams.set("issuer", issuer);
  return url.href;
}

function loginPage(state: string, action: string, title: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${htmlEscape(title)}</title></head><body><main><h1>${htmlEscape(title)}</h1><form method="post" action="${htmlEscape(action)}"><input type="hidden" name="state" value="${htmlEscape(state)}"><label>Email <input name="email" type="email" autocomplete="username" required></label><label>Verification code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button type="submit">Continue</button></form></main></body></html>`;
}

function userPage(user: UpdateControlUser, csrfToken: string): string {
  const adminLink = user.role === "admin" ? '<p><a href="/admin">Admin</a></p>' : "";
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Update Center session</title></head><body><main><h1>Signed in</h1><p>' +
    htmlEscape(user.displayName) + '</p><p>Role: ' + htmlEscape(user.role) + '</p>' + adminLink +
    '<form method="post" action="/user/logout"><input type="hidden" name="csrf" value="' +
    htmlEscape(csrfToken) + '"><button type="submit">Sign out</button></form></main></body></html>';
}

function cookieHeader(name: string, value: string, maxAgeSeconds: number): string {
  return name + "=" + value + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAgeSeconds;
}

function expiredCookie(name: string): string {
  return name + "=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

function enrollmentPage(
  state: string,
  provisioningUri: string,
  email: string,
  emailReadonly: boolean,
): string {
  const qr = qrSvg(provisioningUri);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Enroll Authenticator</title><style>:root{--background:#09090b;--foreground:#fafafa;--card:#0c0c0f;--card-foreground:#fafafa;--muted:#18181b;--muted-foreground:#a1a1aa;--border:#27272a;--input:#27272a;--primary:#fafafa;--primary-foreground:#18181b;--ring:#d4d4d8}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#18181b 0,#09090b 42%);color:var(--foreground);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}main{min-height:100vh;display:grid;place-items:center;padding:32px 20px}.card{width:min(100%,680px);background:color-mix(in srgb,var(--card) 94%,transparent);border:1px solid var(--border);border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.42);padding:28px}.eyebrow{display:inline-flex;align-items:center;border:1px solid var(--border);background:var(--muted);border-radius:999px;padding:5px 10px;color:var(--muted-foreground);font-size:12px;font-weight:600;letter-spacing:.02em}h1{margin:14px 0 8px;font-size:28px;line-height:1.15;letter-spacing:-.03em}.subtitle{margin:0;color:var(--muted-foreground);font-size:14px;line-height:1.6}.qr-section{display:grid;grid-template-columns:auto 1fr;gap:24px;align-items:center;margin:26px 0;padding:20px;background:var(--muted);border:1px solid var(--border);border-radius:14px}.qr-shell{width:272px;max-width:100%;padding:16px;background:#fff;border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.15)}.qr-shell svg{margin:auto}.qr-copy{min-width:0}.qr-copy h2{margin:0 0 6px;font-size:16px;letter-spacing:-.01em}.qr-copy p{margin:0;color:var(--muted-foreground);font-size:13px;line-height:1.55}details{margin-top:12px}summary{cursor:pointer;color:#d4d4d8;font-size:13px}details code{display:block;margin-top:10px;padding:10px 12px;overflow:auto;border:1px solid var(--border);border-radius:8px;background:#09090b;color:#e4e4e7;font-size:12px}form{display:grid;gap:16px}.field{display:grid;gap:7px}.field span{font-size:13px;font-weight:600;color:#e4e4e7}input{width:100%;height:42px;border:1px solid var(--input);border-radius:9px;background:#09090b;color:var(--foreground);padding:0 12px;font:inherit;font-size:14px;outline:none;transition:border-color .15s,box-shadow .15s}input:focus{border-color:var(--ring);box-shadow:0 0 0 3px rgba(212,212,216,.14)}input[readonly]{color:var(--muted-foreground);background:#111113}.code-input{font-variant-numeric:tabular-nums;letter-spacing:.28em;font-weight:700}button{height:42px;border:0;border-radius:9px;background:var(--primary);color:var(--primary-foreground);font:inherit;font-size:14px;font-weight:700;cursor:pointer;transition:opacity .15s,transform .15s}button:hover{opacity:.92}button:active{transform:translateY(1px)}.hint{margin:2px 0 0;color:var(--muted-foreground);font-size:12px;line-height:1.5}@media(max-width:640px){main{padding:18px}.card{padding:20px}.qr-section{grid-template-columns:1fr;justify-items:center;text-align:center}.qr-copy{width:100%}.qr-shell{width:min(272px,100%)}h1{font-size:24px}}</style></head><body><main><section class="card"><span class="eyebrow">MCP V3 Update Center</span><h1>Enroll Authenticator</h1><p class="subtitle">Connect your authenticator to secure administrative access with a time-based verification code.</p><div class="qr-section"><div class="qr-shell" data-provisioning-uri="${htmlEscape(provisioningUri)}">${qr}</div><div class="qr-copy"><h2>Scan the QR code</h2><p>Open Microsoft Authenticator, add another account, then scan this code. After that, enter the current 6-digit code below.</p><details><summary>Use a manual setup key instead</summary><code>${htmlEscape(new URL(provisioningUri).searchParams.get("secret") ?? "")}</code></details></div></div><form method="post" action="/enroll"><input type="hidden" name="state" value="${htmlEscape(state)}"><label class="field"><span>Email</span><input name="email" type="email" value="${htmlEscape(email)}"${emailReadonly ? " readonly" : ""} required></label><label class="field"><span>Name</span><input name="display_name" maxlength="200" autocomplete="name" placeholder="Your name" required></label><label class="field"><span>Verification code</span><input class="code-input" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000" required><p class="hint">Use the 6-digit code currently shown in your authenticator app.</p></label><button type="submit">Enable secure access</button></form></section></main></body></html>`;
}

function enrollmentCompletedPage(user: UpdateControlUser, recoveryCodes: string[]): string {
  const codes = recoveryCodes.map((code) =>
    `<li><code data-recovery-code="${htmlEscape(code)}">${htmlEscape(code)}</code></li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Access enabled</title><style>:root{--background:#09090b;--foreground:#fafafa;--card:#0c0c0f;--muted:#18181b;--muted-foreground:#a1a1aa;--border:#27272a}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#18181b 0,#09090b 42%);color:var(--foreground);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}main{min-height:100vh;display:grid;place-items:center;padding:32px 20px}.card{width:min(100%,680px);background:var(--card);border:1px solid var(--border);border-radius:18px;box-shadow:0 24px 80px rgba(0,0,0,.42);padding:28px}.eyebrow{display:inline-flex;border:1px solid var(--border);background:var(--muted);border-radius:999px;padding:5px 10px;color:var(--muted-foreground);font-size:12px;font-weight:600}h1{margin:14px 0 8px;font-size:28px;letter-spacing:-.03em}.subtitle{margin:0;color:var(--muted-foreground);font-size:14px;line-height:1.6}.notice{margin:24px 0;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:var(--muted);color:#e4e4e7;font-size:13px;line-height:1.55}.codes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:0;margin:18px 0 0;list-style:none}.codes li{margin:0}.codes code{display:block;padding:11px 12px;border:1px solid var(--border);border-radius:9px;background:#09090b;color:#fafafa;text-align:center;font-size:13px;letter-spacing:.08em}@media(max-width:560px){main{padding:18px}.card{padding:20px}.codes{grid-template-columns:1fr}h1{font-size:24px}}</style></head><body><main><section class="card"><span class="eyebrow">MCP V3 Update Center</span><h1>Access enabled</h1><p class="subtitle">${htmlEscape(user.displayName)} is enrolled as <strong>${htmlEscape(user.role)}</strong>.</p><div class="notice"><strong>Save these recovery codes now.</strong><br>Each code can be used once and will not be shown again.</div><ul class="codes">${codes}</ul></section></main></body></html>`;
}

function adminPage(users: UpdateControlUser[], csrfToken: string): string {
  const rows = users.map((user) => {
    const roleOptions = ["admin", "user"].map((role) =>
      `<option value="${role}"${user.role === role ? " selected" : ""}>${role}</option>`).join("");
    const controls = user.status === "active"
      ? `<form method="post" action="/admin/users/${encodeURIComponent(user.id)}/role"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><select name="role">${roleOptions}</select><button type="submit">Change role</button></form><form method="post" action="/admin/users/${encodeURIComponent(user.id)}/revoke"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><button type="submit">Revoke</button></form>`
      : "";
    return `<tr><td>${htmlEscape(user.displayName)}</td><td>${htmlEscape(user.email)}</td><td>${htmlEscape(user.role)}</td><td>${htmlEscape(user.status)}</td><td>${controls}</td></tr>`;
  }).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP V3 Update Center admin</title></head><body><main><h1>MCP V3 Update Center</h1><h2>Users</h2><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table><h2>Invite user</h2><form method="post" action="/admin/invites"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><input type="hidden" name="role" value="user"><button type="submit">Create invite</button></form><form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${htmlEscape(csrfToken)}"><button type="submit">Sign out</button></form></main></body></html>`;
}

async function verifyTotp(
  secret: Uint8Array,
  code: string,
  lastAcceptedCounter: number | undefined,
): Promise<number | null> {
  if (!/^\d{6}$/u.test(code)) return null;
  const current = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  for (const counter of [current, current - 1, current + 1]) {
    if (counter < 0 || (lastAcceptedCounter !== undefined && counter <= lastAcceptedCounter)) continue;
    if (await constantTimeTextEquals(await totpCode(secret, counter), code)) return counter;
  }
  return null;
}

async function totpCode(secret: Uint8Array, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  let value = BigInt(counter);
  for (let index = 7; index >= 0; index -= 1) {
    message[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(message)));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(TOTP_DIGITS, "0");
}

function generateRecoveryCodes(): string[] {
  const result: string[] = [];
  for (let index = 0; index < RECOVERY_CODE_COUNT; index += 1) {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    const text = encodeBase32(bytes).slice(0, 12);
    result.push(text.slice(0, 4) + "-" + text.slice(4, 8) + "-" + text.slice(8, 12));
  }
  return result;
}

function normalizeVerificationCode(value: string): string {
  const trimmed = value.trim().toUpperCase();
  if (/^\d{6}$/u.test(trimmed)) return trimmed;
  const normalizedRecovery = normalizeRecoveryCode(trimmed);
  return isRecoveryCode(normalizedRecovery) ? normalizedRecovery : "";
}

function normalizeRecoveryCode(value: string): string {
  return value.trim().toUpperCase().replaceAll(" ", "");
}

function isRecoveryCode(value: string): boolean {
  return /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/u.test(value);
}

function encodeBase32(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  let output = "";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31];
  return output;
}

function qrSvg(text: string): string {
  const matrix = qrMatrixVersion6L(text);
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  let path = "";
  for (let row = 0; row < matrix.length; row += 1) {
    for (let col = 0; col < matrix.length; col += 1) {
      if (matrix[row]?.[col]) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }
  return `<svg role="img" aria-label="Authenticator QR code" width="240" height="240" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges" style="display:block;max-width:100%;height:auto"><title>Authenticator QR code</title><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`;
}

function qrMatrixVersion6L(text: string): boolean[][] {
  const data = new TextEncoder().encode(text);
  if (data.length > 134) throw new Error("TOTP provisioning URI is too long for the local QR encoder.");
  const dataCodewords = makeQrDataCodewords(data, 136);
  const blocks = [dataCodewords.slice(0, 68), dataCodewords.slice(68, 136)];
  const ecc = blocks.map((block) => reedSolomonRemainder(block, 18));
  const codewords: number[] = [];
  for (let index = 0; index < 68; index += 1) {
    codewords.push(blocks[0]![index]!, blocks[1]![index]!);
  }
  for (let index = 0; index < 18; index += 1) {
    codewords.push(ecc[0]![index]!, ecc[1]![index]!);
  }

  const size = 41;
  const modules: Array<Array<boolean | null>> =
    Array.from({ length: size }, () => Array<boolean | null>(size).fill(null));
  setupFinder(modules, 0, 0);
  setupFinder(modules, size - 7, 0);
  setupFinder(modules, 0, size - 7);
  setupAlignment(modules, [6, 34]);
  setupTiming(modules);
  setupFormatInfo(modules, 0);
  mapQrData(modules, codewords, 0);
  return modules.map((row) => row.map(Boolean));
}

function makeQrDataCodewords(data: Uint8Array, capacity: number): number[] {
  const bits: number[] = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, data.length, 8);
  for (const byte of data) appendBits(bits, byte, 8);
  const capacityBits = capacity * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const result: number[] = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let bit = 0; bit < 8; bit += 1) value = (value << 1) | (bits[index + bit] ?? 0);
    result.push(value);
  }
  let pad = 0;
  while (result.length < capacity) {
    result.push(pad % 2 === 0 ? 0xec : 0x11);
    pad += 1;
  }
  return result;
}

function appendBits(target: number[], value: number, length: number): void {
  for (let bit = length - 1; bit >= 0; bit -= 1) target.push((value >>> bit) & 1);
}

function reedSolomonRemainder(data: number[], degree: number): number[] {
  const exp = new Uint8Array(512);
  const log = new Uint8Array(256);
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    exp[index] = value;
    log[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) exp[index] = exp[index - 255]!;
  const multiply = (a: number, b: number): number =>
    a === 0 || b === 0 ? 0 : exp[log[a]! + log[b]!]!;

  let generator = [1];
  for (let index = 0; index < degree; index += 1) {
    const next = new Array<number>(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j += 1) {
      next[j] = (next[j] ?? 0) ^ generator[j]!;
      next[j + 1] = (next[j + 1] ?? 0) ^ multiply(generator[j]!, exp[index]!);
    }
    generator = next;
  }

  const remainder = new Array<number>(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.shift();
    remainder.push(0);
    for (let index = 0; index < degree; index += 1) {
      remainder[index] = (remainder[index] ?? 0) ^ multiply(generator[index + 1]!, factor);
    }
  }
  return remainder;
}

function setupFinder(modules: Array<Array<boolean | null>>, row: number, col: number): void {
  const size = modules.length;
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const y = row + r;
      const x = col + c;
      if (y < 0 || y >= size || x < 0 || x >= size) continue;
      modules[y]![x] =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
    }
  }
}

function setupAlignment(modules: Array<Array<boolean | null>>, positions: number[]): void {
  for (const row of positions) {
    for (const col of positions) {
      if (modules[row]?.[col] !== null) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          modules[row + r]![col + c] =
            Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0);
        }
      }
    }
  }
}

function setupTiming(modules: Array<Array<boolean | null>>): void {
  const size = modules.length;
  for (let index = 8; index < size - 8; index += 1) {
    if (modules[index]?.[6] === null) modules[index]![6] = index % 2 === 0;
    if (modules[6]?.[index] === null) modules[6]![index] = index % 2 === 0;
  }
}

function setupFormatInfo(modules: Array<Array<boolean | null>>, mask: number): void {
  const size = modules.length;
  const data = (1 << 3) | mask;
  let value = data << 10;
  const polynomial = 0x537;
  while (bitLength(value) - bitLength(polynomial) >= 0) {
    value ^= polynomial << (bitLength(value) - bitLength(polynomial));
  }
  const bits = ((data << 10) | value) ^ 0x5412;
  for (let index = 0; index < 15; index += 1) {
    const dark = ((bits >>> index) & 1) === 1;
    if (index < 6) modules[index]![8] = dark;
    else if (index < 8) modules[index + 1]![8] = dark;
    else modules[size - 15 + index]![8] = dark;

    if (index < 8) modules[8]![size - index - 1] = dark;
    else if (index < 9) modules[8]![15 - index] = dark;
    else modules[8]![15 - index - 1] = dark;
  }
  modules[size - 8]![8] = true;
}

function bitLength(value: number): number {
  let length = 0;
  while (value !== 0) {
    length += 1;
    value >>>= 1;
  }
  return length;
}

function mapQrData(
  modules: Array<Array<boolean | null>>,
  codewords: number[],
  mask: number,
): void {
  const size = modules.length;
  let row = size - 1;
  let direction = -1;
  let byteIndex = 0;
  let bitIndex = 7;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    while (true) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = col - offset;
        if (modules[row]?.[x] !== null) continue;
        let dark = false;
        if (byteIndex < codewords.length) dark = (((codewords[byteIndex] ?? 0) >>> bitIndex) & 1) === 1;
        if (qrMask(mask, row, x)) dark = !dark;
        modules[row]![x] = dark;
        bitIndex -= 1;
        if (bitIndex < 0) {
          byteIndex += 1;
          bitIndex = 7;
        }
      }
      row += direction;
      if (row < 0 || row >= size) {
        row -= direction;
        direction = -direction;
        break;
      }
    }
  }
}

function qrMask(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return (row * col) % 2 + (row * col) % 3 === 0;
    case 6: return ((row * col) % 2 + (row * col) % 3) % 2 === 0;
    default: return ((row * col) % 3 + (row + col) % 2) % 2 === 0;
  }
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

function isPendingLogin(value: unknown): value is PendingLogin {
  if (!isRecord(value) || value.version !== 1 || typeof value.state !== "string" ||
      (value.kind !== "mcp" && value.kind !== "oauth" && value.kind !== "admin" && value.kind !== "user") ||
      !Number.isFinite(value.expiresAtMs)) return false;
  if (value.kind === "mcp" || value.kind === "oauth") {
    return typeof value.clientId === "string" &&
      typeof value.redirectUri === "string" &&
      typeof value.codeChallenge === "string" &&
      Array.isArray(value.scopes) &&
      value.scopes.every((entry) => typeof entry === "string") &&
      typeof value.resource === "string" &&
      (value.clientState === undefined || typeof value.clientState === "string");
  }
  return true;
}

function isPendingEnrollment(value: unknown): value is PendingEnrollment {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.state === "string" &&
    (value.kind === "bootstrap" || value.kind === "join") &&
    isStoredRole(value.role) &&
    isEncryptedSecret(value.encryptedSecret) &&
    Number.isFinite(value.expiresAtMs) &&
    (value.inviteHash === undefined || typeof value.inviteHash === "string");
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

type StoredUpdateControlUser = Omit<UpdateControlUser, "role"> & { role: string };

function isStoredUpdateControlUser(value: unknown): value is StoredUpdateControlUser {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    /^usr_[0-9a-f-]{36}$/iu.test(value.id) &&
    typeof value.displayName === "string" &&
    typeof value.email === "string" &&
    typeof value.role === "string" &&
    (value.status === "active" || value.status === "revoked") &&
    value.provider === "local-totp" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

function isTotpCredential(value: unknown): value is TotpCredential {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.userId === "string" &&
    isEncryptedSecret(value.encryptedSecret) &&
    (value.lastAcceptedCounter === undefined || Number.isSafeInteger(value.lastAcceptedCounter)) &&
    Array.isArray(value.recoveryCodeHashes) &&
    value.recoveryCodeHashes.every((entry) => typeof entry === "string" && /^[A-Za-z0-9_-]{43}$/u.test(entry)) &&
    Number.isSafeInteger(value.failedAttempts) &&
    (value.failedAttempts as number) >= 0 &&
    (value.lockedUntilMs === undefined || Number.isFinite(value.lockedUntilMs)) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  return isRecord(value) &&
    value.version === 1 &&
    typeof value.iv === "string" &&
    /^[A-Za-z0-9_-]{16}$/u.test(value.iv) &&
    typeof value.ciphertext === "string" &&
    /^[A-Za-z0-9_-]+$/u.test(value.ciphertext);
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
    isStoredRole(value.role) &&
    typeof value.createdByUserId === "string" &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.expiresAt));
}

function isHumanSessionRecord(value: unknown): value is HumanSessionRecord {
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
  return value === "admin" || value === "user";
}

function isStoredRole(value: unknown): value is StoredUpdateControlRole {
  return value === "admin" || value === "user" || value === "operator" || value === "viewer";
}

function normalizeRole(value: unknown): UpdateControlRole | null {
  if (value === "admin") return "admin";
  if (value === "user" || value === "operator" || value === "viewer") return "user";
  return null;
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

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const pair of header.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    if (pair.slice(0, index).trim() !== name) continue;
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
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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

function decodeHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
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
