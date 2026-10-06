import {
  EdgeOwnerOAuth,
  type OwnerIdentity,
  type OwnerIdentityStore,
  type OwnerOAuthStorage,
} from "@mcp-access-stack/mcp-owner-auth";
import { createUpdateControlApiHandler } from "./api.js";
import { createUpdateControlMcpHandler } from "./mcp.js";
import { UpdateControlOracleChannelReadClient } from "./oracle-channel-client.js";
import type { OracleChannelNamespace } from "./oracle-channel.js";
import { createUpdateControlReadOnlyTools, type UpdateControlReadClient } from "./tools.js";

const UPDATE_CONTROL_OWNER_ID = "usr_85dd70bf-2a50-4b8e-97d6-3c20c7226757";
const MAX_URL_LENGTH = 8 * 1024;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_OAUTH_BODY_BYTES = 16 * 1024;
const MAX_REPROVISION_BODY_BYTES = 1024;
export const OAUTH_REPROVISION_PATH = "/_operations/oauth/reprovision";
export const UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_HEADER = "x-update-control-internal-reprovision-authenticated";
export const UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_MARKER = "v1";
const OAUTH_REPROVISION_ACTIVE_KEY = "update-control:oauth-reprovision:v1:active";
const OAUTH_REPROVISION_OPERATION_PREFIX = "update-control:oauth-reprovision:v1:operation:";
const OAUTH_REPROVISION_EVENT_PREFIX = "update-control:oauth-reprovision:v1:event:";
const OWNER_CREDENTIAL_MATERIAL_KEY = "owner:credential-material:v1";
const OWNER_OAUTH_STORAGE_PREFIX = "owner:";
const OWNER_OAUTH_DELETE_BATCH_SIZE = 256;
const OWNER_OAUTH_DELETE_LIMIT_PER_REQUEST = 2048;
const OAUTH_REPROVISION_OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type OAuthReprovisionOperationIdResult =
  | { readonly ok: true; readonly operationId: string }
  | { readonly ok: false; readonly response: Response };

export async function parseOAuthReprovisionOperationId(
  request: Request,
  publicBaseUrl: string | undefined,
): Promise<OAuthReprovisionOperationIdResult> {
  if (request.url.length > MAX_URL_LENGTH || !headersWithinBounds(request.headers)) {
    return { ok: false, response: new Response(null, { status: 431, headers: { "cache-control": "no-store" } }) };
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { ok: false, response: jsonResponse({ error: "invalid_request" }, 400) };
  }

  let reprovisionUrl: URL;
  try {
    reprovisionUrl = deriveOAuthReprovisionUrl(publicBaseUrl);
  } catch {
    return { ok: false, response: jsonResponse({ error: "not_found" }, 404) };
  }
  if (url.origin !== reprovisionUrl.origin ||
      url.pathname !== reprovisionUrl.pathname ||
      url.username || url.password || url.hash) {
    return { ok: false, response: jsonResponse({ error: "not_found" }, 404) };
  }

  let operationId: string;
  if (request.method === "GET") {
    if ([...url.searchParams.keys()].some((key) => key !== "operationId") ||
        url.searchParams.getAll("operationId").length !== 1) {
      return { ok: false, response: jsonResponse({ error: "invalid_request" }, 400) };
    }
    operationId = url.searchParams.get("operationId") ?? "";
  } else if (request.method === "POST" && !url.search && !url.hash &&
      !request.url.includes("?") && !request.url.includes("#")) {
    let body: string;
    try {
      body = await readBoundedRequestText(request, MAX_REPROVISION_BODY_BYTES);
    } catch {
      return { ok: false, response: jsonResponse({ error: "invalid_request" }, 400) };
    }
    let input: unknown;
    try {
      input = JSON.parse(body) as unknown;
    } catch {
      return { ok: false, response: jsonResponse({ error: "invalid_request" }, 400) };
    }
    if (!isRecord(input) || Object.keys(input).length !== 1 ||
        typeof input.operationId !== "string") {
      return { ok: false, response: jsonResponse({ error: "invalid_operation_id" }, 400) };
    }
    operationId = input.operationId;
  } else {
    return { ok: false, response: jsonResponse({ error: "method_not_allowed" }, 405) };
  }

  if (!OAUTH_REPROVISION_OPERATION_ID_PATTERN.test(operationId)) {
    return { ok: false, response: jsonResponse({ error: "invalid_operation_id" }, 400) };
  }
  return { ok: true, operationId };
}


