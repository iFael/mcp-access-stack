import {
  EdgeOwnerOAuth,
  type OwnerIdentity,
  type OwnerIdentityStore,
  type OwnerOAuthStorage,
} from "@mcp-access-stack/mcp-owner-auth";
import { createUpdateControlApiHandler } from "./api.js";
import { createUpdateControlMcpHandler } from "./mcp.js";
import { OracleReleaseReadClient } from "./oracle-read-client.js";
import { createUpdateControlReadOnlyTools } from "./tools.js";

const UPDATE_CONTROL_OWNER_ID = "usr_85dd70bf-2a50-4b8e-97d6-3c20c7226757";
const MAX_URL_LENGTH = 8 * 1024;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_OAUTH_BODY_BYTES = 16 * 1024;

export interface UpdateControlEnvironment {
  readonly MCP_UPDATE_CONTROL_PUBLIC_URL?: string;
  readonly MCP_OWNER_TOKEN?: string;
  readonly MCP_OWNER_ACCESS_TOKEN_TTL_SECONDS?: string;
  readonly MCP_OWNER_REFRESH_TOKEN_TTL_SECONDS?: string;
  readonly ORCHESTRATOR_READ_API_URL?: string;
  readonly UPDATE_CONTROL_ORCHESTRATOR_TOKEN?: string;
  readonly ORACLE_ACCESS_CLIENT_ID?: string;
  readonly ORACLE_ACCESS_CLIENT_SECRET?: string;
}

export interface UpdateControlDurableState {
  readonly storage: OwnerOAuthStorage;
}

export class UpdateControlAuthController {
  private readonly ownerOAuth: EdgeOwnerOAuth | undefined;
  private readonly configurationValid: boolean;
  private ownerIdentityPromise: Promise<void> | undefined;
  private readClient: OracleReleaseReadClient | undefined;

  constructor(
    private readonly state: UpdateControlDurableState,
    private readonly env: UpdateControlEnvironment,
  ) {
    try {
      this.ownerOAuth = createOwnerOAuth(state.storage, env, createIdentityStore(state.storage));
      this.configurationValid = true;
    } catch {
      this.ownerOAuth = undefined;
      this.configurationValid = false;
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.configurationValid || !this.ownerOAuth) {
      return jsonResponse({ error: "update_control_not_configured" }, 503);
    }
    if (request.url.length > MAX_URL_LENGTH || !headersWithinBounds(request.headers)) {
      return new Response(null, { status: 431, headers: { "cache-control": "no-store" } });
    }

    try {
      await this.ensureOwnerIdentity();
      const url = new URL(request.url);
      const oauthRequest = isOAuthPostPath(url.pathname) && request.method === "POST"
        ? await boundOAuthRequest(request)
        : request;
      const oauthResponse = await this.ownerOAuth.handle(oauthRequest);
      if (oauthResponse) return oauthResponse;
      if (url.pathname === "/mcp") {
        return createUpdateControlMcpHandler({
          authenticate: (candidate) => this.ownerOAuth!.authenticate(candidate),
          tools: createUpdateControlReadOnlyTools(this.getReadClient()),
        })(oauthRequest);
      }
      if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) {
        return createUpdateControlApiHandler({
          authenticate: (candidate) => this.ownerOAuth!.authenticate(candidate),
          client: this.getReadClient(),
        })(request);
      }
      return jsonResponse({ error: "not_found" }, 404);
    } catch {
      return jsonResponse({ error: "update_control_unavailable" }, 503);
    }
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

  private getReadClient(): OracleReleaseReadClient {
    if (this.readClient) return this.readClient;
    this.readClient = new OracleReleaseReadClient({
      baseUrl: requireValue(this.env.ORCHESTRATOR_READ_API_URL, "ORCHESTRATOR_READ_API_URL"),
      bearerToken: requireValue(
        this.env.UPDATE_CONTROL_ORCHESTRATOR_TOKEN,
        "UPDATE_CONTROL_ORCHESTRATOR_TOKEN",
      ),
      accessClientId: requireValue(this.env.ORACLE_ACCESS_CLIENT_ID, "ORACLE_ACCESS_CLIENT_ID"),
      accessClientSecret: requireValue(
        this.env.ORACLE_ACCESS_CLIENT_SECRET,
        "ORACLE_ACCESS_CLIENT_SECRET",
      ),
    });
    return this.readClient;
  }
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
  const baseUrlValue = requireValue(
    env.MCP_UPDATE_CONTROL_PUBLIC_URL,
    "MCP_UPDATE_CONTROL_PUBLIC_URL",
  );
  const publicBaseUrl = new URL(baseUrlValue);
  if (publicBaseUrl.protocol !== "https:" || publicBaseUrl.username || publicBaseUrl.password ||
      publicBaseUrl.pathname !== "/" || publicBaseUrl.search || publicBaseUrl.hash) {
    throw new Error("MCP_UPDATE_CONTROL_PUBLIC_URL must be an HTTPS origin.");
  }
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
