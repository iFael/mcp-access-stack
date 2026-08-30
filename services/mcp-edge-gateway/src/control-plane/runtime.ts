import {
  createExternalOAuthAuthenticator,
  type EdgeAuthenticator,
} from "./auth.js";
import {
  createMcpControlPlane,
  type EdgeExecutionTransport,
  type EdgeMcpControlPlane,
} from "./mcp-control-plane.js";
import {
  createMcpSessionRouter,
  type EdgeOAuthRouteHandler,
  type McpSessionRouter,
} from "./mcp-session-router.js";
import {
  EdgeOwnerOAuth,
  type OwnerOAuthStorage,
} from "./owner-oauth.js";
import {
  EDGE_MCP_CATALOG_METADATA,
  EDGE_MCP_SERVER_IDENTITY,
  EDGE_MCP_TOOL_MANIFEST,
} from "../generated/mcp-tool-manifest.js";

export interface EdgeControlPlaneEnv {
  MCP_EDGE_AUTH_MODE?: string;
  MCP_PUBLIC_BASE_URL?: string;
  MCP_OWNER_TOKEN?: string;
  MCP_OWNER_OAUTH_SCOPES?: string;
  MCP_OWNER_ACCESS_TOKEN_TTL_SECONDS?: string;
  MCP_OWNER_REFRESH_TOKEN_TTL_SECONDS?: string;
  MCP_OWNER_RESOURCE_NAME?: string;
  MCP_OAUTH_ISSUER?: string;
  MCP_OAUTH_AUDIENCE?: string;
  MCP_OAUTH_JWKS_URL?: string;
  MCP_OAUTH_ALLOWED_SUBJECTS?: string;
  MCP_OAUTH_REQUIRED_SCOPE?: string;
}

export class EdgeControlPlaneConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdgeControlPlaneConfigurationError";
  }
}

export interface EdgeControlPlaneRuntime {
  authenticator: EdgeAuthenticator;
  oauth: EdgeOAuthRouteHandler;
  controlPlane: EdgeMcpControlPlane;
  router: McpSessionRouter;
}

export function createEdgeControlPlaneRuntime(
  env: EdgeControlPlaneEnv,
  storage: OwnerOAuthStorage,
  execution: EdgeExecutionTransport,
): EdgeControlPlaneRuntime {
  const publicBaseUrl = parsePublicBaseUrl(requireValue(env.MCP_PUBLIC_BASE_URL, "MCP_PUBLIC_BASE_URL"));
  const mode = requireValue(env.MCP_EDGE_AUTH_MODE, "MCP_EDGE_AUTH_MODE");

  let authenticator: EdgeAuthenticator;
  let oauth: EdgeOAuthRouteHandler;

  if (mode === "owner") {
    const scopes = parseCsv(requireValue(env.MCP_OWNER_OAUTH_SCOPES, "MCP_OWNER_OAUTH_SCOPES"), "MCP_OWNER_OAUTH_SCOPES");
    const owner = new EdgeOwnerOAuth(storage, {
      ...(env.MCP_OWNER_TOKEN?.trim() ? { ownerSecret: env.MCP_OWNER_TOKEN.trim() } : {}),
      publicBaseUrl,
      mcpPath: "/mcp",
      scopes,
      accessTokenTtlSeconds: parsePositiveInteger(env.MCP_OWNER_ACCESS_TOKEN_TTL_SECONDS, "MCP_OWNER_ACCESS_TOKEN_TTL_SECONDS"),
      refreshTokenTtlSeconds: parsePositiveInteger(env.MCP_OWNER_REFRESH_TOKEN_TTL_SECONDS, "MCP_OWNER_REFRESH_TOKEN_TTL_SECONDS"),
      resourceName: requireValue(env.MCP_OWNER_RESOURCE_NAME, "MCP_OWNER_RESOURCE_NAME"),
    });
    authenticator = owner;
    oauth = owner;
  } else if (mode === "oauth") {
    const issuer = requireAbsoluteUrl(env.MCP_OAUTH_ISSUER, "MCP_OAUTH_ISSUER");
    const audience = requireValue(env.MCP_OAUTH_AUDIENCE, "MCP_OAUTH_AUDIENCE");
    const jwksUrl = new URL(requireAbsoluteUrl(env.MCP_OAUTH_JWKS_URL, "MCP_OAUTH_JWKS_URL"));
    const allowedSubjects = new Set(parseCsv(requireValue(env.MCP_OAUTH_ALLOWED_SUBJECTS, "MCP_OAUTH_ALLOWED_SUBJECTS"), "MCP_OAUTH_ALLOWED_SUBJECTS"));
    const requiredScope = requireValue(env.MCP_OAUTH_REQUIRED_SCOPE, "MCP_OAUTH_REQUIRED_SCOPE");
    const mcpUrl = new URL("/mcp", publicBaseUrl);
    const resourceMetadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", publicBaseUrl);
    authenticator = createExternalOAuthAuthenticator({
      issuer,
      audience,
      jwksUrl,
      allowedSubjects,
      requiredScope,
      resourceMetadataUrl,
    });
    oauth = {
      async handle(request: Request): Promise<Response | null> {
        const url = new URL(request.url);
        if (
          request.method !== "GET" ||
          (url.pathname !== "/.well-known/oauth-protected-resource" && url.pathname !== resourceMetadataUrl.pathname)
        ) return null;
        return jsonResponse({
          resource: mcpUrl.href,
          authorization_servers: [issuer],
          scopes_supported: [requiredScope],
          resource_name: "MCP Access Stack",
        });
      },
    };
  } else {
    throw new EdgeControlPlaneConfigurationError("MCP_EDGE_AUTH_MODE must be exactly owner or oauth.");
  }

  const controlPlane = createMcpControlPlane({
    authenticator,
    execution,
    manifest: EDGE_MCP_TOOL_MANIFEST,
    catalogMetadata: EDGE_MCP_CATALOG_METADATA,
    serverIdentity: EDGE_MCP_SERVER_IDENTITY,
  });
  const router = createMcpSessionRouter({ oauth, controlPlane });
  return { authenticator, oauth, controlPlane, router };
}

function requireValue(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new EdgeControlPlaneConfigurationError(`${name} is required.`);
  return normalized;
}

function requireAbsoluteUrl(value: string | undefined, name: string): string {
  const normalized = requireValue(value, name);
  try {
    return new URL(normalized).href;
  } catch {
    throw new EdgeControlPlaneConfigurationError(`${name} must be an absolute URL.`);
  }
}

function parsePublicBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EdgeControlPlaneConfigurationError("MCP_PUBLIC_BASE_URL must be an absolute URL origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new EdgeControlPlaneConfigurationError("MCP_PUBLIC_BASE_URL must be an HTTPS origin without credentials, path, query, or fragment.");
  }
  return url;
}

function parseCsv(value: string, name: string): string[] {
  const entries = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (entries.length === 0) throw new EdgeControlPlaneConfigurationError(`${name} must contain at least one value.`);
  return entries;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const normalized = requireValue(value, name);
  if (!/^\d+$/u.test(normalized)) throw new EdgeControlPlaneConfigurationError(`${name} must be a positive integer.`);
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new EdgeControlPlaneConfigurationError(`${name} must be a positive integer.`);
  return parsed;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}