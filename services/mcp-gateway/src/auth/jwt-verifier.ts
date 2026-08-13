import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type { GatewayOAuthConfig } from "../config.js";

export class AuthenticationError extends Error {
  constructor(
    readonly status: 401 | 403,
    readonly oauthError: "invalid_token" | "insufficient_scope",
  ) {
    super("Access token validation failed.");
    this.name = "AuthenticationError";
  }
}

export interface AccessTokenVerifier {
  verify(token: string): Promise<AuthInfo>;
}

export class JwtAccessTokenVerifier implements AccessTokenVerifier {
  private readonly getKey: JWTVerifyGetKey;

  constructor(
    private readonly config: GatewayOAuthConfig,
    getKey?: JWTVerifyGetKey,
  ) {
    this.getKey = getKey ?? createRemoteJWKSet(config.jwksUrl);
  }

  async verify(token: string): Promise<AuthInfo> {
    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, this.getKey, {
        issuer: this.config.issuer,
        audience: this.config.audience,
      });
      payload = verified.payload;
    } catch {
      throw new AuthenticationError(401, "invalid_token");
    }

    if (!payload.sub || payload.exp === undefined) {
      throw new AuthenticationError(401, "invalid_token");
    }
    if (!this.config.allowedSubjects.has(payload.sub)) {
      throw new AuthenticationError(403, "insufficient_scope");
    }
    const scopes = parseScopes(payload.scope);
    if (!scopes.includes(this.config.requiredScope)) {
      throw new AuthenticationError(403, "insufficient_scope");
    }

    return {
      token,
      clientId: readClientId(payload),
      scopes,
      expiresAt: payload.exp,
      extra: { subject: payload.sub },
    };
  }
}

function parseScopes(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  return [...new Set(value.split(/\s+/u).filter(Boolean))];
}

function readClientId(payload: JWTPayload): string {
  if (typeof payload.azp === "string" && payload.azp) {
    return payload.azp;
  }
  if (typeof payload.client_id === "string" && payload.client_id) {
    return payload.client_id;
  }
  return payload.sub ?? "unknown";
}
