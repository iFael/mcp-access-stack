import type { OwnerOAuthStorage } from "@mcp-access-stack/mcp-owner-auth";
import {
  createOAuthReprovisionOidcFailureResponse,
  OAUTH_REPROVISION_PATH,
  parseOAuthReprovisionOperationId,
  UPDATE_CONTROL_INTERNAL_OIDC_HEADER,
  UPDATE_CONTROL_INTERNAL_OIDC_MARKER,
  UpdateControlAuthController,
  type UpdateControlDurableStorage,
  type UpdateControlEnvironment,
} from "./auth-state.js";
import { GitHubActionsOidcAssertionVerifier } from "./github-actions-oidc.js";
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

function withoutClientInternalOidcMarker(request: Request): Request {
  if (!request.headers.has(UPDATE_CONTROL_INTERNAL_OIDC_HEADER)) return request;
  const headers = new Headers(request.headers);
  headers.delete(UPDATE_CONTROL_INTERNAL_OIDC_HEADER);
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

    if (url.pathname === OAUTH_REPROVISION_PATH) {
      const parsed = await parseOAuthReprovisionOperationId(
        request.clone() as unknown as Request,
        env.MCP_UPDATE_CONTROL_PUBLIC_URL,
      );
      if (!parsed.ok) return parsed.response;

      const authorization = request.headers.get("authorization");
      const assertion = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : "";
      if (!assertion) return createOAuthReprovisionOidcFailureResponse(request);

      const verification = await new GitHubActionsOidcAssertionVerifier(fetch)
        .verifyWithStage(assertion, parsed.operationId);
      if (!verification.valid) {
        return createOAuthReprovisionOidcFailureResponse(request, verification);
      }

      const headers = new Headers(request.headers);
      headers.delete("authorization");
      headers.delete("x-update-control-oidc-diagnose");
      headers.delete(UPDATE_CONTROL_INTERNAL_OIDC_HEADER);
      headers.set(UPDATE_CONTROL_INTERNAL_OIDC_HEADER, UPDATE_CONTROL_INTERNAL_OIDC_MARKER);
      const internalRequest = new Request(request, { headers });
      const id = env.UPDATE_CONTROL_AUTH_STATE.idFromName("update-control-auth-v1");
      return env.UPDATE_CONTROL_AUTH_STATE.get(id).fetch(internalRequest);
    }

    const routedRequest = withoutClientInternalOidcMarker(request);
    if (url.pathname === ORACLE_CHANNEL_CONNECT_PATH) {
      const channel = env.UPDATE_CONTROL_ORACLE_CHANNEL;
      if (!channel) {
        return new Response(JSON.stringify({ error: "oracle_channel_not_configured" }), {
          status: 503,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
        });
      }
      const id = channel.idFromName(ORACLE_CHANNEL_SCOPE);
      return channel.get(id).fetch(routedRequest);
    }

    const id = env.UPDATE_CONTROL_AUTH_STATE.idFromName("update-control-auth-v1");
    return env.UPDATE_CONTROL_AUTH_STATE.get(id).fetch(routedRequest);
  },
};

export { UpdateControlOracleChannel } from "./oracle-channel.js";
export default updateControlWorker;