type OAuthReprovisionStatus = "in_progress" | "completed" | "outcome_unknown";
type OAuthReprovisionEventType =
  | "started"
  | "resumed"
  | "oauth_state_cleared"
  | "owner_authority_reprovisioned"
  | "completed"
  | "outcome_unknown";

interface OAuthReprovisionOperation {
  readonly operationId: string;
  readonly status: OAuthReprovisionStatus;
  readonly attempt: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly targetOwnerVerifierHash?: string;
}

interface OAuthReprovisionActiveState {
  readonly operationId: string;
  readonly status: OAuthReprovisionStatus;
  readonly updatedAt: string;
}

interface OAuthReprovisionAuditEvent {
  readonly operationId: string;
  readonly attempt: number;
  readonly eventType: OAuthReprovisionEventType;
  readonly occurredAt: string;
}

export interface UpdateControlEnvironment {
  readonly MCP_UPDATE_CONTROL_PUBLIC_URL?: string;
  readonly MCP_OWNER_TOKEN?: string;
  readonly UPDATE_CONTROL_OAUTH_REPROVISION_HMAC_KEY?: string;
  readonly MCP_OWNER_ACCESS_TOKEN_TTL_SECONDS?: string;
  readonly MCP_OWNER_REFRESH_TOKEN_TTL_SECONDS?: string;
  readonly UPDATE_CONTROL_ORACLE_CHANNEL?: OracleChannelNamespace;
}

export interface UpdateControlDurableStorage extends OwnerOAuthStorage {
  listPrefix(prefix: string, limit: number): Promise<Map<string, unknown>>;
  deleteMany(keys: string[]): Promise<number>;
}

export interface UpdateControlDurableState {
  readonly storage: UpdateControlDurableStorage;
}

