import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import {
  ADMIN_BOOTSTRAP_PATH,
  OAUTH_REPROVISION_PATH,
  parseAdminBootstrapOperationId,
  parseOAuthReprovisionOperationId,
  UPDATE_CONTROL_INTERNAL_ADMIN_OPERATION_AUTH_HEADER,
  UPDATE_CONTROL_INTERNAL_ADMIN_OPERATION_AUTH_MARKER,
  UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_HEADER,
  UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_MARKER,
  UpdateControlAuthController,
  type UpdateControlDurableStorage,
  type UpdateControlEnvironment,
} from "./auth-state.js";
import { verifyOperationHmac } from "./operation-hmac.js";
import {
  ORACLE_CHANNEL_CONNECT_PATH,
  ORACLE_CHANNEL_SCOPE,
  type OracleChannelNamespace,
} from "./oracle-channel.js";

interface DurableObjectStorageLike extends Omit<OwnerOAuthStorage, "delete"> {
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list(options: { prefix: string; limit: number }): Promise<Map<string, unknown>>;
}

interface DurableObjectStateLike {
  readonly storage: DurableObjectStorageLike;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export interface UpdateControlWorkerEnv extends UpdateControlEnvironment {
  readonly UPDATE_CONTROL_AUTH_STATE: DurableObjectNamespaceLike;
  readonly UPDATE_CONTROL_ORACLE_CHANNEL: OracleChannelNamespace;
  readonly UPDATE_CONTROL_ORACLE_CHANNEL_TOKEN?: string;
}

export class UpdateControlAuthState {
  private readonly controller: UpdateControlAuthController;

  constructor(state: DurableObjectStateLike, env: UpdateControlWorkerEnv) {
    const storage: UpdateControlDurableStorage = {
      get: <T>(key: string) => state.storage.get<T>(key),
      put: <T>(key: string, value: T) => state.storage.put(key, value),
      delete: (key: string) => state.storage.delete(key),
      listPrefix: (prefix, limit) => state.storage.list({ prefix, limit }),
      deleteMany: (keys) => state.storage.delete(keys),
    };
    this.controller = new UpdateControlAuthController({ storage }, env);
  }

  fetch(request: Request): Promise<Response> {
    return this.controller.fetch(request);
  }
}

const REPROVISION_HMAC_DOMAIN = "mcp-v3-update-control:oauth-reprovision";
const ADMIN_BOOTSTRAP_HMAC_DOMAIN = "mcp-v3-update-control:admin-bootstrap";

function withoutClientInternalAuthMarkers(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete(UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_HEADER);
  headers.delete(UPDATE_CONTROL_INTERNAL_ADMIN_OPERATION_AUTH_HEADER);
  return new Request(request, { headers });
}

function withTrustedInternalMarker(
  request: Request,
  headerName: string,
  marker: string,
): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("x-update-control-oidc-diagnose");
  headers.delete(UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_HEADER);
  headers.delete(UPDATE_CONTROL_INTERNAL_ADMIN_OPERATION_AUTH_HEADER);
  headers.set(headerName, marker);
  return new Request(request, { headers });
}

const updateControlWorker = {
  async fetch(request: Request, env: UpdateControlWorkerEnv): Promise<Response> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname === ORACLE_CHANNEL_CONNECT_PATH) {
      const channel = env.UPDATE_CONTROL_ORACLE_CHANNEL;
      if (!channel) {
        return jsonResponse({ error: "oracle_channel_not_configured" }, 503);
      }
      const id = channel.idFromName(ORACLE_CHANNEL_SCOPE);
      return channel.get(id).fetch(withoutClientInternalAuthMarkers(request));
    }

    const authState = env.UPDATE_CONTROL_AUTH_STATE.get(
      env.UPDATE_CONTROL_AUTH_STATE.idFromName("update-control-auth-v1"),
    );

    if (url.pathname === OAUTH_REPROVISION_PATH) {
      const parsed = await parseOAuthReprovisionOperationId(
        request.clone() as unknown as Request,
        env.MCP_UPDATE_CONTROL_PUBLIC_URL,
      );
      if (!parsed.ok) return parsed.response;
      const authenticated = await verifyOperationHmac(
        request,
        parsed.operationId,
        env.UPDATE_CONTROL_ADMIN_HMAC_KEY,
        { domain: REPROVISION_HMAC_DOMAIN, path: OAUTH_REPROVISION_PATH },
      );
      if (!authenticated) return operationAuthRequired();
      return authState.fetch(withTrustedInternalMarker(
        request,
        UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_HEADER,
        UPDATE_CONTROL_INTERNAL_REPROVISION_AUTH_MARKER,
      ));
    }

    if (url.pathname === ADMIN_BOOTSTRAP_PATH) {
      const parsed = await parseAdminBootstrapOperationId(
        request.clone() as unknown as Request,
        env.MCP_UPDATE_CONTROL_PUBLIC_URL,
      );
      if (!parsed.ok) return parsed.response;
      const authenticated = await verifyOperationHmac(
        request,
        parsed.operationId,
        env.UPDATE_CONTROL_ADMIN_HMAC_KEY,
        { domain: ADMIN_BOOTSTRAP_HMAC_DOMAIN, path: ADMIN_BOOTSTRAP_PATH },
      );
      if (!authenticated) return operationAuthRequired();
      return authState.fetch(withTrustedInternalMarker(
        request,
        UPDATE_CONTROL_INTERNAL_ADMIN_OPERATION_AUTH_HEADER,
        UPDATE_CONTROL_INTERNAL_ADMIN_OPERATION_AUTH_MARKER,
      ));
    }

    return authState.fetch(withoutClientInternalAuthMarkers(request));
  },
};

function operationAuthRequired(): Response {
  return jsonResponse({ error: "operation_auth_required" }, 401);
}

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export { UpdateControlOracleChannel } from "./oracle-channel.js";
export default updateControlWorker;
