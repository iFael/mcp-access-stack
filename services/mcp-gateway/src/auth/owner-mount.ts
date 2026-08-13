import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { Express, NextFunction, Request, Response } from "express";
import type { GatewayConfig } from "../config.js";
import {
  deriveAllowedRedirectHosts,
  OwnerOAuthProvider,
} from "./owner-provider.js";

type AuthenticatedRequest = Request & { auth?: AuthInfo };

export interface OwnerOAuthMount {
  provider: OwnerOAuthProvider;
  requiredScope: string;
  resourceMetadataUrl: URL;
  challenge: string;
}

export function mountOwnerOAuth(app: Express, config: GatewayConfig): OwnerOAuthMount {
  const owner = config.ownerOAuth;
  if (!owner) {
    throw new Error("Owner OAuth configuration is required when authMode is owner.");
  }

  const mcpUrl = new URL(config.mcpPath, config.publicBaseUrl);
  const resourceMetadataUrl = new URL(
    `/.well-known/oauth-protected-resource${config.mcpPath}`,
    config.publicBaseUrl,
  );
  const provider = new OwnerOAuthProvider(
    {
      ownerToken: owner.ownerToken,
      accessTokenTtlSeconds: owner.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: owner.refreshTokenTtlSeconds,
      scopes: owner.scopes,
      allowedRedirectHosts: deriveAllowedRedirectHosts(config.publicBaseUrl),
      resourceName: owner.resourceName,
    },
    mcpUrl,
  );
  const requiredScope = owner.scopes[0] ?? "mcp:tools";
  const challenge = `Bearer resource_metadata="${resourceMetadataUrl.href}", scope="${requiredScope}"`;

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicBaseUrl,
      scopesSupported: owner.scopes,
      resourceServerUrl: mcpUrl,
      resourceName: owner.resourceName,
    }),
  );

  app.get(
    [
      "/.well-known/oauth-protected-resource",
      `/.well-known/oauth-protected-resource${config.mcpPath}`,
    ],
    (_request, response) => {
      response.json({
        resource: mcpUrl.href,
        authorization_servers: [config.publicBaseUrl.href],
        scopes_supported: owner.scopes,
        resource_name: owner.resourceName,
      });
    },
  );

  return { provider, requiredScope, resourceMetadataUrl, challenge };
}

export function createOwnerAuthenticationMiddleware(
  provider: OwnerOAuthProvider,
  challenge: string,
): (request: AuthenticatedRequest, response: Response, next: NextFunction) => void {
  return (request, response, next) => {
    const header = request.header("authorization");
    if (!header) {
      next();
      return;
    }
    if (!header.startsWith("Bearer ") || header.length === "Bearer ".length) {
      response.setHeader("WWW-Authenticate", `${challenge}, error="invalid_token"`);
      response.status(401).json({ error: "invalid_token" });
      return;
    }
    void provider.verifyAccessToken(header.slice("Bearer ".length)).then(
      (authInfo) => {
        request.auth = authInfo;
        next();
      },
      () => {
        response.setHeader("WWW-Authenticate", `${challenge}, error="invalid_token"`);
        response.status(401).json({ error: "invalid_token" });
      },
    );
  };
}