export class UpdateControlAuthController {
  private ownerOAuth: EdgeOwnerOAuth | undefined;
  private configurationValid = false;
  private ownerIdentityPromise: Promise<void> | undefined;
  private readClient: UpdateControlOracleChannelReadClient | undefined;
  private requestQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly state: UpdateControlDurableState,
    private readonly env: UpdateControlEnvironment,
  ) {
    try {
      deriveOAuthReprovisionUrl(env.MCP_UPDATE_CONTROL_PUBLIC_URL);
      this.configurationValid = true;
    } catch {
      this.configurationValid = false;
    }
    try {
      this.ownerOAuth = createOwnerOAuth(state.storage, env, createIdentityStore(state.storage));
    } catch {
      this.ownerOAuth = undefined;
    }
  }

  fetch(request: Request): Promise<Response> {
    return this.serialize(() => this.fetchSerialized(request));
  }

  private async fetchSerialized(request: Request): Promise<Response> {
    if (request.url.length > MAX_URL_LENGTH || !headersWithinBounds(request.headers)) {
      return new Response(null, { status: 431, headers: { "cache-control": "no-store" } });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return jsonResponse({ error: "invalid_request" }, 400);
    }
    if (url.pathname === OAUTH_REPROVISION_PATH) {
      return this.handleOAuthReprovision(request);
    }
    if (url.pathname === "/_operations" || url.pathname.startsWith("/_operations/")) {
      return jsonResponse({ error: "not_found" }, 404);
    }
    if (!this.configurationValid || !this.ownerOAuth) {
      return jsonResponse({ error: "update_control_not_configured" }, 503);
    }

    try {
      const active = await this.state.storage.get<unknown>(OAUTH_REPROVISION_ACTIVE_KEY);
      if (!isRecord(active) || active.status !== "completed" ||
          !(await ownerSecretMatchesPersistedState(this.state.storage, this.env.MCP_OWNER_TOKEN))) {
        return jsonResponse({ error: "oauth_reprovision_required" }, 503);
      }
      await this.ensureOwnerIdentity();
      const oauthRequest = isOAuthPostPath(url.pathname) && request.method === "POST"
        ? await boundOAuthRequest(request)
        : request;
      const oauthResponse = await this.ownerOAuth.handle(oauthRequest);
      if (oauthResponse) return oauthResponse;
      if (url.pathname === "/mcp") {
        return createUpdateControlMcpHandler({
          authenticate: (candidate) => this.ownerOAuth!.authenticate(candidate),
          tools: createUpdateControlReadOnlyTools(this.createReadClientProxy()),
        })(oauthRequest);
      }
      if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
        return createUpdateControlApiHandler({
          authenticate: (candidate) => this.ownerOAuth!.authenticate(candidate),
          client: this.createReadClientProxy(),
        })(request);
      }
      return jsonResponse({ error: "not_found" }, 404);
    } catch {
      return jsonResponse({ error: "update_control_unavailable" }, 503);
    }
  }

  private async handleOAuthReprovision(request: Request): Promise<Response> {
    const parsed = await parseOAuthReprovisionOperationId(request, this.env.MCP_UPDATE_CONTROL_PUBLIC_URL);
    if (!parsed.ok) return parsed.response;
    if (request.headers.get(UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_HEADER) !== UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_MARKER) {
      return jsonResponse({ error: "operation_auth_required" }, 401);
    }
    return request.method === "GET"
      ? this.readOAuthReprovisionStatus(parsed.operationId)
      : this.runOAuthReprovision(parsed.operationId);
  }

  private async readOAuthReprovisionStatus(operationId: string): Promise<Response> {
    try {
      const operation = await this.state.storage.get<unknown>(oauthOperationKey(operationId));
      const active = await this.state.storage.get<unknown>(OAUTH_REPROVISION_ACTIVE_KEY);
      if (!isOAuthReprovisionOperation(operation) && isRecord(active) &&
          isOAuthReprovisionStatus(active.status) && active.status !== "completed" &&
          active.operationId !== operationId) {
        return jsonResponse({ operationId, status: active.status, error: "another_operation_active" }, 409);
      }
      let status: "not_executed" | OAuthReprovisionStatus = isOAuthReprovisionOperation(operation)
        ? operation.status
        : "not_executed";
      if (isRecord(active) && active.operationId === operationId &&
          active.status !== "completed" && status === "completed") {
        status = "outcome_unknown";
      } else if (!isOAuthReprovisionOperation(operation) &&
          isRecord(active) && active.operationId === operationId &&
          isOAuthReprovisionStatus(active.status)) {
        status = active.status;
      }
      const events = await this.readOAuthReprovisionEvents(operationId);
      return jsonResponse({
        operationId,
        status,
        ...(isOAuthReprovisionOperation(operation) ? { attempt: operation.attempt } : {}),
        events,
      });
    } catch {
      return jsonResponse({ operationId, status: "outcome_unknown" }, 503);
    }
  }

  private async runOAuthReprovision(operationId: string): Promise<Response> {
    const ownerToken = this.env.MCP_OWNER_TOKEN;
    if (!ownerToken || ownerToken.length < 32) {
      return jsonResponse({ operationId, status: "not_executed", error: "owner_token_invalid" }, 503);
    }
    const operationKey = oauthOperationKey(operationId);
    let operation: OAuthReprovisionOperation | undefined;
    try {
      const existing = await this.state.storage.get<unknown>(operationKey);
      const active = await this.state.storage.get<unknown>(OAUTH_REPROVISION_ACTIVE_KEY);
      if (isRecord(active) && isOAuthReprovisionStatus(active.status) &&
          active.status !== "completed" && active.operationId !== operationId) {
        return jsonResponse({ operationId, status: "in_progress", error: "another_operation_active" }, 409);
      }

      if (isOAuthReprovisionOperation(existing) && existing.status === "completed") {
        if (isRecord(active) && active.operationId === operationId && active.status !== "completed") {
          if (!(await ownerSecretMatchesPersistedState(this.state.storage, this.env.MCP_OWNER_TOKEN))) {
            return jsonResponse({ operationId, status: "outcome_unknown" }, 503);
          }
          await this.appendOAuthReprovisionEvent(operationId, existing.attempt, "completed");
          await this.state.storage.put(OAUTH_REPROVISION_ACTIVE_KEY, {
            operationId,
            status: "completed",
            updatedAt: existing.updatedAt,
          } satisfies OAuthReprovisionActiveState);
        }
        return jsonResponse({ operationId, status: "completed", attempt: existing.attempt });
      }

      const targetVerifierHash = await ownerSecretVerifierHash(ownerToken);
      if (isOAuthReprovisionOperation(existing) &&
          existing.targetOwnerVerifierHash !== targetVerifierHash) {
        return jsonResponse({ operationId, status: existing.status, error: "operation_secret_changed" }, 409);
      }
      let replacementOAuth: EdgeOwnerOAuth;
      try {
        replacementOAuth = createOwnerOAuth(
          this.state.storage,
          this.env,
          createIdentityStore(this.state.storage),
        );
      } catch {
        const currentStatus = isOAuthReprovisionOperation(existing)
          ? existing.status
          : isRecord(active) && active.operationId === operationId &&
            isOAuthReprovisionStatus(active.status)
            ? active.status
            : "not_executed";
        return jsonResponse({ operationId, status: currentStatus, error: "runtime_configuration_invalid" }, 503);
      }
      if (isOAuthReprovisionOperation(existing)) {
        operation = {
          ...existing,
          status: "in_progress",
          attempt: existing.attempt + 1,
          updatedAt: new Date().toISOString(),
        };
        await this.state.storage.put(OAUTH_REPROVISION_ACTIVE_KEY, {
          operationId,
          status: "in_progress",
          updatedAt: operation.updatedAt,
        } satisfies OAuthReprovisionActiveState);
        await this.state.storage.put(operationKey, operation);
        await this.appendOAuthReprovisionEvent(operationId, operation.attempt, "resumed");
      } else {
        const currentMaterial = await this.state.storage.get<unknown>(OWNER_CREDENTIAL_MATERIAL_KEY);
        if (isRecord(currentMaterial) && typeof currentMaterial.ownerVerifierHash === "string" &&
            await constantTimeTextEquals(currentMaterial.ownerVerifierHash, targetVerifierHash)) {
          return jsonResponse({
            operationId,
            status: "not_executed",
            error: "owner_token_must_change",
          }, 409);
        }
        const now = new Date().toISOString();
        operation = {
          operationId,
          status: "in_progress",
          attempt: 1,
          startedAt: now,
          updatedAt: now,
          targetOwnerVerifierHash: targetVerifierHash,
        };
        await this.state.storage.put(OAUTH_REPROVISION_ACTIVE_KEY, {
          operationId,
          status: "in_progress",
          updatedAt: now,
        } satisfies OAuthReprovisionActiveState);
        await this.state.storage.put(operationKey, operation);
        await this.appendOAuthReprovisionEvent(operationId, 1, "started");
      }

      const currentOperation = operation;
      if (!currentOperation) throw new Error("Reprovision operation was not persisted.");

      let deletedThisRequest = 0;
      while (true) {
        const batch = await this.state.storage.listPrefix(
          OWNER_OAUTH_STORAGE_PREFIX,
          OWNER_OAUTH_DELETE_BATCH_SIZE,
        );
        const keys = [...batch.keys()];
        if (keys.length === 0) break;
        if (deletedThisRequest >= OWNER_OAUTH_DELETE_LIMIT_PER_REQUEST) {
          return jsonResponse({ operationId, status: "in_progress", attempt: currentOperation.attempt }, 202);
        }
        const allowed = keys.slice(0, OWNER_OAUTH_DELETE_LIMIT_PER_REQUEST - deletedThisRequest);
        await this.state.storage.deleteMany(allowed);
        deletedThisRequest += allowed.length;
      }
      await this.state.storage.delete(UPDATE_CONTROL_OWNER_KEY);
      await this.appendOAuthReprovisionEvent(operationId, currentOperation.attempt, "oauth_state_cleared");
      await ensureSingleOwner(this.state.storage);
      await replacementOAuth.activateSingleUser(UPDATE_CONTROL_OWNER_ID);
      this.ownerOAuth = replacementOAuth;
      this.ownerIdentityPromise = undefined;
      if (!(await ownerSecretMatchesPersistedState(this.state.storage, this.env.MCP_OWNER_TOKEN))) {
        throw new Error("Reprovisioned OAuth authority did not match configured secret.");
      }
      await this.appendOAuthReprovisionEvent(
        operationId,
        currentOperation.attempt,
        "owner_authority_reprovisioned",
      );
      const completedAt = new Date().toISOString();
      operation = {
        operationId,
        status: "completed",
        attempt: currentOperation.attempt,
        startedAt: currentOperation.startedAt,
        updatedAt: completedAt,
      };
      await this.state.storage.put(operationKey, operation);
      await this.appendOAuthReprovisionEvent(operationId, currentOperation.attempt, "completed");
      await this.state.storage.put(OAUTH_REPROVISION_ACTIVE_KEY, {
        operationId,
        status: "completed",
        updatedAt: completedAt,
      } satisfies OAuthReprovisionActiveState);
      return jsonResponse({ operationId, status: "completed", attempt: currentOperation.attempt });
    } catch {
      try {
        const persisted = await this.state.storage.get<unknown>(operationKey);
        if (isOAuthReprovisionOperation(persisted) && persisted.status !== "completed") {
          const unknown: OAuthReprovisionOperation = {
            ...persisted,
            status: "outcome_unknown",
            updatedAt: new Date().toISOString(),
          };
          await this.state.storage.put(operationKey, unknown);
          await this.state.storage.put(OAUTH_REPROVISION_ACTIVE_KEY, {
            operationId,
            status: "outcome_unknown",
            updatedAt: unknown.updatedAt,
          } satisfies OAuthReprovisionActiveState);
          await this.appendOAuthReprovisionEvent(operationId, unknown.attempt, "outcome_unknown");
          return jsonResponse({ operationId, status: "outcome_unknown" }, 503);
        }
      } catch {
        // If persistence itself is unavailable, the last durable marker remains in progress and normal OAuth stays blocked.
      }
      return jsonResponse({ operationId, status: "outcome_unknown" }, 503);
    }
  }

  private async readOAuthReprovisionEvents(operationId: string): Promise<OAuthReprovisionAuditEvent[]> {
    const entries = await this.state.storage.listPrefix(
      oauthEventPrefix(operationId),
      100,
    );
    return [...entries.values()]
      .filter((event): event is OAuthReprovisionAuditEvent =>
        isOAuthReprovisionAuditEvent(event) && event.operationId === operationId)
      .sort((left, right) =>
        left.attempt - right.attempt ||
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.eventType.localeCompare(right.eventType))
      .slice(-100);
  }

  private async appendOAuthReprovisionEvent(
    operationId: string,
    attempt: number,
    eventType: OAuthReprovisionEventType,
  ): Promise<void> {
    const key = oauthEventKey(operationId, attempt, eventType);
    if (await this.state.storage.get<unknown>(key) !== undefined) return;
    await this.state.storage.put(key, {
      operationId,
      attempt,
      eventType,
      occurredAt: new Date().toISOString(),
    } satisfies OAuthReprovisionAuditEvent);
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.requestQueue;
    let release!: () => void;
    this.requestQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(async () => {
      try {
        return await action();
      } finally {
        release();
      }
    });
  }

  private ensureOwnerIdentity(): Promise<void> {
    if (!this.ownerIdentityPromise) {
      this.ownerIdentityPromise = ensureSingleOwner(this.state.storage)
        .then(() => this.ownerOAuth!.activateSingleUser(UPDATE_CONTROL_OWNER_ID))
        .then(() => undefined)
        .catch((error: unknown) => {
          this.ownerIdentityPromise = undefined;
          throw error;
        });
    }
    return this.ownerIdentityPromise;
  }

  private createReadClientProxy(): UpdateControlReadClient {
    return {
      listRuns: (input) => this.getReadClient().listRuns(input),
      getRun: (input) => this.getReadClient().getRun(input),
      waitEvents: (input) => this.getReadClient().waitEvents(input),
    };
  }

  private getReadClient(): UpdateControlOracleChannelReadClient {
    if (this.readClient) return this.readClient;
    const channel = this.env.UPDATE_CONTROL_ORACLE_CHANNEL;
    if (!channel) throw new Error("Update Control Oracle channel is not configured.");
    this.readClient = new UpdateControlOracleChannelReadClient(channel);
    return this.readClient;
  }
}

