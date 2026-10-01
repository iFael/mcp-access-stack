import type { AuthenticatedEdgePrincipal } from "@mcp-access-stack/edge-protocol";

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