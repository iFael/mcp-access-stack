import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol/source";

export interface EdgeAuthenticator {
  authenticate(request: Request): Promise<AuthenticatedEdgePrincipal>;
}

export class EdgeAuthenticationError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly oauthError: "invalid_token" | "insufficient_scope",
    readonly challenge: string,
  ) {
    super("Access token validation failed.");
    this.name = "EdgeAuthenticationError";
  }

  toResponse(): Response {
    return new Response(JSON.stringify({ error: this.oauthError }), {
      status: this.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "www-authenticate": `${this.challenge}, error="${this.oauthError}"`,
      },
    });
  }
}

export interface ExternalOAuthEdgeConfig {
  issuer: string;
  audience: string;
  jwksUrl: URL;
  allowedSubjects: ReadonlySet<string>;
  requiredScope: string;
  resourceMetadataUrl: URL;
}

export function createExternalOAuthAuthenticator(
  config: ExternalOAuthEdgeConfig,
  getKey: JWTVerifyGetKey = createRemoteJWKSet(config.jwksUrl),
): EdgeAuthenticator {
  const challenge = createBearerChallenge(config.resourceMetadataUrl, config.requiredScope);
  return {
    async authenticate(request: Request): Promise<AuthenticatedEdgePrincipal> {
      const token = readBearerToken(request.headers.get("authorization"));
      if (!token) throw new EdgeAuthenticationError(401, "invalid_token", challenge);

      let payload: JWTPayload;
      try {
        const verified = await jwtVerify(token, getKey, {
          issuer: config.issuer,
          audience: config.audience,
        });
        payload = verified.payload;
      } catch {
        throw new EdgeAuthenticationError(401, "invalid_token", challenge);
      }

      if (!payload.sub || payload.exp === undefined) {
        throw new EdgeAuthenticationError(401, "invalid_token", challenge);
      }
      if (!config.allowedSubjects.has(payload.sub)) {
        throw new EdgeAuthenticationError(403, "insufficient_scope", challenge);
      }

      const scopes = parseScopes(payload.scope);
      if (!scopes.includes(config.requiredScope)) {
        throw new EdgeAuthenticationError(403, "insufficient_scope", challenge);
      }

      return { subject: payload.sub, scopes };
    },
  };
}

export function createBearerChallenge(resourceMetadataUrl: URL, requiredScope: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl.href}", scope="${requiredScope}"`;
}

export function readBearerToken(header: string | null): string | null {
  const prefix = "Bearer ";
  if (!header?.startsWith(prefix) || header.length === prefix.length) return null;
  const token = header.slice(prefix.length).trim();
  return token.length > 0 ? token : null;
}

export function parseScopes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(/\s+/u).filter(Boolean))];
}