function oauthOperationKey(operationId: string): string {
  return OAUTH_REPROVISION_OPERATION_PREFIX + operationId;
}

function oauthEventPrefix(operationId: string): string {
  return OAUTH_REPROVISION_EVENT_PREFIX + operationId + ":";
}

function oauthEventKey(
  operationId: string,
  attempt: number,
  eventType: OAuthReprovisionEventType,
): string {
  return oauthEventPrefix(operationId) + String(attempt).padStart(6, "0") + ":" + eventType;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOAuthReprovisionStatus(value: unknown): value is OAuthReprovisionStatus {
  return value === "in_progress" || value === "completed" || value === "outcome_unknown";
}

function isOAuthReprovisionOperation(value: unknown): value is OAuthReprovisionOperation {
  return isRecord(value) &&
    typeof value.operationId === "string" &&
    OAUTH_REPROVISION_OPERATION_ID_PATTERN.test(value.operationId) &&
    isOAuthReprovisionStatus(value.status) &&
    Number.isSafeInteger(value.attempt) && (value.attempt as number) > 0 &&
    typeof value.startedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (value.targetOwnerVerifierHash === undefined ||
      (typeof value.targetOwnerVerifierHash === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value.targetOwnerVerifierHash)));
}

function isOAuthReprovisionAuditEvent(value: unknown): value is OAuthReprovisionAuditEvent {
  return isRecord(value) &&
    typeof value.operationId === "string" &&
    OAUTH_REPROVISION_OPERATION_ID_PATTERN.test(value.operationId) &&
    Number.isSafeInteger(value.attempt) && (value.attempt as number) > 0 &&
    typeof value.eventType === "string" &&
    ["started", "resumed", "oauth_state_cleared", "owner_authority_reprovisioned", "completed", "outcome_unknown"].includes(value.eventType) &&
    typeof value.occurredAt === "string" &&
    Number.isFinite(Date.parse(value.occurredAt));
}

function parseUpdateControlPublicUrl(value: string | undefined): URL {
  const raw = requireValue(value, "MCP_UPDATE_CONTROL_PUBLIC_URL");
  if (/[\u0000-\u001f\u007f]/u.test(raw) || raw.includes("?") || raw.includes("#")) {
    throw new Error("MCP_UPDATE_CONTROL_PUBLIC_URL must be an HTTPS origin without query or fragment.");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("MCP_UPDATE_CONTROL_PUBLIC_URL must be an HTTPS origin.");
  }
  const isRootOrigin = raw === url.origin || raw === `${url.origin}/`;
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.pathname !== "/" || url.search || url.hash || !isRootOrigin) {
    throw new Error("MCP_UPDATE_CONTROL_PUBLIC_URL must be an HTTPS origin without credentials, nonstandard port, path, query, or fragment.");
  }
  return url;
}

function deriveOAuthReprovisionUrl(publicBaseUrl: string | undefined): URL {
  return new URL(OAUTH_REPROVISION_PATH, parseUpdateControlPublicUrl(publicBaseUrl).origin);
}

async function ownerSecretMatchesPersistedState(
  storage: OwnerOAuthStorage,
  ownerSecret: string | undefined,
): Promise<boolean> {
  if (!ownerSecret || ownerSecret.length < 32) return false;
  const material = await storage.get<unknown>(OWNER_CREDENTIAL_MATERIAL_KEY);
  if (!isRecord(material) || typeof material.ownerVerifierHash !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/u.test(material.ownerVerifierHash)) return false;
  return constantTimeTextEquals(material.ownerVerifierHash, await ownerSecretVerifierHash(ownerSecret));
}

async function ownerSecretVerifierHash(ownerSecret: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ownerSecret),
  ));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function constantTimeTextEquals(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index]! ^ rightBytes[index]!;
  }
  return difference === 0;
}

async function readBoundedRequestText(request: Request, maximumBytes: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await request.body?.cancel();
    throw new Error("Request exceeded the configured payload limit.");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("Request exceeded the configured payload limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}


const UPDATE_CONTROL_OWNER_KEY = "update-control:owner-identity:v1";

export async function ensureSingleOwner(storage: OwnerOAuthStorage): Promise<void> {
  const owner = await storage.get<OwnerIdentity>(UPDATE_CONTROL_OWNER_KEY);
  if (owner === undefined) {
    await storage.put(UPDATE_CONTROL_OWNER_KEY, {
      id: UPDATE_CONTROL_OWNER_ID,
      displayName: "MCP V3 Update Control Owner",
    } satisfies OwnerIdentity);
    return;
  }
  if (!isUpdateControlOwner(owner)) {
    throw new Error("Update Control authorization storage has an unexpected owner identity.");
  }
}

function isOAuthPostPath(pathname: string): boolean {
  return pathname === "/register" || pathname === "/authorize" ||
    pathname === "/token" || pathname === "/revoke";
}

function createIdentityStore(storage: OwnerOAuthStorage): OwnerIdentityStore {
  return {
    async getUser(userId) {
      const owner = await storage.get<OwnerIdentity>(UPDATE_CONTROL_OWNER_KEY);
      return userId === UPDATE_CONTROL_OWNER_ID && isUpdateControlOwner(owner) ? owner : null;
    },
    async listUsers() {
      const owner = await storage.get<OwnerIdentity>(UPDATE_CONTROL_OWNER_KEY);
      return isUpdateControlOwner(owner) ? [owner] : [];
    },
  };
}

function isUpdateControlOwner(value: unknown): value is OwnerIdentity {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    "id" in value && value.id === UPDATE_CONTROL_OWNER_ID &&
    "displayName" in value && value.displayName === "MCP V3 Update Control Owner";
}

function createOwnerOAuth(
  storage: OwnerOAuthStorage,
  env: UpdateControlEnvironment,
  identityStore: OwnerIdentityStore,
): EdgeOwnerOAuth {
  const ownerSecret = requireValue(env.MCP_OWNER_TOKEN, "MCP_OWNER_TOKEN");
  if (ownerSecret.length < 32) throw new Error("MCP_OWNER_TOKEN must contain at least 32 characters.");
  const baseUrlValue = requireValue(
    env.MCP_UPDATE_CONTROL_PUBLIC_URL,
    "MCP_UPDATE_CONTROL_PUBLIC_URL",
  );
  const publicBaseUrl = parseUpdateControlPublicUrl(baseUrlValue);
  return new EdgeOwnerOAuth(storage, {
    ownerSecret,
    publicBaseUrl,
    mcpPath: "/mcp",
    scopes: ["update:read"],
    accessTokenTtlSeconds: readBoundedInteger(
      env.MCP_OWNER_ACCESS_TOKEN_TTL_SECONDS,
      3_600,
      60,
      86_400,
    ),
    refreshTokenTtlSeconds: readBoundedInteger(
      env.MCP_OWNER_REFRESH_TOKEN_TTL_SECONDS,
      2_592_000,
      300,
      31_536_000,
    ),
    resourceName: "MCP V3 Update Center",
  }, identityStore);
}

async function boundOAuthRequest(request: Request): Promise<Request> {
  if (request.method !== "POST") return request;
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_OAUTH_BODY_BYTES)) {
    await request.body?.cancel();
    throw new Error("OAuth request exceeded the configured payload limit.");
  }
  const reader = request.body?.getReader();
  if (!reader) return new Request(request.url, { method: request.method, headers: request.headers });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > MAX_OAUTH_BODY_BYTES) {
        await reader.cancel();
        throw new Error("OAuth request exceeded the configured payload limit.");
      }
      chunks.push(result.value);
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
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: bytes,
  });
}

function headersWithinBounds(headers: Headers): boolean {
  let count = 0;
  let bytes = 0;
  for (const [name, value] of headers) {
    count += 1;
    bytes += new TextEncoder().encode(name).byteLength +
      new TextEncoder().encode(value).byteLength;
    if (count > MAX_HEADER_COUNT || bytes > MAX_HEADER_BYTES) return false;
  }
  return true;
}

function requireValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required.`);
  return normalized;
}

function readBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d{1,10}$/u.test(value.trim())) throw new Error("OAuth token TTL is invalid.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("OAuth token TTL is invalid.");
  }
  return parsed;
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
